#!/usr/bin/env bash
# Ставит одобренный PR в очередь поезда мерджей: дописывает номер строкой в
# .lead/train-queue.txt основного клона, откуда бы ни был запущен скрипт
# (рабочая копия агента, поезд). Повторная постановка после провала — тот же
# вызов: поезд повезёт PR ещё раз.
# Использование: bash scripts/lead/enqueue.sh <номер PR>
set -u
n="${1:-}"
[[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "Использование: enqueue.sh <номер PR>" >&2; exit 2; }
# shellcheck source=paths.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/paths.sh" || exit 1
echo "$n" >> "$LEAD_DIR/train-queue.txt"
echo "в очереди поезда: #$n"
