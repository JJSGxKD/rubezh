import { AHEAD_LABEL, aheadCheck, prStatus } from "./board.mjs";
import { zonesOverlap } from "./zones.mjs";

/**
 * Проверка захвата для CI (tasks/README.md, «Значки статуса»): PR ветки
 * `task/T-NNNN` проходит, только если задачу можно было взять по тем же
 * правилам, что в `pnpm task claim`. Чистая функция — состояние git и GitHub
 * приходит снаружи, тесты — scripts/test/tasks-claim.test.ts.
 */

const BRANCH_RE = /^task\/(T-\d{4})$/;

/**
 * Что не так с захватом задачи `id`: список ошибок, пустой — всё в порядке.
 *
 * - `tasks` — задачи **на базе** PR (`origin/dev`), а не из ветки: иначе PR
 *   мог бы сам поставить себе нужный статус;
 * - `taken` — id задач, у которых на `origin` есть ветка `task/T-NNNN`;
 * - `prs` — открытые PR `{ headRefName, isDraft, labels }` или `null`, если список не получить;
 * - `repoFiles` — файлы репозитория для пересечения зон;
 * - `claims` — время коммита захвата по id задачи (ISO), если известно;
 * - `ahead` — задача взята заделом (Р178): у PR метка «задел». Тогда незакрытые
 *   зависимости допустимы, если у каждой открыт PR и сама она не задел (`aheadCheck`, в CI
 *   без требования «на ревью»: зависимость могли вернуть в работу уже после захвата);
 *   без `ahead` любая не `done` — отказ.
 *
 * Пересечение зон держит захват, только если соседняя задача взята раньше и
 * ещё в работе: ветка без PR, PR со статусом «в работе» или «доработка» (Р171,
 * Р172, docs/35-stage4-plan.md; статус — метка PR, `prStatus`). PR «на ревью»
 * и «ждёт владельца» соседей не держат, черновик тоже, если он помечен «на
 * ревью» — кто вливается вторым, перебазируется, конфликт правит тимлид.
 * Время захвата неизвестно — держит, как раньше.
 */
export function checkClaim(id, { tasks, taken, prs, repoFiles, claims = {}, ahead = false }) {
  const task = tasks.find((candidate) => candidate.id === id);
  if (task === undefined) return [`задачи ${id} нет в реестре на базе PR: ветку task/${id} заводят под существующую задачу`];

  const problems = [];
  if (task.status !== "ready" && task.status !== "in-progress") {
    problems.push(`задача ${id} на базе в статусе ${task.status}: брать можно только ready`);
  }

  if (ahead) problems.push(...aheadCheck(task, tasks, prs, { atClaim: false }).problems);
  else {
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    for (const dependencyId of task.depends_on) {
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) problems.push(`зависимости ${dependencyId} нет в реестре`);
      else if (dependency.status !== "done") problems.push(`зависимость ${dependencyId} не сделана (статус ${dependency.status})`);
    }
  }

  // Занята задача, у которой есть ветка или открытый PR. Сделанные и отменённые задачи, у которых ветка не удалена,
  // заняты не считаются: так же считает доска (classify). Свои зависимости — не помеха по определению.
  const withBranch = new Set([
    ...taken,
    ...(prs ?? []).map((pr) => BRANCH_RE.exec(pr.headRefName)?.[1]).filter((value) => value !== undefined),
  ]);
  const prOf = new Map((prs ?? []).map((pr) => [BRANCH_RE.exec(pr.headRefName)?.[1], pr]));
  const mine = claimTime(claims[id], Infinity);
  for (const other of tasks) {
    if (other.id === id || task.depends_on.includes(other.id) || !withBranch.has(other.id)) continue;
    if (other.status !== "ready" && other.status !== "in-progress") continue;
    if (waitsForReview(prOf.get(other.id))) continue;
    if (claimTime(claims[other.id], -Infinity) > mine) continue;
    if (zonesOverlap(task.zones, other.zones, repoFiles)) {
      problems.push(`зоны пересекаются с ${other.id}: она взята раньше и ещё в работе (ветка без PR, PR «в работе» или «доработка»)`);
    }
  }
  return problems;
}

/** PR ждёт ревью или владельца либо это задел: код в нём не пишут (или пишут поверх чужих веток), зоны свободны. */
function waitsForReview(pr) {
  if (pr === undefined) return false;
  const status = prStatus(pr);
  return status === "review" || status === "owner" || status === "ahead";
}

/**
 * Что не так с PR задела для CI (Р178, п. 5): пока у задачи есть незакрытые
 * зависимости (не `done` на базе), её PR обязан быть черновиком с меткой
 * «задел» — иначе его можно снять с черновика и влить раньше зависимостей.
 * Все зависимости `done` — PR любого вида. `pr` — PR ветки задачи или
 * `undefined`, если среди открытых его не нашли; `tasks` — реестр с базы.
 */
export function checkAheadPr(pr, task, tasks) {
  const done = new Set(tasks.filter((candidate) => candidate.status === "done").map((candidate) => candidate.id));
  const unclosed = task.depends_on.filter((id) => !done.has(id));
  if (unclosed.length === 0) return [];
  const list = unclosed.join(", ");
  if (pr === undefined) {
    return [`не найден открытый PR ветки задачи, а зависимости не влиты (${list}): без PR с меткой «${AHEAD_LABEL}» проверить задел нечем`];
  }
  const problems = [];
  if (pr.isDraft !== true) {
    problems.push(`PR — не черновик, а зависимости не влиты (${list}): пока они не влиты, PR остаётся черновиком с меткой «${AHEAD_LABEL}»`);
  }
  if (!(pr.labels ?? []).some((label) => label?.name === AHEAD_LABEL)) {
    problems.push(`у PR нет метки «${AHEAD_LABEL}», а зависимости не влиты (${list}): задачу с невлитыми зависимостями берут заделом (pnpm task claim --ahead)`);
  }
  return problems;
}

/**
 * Незакрытые зависимости задачи `id` по реестру **базы** (`tasks` — задачи с `origin/dev`),
 * в порядке `depends_on`. Список зависимостей берётся с базы, как в `claim-check`: иначе PR
 * дописал бы себе в ветке чужую задачу, `diff-check` вычел бы её файлы, а `claim-check` не
 * потребовал бы черновика задела. Задачи нет на базе — вычитать нечего.
 */
export function unclosedDependenciesOnBase(id, tasks) {
  const task = tasks.find((candidate) => candidate.id === id);
  if (task === undefined) return [];
  return task.depends_on.filter((dependencyId) => tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done");
}

/**
 * Дифф задела без файлов его незакрытых зависимостей (Р178, п. 6): их меняют
 * PR самих зависимостей, и зоны проверяются там. `dependencyFiles` — файлы,
 * изменённые ветками зависимостей относительно базы.
 */
export function withoutDependencyFiles(changed, dependencyFiles) {
  const own = new Set(dependencyFiles);
  return changed.filter((path) => !own.has(path));
}

/** Время захвата в миллисекундах; нет или не разобрать — `fallback`. */
function claimTime(iso, fallback) {
  const ms = iso === undefined || iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? fallback : ms;
}
