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
 * - `prs` — открытые PR `{ headRefName }` или `null`, если список не получить;
 * - `repoFiles` — файлы репозитория для пересечения зон.
 */
export function checkClaim(id, { tasks, taken, prs, repoFiles }) {
  const task = tasks.find((candidate) => candidate.id === id);
  if (task === undefined) return [`задачи ${id} нет в реестре на базе PR: ветку task/${id} заводят под существующую задачу`];

  const problems = [];
  if (task.status !== "ready" && task.status !== "in-progress") {
    problems.push(`задача ${id} на базе в статусе ${task.status}: брать можно только ready`);
  }

  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  for (const dependencyId of task.depends_on) {
    const dependency = byId.get(dependencyId);
    if (dependency === undefined) problems.push(`зависимости ${dependencyId} нет в реестре`);
    else if (dependency.status !== "done") problems.push(`зависимость ${dependencyId} не сделана (статус ${dependency.status})`);
  }

  // Занята задача, у которой есть ветка или открытый PR. Сделанные и отменённые задачи, у которых ветка не удалена,
  // заняты не считаются: так же считает доска (classify). Свои зависимости — не помеха по определению.
  const withBranch = new Set([
    ...taken,
    ...(prs ?? []).map((pr) => BRANCH_RE.exec(pr.headRefName)?.[1]).filter((value) => value !== undefined),
  ]);
  for (const other of tasks) {
    if (other.id === id || task.depends_on.includes(other.id) || !withBranch.has(other.id)) continue;
    if (other.status !== "ready" && other.status !== "in-progress") continue;
    if (zonesOverlap(task.zones, other.zones, repoFiles)) {
      problems.push(`зоны пересекаются с ${other.id}, которая уже в работе или на ревью`);
    }
  }
  return problems;
}
