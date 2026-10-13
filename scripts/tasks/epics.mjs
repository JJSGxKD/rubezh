import { REPOSITORY, STATUS_URL, taskBadge } from "./task-file.mjs";

/**
 * Ячейки эпиков в tasks/epics.md (tasks/README.md, «Значки статуса»): «Задачи» —
 * живые значки задач эпика вместо номеров, которые отстали бы от доски в первый
 * же день; «Потоки» — значок, какие потоки автопотока можно запускать для эпика
 * сейчас. Чистые функции над текстом, тесты — scripts/test/tasks-epics.test.ts.
 */

/** Строка эпика узнаётся так же, как в `parseEpics`: «**E<число>.» в первой ячейке. */
const EPIC_ROW_RE = /^\|\s*\*\*(E\d+)\./;

/** Раздел «Потоки сейчас» на странице доски — куда ведёт значок потоков. */
export const BOARD_STREAMS_URL = `https://github.com/${REPOSITORY}/blob/task-board/README.md#потоки-сейчас`;

/**
 * Столбец «Потоки» необязателен и стоит перед «Задачи»: «Задачи» остаётся
 * последней ячейкой, как её находят остальные части разбора.
 */
const STREAMS_HEADER_RE = /^\|.*\|\s*Потоки\s*\|\s*Задачи\s*\|\s*$/m;

/** Значки задач эпика по возрастанию id через пробел; задач нет — «—». Статус задачи не важен: значок скажет сам. */
export function epicTasksCell(epicId, tasks) {
  const badges = tasks
    .filter((task) => task.epic === epicId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((task) => taskBadge(task.id, task.fileName));
  return badges.length === 0 ? "—" : badges.join(" ");
}

/**
 * Значок потоков эпика: картинку читает `status/epic-<эпик>.json` ветки
 * task-board (его пишет `pnpm task status-json`), ссылка ведёт на раздел
 * «Потоки сейчас». Задач в эпике нет — «—», как и в ячейке «Задачи».
 */
export function epicStreamsCell(epicId, tasks) {
  if (!tasks.some((task) => task.epic === epicId)) return "—";
  return `[![потоки](${STATUS_URL}/epic-${epicId}.json)](${BOARD_STREAMS_URL})`;
}

/** Границы ячейки, считая справа (0 — последняя): между «|», которые стоят на этом месте с конца. */
function cellBounds(line, fromEnd) {
  const pipes = [];
  for (let index = line.length - 1; index >= 0 && pipes.length < fromEnd + 2; index -= 1) {
    if (line[index] === "|") pipes.push(index);
  }
  return pipes.length < fromEnd + 2 ? null : { start: pipes[fromEnd + 1], end: pipes[fromEnd] };
}

/** Ячейки эпика, что проверяются и правятся: «Потоки» — только если столбец есть в таблице. */
function epicCells(markdown) {
  const cells = [{ name: "Задачи", fromEnd: 0, expected: epicTasksCell }];
  if (STREAMS_HEADER_RE.test(markdown)) cells.unshift({ name: "Потоки", fromEnd: 1, expected: epicStreamsCell });
  return cells;
}

/** Ошибки ячеек: ячейка строки эпика (без пробелов по краям) должна совпасть с `epicTasksCell` и `epicStreamsCell`. */
export function checkEpicCells(markdown, tasks) {
  const errors = [];
  const cells = epicCells(markdown);
  for (const line of markdown.split(/\r?\n/)) {
    const epic = EPIC_ROW_RE.exec(line)?.[1];
    if (epic === undefined) continue;
    for (const cell of cells) {
      const bounds = cellBounds(line, cell.fromEnd);
      if (bounds === null) continue;
      const expected = cell.expected(epic, tasks);
      if (line.slice(bounds.start + 1, bounds.end).trim() !== expected) {
        errors.push(`epics.md: эпик ${epic} — ячейка «${cell.name}» не совпадает с реестром, поправит pnpm task fix; ожидается: ${expected}`);
      }
    }
  }
  return errors;
}

/** Тот же текст с исправленными ячейками в строках эпиков (`| <ячейка> |`); остальное не трогается. */
export function fixEpicCells(markdown, tasks) {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const cells = epicCells(markdown);
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const epic = EPIC_ROW_RE.exec(line)?.[1];
      if (epic === undefined) return line;
      // Границы считаются справа и от содержимого соседней ячейки не зависят, порядок правки не важен.
      let fixed = line;
      for (const cell of cells) {
        const bounds = cellBounds(fixed, cell.fromEnd);
        if (bounds !== null) fixed = `${fixed.slice(0, bounds.start + 1)} ${cell.expected(epic, tasks)} ${fixed.slice(bounds.end)}`;
      }
      return fixed;
    })
    .join(eol);
}
