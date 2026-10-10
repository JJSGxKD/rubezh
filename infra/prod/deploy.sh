#!/usr/bin/env bash
# Выкат версии на прод (docs/09-ci-cd.md §10). Запускается пользователем
# деплоя в /srv/rubezh/app — из workflow выката или руками:
#
#   ./deploy.sh v0.6.0-rc.29
#   ./deploy.sh v0.6.0-rc.29 --no-backup   # только в аварии: без дампа перед выкатом
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
skip_backup=no
case "${2:-}" in
  "") ;;
  --no-backup) skip_backup=yes ;;
  *)
    echo "deploy.sh: неизвестный аргумент «$2». Использование: ./deploy.sh <версия> [--no-backup]" >&2
    exit 2
    ;;
esac
APP="/srv/rubezh/app"
WEB="/srv/rubezh/web"
REPO="${REPO:-JJSGxKD/rubezh}"
KEEP_WEB_VERSIONS=5

cd "$APP"
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

# Переменная из .env compose — без source: в файле секреты, и исполнять его
# как скрипт незачем.
env_value() { { grep -E "^$1=" .env || true; } | tail -1 | cut -d= -f2- | sed -E "s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/"; }
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

# Бэкап на момент (Р54) — если задано хранилище: ключ задан — включено (Р53).
# Тогда Postgres архивирует журнал, а профиль backup поднимает контейнер,
# который его увозит. Оба переключателя пишутся в .env, а не только в
# окружение выката: иначе ручной `docker compose up` пересоздал бы Postgres
# без архива. Пароль роли backup и ключ пробного восстановления заводятся
# один раз и дальше не меняются.
if [ -n "$(env_value BACKUP_S3_ZONE)" ] && [ -n "$(env_value BACKUP_S3_PASSWORD)" ]; then
  set_env_value PG_ARCHIVE_MODE on
  set_env_value COMPOSE_PROFILES backup
  [ -n "$(env_value BACKUP_PG_PASSWORD)" ] || set_env_value BACKUP_PG_PASSWORD "$(openssl rand -hex 24)"
  # Каталог на месте ключа оставляет Docker, если контейнер запускали раньше,
  # чем ключ завели, — ключом он не считается.
  if [ -d backup-drill.key ]; then rmdir backup-drill.key; fi
  if [ ! -s backup-drill.key ]; then
    (umask 077 && age-keygen -o backup-drill.key 2> /dev/null)
    log "заведён ключ пробного восстановления backup-drill.key"
  fi
  backups=on
else
  set_env_value PG_ARCHIVE_MODE off
  set_env_value COMPOSE_PROFILES ""
  backups=off
  log "хранилище бэкапов не задано — бэкап на момент выключен, остаётся ежедневный дамп"
fi

# Место на диске — до всего, что пишет в базу. Миграция, упавшая на полном
# диске, остаётся в журнале Prisma неудачной, и API не поднимается ни новой,
# ни прежней версии, пока её не снимут руками (docs/20-env-and-ports.md §5.5).
# Поэтому сначала уходят старые образы API — их по одному на каждый выкат, — а
# если места всё равно мало, выкат останавливается до миграций: работающий API
# продолжает работать.
API_IMAGE="ghcr.io/jjsgxkd/rubezh-api"   # тот же, что у сервиса api в compose.yml
MIN_FREE_MB=2048
free_mb() { df -Pm "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)" | awk 'NR == 2 { print $4 }'; }
# Образы API, кроме названных: текущий и тот, на который откатываемся.
prune_api_images() {
  docker images "$API_IMAGE" --format '{{.Tag}}' | { grep -vxF -e "$1" -e "${2:-$1}" || true; } |
    while read -r tag; do docker rmi "${API_IMAGE}:${tag}" > /dev/null 2>&1 || true; done
  docker image prune -f > /dev/null 2>&1 || true
}
ensure_space() {
  local free
  free="$(free_mb)"
  if [ "$free" -lt "$MIN_FREE_MB" ]; then
    log "свободно ${free} МБ, нужно не меньше ${MIN_FREE_MB} — выкат остановлен до миграций, API остаётся на ${previous:-прежней версии}. Что занято: docker system df; du -xh --max-depth=1 /var/lib/docker /srv/rubezh"
    exit 1
  fi
}

previous="$(env_value API_TAG)"
prune_api_images "$VERSION" "$previous"
ensure_space
log "API ${previous:-—} → ${VERSION}"
docker compose pull --quiet api
# Новый образ занял место — проверка ещё раз, пока миграции не начались.
ensure_space
# Свежий дамп — прямо перед подъёмом новой версии: миграции применяются при
# старте её контейнера, то есть со следующей строки, а ближайший ночной дамп
# может быть на сутки старше. Даже без новых миграций: выкаты редкие, база на
# тесте небольшая, а выяснять, есть ли миграции, — лишняя сложность.
# Дамп не сделался — выкат стоит до миграций, API остаётся на прежней версии.
if [ "$skip_backup" = yes ]; then
  log "⚠️ выкат без бэкапа (--no-backup) — только для аварий"
elif ! "${APP}/backup.sh" --before-deploy "$VERSION"; then
  log "бэкап перед выкатом не сделан — выкат остановлен до миграций, API остаётся на ${previous:-прежней версии}"
  exit 1
fi
# Дамп занял место — проверка ещё раз.
ensure_space
set_env_value API_TAG "$VERSION"
# Повтор выката той же версии после ручной починки: тег не сменился, и
# compose не пересоздаёт контейнер, а застаёт упавший API в паузе между
# перезапусками и считает выкат неудачным — с логами прошлых падений.
# Нездоровый API поэтому пересоздаётся; здоровый той же версии не трогается.
api_health() { docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(docker compose ps -q api)" 2> /dev/null || echo none; }
recreate=()
[ "$(api_health)" = healthy ] || recreate=(--force-recreate)
if ! docker compose up -d --wait --wait-timeout 180 "${recreate[@]}" api; then
  log "API ${VERSION} не прошёл healthcheck — возврат на ${previous}"
  docker compose logs --tail 80 api || true
  # Миграция, отмеченная в базе неудачной, не даст подняться и прежней
  # версии: её entrypoint тоже начинает с `migrate deploy`.
  if docker compose logs --tail 80 api 2>/dev/null | grep -qE 'P3018|P3009'; then
    log "миграция отмечена в базе неудачной — API не поднимется ни одной версией, пока её не снимут: docs/20-env-and-ports.md §5.5"
  fi
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
  webhook) docker compose exec -T api node dist/cli/bot-webhook.js < /dev/null || log "вебхук бота не зарегистрирован — Bot API недоступен" ;;
  polling) docker compose exec -T api node dist/cli/bot-webhook.js --delete < /dev/null || log "вебхук бота не снят — Bot API недоступен" ;;
esac

# Строки журнала обновлений из PR выпуска — черновиками (docs/35-stage4-plan.md
# WP31): игрок их не видит, публикует человек в панели. Файл — из того же
# релиза, что статика; у старых релизов его нет. Импорт идемпотентен: повтор
# выката ничего не задваивает, а сбой журнала выкат не останавливает — строки
# заведёт следующий выкат или их напишут в панели.
import_changelog() {
  local tmp
  tmp="$(mktemp)"
  if ! curl -fsSL --retry 3 --max-time 60 "https://github.com/${REPO}/releases/download/${VERSION}/changelog-${VERSION}.json" -o "$tmp"; then
    log "в релизе ${VERSION} нет changelog-${VERSION}.json — журнал не пополняется"
  elif ! docker compose exec -T api node dist/cli/changelog-import.js < "$tmp"; then
    log "черновики журнала не заведены — выкат продолжается"
  fi
  rm -f "$tmp"
}
import_changelog

for app in "${apps[@]}"; do switch_web "$app"; done

# Роль для базовой копии — с правом репликации и только им; пароль — из
# .env. Повторный выкат лишь подтверждает пароль. Заводится до подъёма
# контейнера бэкапа: иначе его первая база получает отказ и ждёт повтора.
# Пароль идёт окружением, а не аргументом: аргументы видны в списке процессов.
if [ "$backups" = on ]; then
  BACKUP_PG_PASSWORD="$(env_value BACKUP_PG_PASSWORD)" docker compose exec -T -e BACKUP_PG_PASSWORD postgres \
    psql -q -v ON_ERROR_STOP=1 -U "$(env_value POSTGRES_USER)" -d "$(env_value POSTGRES_DB)" <<'SQL' > /dev/null
\getenv password BACKUP_PG_PASSWORD
SELECT format('%s ROLE backup WITH LOGIN REPLICATION PASSWORD %L',
              CASE WHEN EXISTS (SELECT FROM pg_roles WHERE rolname = 'backup') THEN 'ALTER' ELSE 'CREATE' END,
              :'password') \gexec
SQL
fi

# Остальные сервисы — по конфигурации из этого выката; Caddy перечитывает
# сниппеты политики без разрыва соединений.
docker compose up -d --build --remove-orphans
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile < /dev/null

# Ежедневный бэкап — у пользователя деплоя, без sudo; строка ставится один раз.
cron_line="17 3 * * * ${APP}/backup.sh >> /srv/rubezh/backups/backup.log 2>&1"
# Пустой crontab у нового пользователя — не ошибка: без `|| true` pipefail
# остановил бы выкат на этой строке.
watch_line="*/10 * * * * ${APP}/backup-watch.sh >> /srv/rubezh/backups/backup-watch.log 2>&1"
{ crontab -l 2>/dev/null | grep -vF -e "${APP}/backup.sh" -e "${APP}/backup-watch.sh" || true; echo "$cron_line"; echo "$watch_line"; } | crontab -

# Старые образы — после успешного выката: прежний остаётся для отката.
prune_api_images "$VERSION" "$previous"
# Кеш сборки Caddy и бэкапа (`--build` выше) растёт с каждым выкатом; недели
# хватает, чтобы пересборка без изменений не скачивала слои заново.
docker builder prune -f --filter until=168h > /dev/null 2>&1 || true

echo "$VERSION" > .deployed
log "выкачено: ${VERSION}"
