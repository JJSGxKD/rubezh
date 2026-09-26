#!/usr/bin/env bash
# Разовая настройка прода после bootstrap.sh (docs/20-env-and-ports.md §5.2).
# Запускается пользователем деплоя в каталоге с файлами infra/prod:
#
#   ./provision.sh <файл с токеном бота и ID администраторов> <файл с ключом Bunny> <открытый ключ владельца>
#
# Секреты, которые можно сгенерировать, генерируются здесь же, на сервере:
# пароль базы, JWT, секрет вебхука, ключ псевдонимов, токен туннелей. Токен
# бота и ID приходят от владельца файлом. Уже заданные значения повторный
# запуск не трогает — иначе новый пароль базы разошёлся бы с томом, где
# лежит старый.
set -euo pipefail

OWNER_ENV="${1:?файл с TELEGRAM_BOT_TOKEN и ADMIN_*}"
BUNNY_KEY_FILE="${2:?файл с ключом API Bunny}"
OWNER_PUBKEY="${3:?открытый SSH-ключ владельца — им шифруются бэкапы}"
APP="/srv/rubezh/app"
WEB="/srv/rubezh/web"

cd "$APP"
umask 077

secret() { openssl rand -hex "$1"; }
value() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2-; }
# Записать, только если пусто: заданное не переписывается.
ensure() {
  local file="$1" key="$2" val="$3"
  touch "$file"
  if [ -n "$(value "$file" "$key")" ]; then return 0; fi
  if grep -qE "^${key}=" "$file"; then sed -i "s|^${key}=.*|${key}=${val}|" "$file"; else printf '%s=%s\n' "$key" "$val" >> "$file"; fi
}

[ -f .env ] || cp env.example .env
[ -f api.env ] || cp api.env.example api.env
chmod 600 .env api.env

ensure .env BUNNY_API_KEY "$(tr -d '[:space:]' < "$BUNNY_KEY_FILE")"
ensure .env POSTGRES_PASSWORD "$(secret 24)"
ensure .env FRP_TOKEN "$(secret 24)"

password="$(value .env POSTGRES_PASSWORD)"
user="$(value .env POSTGRES_USER)"
db="$(value .env POSTGRES_DB)"
# Строка подключения собирается из .env, а не копируется руками: пароль
# живёт в одном месте.
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://${user}:${password}@postgres:5432/${db}?schema=public|" api.env

ensure api.env JWT_ACCESS_SECRET "$(secret 32)"
ensure api.env TELEGRAM_WEBHOOK_SECRET "$(secret 24)"
ensure api.env EXPORT_PSEUDONYM_KEY "$(secret 32)"
for key in TELEGRAM_BOT_TOKEN ADMIN_TELEGRAM_IDS ADMIN_CHAT_ID ADMIN_CHAT_STATS ADMIN_CHAT_STRESS ADMIN_CHAT_RUNS ADMIN_CHAT_FEEDBACK ADMIN_CHAT_RUN_REVIEW; do
  val="$(value "$OWNER_ENV" "$key")"
  [ -n "$val" ] && ensure api.env "$key" "$val"
done
# Бэкап — владельцу: первый из администраторов.
ensure .env BACKUP_CHAT_ID "$(value api.env ADMIN_TELEGRAM_IDS | cut -d, -f1)"

cp "$OWNER_PUBKEY" backup-recipient.pub
chmod 644 backup-recipient.pub
chmod +x deploy.sh backup.sh provision.sh

# Заглушка лендинга, пока нет настоящего (docs/36-parallel-work.md, О7).
if [ ! -e "$WEB/landing/current" ]; then
  mkdir -p "$WEB/landing/placeholder"
  cp landing-placeholder.html "$WEB/landing/placeholder/index.html"
  ln -sfn placeholder "$WEB/landing/current"
fi

echo "готово: .env и api.env заполнены, секретов в выводе нет"
