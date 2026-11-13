#!/bin/sh
# Запускает Xray и перезапускает его, когда бэкенд записал новый конфиг.
# Новый конфиг сначала проверяется `xray run -test`: битый не роняет
# работающие узлы, Xray остаётся на прежнем (docs/20-env-and-ports.md).
# Версию ядра пишет в файл статуса (Р202, docs/20-env-and-ports.md).
CONFIG="${XRAY_CONFIG:-/etc/xray/config.json}"
hash_of() { sha256sum "$CONFIG" 2>/dev/null | cut -d' ' -f1; }
# Версия и время запуска ядра — файл в томе xray-status для панели (Р202); сбой записи Xray не роняет.
STATUS="${XRAY_STATUS:-/xray-status/core}"
write_status() {
  ver="$(xray version 2>/dev/null | head -n 1 | sed -n 's/^Xray \([0-9][0-9.]*\).*/\1/p')"
  { printf 'version=%s\n' "$ver"; printf 'started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; } > "$STATUS.$$.tmp" 2>/dev/null \
    && mv -f "$STATUS.$$.tmp" "$STATUS" 2>/dev/null \
    || echo "xray: статус ядра не записан"
  return 0
}

while [ ! -s "$CONFIG" ]; do echo "xray: жду конфиг"; sleep 5; done
current="$(hash_of)"; rejected=""
write_status; xray run -c "$CONFIG" & pid=$!
# Сигнал останавливает и Xray; `sleep` идёт в фоне, чтобы сигнал не ждал его конца.
trap 'kill "$pid" 2>/dev/null; exit 0' TERM INT

while kill -0 "$pid" 2>/dev/null; do
  sleep 5 & wait $!
  latest="$(hash_of)"
  if [ -n "$latest" ] && [ "$latest" != "$current" ] && [ "$latest" != "$rejected" ]; then
    if xray run -test -c "$CONFIG" >/dev/null 2>&1; then
      echo "xray: конфиг сменился, перезапуск"
      kill "$pid"; wait "$pid" 2>/dev/null
      current="$latest"; write_status; xray run -c "$CONFIG" & pid=$!
    else
      echo "xray: новый конфиг не принят, остаюсь на прежнем"; rejected="$latest"
    fi
  fi
done
exit 1
