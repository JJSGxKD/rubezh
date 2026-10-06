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
 * Возвращает `{ <колонка>: [{ task, reason?, pr?, waitingFor?, busyWith? }] }`,
 * внутри колонки порядок: приоритет, эпик, id. У заблокированных `waitingFor` —
 * id недоделанных зависимостей, `busyWith` — id задач, чьи зоны заняты.
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
    // Те же причины списками id — из них собирается значок статуса, текст не разбирается обратно.
    const waitingFor = [];
    const busyWith = [];
    for (const id of task.depends_on) {
      const dependency = byId.get(id);
      if (dependency === undefined) {
        reasons.push(`${id} нет в реестре`);
        waitingFor.push(id);
      } else if (dependency.status !== "done") {
        reasons.push(`ждёт ${id}`);
        waitingFor.push(id);
      }
    }
    for (const other of busy) {
      if (zonesOverlap(task.zones, other.task.zones, repoFiles)) {
        reasons.push(`зоны пересекаются с ${other.task.id} (${other.where})`);
        busyWith.push(other.task.id);
      }
    }
    if (reasons.length === 0) result.free.push({ task });
    else result.blocked.push({ task, reason: reasons.join("; "), waitingFor, busyWith });
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

/** Сколько номеров показывает значок: длинный список не влезает в картинку, остаток — «+N». */
const BADGE_IDS_SHOWN = 2;

/** Значок живёт в кэше shields.io и GitHub; пять минут — предел, ниже пересчёт workflow всё равно не успевает. */
const BADGE_CACHE_SECONDS = 300;

function idList(ids) {
  const shown = ids.slice(0, BADGE_IDS_SHOWN).join(", ");
  return ids.length > BADGE_IDS_SHOWN ? `${shown} +${String(ids.length - BADGE_IDS_SHOWN)}` : shown;
}

/**
 * Значок статуса задачи (endpoint-формат shields.io): сообщение и цвет по
 * колонке доски, таблица — в tasks/README.md, «Значки статуса».
 *
 * `entry` — запись `classify` с ключом колонки `column` и, если известен,
 * `owner` из ветки задачи («аккаунт / модель»; модель в значке не нужна).
 * Заблокированной зависимость важнее зоны: пока зависимость не сделана, зона
 * ничего не решает.
 */
export function statusBadge(entry) {
  const badge = (message, color) => ({ schemaVersion: 1, label: "статус", message, color, cacheSeconds: BADGE_CACHE_SECONDS });
  switch (entry.column) {
    case "free":
      return badge("можно брать", "brightgreen");
    case "inProgress": {
      const account = (entry.owner ?? "").split(" / ")[0].trim();
      return badge(account === "" ? "в работе" : `в работе · ${account}`, "orange");
    }
    case "review":
      return badge(`на ревью · #${String(entry.pr)}`, "blue");
    case "blocked": {
      const waitingFor = entry.waitingFor ?? [];
      if (waitingFor.length > 0) return badge(`ждёт ${idList(waitingFor)}`, "red");
      return badge(`зона занята ${idList(entry.busyWith ?? [])}`, "red");
    }
    case "done":
      return badge("готово", "6e40c9");
    case "draft":
      return badge("черновик", "lightgrey");
    case "cancelled":
      return badge("отменено", "inactive");
    default:
      throw new Error(`неизвестная колонка доски: ${String(entry.column)}`);
  }
}
