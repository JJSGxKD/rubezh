import { checkEpicCells } from "./epics.mjs";
import { FILE_NAME_RE, batchNumber, parseFrontmatter, validateTask } from "./task-file.mjs";

/**
 * Проверка реестра задач целиком (tasks/README.md): уникальные `id`, эпики из
 * `epics.md`, существующие зависимости, нет циклов, зависимости не позже по
 * пачкам очереди. Чистые функции — файлы и текст `epics.md` приходят снаружи,
 * тесты — scripts/test/tasks-registry.test.ts.
 */

/** Задача — это файл `tasks/T-*.md`; остальное в каталоге (README, epics, inbox, шаблон и будущее) не проверяется. */
export function isTaskFile(name) {
  return name.startsWith("T-");
}

/** Эпики в порядке строк `epics.md`: эпик узнаётся по `**E<число>.` в первой колонке. */
export function parseEpics(markdown) {
  return [...markdown.matchAll(/^\|\s*\*\*(E\d+)\./gm)].map((match) => match[1]);
}

/**
 * Читает файлы каталога `tasks/`: `[{ name, text }]` → `{ tasks, errors }`, где
 * `tasks` — поля задач с добавленным `fileName`. Задача с битой шапкой в
 * `tasks` не попадает: её ошибки уже в списке.
 */
export function readTasks(files) {
  const parsedFiles = [];
  const errors = [];
  for (const file of files.filter((candidate) => isTaskFile(candidate.name))) {
    if (!FILE_NAME_RE.test(file.name)) {
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

  // Строке значков нужны имена файлов зависимостей, поэтому проверка тела — вторым проходом, когда реестр уже прочитан.
  const fileNames = {};
  for (const file of parsedFiles) if (typeof file.data.id === "string") fileNames[file.data.id] = file.name;

  const tasks = [];
  for (const file of parsedFiles) {
    // Задача с неверной строкой значков остаётся в реестре: поле у неё в порядке, а ячейка эпика
    // без неё дала бы вторую, ложную ошибку.
    const fieldProblems = validateTask(file.name, file.data);
    errors.push(...(fieldProblems.length === 0 ? validateTask(file.name, file.data, { body: file.body, fileNames }) : fieldProblems));
    if (fieldProblems.length === 0) tasks.push({ ...file.data, fileName: file.name });
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

/** Все ошибки реестра: пустой список — реестр в порядке. */
export function checkRegistry(files, epicsMarkdown) {
  const { tasks, errors } = readTasks(files);
  const epics = new Set(parseEpics(epicsMarkdown));

  const byId = new Map();
  for (const task of tasks) byId.set(task.id, [...(byId.get(task.id) ?? []), task.fileName]);
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
  errors.push(...checkEpicCells(epicsMarkdown, tasks));
  return errors;
}
