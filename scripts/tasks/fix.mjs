import { fixEpicCells } from "./epics.mjs";
import { placementPath, readTasks } from "./registry.mjs";
import { badgeLine, withBadgeLine, withTaskLinks } from "./task-file.mjs";

/**
 * План `pnpm task fix` и `pnpm task archive` над файлами `tasks/`: `files` —
 * `[{ name, text }]`, имя — путь от `tasks/` (`T-0001-x.md`, `archive/T-0001-x.md`,
 * `epics.md`). Результат — `{ moves, files }`: переносы `{ from, to }` и файлы с
 * новым текстом по именам после переносов. Перенесённый файл без правки текста в
 * `files` не входит. Чистая функция — диска и git здесь нет, как у соседних модулей;
 * тесты — scripts/test/tasks-fix.test.ts.
 *
 * - `archive: false` (fix) — строки значков, ссылки на файлы задач и ячейки эпиков
 *   по тому, где файлы лежат сейчас; ничего не переносится;
 * - `archive: true` (archive) — то же плюс перенос по статусу в обе стороны:
 *   закрытые уходят в `archive/`, открытые возвращаются наверх.
 */
export function planFix(files, { archive }) {
  let current = files;

  // (а) перенос: путь задачи должен быть равен месту по статусу — только по команде уборки
  const moves = [];
  if (archive) {
    for (const task of readTasks(current).tasks) {
      const target = placementPath(task);
      if (task.path !== target) moves.push({ from: task.path, to: target });
    }
    if (moves.length > 0) current = current.map((file) => ({ ...file, name: moves.find((move) => move.from === file.name)?.to ?? file.name }));
  }

  // (б) пути пересчитаны по настоящему расположению
  const { tasks } = readTasks(current);
  const paths = Object.fromEntries(tasks.map((task) => [task.id, task.path]));
  const taskOf = new Map(tasks.map((task) => [task.path, task]));

  const changed = [];
  for (const file of current) {
    let text = file.text;
    const data = taskOf.get(file.name);
    // Битая шапка или зависимость без файла — править нечего: об этом скажет `pnpm task check`.
    if (data !== undefined && !data.depends_on.some((id) => paths[id] === undefined)) text = withBadgeLine(text, badgeLine(data, paths));
    // (в) ссылки на файлы задач — во всех файлах tasks/ и tasks/archive/
    text = withTaskLinks(text, file.name, paths);
    // (г) ячейки эпиков
    if (file.name === "epics.md") text = fixEpicCells(text, tasks);
    if (text !== file.text) changed.push({ name: file.name, text });
  }
  return { moves, files: changed };
}
