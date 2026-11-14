#!/usr/bin/env bash
# Ждёт итогов gate и check у PR до ~9 минут (укладывается в таймаут Bash).
# Использование: bash scripts/lead/wait-checks.sh <номер PR>
# Печатает одну строку: green | red <имена> | pending <состояние>.
# Код выхода: 0 — green, 1 — red, 2 — ещё идут (повторить вызов).
n="${1:?номер PR}"
for _ in $(seq 1 17); do
  s=$(gh pr checks "$n" --json name,state --jq '[.[] | select(.name=="gate" or .name=="check") | "\(.name)=\(.state)"] | sort | join(",")' 2>/dev/null)
  case "$s" in
    *FAILURE*|*CANCELLED*|*ERROR*|*TIMED_OUT*) echo "red $s"; exit 1 ;;
    "check=SUCCESS,gate=SUCCESS") echo "green"; exit 0 ;;
  esac
  sleep 30
done
echo "pending $s"
exit 2
