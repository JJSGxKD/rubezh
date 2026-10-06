import { taskBadge } from "./task-file.mjs";

/**
 * Ячейка «Задачи» в tasks/epics.md (tasks/README.md, «Значки статуса»): живые
 * значки задач эпика вместо номеров, которые отстали бы от доски в первый же
 * день. Чистые функции над текстом, тесты — scripts/test/tasks-epics.test.ts.
 */

/** Строка эпика узнаётся так же, как в `parseEpics`: «**E<число>.» в первой ячейке. */
const EPIC_ROW_RE = /^\|\s*\*\*(E\d+)\./;

/** Значки задач эпика по возрастанию id через пробел; задач нет — «—». Статус задачи не важен: значок скажет сам. */
export function epicTasksCell(epicId, tasks) {
  const badges = tasks
    .filter((task) => task.epic === epicId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((task) => taskBadge(task.id, task.fileName));
  return badges.length === 0 ? "—" : badges.join(" ");
}

/** Границы последней ячейки строки таблицы: между двумя последними «|». */
function lastCellBounds(line) {
  const end = line.lastIndexOf("|");
  if (end <= 0) return null;
  const start = line.lastIndexOf("|", end - 1);
  return start === -1 ? null : { start, end };
}

/** Ошибки ячеек: последняя ячейка строки эпика (без пробелов по краям) должна совпасть с `epicTasksCell`. */
export function checkEpicCells(markdown, tasks) {
  const errors = [];
  for (const line of markdown.split(/\r?\n/)) {
    const epic = EPIC_ROW_RE.exec(line)?.[1];
    const bounds = lastCellBounds(line);
    if (epic === undefined || bounds === null) continue;
    const expected = epicTasksCell(epic, tasks);
    if (line.slice(bounds.start + 1, bounds.end).trim() !== expected) {
      errors.push(`epics.md: эпик ${epic} — ячейка «Задачи» не совпадает с реестром, поправит pnpm task fix; ожидается: ${expected}`);
    }
  }
  return errors;
}

/** Тот же текст с исправленной последней ячейкой в строках эпиков (`| <ячейка> |`); остальное не трогается. */
export function fixEpicCells(markdown, tasks) {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const epic = EPIC_ROW_RE.exec(line)?.[1];
      const bounds = lastCellBounds(line);
      if (epic === undefined || bounds === null) return line;
      return `${line.slice(0, bounds.start + 1)} ${epicTasksCell(epic, tasks)} ${line.slice(bounds.end)}`;
    })
    .join(eol);
}
