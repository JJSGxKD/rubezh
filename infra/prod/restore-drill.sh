#!/usr/bin/env bash
# Пробное восстановление (docs/35-stage4-plan.md, Р54; инструкция — docs/20-env-and-ports.md §5.4).
# Раз в месяц руками — или когда нужно достать данные на момент:
#
#   ./restore-drill.sh                      # на последний отправленный сегмент
#   ./restore-drill.sh 20260929T031500Z     # на момент, UTC
#
# Базовая копия и журнал скачиваются из хранилища и расшифровываются ключом
# пробного восстановления, Postgres того же образа, что прод, поднимает их в
# отдельном контейнере без сети и доигрывает журнал. Итог — число строк
# ключевых таблиц против прода, в консоль и в чат администраторов. Прод не
# трогается: у копии свой том, и он удаляется в конце.
#
# Бэкап, который ни разу не восстанавливали, — надежда, а не бэкап.
set -euo pipefail

APP="/srv/rubezh/app"
TARGET="${1:-}"
DRILL="rubezh-restore-drill"
TABLES=(account wallet_entry run item)
cd "$APP"

value() { { grep -E "^$2=" "$1" || true; } | tail -1 | cut -d= -f2- | sed -E "s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/"; }
POSTGRES_USER="$(value .env POSTGRES_USER)"
POSTGRES_DB="$(value .env POSTGRES_DB)"
TOKEN="$(value api.env TELEGRAM_BOT_TOKEN)"
API_ROOT="$(value api.env TELEGRAM_API_ROOT)"
API_ROOT="${API_ROOT:-https://api.telegram.org}"
ADMIN_CHAT="$(value api.env ADMIN_CHAT_ID)"
log() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }
report() {
  [ -n "$ADMIN_CHAT" ] && [ -n "$TOKEN" ] || return 0
  printf 'url = "%s/bot%s/sendMessage"\n' "${API_ROOT%/}" "$TOKEN" |
    curl -fsS --max-time 60 -K - --data-urlencode "chat_id=${ADMIN_CHAT}" --data-urlencode "text=$1" > /dev/null || true
}

cleanup() {
  docker rm -f "${DRILL}-pg" > /dev/null 2>&1 || true
  docker volume rm -f "$DRILL" > /dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'report "❌ Пробное восстановление не прошло: ${BASH_COMMAND}"' ERR
cleanup
docker volume create "$DRILL" > /dev/null

log "скачиваю базовую копию и журнал${TARGET:+ до ${TARGET}}"
docker compose --profile backup run --rm --no-deps -T -v "${DRILL}:/restore" backup fetch /restore ${TARGET:+"$TARGET"} < /dev/null

# Доиграть журнал из скачанного и открыть базу: без цели — до конца журнала.
recovery="restore_command = 'cp /restore/wal/%f %p'\nrecovery_target_action = 'promote'\n"
if [ -n "$TARGET" ]; then
  moment="${TARGET:0:4}-${TARGET:4:2}-${TARGET:6:2} ${TARGET:9:2}:${TARGET:11:2}:${TARGET:13:2}+00"
  recovery+="recovery_target_time = '${moment}'\n"
fi
# Настройка — аргументом и через %b: в ней %f и %p Postgres, и printf не
# должен принять их за свои шаблоны.
docker compose --profile backup run --rm --no-deps -T -v "${DRILL}:/restore" --entrypoint bash backup \
  -c 'printf "%b" "$1" >> /restore/pgdata/postgresql.auto.conf && touch /restore/pgdata/recovery.signal && chown 70:70 /restore/pgdata/postgresql.auto.conf /restore/pgdata/recovery.signal' \
  _ "$recovery" < /dev/null

image="$(docker inspect --format '{{.Config.Image}}' rubezh-postgres-1)"
docker run -d --name "${DRILL}-pg" --network none -v "${DRILL}:/restore" -e PGDATA=/restore/pgdata \
  "$image" postgres -c archive_mode=off -c shared_buffers=128MB > /dev/null

log "доигрываю журнал"
for _ in $(seq 1 180); do
  if docker exec "${DRILL}-pg" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select pg_is_in_recovery()" 2> /dev/null | grep -qx f; then
    break
  fi
  sleep 5
done
docker exec "${DRILL}-pg" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select pg_is_in_recovery()" | grep -qx f

lines=()
for table in "${TABLES[@]}"; do
  restored="$(docker exec "${DRILL}-pg" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from ${table}")"
  live="$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from ${table}" < /dev/null)"
  lines+=("${table}: ${restored} из ${live}")
done
summary="$(printf '%s; ' "${lines[@]}")"
summary="${summary%; }"
log "восстановлено: ${summary}"
trap - ERR
report "✅ Пробное восстановление${TARGET:+ на ${TARGET}} прошло: ${summary}"
