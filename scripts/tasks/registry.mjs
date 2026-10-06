import { FILE_NAME_RE, parseFrontmatter, validateTask } from "./task-file.mjs";

/**
 * Проверка реестра задач целиком (tasks/README.md): уникальные `id`, эпики из
 * `epics.md`, существующие зависимости, нет циклов. Чистые функции — файлы и
 * текст `epics.md` приходят снаружи, тесты — scripts/test/tasks-registry.test.ts.
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
  const tasks = [];
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
    const problems = validateTask(file.name, parsed.data);
    errors.push(...problems);
    if (problems.length === 0) tasks.push({ ...parsed.data, fileName: file.name });
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
  return errors;
}
