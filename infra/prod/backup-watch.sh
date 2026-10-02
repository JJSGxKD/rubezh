#!/usr/bin/env bash
# Сторож бэкапов с восстановлением на момент (docs/35-stage4-plan.md, Р54) и
# места на диске. Ставится в crontab пользователя деплоя раз в десять минут
# (deploy.sh).
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

TOKEN="$(value api.env TELEGRAM_BOT_TOKEN)"
API_ROOT="$(value api.env TELEGRAM_API_ROOT)"
API_ROOT="${API_ROOT:-https://api.telegram.org}"
ADMIN_CHAT="$(value api.env ADMIN_CHAT_ID)"

report() {
  [ -n "$ADMIN_CHAT" ] && [ -n "$TOKEN" ] || return 0
  printf 'url = "%s/bot%s/sendMessage"\n' "${API_ROOT%/}" "$TOKEN" |
    curl -fsS --max-time 60 -K - --data-urlencode "chat_id=${ADMIN_CHAT}" --data-urlencode "text=$1" > /dev/null || true
}

# Диск — заодно и с бэкапом, и без него: полный диск роняет базу, а с ней
# любую миграцию (docs/20-env-and-ports.md §5.5). Один раз на заполнение и
# один раз на освобождение; порог освобождения ниже порога тревоги, чтобы
# диск на границе не писал в чат каждые десять минут.
DISK_FLAG="/srv/rubezh/backups/disk-low"
DISK_ALERT_PCT=85
DISK_CLEAR_PCT=80
disk_dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)"
disk_used="$(df -P "$disk_dir" | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
disk_free="$(df -Pm "$disk_dir" | awk 'NR == 2 { print $4 }')"
if [ "$disk_used" -ge "$DISK_ALERT_PCT" ] && [ ! -f "$DISK_FLAG" ]; then
  report "⚠️ Диск сервера занят на ${disk_used}%, свободно ${disk_free} МБ. На полном диске падают база и выкат. Что занято: docker system df; du -xh --max-depth=1 /var/lib/docker /srv/rubezh"
  # На совсем полном диске отметка не запишется — тогда тревога повторится
  # через десять минут, и это правильно.
  { mkdir -p "$(dirname "$DISK_FLAG")" && date -u +%FT%TZ > "$DISK_FLAG"; } 2> /dev/null || true
elif [ "$disk_used" -lt "$DISK_CLEAR_PCT" ] && [ -f "$DISK_FLAG" ]; then
  rm -f "$DISK_FLAG"
  report "✅ Место на диске сервера есть: занято ${disk_used}%, свободно ${disk_free} МБ"
fi

# Хранилище не задано — бэкапа на момент нет, и сторожить его нечего.
[ -n "$(value .env BACKUP_S3_ZONE)" ] || exit 0

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
