#!/usr/bin/env bash
# Бэкапы с восстановлением на момент времени (docs/35-stage4-plan.md, Р54;
# docs/20-env-and-ports.md §5.4; инструкция восстановления — там же).
#
# Postgres кладёт каждый сегмент журнала (WAL) в локальную очередь
# /wal-spool — архив никогда не ждёт сеть. Отсюда раз в минуту сегменты
# сжимаются, шифруются и уезжают в S3-хранилище (Bunny Storage). Раз в сутки —
# базовая копия, чистка старше срока хранения и зеркало репозитория. Базовая
# копия и журнал после неё — это восстановление на любой момент: потеря —
# минуты, а не сутки, как у ежедневного дампа.
#
# Шифруется всё двумя получателями: открытым SSH-ключом владельца — чтобы
# восстановиться, даже если сервер потерян, — и ключом пробного
# восстановления на сервере — чтобы восстановление проверялось, а не
# предполагалось. У хранилища нет ни одного незашифрованного байта.
#
# Команды: loop (по умолчанию), ship, base, prune, repo, health, status,
# fetch <каталог> [момент YYYYmmddTHHMMSSZ].
set -euo pipefail

SPOOL=/wal-spool
STATE=/state
KEEP_DAYS=14
# Базовая копия — в полночь UTC, это 03:00 по Москве: меньше всего игроков.
DAILY_HOUR_UTC=00
OWNER_KEY=/keys/owner.pub
DRILL_KEY=/keys/drill.key

# Проход — отдельным процессом: у функции, вызванной под `||`, bash
# выключает set -e целиком, и упавшая отправка удаляла бы сегмент из очереди.
SELF="$(readlink -f "$0")"
# Неудачный суточный проход повторяется не чаще раза в десять минут: иначе
# сломанная выгрузка гнала бы базу целиком каждую минуту.
DAILY_RETRY_SEC=600
# Базе, от которой доигрывается журнал, — не больше суток с запасом: иначе
# восстановление доигрывает всё дольше, а пропущенная ночь означает поломку.
BASE_MAX_AGE_SEC=$((26 * 3600))
# Сколько после старта контейнера ждать первую базу, прежде чем бить тревогу.
FIRST_BASE_GRACE_SEC=1800

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
stamp() { date -u +%Y%m%dT%H%M%SZ; }

# Хранилище: Bunny Storage по S3 (ключ доступа — имя зоны, секрет — пароль
# зоны) или любое другое, заданное BACKUP_REMOTE, — так скрипт проверяется
# локально на каталоге вместо хранилища.
if [ -z "${BACKUP_REMOTE:-}" ]; then
  : "${BACKUP_S3_ZONE:?нужна зона хранения BACKUP_S3_ZONE}"
  : "${BACKUP_S3_PASSWORD:?нужен пароль зоны BACKUP_S3_PASSWORD}"
  export RCLONE_CONFIG_BUNNY_TYPE=s3
  export RCLONE_CONFIG_BUNNY_PROVIDER=Other
  export RCLONE_CONFIG_BUNNY_ENDPOINT="https://${BACKUP_S3_REGION:-de}-s3.storage.bunnycdn.com"
  export RCLONE_CONFIG_BUNNY_ACCESS_KEY_ID="$BACKUP_S3_ZONE"
  export RCLONE_CONFIG_BUNNY_SECRET_ACCESS_KEY="$BACKUP_S3_PASSWORD"
  export RCLONE_CONFIG_BUNNY_FORCE_PATH_STYLE=true
  # Бакет — это зона, она уже есть; проверять и создавать её незачем.
  export RCLONE_CONFIG_BUNNY_NO_CHECK_BUCKET=true
  REMOTE="bunny:${BACKUP_S3_ZONE}"
else
  REMOTE="$BACKUP_REMOTE"
fi
# Без повторов с паузой одна сетевая осечка роняла бы проход.
RCLONE=(rclone --retries 5 --low-level-retries 10 --contimeout 30s --timeout 120s)

drill_recipient() { age-keygen -y "$DRILL_KEY"; }

encrypt() { zstd -q -c | age -R "$OWNER_KEY" -r "$(drill_recipient)"; }

decrypt() { age -d -i "$DRILL_KEY" | zstd -q -d -c; }

# Сегменты уходят по порядку имён — это порядок журнала. Отметка «отправлено»
# ставится, только когда очередь пуста: по ней проверка здоровья видит, что
# отправка идёт, а не только что процесс жив.
ship() {
  local file name
  for file in "$SPOOL"/*; do
    [ -f "$file" ] || continue
    name="$(basename "$file")"
    case "$name" in *.tmp) continue ;; esac
    encrypt < "$file" > "$STATE/ship.part" || return 1
    # Сегмент уходит из очереди, только когда он в хранилище.
    "${RCLONE[@]}" copyto "$STATE/ship.part" "$REMOTE/wal/${name}.zst.age" || return 1
    rm -f "$file"
  done
  rm -f "$STATE/ship.part"
  touch "$STATE/last-ship"
}

# Базовая копия без журнала (-X none): нужный ей журнал и так в архиве. Тар
# идёт потоком, на диск сервера копия не пишется — поэтому оборванная
# выгрузка остаётся в хранилище недописанным файлом. Готовой копию делает
# метка <момент>.ok рядом: восстановление и чистка смотрят только на копии
# с меткой, а без метки файл — мусор, который уберёт чистка.
base() {
  local when
  when="$(stamp)"
  if ! PGPASSWORD="${BACKUP_PG_PASSWORD:?нужен пароль роли backup}" \
    pg_basebackup -h postgres -U backup -D - -Ft -X none --checkpoint=fast |
    encrypt | "${RCLONE[@]}" rcat "$REMOTE/base/${when}.tar.zst.age"; then
    "${RCLONE[@]}" deletefile "$REMOTE/base/${when}.tar.zst.age" 2> /dev/null || true
    log "базовая копия ${when} не снята"
    return 1
  fi
  printf '%s\n' "$when" | "${RCLONE[@]}" rcat "$REMOTE/base/${when}.ok" || return 1
  echo "$when" > "$STATE/last-base"
  log "базовая копия ${when}"
}

# Моменты готовых базовых копий — по меткам, по порядку.
bases() { "${RCLONE[@]}" lsf "$REMOTE/base/" | sed -n 's/\.ok$//p' | sort; }

# Хранилище без правил жизненного цикла и пакетного удаления (Bunny S3), поэтому
# старое удаляется по одному. Две последние базовые копии остаются всегда,
# сколько бы им ни было дней: без базы журнал бесполезен.
prune() {
  local cutoff yesterday when file listing
  cutoff="$(date -u -d "-${KEEP_DAYS} days" +%Y%m%dT%H%M%SZ)"
  yesterday="$(date -u -d "-1 day" +%Y%m%dT%H%M%SZ)"
  # Один список на весь проход: осечка второго листинга при удачном первом
  # записала бы все копии в недописанные.
  listing="$("${RCLONE[@]}" lsf "$REMOTE/base/")" || return 1
  mapfile -t done_bases < <(printf '%s\n' "$listing" | sed -n 's/\.ok$//p' | sort)
  local count="${#done_bases[@]}"
  for ((i = 0; i < count - 2; i++)); do
    when="${done_bases[$i]}"
    # Сначала метка: копия без метки уже не выбирается, даже если сам
    # файл удалить не успели.
    if [[ "$when" < "$cutoff" ]]; then
      "${RCLONE[@]}" deletefile "$REMOTE/base/${when}.ok"
      "${RCLONE[@]}" deletefile "$REMOTE/base/${when}.tar.zst.age"
    fi
  done
  # Недописанные копии — старше суток: свежая может ещё выгружаться.
  for file in $(printf '%s\n' "$listing" | grep '\.tar\.zst\.age$'); do
    when="${file%%.*}"
    if [[ "$when" < "$yesterday" ]] && ! printf '%s\n' "${done_bases[@]}" | grep -qx "$when"; then
      "${RCLONE[@]}" deletefile "$REMOTE/base/${file}"
    fi
  done
  # Журнал живёт на день дольше базы: самой старой оставшейся базе нужен свой.
  "${RCLONE[@]}" delete --min-age "$((KEEP_DAYS + 1))d" "$REMOTE/wal/"
  "${RCLONE[@]}" delete --min-age "${KEEP_DAYS}d" "$REMOTE/repo/"
}

# Зеркало репозитория — на случай, если площадка кода недоступна или
# репозиторий потерян: все ветки и теги одним пакетом git bundle.
repo() {
  [ -n "${BACKUP_REPO_URL:-}" ] || return 0
  local work status=0
  work="$(mktemp -d)"
  {
    git clone --quiet --mirror "$BACKUP_REPO_URL" "$work/repo.git" &&
      git -C "$work/repo.git" bundle create --quiet "$work/repo.bundle" --all &&
      encrypt < "$work/repo.bundle" > "$work/repo.bundle.age" &&
      "${RCLONE[@]}" copyto "$work/repo.bundle.age" "$REMOTE/repo/$(stamp).bundle.zst.age"
  } || status=1
  rm -rf "$work"
  [ "$status" = 0 ] || return 1
  log "зеркало репозитория"
}

# Сутки засчитаны, когда в хранилище база: чистка и зеркало, не
# прошедшие сегодня, пройдут завтра и базу не повторяют.
daily() {
  touch "$STATE/daily-attempt"
  base
  date -u +%F > "$STATE/last-daily"
  "$SELF" prune || log "чистка хранилища не прошла"
  "$SELF" repo || log "зеркало репозитория не снято"
}

age_of() { echo $(($(date +%s) - $(stat -c %Y "$1"))); }

# Пора ли суточному проходу: без базовой копии журнал ничего не
# восстанавливает — первая снимается сразу, дальше раз в сутки в свой час.
# База старше суток — тоже сразу, не дожидаясь часа: контейнер мог стоять
# ночью, когда была её очередь.
daily_due() {
  if [ -f "$STATE/daily-attempt" ] && [ "$(age_of "$STATE/daily-attempt")" -lt "$DAILY_RETRY_SEC" ]; then
    return 1
  fi
  [ ! -s "$STATE/last-base" ] && return 0
  [ "$(age_of "$STATE/last-base")" -ge $((25 * 3600)) ] && return 0
  [ "$(date -u +%H)" = "$DAILY_HOUR_UTC" ] && [ "$(cat "$STATE/last-daily" 2> /dev/null)" != "$(date -u +%F)" ]
}

loop() {
  # Postgres пишет в очередь от своего пользователя (uid 70 в Alpine), а
  # свежий том принадлежит root: без этого архив журнала не пишется.
  chown 70:70 "$SPOOL"
  chmod 700 "$SPOOL"
  touch "$STATE/started"
  while true; do
    "$SELF" ship || log "отправка журнала не прошла — повтор через минуту"
    if daily_due; then
      "$SELF" daily || log "суточный проход не прошёл — повтор через $((DAILY_RETRY_SEC / 60)) минут"
    fi
    sleep 60
  done
}

# Здоров — отправка журнала шла последние 15 минут, очередь не копится и
# есть свежая база: журнал без базы восстановить не от чего.
health() {
  [ -f "$STATE/last-ship" ] || exit 1
  local pending
  pending="$(find "$SPOOL" -maxdepth 1 -type f ! -name '*.tmp' | wc -l)"
  [ "$(age_of "$STATE/last-ship")" -lt 900 ] && [ "$pending" -lt 60 ] || exit 1
  if [ -s "$STATE/last-base" ]; then
    [ "$(age_of "$STATE/last-base")" -lt "$BASE_MAX_AGE_SEC" ]
  else
    [ -f "$STATE/started" ] && [ "$(age_of "$STATE/started")" -lt "$FIRST_BASE_GRACE_SEC" ]
  fi
}

status() {
  local last_ship="—" base="—"
  [ -f "$STATE/last-ship" ] && last_ship="$(age_of "$STATE/last-ship") с назад"
  [ -s "$STATE/last-base" ] && base="$(cat "$STATE/last-base"), $(($(age_of "$STATE/last-base") / 3600)) ч назад"
  printf 'база: %s\nжурнал отправлен: %s\nв очереди: %s\n' "$base" "$last_ship" \
    "$(find "$SPOOL" -maxdepth 1 -type f ! -name '*.tmp' | wc -l)"
}

# Достать базовую копию не позже момента и весь журнал после неё — в каталог
# для восстановления: <каталог>/pgdata и <каталог>/wal. Ключ — пробного
# восстановления; владелец делает то же своим SSH-ключом (docs/20-env-and-ports.md §5.4).
fetch() {
  local target_dir="${1:?каталог}" until="${2:-99999999T999999Z}" chosen=""
  for when in $(bases); do [[ "$when" > "$until" ]] || chosen="$when"; done
  [ -n "$chosen" ] || { log "нет базовой копии раньше ${until}"; exit 1; }
  mkdir -p "$target_dir/pgdata" "$target_dir/wal"
  "${RCLONE[@]}" cat "$REMOTE/base/${chosen}.tar.zst.age" | decrypt | tar -x -C "$target_dir/pgdata"
  # Журнал нужен с сегмента, с которого начата копия: он записан в её
  # backup_label. Всё раньше — две недели журнала, которые не понадобятся.
  local first
  first="$(sed -nE 's/^START WAL LOCATION: .*\(file ([0-9A-F]{24})\)$/\1/p' "$target_dir/pgdata/backup_label")"
  for file in $("${RCLONE[@]}" lsf "$REMOTE/wal/" | sort); do
    local segment="${file%.zst.age}"
    # Файлы истории линий времени нужны всегда, сегменты — только новее копии.
    [[ "$segment" == *.history || ! "$segment" < "$first" ]] || continue
    "${RCLONE[@]}" cat "$REMOTE/wal/${file}" | decrypt > "$target_dir/wal/${segment}"
  done
  chown -R 70:70 "$target_dir"
  chmod 700 "$target_dir/pgdata"
  log "восстановление из ${chosen} в ${target_dir}"
}

case "${1:-loop}" in
  loop) loop ;;
  ship) ship ;;
  base) base ;;
  prune) prune ;;
  repo) repo ;;
  daily) daily ;;
  health) health ;;
  status) status ;;
  fetch) shift; fetch "$@" ;;
  *) echo "команды: loop ship base prune repo daily health status fetch" >&2; exit 2 ;;
esac
