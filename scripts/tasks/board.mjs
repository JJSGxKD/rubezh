import { zonesOverlap } from "./zones.mjs";

/**
 * Доска задач (tasks/README.md, «Состояния»): каждая задача попадает ровно в
 * одну колонку. Чистые функции — состояние git и GitHub приходит снаружи,
 * тесты — scripts/test/tasks-board.test.ts.
 */

/** Колонки в порядке показа: сначала то, что исполнителю нужно прямо сейчас. */
export const COLUMNS = [
  { key: "free", title: "Свободно" },
  { key: "inProgress", title: "В работе" },
  { key: "review", title: "На ревью" },
  { key: "blocked", title: "Заблокировано" },
  { key: "draft", title: "Черновики" },
  { key: "done", title: "Готово" },
  { key: "cancelled", title: "Отменено" },
];

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

function compareTasks(epicOrder) {
  const epicRank = (epic) => {
    const index = epicOrder.indexOf(epic);
    return index === -1 ? epicOrder.length : index;
  };
  return (a, b) =>
    (PRIORITY_RANK[a.task.priority] ?? 99) - (PRIORITY_RANK[b.task.priority] ?? 99) ||
    epicRank(a.task.epic) - epicRank(b.task.epic) ||
    a.task.id.localeCompare(b.task.id);
}

/**
 * Раскладывает задачи по колонкам.
 *
 * - `tasks` — поля задач с `fileName` (как в `readTasks`);
 * - `taken` — id задач, у которых на `origin` есть ветка `task/T-NNNN`;
 * - `prs` — открытые PR `{ number, headRefName, isDraft }` или `null`, если
 *   список получить не удалось (нет `gh`): тогда «На ревью» сливается с «В работе»;
 * - `repoFiles` — файлы репозитория для пересечения зон;
 * - `epicOrder` — эпики в порядке `epics.md`.
 *
 * Возвращает `{ <колонка>: [{ task, reason?, pr? }] }`, внутри колонки порядок:
 * приоритет, эпик, id.
 */
export function classify(tasks, taken, prs, repoFiles, epicOrder) {
  const branches = new Set(taken);
  const openPrs = new Map((prs ?? []).filter((pr) => !pr.isDraft).map((pr) => [pr.headRefName, pr.number]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const result = Object.fromEntries(COLUMNS.map((column) => [column.key, []]));

  const waiting = [];
  for (const task of tasks) {
    if (task.status === "done") result.done.push({ task });
    else if (task.status === "cancelled") result.cancelled.push({ task });
    else if (task.status === "draft") result.draft.push({ task });
    else if (branches.has(task.id)) {
      const pr = openPrs.get(`task/${task.id}`);
      if (pr === undefined) result.inProgress.push({ task });
      else result.review.push({ task, pr });
    } else if (task.status === "in-progress") {
      // На dev этот статус не живёт (tasks/README.md, «Состояния»); без ветки
      // задачу всё равно считаем занятой — статус в файле говорит, что её взяли.
      result.inProgress.push({ task });
    } else waiting.push(task);
  }

  const busy = [
    ...result.inProgress.map((entry) => ({ task: entry.task, where: "в работе" })),
    ...result.review.map((entry) => ({ task: entry.task, where: "на ревью" })),
  ];

  for (const task of waiting) {
    const reasons = [];
    for (const id of task.depends_on) {
      const dependency = byId.get(id);
      if (dependency === undefined) reasons.push(`${id} нет в реестре`);
      else if (dependency.status !== "done") reasons.push(`ждёт ${id}`);
    }
    for (const other of busy) {
      if (zonesOverlap(task.zones, other.task.zones, repoFiles)) {
        reasons.push(`зоны пересекаются с ${other.task.id} (${other.where})`);
      }
    }
    if (reasons.length === 0) result.free.push({ task });
    else result.blocked.push({ task, reason: reasons.join("; ") });
  }

  const compare = compareTasks(epicOrder);
  for (const entries of Object.values(result)) entries.sort(compare);
  return result;
}

/**
 * Что показать в `pnpm task next`: свободные задачи с подходящим `runner`
 * (по умолчанию `any`; `local` включает `any`; `human` — никогда) и, если
 * задан `executor`, только этого исполнителя. Порядок колонки сохраняется.
 */
export function nextTasks(free, { runner = "any", executor } = {}) {
  const runners = runner === "local" ? ["any", "local"] : ["any"];
  return free.filter(
    (entry) => runners.includes(entry.task.runner) && (executor === undefined || entry.task.executor === executor),
  );
}
