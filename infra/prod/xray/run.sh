#!/bin/sh
# Запускает Xray и перезапускает его, когда бэкенд записал новый конфиг.
# Новый конфиг сначала проверяется `xray run -test`: битый не роняет
# работающие узлы, Xray остаётся на прежнем (docs/20-env-and-ports.md).
CONFIG="${XRAY_CONFIG:-/etc/xray/config.json}"
hash_of() { sha256sum "$CONFIG" 2>/dev/null | cut -d' ' -f1; }

while [ ! -s "$CONFIG" ]; do echo "xray: жду конфиг"; sleep 5; done
current="$(hash_of)"; rejected=""
xray run -c "$CONFIG" & pid=$!
# Сигнал останавливает и Xray; `sleep` идёт в фоне, чтобы сигнал не ждал его конца.
trap 'kill "$pid" 2>/dev/null; exit 0' TERM INT

while kill -0 "$pid" 2>/dev/null; do
  sleep 5 & wait $!
  latest="$(hash_of)"
  if [ -n "$latest" ] && [ "$latest" != "$current" ] && [ "$latest" != "$rejected" ]; then
    if xray run -test -c "$CONFIG" >/dev/null 2>&1; then
      echo "xray: конфиг сменился, перезапуск"
      kill "$pid"; wait "$pid" 2>/dev/null
      current="$latest"; xray run -c "$CONFIG" & pid=$!
    else
      echo "xray: новый конфиг не принят, остаюсь на прежнем"; rejected="$latest"
    fi
  fi
done
exit 1
