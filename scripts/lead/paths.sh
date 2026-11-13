# Пути конвейера тимлида (T-0477, Р224). Подключается через `source`, сам
# ничего не запускает. Задаёт:
#   LEAD_ROOT — корень основного клона (из связанной рабочей копии — он же:
#               состояние одно на всех линии конвейера);
#   LEAD_DIR  — состояние: очередь, итоги, провалы, лог поезда (по умолчанию
#               $LEAD_ROOT/.lead, в .gitignore);
#   TRAIN_WT  — рабочая копия поезда (по умолчанию
#               $LEAD_ROOT/.claude/worktrees/train);
#   LEAD_SCRIPTS — каталог самих скриптов.
# Любую из переменных можно задать в окружении до запуска.
# Тот же расчёт — scripts/lead/paths.mjs.
_lead_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${LEAD_ROOT:-}" ]; then
  _lead_common="$(git -C "$_lead_here" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || _lead_common=""
  case "$_lead_common" in
    */.git) LEAD_ROOT="${_lead_common%/.git}" ;;
    *) LEAD_ROOT="$(git -C "$_lead_here" rev-parse --show-toplevel 2>/dev/null)" ;;
  esac
  unset _lead_common
fi
if [ -z "${LEAD_ROOT:-}" ]; then
  echo "Корень репозитория не определён: запустите внутри репозитория или задайте LEAD_ROOT" >&2
  return 1
fi
LEAD_DIR="${LEAD_DIR:-$LEAD_ROOT/.lead}"
TRAIN_WT="${TRAIN_WT:-$LEAD_ROOT/.claude/worktrees/train}"
LEAD_SCRIPTS="$_lead_here"
unset _lead_here
export LEAD_ROOT LEAD_DIR TRAIN_WT LEAD_SCRIPTS
mkdir -p "$LEAD_DIR"
