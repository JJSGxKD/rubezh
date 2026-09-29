#!/usr/bin/env bash
# Сторож бэкапов с восстановлением на момент (docs/35-stage4-plan.md, Р54).
# Ставится в crontab пользователя деплоя раз в десять минут (deploy.sh).
#
# Контейнер backup сам знает, здоров ли он (`backupctl health`: журнал
# уезжал последние 15 минут, очередь не копится), но писать в чат ему нечем
# — токена бота у него нет и не должно быть. Сторож читает здоровье и пишет
# в чат администраторов один раз на поломку и один раз на починку.
set -euo pipefail

APP="/srv/rubezh/app"
FLAG="/srv/rubezh/backups/pitr-broken"
cd "$APP"

value() { { grep -E "^$2=" "$1" || true; } | tail -1 | cut -d= -f2- | sed -E "s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/"; }
# Хранилище не задано — бэкапа на момент нет, и сторожить нечего.
[ -n "$(value .env BACKUP_S3_ZONE)" ] || exit 0

TOKEN="$(value api.env TELEGRAM_BOT_TOKEN)"
API_ROOT="$(value api.env TELEGRAM_API_ROOT)"
API_ROOT="${API_ROOT:-https://api.telegram.org}"
ADMIN_CHAT="$(value api.env ADMIN_CHAT_ID)"

report() {
  [ -n "$ADMIN_CHAT" ] && [ -n "$TOKEN" ] || return 0
  printf 'url = "%s/bot%s/sendMessage"\n' "${API_ROOT%/}" "$TOKEN" |
    curl -fsS --max-time 60 -K - --data-urlencode "chat_id=${ADMIN_CHAT}" --data-urlencode "text=$1" > /dev/null || true
}

state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' rubezh-backup-1 2>/dev/null || echo missing)"
if [ "$state" = "healthy" ]; then
  if [ -f "$FLAG" ]; then
    rm -f "$FLAG"
    report "✅ Бэкап на момент снова работает: журнал уезжает в хранилище"
  fi
  exit 0
fi
# «Запускается» — не поломка: первые минуты после выката проверка ещё идёт.
[ "$state" = "starting" ] && exit 0

if [ ! -f "$FLAG" ]; then
  mkdir -p "$(dirname "$FLAG")"
  date -u +%FT%TZ > "$FLAG"
  detail="$(docker compose --profile backup exec -T backup backupctl status < /dev/null 2>&1 || true)"
  report "❌ Бэкап на момент не работает (${state}): журнал не уезжает в хранилище. ${detail//$'\n'/; }"
fi
