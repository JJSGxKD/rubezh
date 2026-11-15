#!/usr/bin/env bash
# Вливание PR по одному (T-0477, Р224) — запасной путь рядом с поездом: только
# при зелёных gate и check, свежем dev в ветке и без конфликтов. Конфликт только
# в tasks/epics.md (и в файле своей задачи, который ветка перенесла в архив)
# решается пересборкой и повторным ожиданием CI; любой другой конфликт или
# красная проверка останавливают очередь.
#
# Использование: bash scripts/lead/merge-one.sh [--worktree КАТАЛОГ] N [N...]
# Рабочая копия по умолчанию — рабочая копия поезда ($TRAIN_WT, paths.sh):
# в ней вливаются свежие dev в ветки, поэтому она не должна быть занята.
# REFRESH_FIRST=N — PR N сначала освежить (влить dev), не дожидаясь красного.
set -u
# shellcheck source=paths.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/paths.sh" || exit 1
WT="$TRAIN_WT"
if [ "${1:-}" = "--worktree" ]; then WT="${2:?каталог рабочей копии}"; shift 2; fi
[ "$#" -ge 1 ] || { echo "Использование: merge-one.sh [--worktree КАТАЛОГ] N [N...]" >&2; exit 2; }
if [ ! -d "$WT" ]; then
  git -C "$LEAD_ROOT" worktree add -q --detach "$WT" origin/dev || { echo "не создать рабочую копию $WT" >&2; exit 1; }
fi
cd "$WT" || exit 1

checks() { gh pr checks "$1" --json name,state --jq '[.[] | select(.name=="gate" or .name=="check") | "\(.name)=\(.state)"] | sort | join(",")' 2>/dev/null; }

wait_green() {
  local n=$1 s
  for _ in $(seq 1 60); do
    s=$(checks "$n")
    case "$s" in
      *PENDING*|*IN_PROGRESS*|*QUEUED*|"") sleep 30 ;;
      "check=SUCCESS,gate=SUCCESS") return 0 ;;
      *) echo "#$n: проверки не зелёные — $s"; return 1 ;;
    esac
  done
  echo "#$n: не дождался проверок"; return 1
}

resolve() {
  local n=$1 branch
  branch=$(gh pr view "$n" --json headRefName --jq .headRefName)
  git fetch -q origin
  git checkout -q -B "$branch" "origin/$branch" || return 1
  if git merge --no-edit -q origin/dev -m "chore: Влить dev в $branch" >/dev/null 2>&1; then
    git push -q origin "$branch"; return 0
  fi
  local bad=""
  for f in $(git diff --name-only --diff-filter=U); do
    if [ "$f" = "tasks/epics.md" ]; then git checkout -q --theirs tasks/epics.md
    elif [[ "$f" == tasks/T-*.md ]] && [ -n "$(git ls-files "tasks/archive/$(basename "$f")")" ]; then git rm -q "$f"
    elif [[ "$f" == tasks/T-*.md || "$f" == tasks/archive/T-*.md ]] && [[ "$(basename "$f")" != "${branch#task/}"-* ]]; then
      # чужая задача: в ней правятся только ссылки — берём dev, ссылки вернёт pnpm task fix
      git checkout -q --theirs "$f"
    else bad="$bad $f"; fi
  done
  if [ -n "$bad" ]; then echo "#$n: конфликт для тимлида:$bad"; git merge --abort; return 1; fi
  node scripts/tasks/task.mjs fix >/dev/null 2>&1
  git add -A tasks && git commit -q --no-edit || return 1
  # PR задачи меняет в tasks/ только свой файл: выход за зоны — повод для
  # тимлида, а не для shared.
  local out
  out=$(GITHUB_HEAD_REF="$branch" node scripts/tasks/task.mjs diff-check --base origin/dev 2>&1)
  if echo "$out" | grep -q "меняет файлы вне её зон"; then
    echo "#$n: вне зон после влития dev:"; echo "$out" | grep -E "^  " ; return 1
  fi
  git push -q origin "$branch" && echo "#$n: dev влит"
}

for n in "$@"; do
  for round in 1 2 3 4 5; do
    if ! wait_green "$n"; then
      [ "$round" = "1" ] && [ "${REFRESH_FIRST:-}" = "$n" ] && { resolve "$n" || exit 1; sleep 40; continue; }
      exit 1
    fi
    sleep 5
    # Задел (Р178) вливается только после своих зависимостей — его доводит поток.
    if gh pr view "$n" --json labels --jq 'any(.labels[]; .name == "задел")' | grep -qx true; then
      echo "#$n: задел — сначала зависимости и доводка"; exit 1
    fi
    # Зелёный CI на старом dev ничего не говорит о новом: два PR, зелёные
    # порознь, вместе ломали typecheck (#552 + #554). Ветка обязана содержать
    # свежий dev, иначе влить его и ждать CI заново.
    head=$(gh pr view "$n" --json headRefOid --jq .headRefOid)
    git fetch -q origin
    if ! git merge-base --is-ancestor origin/dev "$head" 2>/dev/null; then
      resolve "$n" || exit 1
      sleep 40
      continue
    fi
    m=$(gh pr view "$n" --json mergeable --jq .mergeable)
    if [ "$m" = "UNKNOWN" ]; then sleep 15; m=$(gh pr view "$n" --json mergeable --jq .mergeable); fi
    if [ "$m" = "MERGEABLE" ]; then
      gh pr merge "$n" --merge --match-head-commit "$head" >/dev/null 2>&1 && echo "#$n: влит" && break
      echo "#$n: мердж не прошёл"; exit 1
    fi
    resolve "$n" || exit 1
    sleep 40
  done
done
echo "очередь пройдена"
