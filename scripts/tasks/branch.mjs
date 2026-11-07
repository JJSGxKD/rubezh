/**
 * Имена веток задач и попытки (T-0390, Р195): единственное место, где ветка
 * задачи собирается и разбирается. Без обращений к git и сети — чистые
 * функции, тесты — scripts/test/tasks-branch.test.ts.
 *
 * Попытка задачи — необязательное поле шапки `attempt`: нет поля — попытка 1.
 * Тимлид снимает застрявший захват командой `pnpm task restart`, и задача
 * получает следующую попытку; её ветка — `task/T-NNNN-N`. Суффикс бывает только
 * у попыток от 2: `task/T-NNNN-1` — не ветка задачи.
 */

export const TASK_BRANCH_RE = /^task\/(T-\d{4})(?:-([2-9]|[1-9]\d+))?$/;

/** `{ id, attempt }` по имени ветки (с `refs/heads/` или без) или `null`, если это не ветка задачи. */
export function parseTaskBranch(ref) {
  if (typeof ref !== "string") return null;
  const match = TASK_BRANCH_RE.exec(ref.replace(/^refs\/heads\//, ""));
  return match === null ? null : { id: match[1], attempt: match[2] === undefined ? 1 : Number(match[2]) };
}

/** Имя ветки задачи для попытки (по умолчанию первой). */
export function taskBranch(id, attempt = 1) {
  return attempt <= 1 ? `task/${id}` : `task/${id}-${String(attempt)}`;
}

/**
 * Попытка задачи: число из поля `attempt` (в шапке это строка) или 1. Всё, что не
 * целое от 2, — первая попытка: об ошибке в поле говорит проверка шапки, а не доска.
 */
export function attemptOf(task) {
  const raw = task?.attempt;
  const value = typeof raw === "string" && /^[2-9]$|^[1-9]\d+$/.test(raw) ? Number(raw) : raw;
  return Number.isInteger(value) && value >= 2 ? value : 1;
}

/** Ветка текущей попытки задачи — единственная действующая ветка. */
export function currentBranchOf(task) {
  return taskBranch(task.id, attemptOf(task));
}

/**
 * `Map<id, попытка>` по реестру. Задачи вне реестра в нём нет, и их попытка —
 * 1, как у задачи без поля. Считать один раз и передавать в `currentBranchTaskId`,
 * когда веток много.
 */
export function attemptsMap(tasks) {
  return new Map([...tasks].map((task) => [task.id, attemptOf(task)]));
}

/**
 * id задач, у которых на `origin` есть ветка **текущей** попытки. Ветка прежней
 * (и будущей) попытки задачу не занимает и зоны не держит. `branches` — имена
 * веток или полные ссылки `refs/heads/…`.
 */
export function takenIdsOf(branches, tasks) {
  const attempts = attemptsMap(tasks);
  const ids = new Set();
  for (const name of branches) {
    const parsed = parseTaskBranch(name);
    if (parsed !== null && (attempts.get(parsed.id) ?? 1) === parsed.attempt) ids.add(parsed.id);
  }
  return [...ids];
}

/**
 * id задачи, если `ref` — ветка её текущей попытки (так выбирают PR задачи среди
 * открытых); иначе `undefined`: чужая ветка, прежняя или будущая попытка. Вторым
 * аргументом — реестр задач или готовая `attemptsMap`.
 */
export function currentBranchTaskId(ref, tasksOrAttempts) {
  const parsed = parseTaskBranch(ref);
  if (parsed === null) return undefined;
  const attempts = tasksOrAttempts instanceof Map ? tasksOrAttempts : attemptsMap(tasksOrAttempts);
  return (attempts.get(parsed.id) ?? 1) === parsed.attempt ? parsed.id : undefined;
}

/** Ветки прежних попыток задачи среди `branches`, от поздней к ранней. */
export function previousAttemptBranches(task, branches) {
  const current = attemptOf(task);
  return branches
    .map((name) => ({ name, parsed: parseTaskBranch(name) }))
    .filter(({ parsed }) => parsed !== null && parsed.id === task.id && parsed.attempt < current)
    .sort((a, b) => b.parsed.attempt - a.parsed.attempt)
    .map(({ name }) => name);
}
