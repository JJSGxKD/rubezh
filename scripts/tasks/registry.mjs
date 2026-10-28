import { posix } from "node:path";
import { checkEpicCells } from "./epics.mjs";
import { FILE_NAME_RE, batchNumber, parseFrontmatter, validateTask } from "./task-file.mjs";

/**
 * Проверка реестра задач целиком (tasks/README.md): уникальные `id`, эпики из
 * `epics.md`, существующие зависимости, нет циклов, зависимости не позже по
 * пачкам очереди. Чистые функции — файлы и текст `epics.md` приходят снаружи,
 * тесты — scripts/test/tasks-registry.test.ts.
 */

/** Папка архива внутри `tasks/`: готовые и отменённые задачи (T-0204). */
export const ARCHIVE_DIR = "archive";

/**
 * Задача — это файл `T-*.md` в `tasks/` или `tasks/archive/`; `name` — путь
 * относительно `tasks/`. Остальное (README, epics, inbox, шаблон) не проверяется.
 */
export function isTaskFile(name) {
  return posix.basename(name).startsWith("T-");
}

/**
 * Место задачи по статусу — туда её переносит `pnpm task archive` (уборка
 * тимлида): готовая и отменённая в архив, остальные наверх. Закрытая задача
 * наверху — не ошибка, а «ждёт уборки» (T-0343).
 */
export function placementPath(task) {
  return task.status === "done" || task.status === "cancelled" ? `${ARCHIVE_DIR}/${task.fileName}` : task.fileName;
}

/** Эпики в порядке строк `epics.md`: эпик узнаётся по `**E<число>.` в первой колонке. */
export function parseEpics(markdown) {
  return [...markdown.matchAll(/^\|\s*\*\*(E\d+)\./gm)].map((match) => match[1]);
}

/**
 * Читает файлы `tasks/` и `tasks/archive/`: `[{ name, text }]`, где `name` —
 * путь от `tasks/`, → `{ tasks, errors }`. У задачи в `tasks` кроме полей шапки
 * есть `fileName` (имя без каталога) и `path` (путь от `tasks/`). Задача с
 * битой шапкой в `tasks` не попадает: её ошибки уже в списке.
 */
export function readTasks(files) {
  const parsedFiles = [];
  const errors = [];
  for (const file of files.filter((candidate) => isTaskFile(candidate.name))) {
    const dir = posix.dirname(file.name);
    if (dir !== "." && dir !== ARCHIVE_DIR) {
      errors.push(`${file.name}: задачи лежат только в tasks/ и tasks/archive/`);
      continue;
    }
    if (!FILE_NAME_RE.test(posix.basename(file.name))) {
      errors.push(`${file.name}: имя файла должно быть T-NNNN-slug.md (slug — строчная латиница, цифры, дефис)`);
      continue;
    }
    const parsed = parseFrontmatter(file.text);
    if (parsed.errors.length > 0) {
      errors.push(...parsed.errors.map((error) => `${file.name}: ${error}`));
      continue;
    }
    parsedFiles.push({ name: file.name, ...parsed });
  }

  // Строке значков нужны пути файлов зависимостей, поэтому проверка тела — вторым проходом, когда реестр уже прочитан.
  const paths = {};
  for (const file of parsedFiles) if (typeof file.data.id === "string") paths[file.data.id] = file.name;

  const tasks = [];
  for (const file of parsedFiles) {
    // Задача с неверной строкой значков остаётся в реестре: поле у неё в порядке, а ячейка эпика
    // без неё дала бы вторую, ложную ошибку.
    const fileName = posix.basename(file.name);
    const fieldProblems = validateTask(fileName, file.data);
    errors.push(...(fieldProblems.length === 0 ? validateTask(fileName, file.data, { body: file.body, paths, path: file.name }) : fieldProblems));
    if (fieldProblems.length === 0) tasks.push({ ...file.data, fileName, path: file.name });
  }
  return { tasks, errors };
}

/** Первый найденный цикл в `depends_on`: список id, замкнутый на себя, начиная с наименьшего. */
function findCycles(tasks) {
  const edges = new Map(tasks.map((task) => [task.id, task.depends_on]));
  const cycles = new Map();
  const state = new Map(); // 1 — в обходе, 2 — обойдена
  const stack = [];

  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      if (state.get(next) === 1) {
        const loop = stack.slice(stack.indexOf(next));
        const start = loop.indexOf([...loop].sort()[0]);
        const rotated = [...loop.slice(start), ...loop.slice(0, start)];
        cycles.set(rotated.join(" → "), [...rotated, rotated[0]].join(" → "));
      } else if (state.get(next) === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const id of [...edges.keys()].sort()) if (state.get(id) === undefined) visit(id);
  return [...cycles.values()];
}

/** Сделанная или отменённая задача уже не ждёт выхода в main: от её пачки ничего не зависит. */
function isSettled(task) {
  return task.status === "done" || task.status === "cancelled";
}

/**
 * Пачки в зависимостях (docs/38-release-plan.md, §5): зависимость уходит в main
 * не позже зависящей задачи, а задача с пачкой не ждёт задачу без пачки —
 * иначе пачка не соберётся. Сделанные и отменённые задачи не в счёт; зависимости
 * без файла в реестре — ошибка другой проверки. Одна ошибка на пару.
 */
export function checkBatches(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const errors = [];
  for (const task of tasks) {
    const batch = batchNumber(task);
    if (batch === null || isSettled(task)) continue;
    for (const id of task.depends_on) {
      const dependency = byId.get(id);
      if (dependency === undefined || isSettled(dependency)) continue;
      const dependencyBatch = batchNumber(dependency);
      const head = `${task.fileName}: поле depends_on — ${task.id} (пачка ${String(batch)}) зависит от ${id}`;
      if (dependencyBatch === null) {
        errors.push(`${head} (без пачки): отдай ${id} пачку ${String(batch)} или раньше, либо убери зависимость`);
      } else if (dependencyBatch > batch) {
        errors.push(`${head} (пачка ${String(dependencyBatch)}): зависимость уходит в main позже; перенеси ${id} в пачку ${String(batch)} или раньше, либо ${task.id} — в пачку ${String(dependencyBatch)} или позже`);
      }
    }
  }
  return errors;
}

/**
 * Открытая задача в архиве — ошибка: её вернёт наверх `pnpm task archive`. Закрытая
 * наверху ошибкой не считается: в PR задача закрывается на месте, а в архив её
 * переносит уборка тимлида (`awaitingArchive`).
 */
export function checkPlacement(tasks) {
  const errors = [];
  for (const task of tasks) {
    if (task.path === placementPath(task) || isSettled(task)) continue;
    errors.push(`${task.path}: задача в статусе ${task.status} лежит в архиве — вернёт наверх pnpm task archive`);
  }
  return errors;
}

/** Закрытые задачи наверху: ждут уборки в архив, по возрастанию `id`. */
export function awaitingArchive(tasks) {
  return tasks.filter((task) => isSettled(task) && task.path !== placementPath(task)).sort((a, b) => a.id.localeCompare(b.id));
}

/** Строка о ждущих уборки для `pnpm task check` и `fix`; `null` — таких нет. */
export function awaitingArchiveLine(tasks) {
  const waiting = awaitingArchive(tasks);
  if (waiting.length === 0) return null;
  return `Ждут уборки в архив: ${String(waiting.length)} — ${waiting.map((task) => task.id).join(", ")}. Перенесёт pnpm task archive — уборка тимлида (tasks/README.md, «Уборка архива»).`;
}

/** Итог проверки реестра: всего, открытых, в архиве и ждущих уборки (часть про них — только когда они есть). */
export function registrySummary(tasks) {
  const archived = tasks.filter((task) => task.path.startsWith(`${ARCHIVE_DIR}/`)).length;
  const open = tasks.filter((task) => !isSettled(task)).length;
  const waiting = awaitingArchive(tasks).length;
  return `Реестр задач в порядке: ${String(tasks.length)} задач (открытых ${String(open)}, в архиве ${String(archived)}${waiting > 0 ? `, ждут уборки ${String(waiting)}` : ""}).`;
}

/** Все ошибки реестра: пустой список — реестр в порядке. */
export function checkRegistry(files, epicsMarkdown) {
  const { tasks, errors } = readTasks(files);
  const epics = new Set(parseEpics(epicsMarkdown));

  const byId = new Map();
  for (const task of tasks) byId.set(task.id, [...(byId.get(task.id) ?? []), task.path]);
  for (const [id, names] of byId) {
    if (names.length > 1) errors.push(`повтор id ${id}: ${names.join(", ")}`);
  }

  for (const task of tasks) {
    if (!epics.has(task.epic)) errors.push(`${task.fileName}: поле epic — эпика ${task.epic} нет в epics.md`);
    for (const dependency of task.depends_on) {
      if (!byId.has(dependency)) errors.push(`${task.fileName}: поле depends_on — нет такой задачи: ${dependency}`);
    }
  }

  for (const cycle of findCycles(tasks)) errors.push(`цикл в depends_on: ${cycle}`);
  errors.push(...checkBatches(tasks));
  errors.push(...checkPlacement(tasks));
  errors.push(...checkEpicCells(epicsMarkdown, tasks));
  return errors;
}
