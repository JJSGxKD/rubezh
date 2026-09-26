#!/usr/bin/env bash
# Ежедневный бэкап базы (docs/20-env-and-ports.md §5.4). Ставится в crontab
# пользователя деплоя скриптом deploy.sh.
#
# Дамп шифруется открытым SSH-ключом владельца (`age -R`): сервер умеет
# только зашифровать, расшифровать может лишь владелец своим закрытым ключом,
# и бэкап в личке бота без ключа — просто байты. Восстановление:
#
#   age -d -i ~/.ssh/id_ed25519 rubezh-….dump.age > rubezh.dump
#   pg_restore --clean --if-exists -d <база> rubezh.dump
set -euo pipefail

APP="/srv/rubezh/app"
OUT="/srv/rubezh/backups"
KEEP_LOCAL=14
# Лимит документа у бота — 50 МБ; ближе к нему бэкап уходит только на диск.
TELEGRAM_MAX_BYTES=$((49 * 1024 * 1024))

cd "$APP"
value() { grep -E "^$2=" "$1" | tail -1 | cut -d= -f2-; }
POSTGRES_USER="$(value .env POSTGRES_USER)"
POSTGRES_DB="$(value .env POSTGRES_DB)"
TOKEN="$(value api.env TELEGRAM_BOT_TOKEN)"
# Bot API — тем же адресом, что у API: из российской сети api.telegram.org
# недоступен, и бот ходит через прокси (docs/20-env-and-ports.md §5.2).
API_ROOT="$(value api.env TELEGRAM_API_ROOT)"
API_ROOT="${API_ROOT:-https://api.telegram.org}"
OWNER_CHAT="$(value .env BACKUP_CHAT_ID)"
ADMIN_CHAT="$(value api.env ADMIN_CHAT_ID)"

# Токен — в конфигурации curl со стандартного ввода, а не в аргументах: так
# он не виден в списке процессов.
telegram() {
  local method="$1"
  shift
  printf 'url = "%s/bot%s/%s"\n' "${API_ROOT%/}" "$TOKEN" "$method" |
    curl -fsS --max-time 120 -K - "$@" > /dev/null
}

report() {
  [ -n "$ADMIN_CHAT" ] || return 0
  telegram sendMessage --data-urlencode "chat_id=${ADMIN_CHAT}" --data-urlencode "text=$1" || true
}

on_error() { report "❌ Бэкап базы не сделан: ${BASH_COMMAND}"; }
trap on_error ERR

stamp="$(date -u +%Y%m%dT%H%MZ)"
file="${OUT}/rubezh-${stamp}.dump.age"
mkdir -p "$OUT"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom |
  age -R "${APP}/backup-recipient.pub" > "${file}.part"
mv "${file}.part" "$file"

size="$(stat -c %s "$file")"
human="$(numfmt --to=iec "$size")"
if [ "$size" -le "$TELEGRAM_MAX_BYTES" ] && [ -n "$OWNER_CHAT" ]; then
  telegram sendDocument -F "chat_id=${OWNER_CHAT}" -F "document=@${file}" \
    -F "caption=Бэкап базы ${stamp}, ${human}. Расшифровка — своим SSH-ключом: age -d -i ~/.ssh/id_ed25519"
  report "✅ Бэкап базы ${stamp}: ${human}, отправлен владельцу"
else
  report "⚠️ Бэкап базы ${stamp}: ${human} — больше лимита бота, лежит только на сервере"
fi

# Локально — последние две недели.
ls -1t "${OUT}"/rubezh-*.dump.age | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f
