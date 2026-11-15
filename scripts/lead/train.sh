#!/usr/bin/env bash
# Поезд мерджей тимлида: одобренные PR вливаются пачками (T-0477, Р224).
#
# Запуск: `bash scripts/lead/train.sh` — фоном, из любой рабочей копии
# репозитория; состояние лежит в `.lead/` основного клона (см. paths.sh).
# MAX_BATCH — размер пачки (по умолчанию 6), TRAIN_WT — рабочая копия поезда.
#
# Линии ревью дописывают номер одобренного PR строкой в .lead/train-queue.txt
# (scripts/lead/enqueue.sh). Поезд берёт до MAX_BATCH ждущих PR со своим
# зелёным CI, собирает их по очереди поверх свежего origin/dev во временную
# ветку queue/train-*, открывает на неё служебный PR-черновик и ждёт gate —
# одну проверку на всю пачку. Зелёный и dev не сдвинулся — вливает PR по одному
# тем же `gh pr merge --merge --match-head-commit`, что merge-one.sh: GitHub
# повторяет те же слияния в том же порядке, и dev получает ровно проверенное
# дерево. Правило свежести (#552 + #554: зелёные порознь ломали вместе)
# сохраняется — проверено итоговое состояние, а не каждая ветка отдельно.
#
# Конфликт с dev или с соседом по пачке, красная пачка, сдвинутый dev после
# трёх пересборок — такие PR идут медленным путём: по одному (вливает dev в
# ветку, ждёт CI, вливает). Не прошёл и он — строка в .lead/train-failed.txt:
# её подберёт линия доработки.
#
# Каждая строка stdout — событие для монитора тимлида; те же строки пишутся в
# .lead/train.log.
set -u
# shellcheck source=paths.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/paths.sh" || exit 1
QUEUE="$LEAD_DIR/train-queue.txt"
DONE="$LEAD_DIR/train-done.txt"
FAILED="$LEAD_DIR/train-failed.txt"
LOG="$LEAD_DIR/train.log"
WT="$TRAIN_WT"
MAX_BATCH="${MAX_BATCH:-6}"
touch "$QUEUE" "$DONE" "$FAILED" "$LOG"

say() { local line; line="$(date -u +%H:%M) $*"; echo "$line"; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }
mark_done() { echo "$1 $2" >> "$DONE"; }
mark_failed() { echo "$1 $2" >> "$FAILED"; say "не влит #$1: $2"; }

if [ ! -d "$WT" ]; then
  git -C "$LEAD_ROOT" worktree add -q --detach "$WT" origin/dev || { say "поезд: не создать рабочую копию $WT"; exit 1; }
fi
cd "$WT" || exit 1

# Ждущие PR по порядку очереди. PR ждёт, пока раз в очереди больше, чем
# итогов (строк в train-done и train-failed): доработанный после провала PR
# линия дописывает в очередь снова, и он едет ещё раз.
pending() {
  local seen=" " n q p
  while read -r n _; do
    [[ "$n" =~ ^[0-9]+$ ]] || continue
    [[ "$seen" == *" $n "* ]] && continue
    seen="$seen$n "
    q=$(grep -cE "^$n( |$)" "$QUEUE")
    p=$(( $(grep -cE "^$n " "$DONE") + $(grep -cE "^$n " "$FAILED") ))
    [ "$q" -gt "$p" ] && echo "$n"
  done < "$QUEUE"
}

# gh pr merge с повтором: сразу после соседнего мерджа GitHub может ещё
# считать mergeable.
# Второй аргумент — проверенная голова: вливается только она, новый push в
# ветку после проверки мердж срывает.
merge_pr() {
  local n=$1 head=$2
  for _ in 1 2 3 4; do
    gh pr merge "$n" --merge --match-head-commit "$head" >/dev/null 2>&1 && return 0
    sleep 15
  done
  return 1
}

# Итог проверки по последнему прогону каждого имени (разбор — train-status.mjs,
# функция ciOf): в сводке GitHub остаются и старые прогоны, по ним судить нельзя.
# Печатает «gate check»: GREEN | RED | PENDING | NONE.
ci_of() {
  { gh pr checks "$1" --json name,state,startedAt 2>/dev/null || true; } | node "$LEAD_SCRIPTS/train-status.mjs" ci
}

# Состояние PR одной строкой: state draft branch head gate check метки-блокеры.
pr_info() {
  local base ci
  base=$(gh pr view "$1" --json state,isDraft,headRefName,headRefOid,labels --jq '
    [.state, (.isDraft|tostring), .headRefName, .headRefOid,
     ([.labels[].name | select(. == "задел" or . == "ждёт владельца" or . == "доработка")] | join(",") | if . == "" then "-" else . end)] | join(" ")' 2>/dev/null)
  ci=$(ci_of "$1")
  read -r st dr br hd bl <<< "$base"
  echo "$st $dr $br $hd $ci $bl"
}

# Ждёт последних прогонов gate и check у PR до ~50 минут: GREEN | RED | PENDING.
wait_ci() {
  local n=$1 r
  for _ in $(seq 1 100); do
    r=$(ci_of "$n")
    case "$r" in
      *RED*) echo RED; return ;;
      "GREEN GREEN") echo GREEN; return ;;
    esac
    sleep 30
  done
  echo PENDING
}

# Влить свежий origin/dev в голову PR в текущей рабочей копии и отправить в
# ветку PR без переключения на неё: ветку держит рабочая копия исполнителя.
# Конфликты только в файлах задач решаются сами, остальные — провал.
# Возвращает: 0 — отправлено, 1 — провал записан, 2 — сеть, позже.
# $1 — номер PR, $2 — ветка, $3 — голова.
sync_dev() {
  local n=$1 branch=$2 head=$3 bad f out
  git checkout -q --detach "$head" 2>/dev/null || { say "сеть: голова #$n не скачана — позже"; return 2; }
  if ! git merge --no-edit -q origin/dev -m "chore: Влить dev в $branch" >/dev/null 2>&1; then
    bad=""
    for f in $(git diff --name-only --diff-filter=U); do
      if [ "$f" = "tasks/epics.md" ]; then git checkout -q --theirs tasks/epics.md
      elif [[ "$f" == tasks/T-*.md ]] && [ -n "$(git ls-files "tasks/archive/$(basename "$f")")" ]; then git rm -q "$f"
      elif [[ "$f" == tasks/T-*.md || "$f" == tasks/archive/T-*.md ]] && [[ "$(basename "$f")" != "${branch#task/}"-* ]]; then git checkout -q --theirs "$f"
      else bad="$bad $f"; fi
    done
    if [ -n "$bad" ]; then git merge --abort >/dev/null 2>&1; mark_failed "$n" "конфликт с dev:$bad"; git checkout -q --detach origin/dev; return 1; fi
    node scripts/tasks/task.mjs fix >/dev/null 2>&1
    git add -A tasks && git commit -q --no-edit || { git merge --abort >/dev/null 2>&1; mark_failed "$n" "не закоммитить влитие dev"; git checkout -q --detach origin/dev; return 1; }
  fi
  out=$(GITHUB_HEAD_REF="$branch" node scripts/tasks/task.mjs diff-check --base origin/dev 2>&1)
  if echo "$out" | grep -q "меняет файлы вне её зон"; then mark_failed "$n" "вне зон после влития dev: $(echo "$out" | grep -E '^  ' | tr '\n' ' ')"; git checkout -q --detach origin/dev; return 1; fi
  if ! git push -q origin "HEAD:refs/heads/$branch" 2>/dev/null; then
    git fetch -q origin 2>/dev/null
    if [ "$(git rev-parse "origin/$branch" 2>/dev/null)" != "$head" ]; then mark_failed "$n" "push влития dev в $branch отклонён: ветку двигают"; else say "сеть: push #$n не прошёл — позже"; fi
    git checkout -q --detach origin/dev; return 1
  fi
  git checkout -q --detach origin/dev
  return 0
}

# Медленный путь — один PR: влить свежий dev в его ветку, дождаться CI и влить.
slow() {
  local n=$1 branch head newhead r
  say "медленный путь #$n"
  read -r branch head <<< "$(gh pr view "$n" --json headRefName,headRefOid --jq '.headRefName + " " + .headRefOid' 2>/dev/null)"
  if [ -z "$branch" ] || [ -z "$head" ]; then say "сеть: #$n не прочитан — позже"; return; fi
  if [ "$(gh pr view "$n" --json state --jq .state 2>/dev/null)" = "MERGED" ]; then mark_done "$n" "уже влит"; return; fi
  git fetch -q origin || { say "сеть: fetch не прошёл — #$n позже"; return; }
  if ! git merge-base --is-ancestor origin/dev "$head" 2>/dev/null; then
    sync_dev "$n" "$branch" "$head" || return
    sleep 40
  fi
  newhead=$(gh pr view "$n" --json headRefOid --jq .headRefOid)
  r=$(wait_ci "$n")
  if [ "$r" != "GREEN" ]; then mark_failed "$n" "CI после влития dev: $r ($(gh pr checks "$n" --json name,state,link --jq '[.[] | select(.state != "SUCCESS" and (.name == "gate" or .name == "check")) | .name + " " + .link] | join(", ")' 2>/dev/null))"; return; fi
  if merge_pr "$n" "$newhead"; then mark_done "$n" "влит по одному"; say "влит #$n (по одному)"
  else mark_failed "$n" "мердж по одному не прошёл"; fi
}

# Освежить ветку PR без ожидания: влить свежий dev, отправить и вернуться. Свой
# CI PR запустится заново, и PR поедет следующей пачкой, когда позеленеет, —
# очередь его не ждёт.
refresh() {
  local n=$1 branch head
  read -r branch head <<< "$(gh pr view "$n" --json headRefName,headRefOid --jq '.headRefName + " " + .headRefOid' 2>/dev/null)"
  if [ -z "$branch" ] || [ -z "$head" ]; then say "сеть: #$n не прочитан — позже"; return; fi
  git fetch -q origin || { say "сеть: fetch не прошёл — #$n позже"; return; }
  git merge-base --is-ancestor origin/dev "$head" 2>/dev/null && return
  sync_dev "$n" "$branch" "$head" && say "освежён #$n: dev влит, ждёт свой CI"
}

# Gate служебного PR: GREEN | RED | PENDING.
gate_of() {
  local g; g=$(ci_of "$1" | cut -d' ' -f1)
  [ "$g" = "NONE" ] && g=PENDING
  echo "$g"
}

idle=0
# Размер следующей пачки: после красной пачки — половина, пока не найдётся
# виновник (пачка из одного красная — провал этого PR); после зелёной — снова MAX_BATCH.
limit=$MAX_BATCH
slowList=""
while true; do
  mapfile -t waiting < <(pending)
  ready=(); heads=(); branches=()
  for n in "${waiting[@]}"; do
    [ "${#ready[@]}" -ge "$limit" ] && break
    info=$(pr_info "$n")
    read -r state draft branch head gate check block <<< "$info"
    if [ -z "$state" ] || [ -z "$head" ] || [ -z "$block" ]; then say "сеть: #$n не прочитан — позже"; continue; fi
    case "$state" in
      MERGED) mark_done "$n" "уже влит"; continue ;;
      OPEN) ;;
      *) mark_failed "$n" "PR в состоянии ${state:-неизвестно}"; continue ;;
    esac
    if [ "$block" != "-" ]; then mark_failed "$n" "метка $block"; continue; fi
    if [ "$draft" = "true" ]; then gh pr ready "$n" >/dev/null 2>&1 || { mark_failed "$n" "черновик, снять не вышло"; continue; }; fi
    if [ "$gate" = "RED" ] || [ "$check" = "RED" ]; then mark_failed "$n" "свой CI красный: gate=$gate check=$check"; continue; fi
    if [ "$gate" != "GREEN" ] || [ "$check" != "GREEN" ]; then continue; fi
    ready+=("$n"); heads+=("$head"); branches+=("$branch")
  done

  if [ "${#ready[@]}" -eq 0 ]; then
    idle=$((idle + 1))
    [ $((idle % 20)) -eq 1 ] && say "поезд ждёт: в очереди $(echo "${waiting[@]:-}" | wc -w), готовых нет"
    sleep 45; continue
  fi
  idle=0

  for attempt in 1 2 3; do
    git fetch -q origin
    base=$(git rev-parse origin/dev)
    git checkout -q --detach "$base"
    inc=(); incHeads=()
    for i in "${!ready[@]}"; do
      n=${ready[$i]}
      if git merge --no-ff --no-edit -q "${heads[$i]}" -m "Пачка: влить #$n" >/dev/null 2>&1; then
        inc+=("$n"); incHeads+=("${heads[$i]}")
      else
        git merge --abort >/dev/null 2>&1
        slowList="$slowList $n"
      fi
    done
    for n in $slowList; do refresh "$n"; done; slowList=""
    [ "${#inc[@]}" -eq 0 ] && break
    git fetch -q origin
    base=$(git rev-parse origin/dev)
    git checkout -q --detach "$base"
    ok=(); okHeads=()
    for i in "${!inc[@]}"; do
      if git merge --no-ff --no-edit -q "${incHeads[$i]}" -m "Пачка: влить #${inc[$i]}" >/dev/null 2>&1; then ok+=("${inc[$i]}"); okHeads+=("${incHeads[$i]}")
      else git merge --abort >/dev/null 2>&1; refresh "${inc[$i]}"; fi
    done
    [ "${#ok[@]}" -eq 0 ] && break

    # Один PR, ветка которого уже содержит свежий dev и зелёная, — вливается сразу.
    if [ "${#ok[@]}" -eq 1 ] && git merge-base --is-ancestor "$base" "${okHeads[0]}"; then
      if merge_pr "${ok[0]}" "${okHeads[0]}"; then mark_done "${ok[0]}" "влит"; say "влит #${ok[0]}"
      else slow "${ok[0]}"; fi
      break
    fi

    tb="queue/train-$(date -u +%m%d%H%M%S)"
    git push -q origin "HEAD:refs/heads/$tb" || { say "поезд: push $tb не прошёл"; sleep 60; continue; }
    list=$(printf '#%s, ' "${ok[@]}"); list=${list%, }
    tpr=$(gh pr create --draft --base dev --head "$tb" --label "release: none" \
      --title "chore(queue): Проверка пачки $list" \
      --body "Служебный PR поезда мерджей тимлида: пачка $list поверх dev $base. Проверяется gate итогового состояния, потом PR пачки вливаются по одному, а этот закрывается без мерджа." 2>/dev/null | grep -oE '[0-9]+$')
    if [ -z "$tpr" ]; then say "поезд: служебный PR не создан (сеть?) — повтор через минуту"; git push -q origin --delete "$tb" >/dev/null 2>&1; sleep 60; continue; fi
    say "пачка $list: проверка в #$tpr"
    g=PENDING
    for _ in $(seq 1 100); do g=$(gate_of "$tpr"); [ "$g" != "PENDING" ] && break; sleep 30; done
    gh pr close "$tpr" --delete-branch >/dev/null 2>&1

    if [ "$g" != "GREEN" ]; then
      if [ "${#ok[@]}" -gt 1 ]; then
        limit=$(( (${#ok[@]} + 1) / 2 ))
        say "пачка $list: gate $g — делю, следующие пачки по $limit"
      else
        mark_failed "${ok[0]}" "красный gate вместе со свежим dev: $(gh run list --branch "$tb" --workflow ci.yml --limit 1 --json url --jq '.[0].url' 2>/dev/null)"
        limit=$MAX_BATCH
      fi
      break
    fi
    git fetch -q origin
    if [ "$(git rev-parse origin/dev)" != "$base" ]; then
      say "пачка $list: dev сдвинулся, пересборка ($attempt)"
      ready=("${ok[@]}"); heads=("${okHeads[@]}")
      [ "$attempt" = "3" ] && for n in "${ok[@]}"; do slow "$n"; done
      continue
    fi
    for i in "${!ok[@]}"; do
      n=${ok[$i]}
      if [ "$(gh pr view "$n" --json state --jq .state 2>/dev/null)" = "MERGED" ]; then mark_done "$n" "уже влит"; continue; fi
      if merge_pr "$n" "${okHeads[$i]}"; then mark_done "$n" "влит пачкой"; say "влит #$n (пачкой $list)"; limit=$MAX_BATCH
      else
        say "#$n: мердж пачки не прошёл — остаток пачки ждёт следующего поезда"
        break
      fi
    done
    break
  done
  git checkout -q --detach origin/dev 2>/dev/null || true
done
