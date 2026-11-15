#!/usr/bin/env bash
# Ждёт новую работу для линии конвейера до ~9 минут (укладывается в таймаут Bash):
# новый PR «на ревью» (не черновик) или новую строку .lead/train-failed.txt.
# Печатает «есть работа» или «пусто».
set -u
# shellcheck source=paths.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/paths.sh" || exit 1
cd "$LEAD_ROOT" || exit 1
sig() {
  echo "$(gh pr list --base dev --state open --limit 80 --json number,isDraft,labels --jq '[.[] | select(.isDraft | not) | select(any(.labels[]; .name == "на ревью")) | .number] | sort | join(",")' 2>/dev/null) $(wc -l < "$LEAD_DIR/train-failed.txt" 2>/dev/null)"
}
start=$(sig)
for _ in $(seq 1 17); do
  sleep 30
  [ "$(sig)" != "$start" ] && { echo "есть работа"; exit 0; }
done
echo "пусто"
