import { BATCH_RE, EFFORTS, EXECUTORS, batchNumber } from "./task-file.mjs";
import { zonesOverlap } from "./zones.mjs";

/**
 * Доска задач (tasks/README.md, «Состояния»): каждая задача попадает ровно в
 * одну колонку. Чистые функции — состояние git и GitHub приходит снаружи,
 * тесты — scripts/test/tasks-board.test.ts.
 */

/**
 * Метка PR «нужна доработка» (tasks/README.md, «Доработка»): тимлид или
 * ревьюер ответил на вопросы или попросил правок, и PR может закончить любой
 * поток с тем же исполнителем и уровнем — не обязательно тот, что его открыл.
 */
export const REWORK_LABEL = "доработка";

/** Колонки в порядке показа: сначала то, что исполнителю нужно прямо сейчас. */
export const COLUMNS = [
  { key: "rework", title: "Доработка" },
  { key: "free", title: "Свободно" },
  { key: "inProgress", title: "В работе" },
  { key: "review", title: "На ревью" },
  { key: "blocked", title: "Заблокировано" },
  { key: "draft", title: "Черновики" },
  { key: "done", title: "Готово" },
  { key: "cancelled", title: "Отменено" },
];

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * Ранг пачки очереди: меньше — раньше (docs/38-release-plan.md). Без пачки —
 * после всех: такую задачу ни одна пачка не ждёт. Принимает и строку из шапки
 * (`"2"`), и число; всё, что не целое от 1, — как отсутствие пачки.
 */
export function batchRank(batch) {
  const number = typeof batch === "string" ? (BATCH_RE.test(batch) ? Number(batch) : Number.NaN) : batch;
  return Number.isInteger(number) && number >= 1 ? number : Number.MAX_SAFE_INTEGER;
}

function compareTasks(epicOrder) {
  const epicRank = (epic) => {
    const index = epicOrder.indexOf(epic);
    return index === -1 ? epicOrder.length : index;
  };
  return (a, b) =>
    batchRank(a.task.batch) - batchRank(b.task.batch) ||
    (PRIORITY_RANK[a.task.priority] ?? 99) - (PRIORITY_RANK[b.task.priority] ?? 99) ||
    epicRank(a.task.epic) - epicRank(b.task.epic) ||
    a.task.id.localeCompare(b.task.id);
}

/**
 * Раскладывает задачи по колонкам.
 *
 * - `tasks` — поля задач с `fileName` (как в `readTasks`);
 * - `taken` — id задач, у которых на `origin` есть ветка `task/T-NNNN`;
 * - `prs` — открытые PR `{ number, headRefName, isDraft, labels? }` или `null`, если
 *   список получить не удалось (нет `gh`): тогда «На ревью» сливается с «В работе»;
 *   PR с меткой `REWORK_LABEL` — «Доработка», будь он хоть черновиком;
 * - `repoFiles` — файлы репозитория для пересечения зон;
 * - `epicOrder` — эпики в порядке `epics.md`.
 *
 * Возвращает `{ <колонка>: [{ task, reason?, pr?, waitingFor?, busyWith? }] }`,
 * внутри колонки порядок: пачка, приоритет, эпик, id. У заблокированных `waitingFor` —
 * id недоделанных зависимостей, `busyWith` — id задач, чьи зоны заняты.
 */
export function classify(tasks, taken, prs, repoFiles, epicOrder) {
  const branches = new Set(taken);
  const openPrs = new Map((prs ?? []).filter((pr) => !pr.isDraft).map((pr) => [pr.headRefName, pr.number]));
  const reworkPrs = new Map(
    (prs ?? []).filter((pr) => (pr.labels ?? []).some((label) => label?.name === REWORK_LABEL)).map((pr) => [pr.headRefName, pr.number]),
  );
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const result = Object.fromEntries(COLUMNS.map((column) => [column.key, []]));

  const waiting = [];
  for (const task of tasks) {
    if (task.status === "done") result.done.push({ task });
    else if (task.status === "cancelled") result.cancelled.push({ task });
    else if (task.status === "draft") result.draft.push({ task });
    else if (branches.has(task.id)) {
      const rework = reworkPrs.get(`task/${task.id}`);
      const pr = openPrs.get(`task/${task.id}`);
      if (rework !== undefined) result.rework.push({ task, pr: rework });
      else if (pr === undefined) result.inProgress.push({ task });
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
    ...result.rework.map((entry) => ({ task: entry.task, where: "на доработке" })),
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
 * Что показать в `pnpm task next`: задачи колонки (свободные или на
 * доработке) с подходящим `runner` (по умолчанию `any`; `local` включает
 * `any`; `human` — никогда) и, если заданы, только этого `executor` и
 * `effort`. Порядок колонки сохраняется.
 */
export function nextTasks(entries, { runner = "any", executor, effort } = {}) {
  const runners = runner === "local" ? ["any", "local"] : ["any"];
  return entries.filter(
    (entry) =>
      runners.includes(entry.task.runner) &&
      (executor === undefined || entry.task.executor === executor) &&
      (effort === undefined || entry.task.effort === effort),
  );
}

/** Сколько номеров показывает значок: длинный список не влезает в картинку, остаток — «+N». */
const BADGE_IDS_SHOWN = 2;

/** Значок живёт в кэше shields.io и GitHub; пять минут — предел, ниже пересчёт workflow всё равно не успевает. */
export const BADGE_CACHE_SECONDS = 300;

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
    case "rework":
      return badge(`доработка · #${String(entry.pr)}`, "yellow");
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

/** Задачи `human` делает человек: потоку они не нужны и в сводку потоков не попадают. */
const STREAM_RUNNERS = ["any", "local"];

/** Сколько задач потока показывают таблица и команда: дальше — «+N». */
export const STREAM_TASKS_SHOWN = 5;

/** Сколько пар помещает значок эпика: длинное сообщение не влезает в картинку, остаток — «+N». */
const EPIC_BADGE_STREAMS_SHOWN = 3;

function rankIn(list, value) {
  const index = list.indexOf(value);
  return index === -1 ? list.length : index;
}

/** Порядок потоков: модель, уровень от лёгкого к тяжёлому, потом `any` перед `local`. */
function compareStreams(a, b) {
  return (
    rankIn(EXECUTORS, a.executor) - rankIn(EXECUTORS, b.executor) ||
    a.executor.localeCompare(b.executor) ||
    rankIn(EFFORTS, a.effort) - rankIn(EFFORTS, b.effort) ||
    rankIn(STREAM_RUNNERS, a.runner) - rankIn(STREAM_RUNNERS, b.runner)
  );
}

/**
 * Сводка для разработчика, который запускает потоки (tasks/README.md,
 * «Автопоток»): по каждой паре «модель + уровень» — что можно делать сейчас и
 * что ждёт. Поверх результата `classify`; `runner` учитывается отдельно, потому
 * что `local` берут только потоки на машине разработчика.
 *
 * Возвращает `{ streams, epics }`: `streams` — все потоки, `epics` — то же по
 * эпикам (`{ E10: [...] }`). Поток — `{ executor, effort, runner, now, queue }`:
 * - `now` — доработка и свободные (`rework` у первых): сначала доработка, как в
 *   `pnpm task next`, внутри каждой — порядок колонки: пачка, приоритет, эпик;
 * - `queue` — заблокированные зависимостью или зоной, порядок колонки.
 * Элемент — `{ id, fileName, batch }` (`batch` — число или `null`). Пары без
 * задач в сводку не входят.
 */
export function streamsSummary(board) {
  const total = new Map();
  const perEpic = new Map();

  const streamIn = (map, task) => {
    const key = `${task.executor}/${task.effort}/${task.runner}`;
    let stream = map.get(key);
    if (stream === undefined) {
      stream = { executor: task.executor, effort: task.effort, runner: task.runner, now: [], queue: [] };
      map.set(key, stream);
    }
    return stream;
  };

  const place = (entry, list, extra) => {
    const { task } = entry;
    if (!STREAM_RUNNERS.includes(task.runner)) return;
    if (!perEpic.has(task.epic)) perEpic.set(task.epic, new Map());
    const item = { id: task.id, fileName: task.fileName, batch: batchNumber(task), ...extra };
    for (const map of [total, perEpic.get(task.epic)]) streamIn(map, task)[list].push(item);
  };

  for (const entry of board.rework) place(entry, "now", { rework: true });
  for (const entry of board.free) place(entry, "now", { rework: false });
  for (const entry of board.blocked) place(entry, "queue", {});

  const sorted = (map) => [...map.values()].sort(compareStreams);
  return { streams: sorted(total), epics: Object.fromEntries([...perEpic].map(([epic, map]) => [epic, sorted(map)])) };
}

/** Имя потока для людей: «sonnet-5.5 / high», для `local` — с пометкой. */
export function streamLabel(stream) {
  const base = `${stream.executor} / ${stream.effort}`;
  return stream.runner === "local" ? `${base} · local` : base;
}

/** Короткое имя для значка: «sonnet·high», версия модели отрезана. */
function streamShortLabel(stream) {
  const model = stream.executor.replace(/-\d+(?:\.\d+)*$/, "");
  return `${model}·${stream.effort}${stream.runner === "local" ? "·local" : ""}`;
}

/**
 * Строки таблиц потоков — общие для команды `pnpm task streams` и страницы
 * доски, чтобы они не разошлись. `now` — потоки, где есть что делать сейчас,
 * `queue` — потоки, где что-то ждёт; пустые пары не попадают ни туда, ни сюда.
 * В `now`: `free` и `rework` — сколько задач, `shown` — первые
 * `STREAM_TASKS_SHOWN`, `more` — сколько не поместилось. В `queue`: `count` и
 * `batch` — ближайшая пачка ожидающих (`null` — ни у одной нет пачки).
 */
export function streamRows(streams) {
  const now = streams
    .filter((stream) => stream.now.length > 0)
    .map((stream) => ({
      label: streamLabel(stream),
      free: stream.now.filter((item) => !item.rework).length,
      rework: stream.now.filter((item) => item.rework).length,
      shown: stream.now.slice(0, STREAM_TASKS_SHOWN),
      more: Math.max(0, stream.now.length - STREAM_TASKS_SHOWN),
    }));
  const queue = streams
    .filter((stream) => stream.queue.length > 0)
    .map((stream) => {
      const batches = stream.queue.map((item) => item.batch).filter((batch) => batch !== null);
      return { label: streamLabel(stream), count: stream.queue.length, batch: batches.length === 0 ? null : Math.min(...batches) };
    });
  return { now, queue };
}

/** Номер задачи с пачкой для текста: «T-0095 (п.1)»; пачки нет — просто номер. */
export function streamItemText(item) {
  return item.batch === null ? item.id : `${item.id} (п.${String(item.batch)})`;
}

function alignedColumns(rows) {
  const widths = [];
  for (const row of rows) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]))).join("  "));
}

/** Текст для терминала: «Запускать сейчас» и «На очереди», пустые пары не печатаются. */
export function renderStreamsText(streams) {
  const { now, queue } = streamRows(streams);
  const lines = [];
  if (now.length === 0) lines.push("Запускать сейчас нечего: ни свободных задач, ни доработки.");
  else {
    lines.push("Запускать сейчас — доработка раньше новых (п.N — пачка выпуска):");
    const rows = now.map((row) => [
      row.label,
      `свободно ${String(row.free)}, на доработке ${String(row.rework)}`,
      row.shown.map(streamItemText).join(", ") + (row.more > 0 ? ` +${String(row.more)}` : ""),
    ]);
    lines.push(...alignedColumns(rows).map((line) => `  ${line}`));
  }
  lines.push("");
  if (queue.length === 0) lines.push("На очереди ничего нет.");
  else {
    lines.push("На очереди — ждут зависимостей или занятых зон:");
    const rows = queue.map((row) => [row.label, `ждут ${String(row.count)}, ${row.batch === null ? "без пачки" : `ближайшая пачка ${String(row.batch)}`}`]);
    lines.push(...alignedColumns(rows).map((line) => `  ${line}`));
  }
  return lines;
}

/**
 * Значок потоков эпика (endpoint-формат shields.io), `streams` — потоки эпика
 * из `streamsSummary`. Есть что делать сейчас — «сейчас: sonnet·high 2, haiku·low 1»
 * (до трёх пар по убыванию числа задач, остаток — «+N»), зелёный; нет —
 * «нет свободных · в очереди N», светло-серый.
 */
export function epicStreamsBadge(streams) {
  const badge = (message, color) => ({ schemaVersion: 1, label: "потоки", message, color, cacheSeconds: BADGE_CACHE_SECONDS });
  const active = streams.filter((stream) => stream.now.length > 0).sort((a, b) => b.now.length - a.now.length);
  if (active.length === 0) {
    const queued = streams.reduce((sum, stream) => sum + stream.queue.length, 0);
    return badge(queued === 0 ? "нет свободных" : `нет свободных · в очереди ${String(queued)}`, "lightgrey");
  }
  const shown = active.slice(0, EPIC_BADGE_STREAMS_SHOWN).map((stream) => `${streamShortLabel(stream)} ${String(stream.now.length)}`);
  const rest = active.length - EPIC_BADGE_STREAMS_SHOWN;
  return badge(`сейчас: ${shown.join(", ")}${rest > 0 ? ` +${String(rest)}` : ""}`, "brightgreen");
}
