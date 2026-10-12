#!/usr/bin/env bash
# Адреса узлов CDN Bunny — доверенные прокси Caddy (docs/20-env-and-ports.md
# §2.2). Узлам верим заголовок X-Forwarded-For с адресом игрока, всем
# остальным — нет. Запускается из deploy.sh и раз в сутки по cron:
#
#   ./edge-ips.sh
#
# Список у Bunny меняется: узел, которого нет в файле, Caddy считает
# клиентом, и игроки за ним делят лимит частоты на узел. Поэтому обновление
# ежедневное, а сбой загрузки оставляет прежний файл — устаревший список
# лучше пустого.
set -euo pipefail

APP="${APP:-/srv/rubezh/app}"
OUT="$APP/edge/trusted-proxies.caddy"
# Меньше — значит, Bunny ответил не тем: обрезанный список закрыл бы адрес
# игрока у половины узлов. Сейчас адресов около девятисот.
MIN_ADDRESSES=300

log() { printf '[edge-ips %s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

fetch() {
  curl -fsS --retry 3 --max-time 30 -H "Accept: application/json" "$1" |
    tr -d '[]" \r\n' | tr ',' '\n' |
    grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F:]+:[0-9a-fA-F:]*$' || true
}

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.list"' EXIT
{ fetch https://bunnycdn.com/api/system/edgeserverlist; fetch https://bunnycdn.com/api/system/edgeserverlist/ipv6; } | sort -u > "$tmp.list"
count="$(wc -l < "$tmp.list")"
if [ "$count" -lt "$MIN_ADDRESSES" ]; then
  log "Bunny отдал ${count} адресов, ждали не меньше ${MIN_ADDRESSES} — оставляю прежний список"
  exit 1
fi

{
  echo "# Узлы CDN Bunny — пишет edge-ips.sh, руками не править."
  printf 'trusted_proxies static %s\n' "$(tr '\n' ' ' < "$tmp.list" | sed 's/ $//')"
} > "$tmp"

mkdir -p "$APP/edge"
if [ -f "$OUT" ] && cmp -s "$tmp" "$OUT"; then
  log "список не изменился: ${count} адресов"
  exit 0
fi
install -m 644 "$tmp" "$OUT"
log "список обновлён: ${count} адресов"

# Caddy подхватывает список только при перечитывании. Во время выката
# deploy.sh перечитает конфигурацию сам.
if [ "${EDGE_IPS_NO_RELOAD:-}" != "1" ]; then
  cd "$APP"
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile < /dev/null
  log "Caddy перечитал конфигурацию"
fi
