#!/usr/bin/env bash
# Бэкап базы (docs/20-env-and-ports.md §5.4). Без аргументов — ежедневный:
# ставится в crontab пользователя деплоя скриптом deploy.sh.
#
#   ./backup.sh                          # ночной: владельцу в бота, отчёт в чат
#   ./backup.sh --before-deploy <версия> # перед выкатом: только на диск сервера
#
# Дамп перед выкатом зовёт deploy.sh до миграций (docs/09-ci-cd.md §10). Об
# ошибке он говорит кодом выхода, а не отчётом в чат: выкат сам остановится
# и напишет, почему.
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
# Дампы перед выкатом хранятся отдельно от ночных: иначе серия выкатов
# вытеснила бы ночные, а ночные — дамп, сделанный перед последним выкатом.
KEEP_PRE_DEPLOY=3
# Лимит документа у бота — 50 МБ; ближе к нему бэкап уходит только на диск.
TELEGRAM_MAX_BYTES=$((49 * 1024 * 1024))

mode=nightly
release=""
case "${1:-}" in
  "") ;;
  --before-deploy)
    mode=before-deploy
    release="${2:-}"
    # Версия попадает в имя файла: только то, что в нём безопасно.
    if [ "$#" -ne 2 ] || ! [[ "$release" =~ ^[0-9A-Za-z.+-]+$ ]]; then
      echo "backup.sh --before-deploy <версия>: версия обязательна, допустимы символы [0-9A-Za-z.+-]" >&2
      exit 2
    fi
    ;;
  *)
    echo "backup.sh: неизвестный аргумент «$1». Использование: backup.sh [--before-deploy <версия>]" >&2
    exit 2
    ;;
esac

cd "$APP"
# Значение без кавычек: compose снимает их сам, а здесь строка идёт в URL.
value() { { grep -E "^$2=" "$1" || true; } | tail -1 | cut -d= -f2- | sed -E "s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/"; }
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

# Бэкап на момент (docs/35-stage4-plan.md, Р54) — строкой в каждом отчёте:
# раз в сутки в чате видно, что журнал уезжает, а не только что сторож молчит.
pitr_line() {
  [ -n "$(value .env BACKUP_S3_ZONE)" ] || { echo "На момент: выключен — хранилище не задано"; return 0; }
  local status
  status="$(docker compose exec -T backup backupctl status < /dev/null 2> /dev/null)" ||
    { echo "На момент: контейнер бэкапа не отвечает"; return 0; }
  echo "На момент: ${status//$'\n'/; }"
}

report() {
  [ -n "$ADMIN_CHAT" ] || return 0
  telegram sendMessage --data-urlencode "chat_id=${ADMIN_CHAT}" --data-urlencode "text=$1"$'\n'"$(pitr_line)" || true
}

on_error() { report "❌ Бэкап базы не сделан: ${BASH_COMMAND}"; }
if [ "$mode" = nightly ]; then trap on_error ERR; fi

stamp="$(date -u +%Y%m%dT%H%MZ)"
if [ "$mode" = before-deploy ]; then
  file="${OUT}/rubezh-pre-${stamp}-${release}.dump.age"
  # Оборванный дамп не остаётся на диске недописанным куском.
  trap 'rm -f "${file}.part"' EXIT
else
  file="${OUT}/rubezh-${stamp}.dump.age"
fi
mkdir -p "$OUT"
# Стандартный ввод закрыт: иначе `exec` съел бы то, что идёт за скриптом, —
# вызов из heredoc по SSH молча обрывался бы на этой строке.
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom < /dev/null |
  age -R "${APP}/backup-recipient.pub" > "${file}.part"
mv "${file}.part" "$file"

size="$(stat -c %s "$file")"
human="$(numfmt --to=iec "$size")"

if [ "$mode" = before-deploy ]; then
  # Пустой файл — не дамп: выкат не должен считать его страховкой.
  if [ ! -s "$file" ]; then
    rm -f "$file"
    echo "дамп перед выкатом пуст" >&2
    exit 1
  fi
  # Только на диск сервера: ночной дамп владельцу уходит и так.
  ls -1t "${OUT}"/rubezh-pre-*.dump.age | tail -n +$((KEEP_PRE_DEPLOY + 1)) | xargs -r rm -f
  echo "бэкап перед выкатом: ${file}, ${human}"
  exit 0
fi

if [ "$size" -le "$TELEGRAM_MAX_BYTES" ] && [ -n "$OWNER_CHAT" ]; then
  # Неотправленный бэкап — не успех: об этом говорят и отчёт, и код выхода.
  if ! telegram sendDocument -F "chat_id=${OWNER_CHAT}" -F "document=@${file}" \
    -F "caption=Бэкап базы ${stamp}, ${human}. Расшифровка — своим SSH-ключом: age -d -i ~/.ssh/id_ed25519"; then
    trap - ERR
    report "⚠️ Бэкап базы ${stamp}: ${human} — владельцу не отправлен, лежит на сервере"
    exit 1
  fi
  report "✅ Бэкап базы ${stamp}: ${human}, отправлен владельцу"
else
  report "⚠️ Бэкап базы ${stamp}: ${human} — больше лимита бота, лежит только на сервере"
fi

# Локально — последние две недели. Шаблон со штампом, начинающимся с года:
# дампы перед выкатом (rubezh-pre-…) ротируются отдельно.
ls -1t "${OUT}"/rubezh-2*.dump.age | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f
