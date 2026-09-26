#!/usr/bin/env bash
# Выкат версии на прод (docs/09-ci-cd.md §10). Запускается пользователем
# деплоя в /srv/rubezh/app — из workflow выката или руками:
#
#   ./deploy.sh v0.6.0-rc.29
#
# Всё берётся из уже выпущенного релиза: образ API — из GHCR по тегу версии,
# статика клиента и панели — архивами из GitHub Release. Пересборки перед
# выкатом нет (docs/09-ci-cd.md §7).
#
# Порядок — от того, что можно проверить, к тому, что видит игрок: сначала
# API новой версии поднимается и проходит healthcheck, и только потом
# переключается статика. Не поднялся — API возвращается на прежний тег, а
# статика не трогается вовсе.
set -euo pipefail

VERSION="${1:?укажите версию: ./deploy.sh v0.6.0-rc.29}"
APP="/srv/rubezh/app"
WEB="/srv/rubezh/web"
REPO="${REPO:-JJSGxKD/rubezh}"
KEEP_WEB_VERSIONS=5

cd "$APP"
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

# Переменная из .env compose — без source: в файле секреты, и исполнять его
# как скрипт незачем.
env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
set_env_value() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}

# Статика версии — каталогом рядом с прежними; повторный выкат той же версии
# ничего не скачивает.
fetch_web() {
  local app="$1" asset="$2" dir="$WEB/$1/$VERSION"
  if [ -f "$dir/index.html" ]; then return 0; fi
  local tmp
  tmp="$(mktemp -d)"
  if ! curl -fsSL --retry 3 --max-time 120 "https://github.com/${REPO}/releases/download/${VERSION}/${asset}" -o "$tmp/web.tar.gz"; then
    rm -rf "$tmp"
    log "в релизе ${VERSION} нет ${asset} — ${app} остаётся на прежней версии"
    return 1
  fi
  mkdir -p "$WEB/$app" "$tmp/out"
  tar -xzf "$tmp/web.tar.gz" -C "$tmp/out"
  mv "$tmp/out" "$dir"
  rm -rf "$tmp"
}

# Политика источников — из сборки, заголовком на краю (scripts/vite/edge-policy.ts).
# Сборка до файла политики его не несёт — тогда сниппет пустой, и это
# пишется в лог: заголовка не будет, пока не выкачена сборка с политикой.
edge_snippet() {
  local app="$1" policy_file="$WEB/$1/$VERSION/csp.txt"
  if [ ! -f "$policy_file" ]; then
    log "в сборке ${app} ${VERSION} нет csp.txt — политика источников не ставится"
    : > "edge/${app}.caddy.next"
    return 0
  fi
  printf 'header Content-Security-Policy "%s"\n' "$(tr -d '\r\n' < "$policy_file")" > "edge/${app}.caddy.next"
}

switch_web() {
  local app="$1"
  ln -sfn "$VERSION" "$WEB/$app/current.next"
  mv -T "$WEB/$app/current.next" "$WEB/$app/current"
  mv "edge/${app}.caddy.next" "edge/${app}.caddy"
  # Старые версии — кроме нескольких последних: откат на них мгновенный.
  find "$WEB/$app" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | tail -n +$((KEEP_WEB_VERSIONS + 1)) |
    while read -r _ old; do [ "$old" != "$VERSION" ] && rm -rf "${WEB:?}/$app/$old"; done
}

mkdir -p edge
apps=()
for pair in "web-telegram:rubezh-web-telegram-${VERSION}.tar.gz" "admin:rubezh-admin-${VERSION}.tar.gz"; do
  app="${pair%%:*}"
  if fetch_web "$app" "${pair#*:}"; then
    edge_snippet "$app"
    apps+=("$app")
  fi
done

previous="$(env_value API_TAG)"
log "API ${previous:-—} → ${VERSION}"
set_env_value API_TAG "$VERSION"
docker compose pull --quiet api
if ! docker compose up -d --wait --wait-timeout 180 api; then
  log "API ${VERSION} не прошёл healthcheck — возврат на ${previous}"
  docker compose logs --tail 80 api || true
  if [ -n "$previous" ]; then
    set_env_value API_TAG "$previous"
    docker compose up -d --wait --wait-timeout 180 api || true
  fi
  rm -f edge/*.caddy.next
  exit 1
fi

# Вебхук бота — идемпотентный шаг выката: тот же адрес и секрет можно
# регистрировать сколько угодно, а новый список обновлений (allowed_updates)
# без этого шага до Telegram не дойдёт. В режиме polling вебхук снимается:
# при заданном вебхуке getUpdates получает отказ, и бот молчит.
# Недоступный Telegram выкат не останавливает: игра работает и без бота, а
# вебхук перерегистрирует следующий выкат.
case "$(grep -E '^TELEGRAM_BOT_UPDATES=' api.env | tail -1 | cut -d= -f2-)" in
  webhook) docker compose exec -T api node dist/cli/bot-webhook.js || log "вебхук бота не зарегистрирован — Bot API недоступен" ;;
  polling) docker compose exec -T api node dist/cli/bot-webhook.js --delete || log "вебхук бота не снят — Bot API недоступен" ;;
esac

for app in "${apps[@]}"; do switch_web "$app"; done

# Остальные сервисы — по конфигурации из этого выката; Caddy перечитывает
# сниппеты политики без разрыва соединений.
docker compose up -d --build --remove-orphans
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile

# Ежедневный бэкап — у пользователя деплоя, без sudo; строка ставится один раз.
cron_line="17 3 * * * ${APP}/backup.sh >> /srv/rubezh/backups/backup.log 2>&1"
# Пустой crontab у нового пользователя — не ошибка: без `|| true` pipefail
# остановил бы выкат на этой строке.
{ crontab -l 2>/dev/null | grep -vF "${APP}/backup.sh" || true; echo "$cron_line"; } | crontab -

echo "$VERSION" > .deployed
log "выкачено: ${VERSION}"
