import { REPOSITORY, STATUS_URL, taskBadge } from "./task-file.mjs";

/**
 * Ячейки эпиков в tasks/epics.md (tasks/README.md, «Значки статуса»): «Задачи» —
 * живые значки задач эпика вместо номеров, которые отстали бы от доски в первый
 * же день. Раздел «Потоки по эпикам» под таблицей — значок на эпик, какие потоки
 * автопотока запускать для него сейчас: по строке на эпик, потому что в ячейке
 * таблицы широкие значки нечитаемы. Чистые функции над текстом, тесты —
 * scripts/test/tasks-epics.test.ts.
 */

/** Строка эпика узнаётся так же, как в `parseEpics`: «**E<число>.» в первой ячейке. */
const EPIC_ROW_RE = /^\|\s*\*\*(E\d+)\./;

/** Название эпика из первой ячейки строки: «E10. Бой». */
const EPIC_TITLE_RE = /^\|\s*\*\*(E\d+\.[^*]*)\*\*/;

/** Раздел «Потоки сейчас» на странице доски — куда ведёт значок потоков. */
export const BOARD_STREAMS_URL = `https://github.com/${REPOSITORY}/blob/task-board/README.md#потоки-сейчас`;

/** Метки раздела «Потоки по эпикам»: текст между ними ставит `pnpm task fix`. Нет меток — нет и раздела. */
export const STREAMS_START = "<!-- потоки по эпикам: ставит pnpm task fix -->";
export const STREAMS_END = "<!-- конец потоков по эпикам -->";

/** Значки задач эпика по возрастанию id через пробел; задач нет — «—». Статус задачи не важен: значок скажет сам. */
export function epicTasksCell(epicId, tasks) {
  const badges = tasks
    .filter((task) => task.epic === epicId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((task) => taskBadge(task.id, task.fileName));
  return badges.length === 0 ? "—" : badges.join(" ");
}

/**
 * Раздел «Потоки по эпикам»: строка на эпик в порядке таблицы — название и значок.
 * Картинку значка читает `status/epic-<эпик>.json` ветки task-board (его пишет
 * `pnpm task status-json`), ссылка ведёт на раздел «Потоки сейчас». Эпик без
 * задач пропускается: запускать для него нечего.
 */
export function epicStreamsBlock(markdown, tasks) {
  const lines = [];
  for (const line of markdown.split(/\r?\n/)) {
    const epic = EPIC_ROW_RE.exec(line)?.[1];
    const title = EPIC_TITLE_RE.exec(line)?.[1]?.trim();
    if (epic === undefined || title === undefined || !tasks.some((task) => task.epic === epic)) continue;
    lines.push(`- **${title}** — [![потоки](${STATUS_URL}/epic-${epic}.json)](${BOARD_STREAMS_URL})`);
  }
  return lines.join("\n");
}

/** Границы текста между метками раздела потоков или `null`, если меток нет. */
function streamsSection(markdown) {
  const start = markdown.indexOf(STREAMS_START);
  const end = markdown.indexOf(STREAMS_END);
  if (start === -1 || end === -1 || end < start) return null;
  return { from: start + STREAMS_START.length, to: end };
}

/** Границы ячейки, считая справа (0 — последняя): между «|», которые стоят на этом месте с конца. */
function cellBounds(line, fromEnd) {
  const pipes = [];
  for (let index = line.length - 1; index >= 0 && pipes.length < fromEnd + 2; index -= 1) {
    if (line[index] === "|") pipes.push(index);
  }
  return pipes.length < fromEnd + 2 ? null : { start: pipes[fromEnd + 1], end: pipes[fromEnd] };
}

/** Ячейки эпика, что проверяются и правятся. */
const EPIC_CELLS = [{ name: "Задачи", fromEnd: 0, expected: epicTasksCell }];

/** Ошибки: ячейка «Задачи» должна совпасть с `epicTasksCell`, раздел потоков — с `epicStreamsBlock`. */
export function checkEpicCells(markdown, tasks) {
  const errors = [];
  for (const line of markdown.split(/\r?\n/)) {
    const epic = EPIC_ROW_RE.exec(line)?.[1];
    if (epic === undefined) continue;
    for (const cell of EPIC_CELLS) {
      const bounds = cellBounds(line, cell.fromEnd);
      if (bounds === null) continue;
      const expected = cell.expected(epic, tasks);
      if (line.slice(bounds.start + 1, bounds.end).trim() !== expected) {
        errors.push(`epics.md: эпик ${epic} — ячейка «${cell.name}» не совпадает с реестром, поправит pnpm task fix; ожидается: ${expected}`);
      }
    }
  }
  const section = streamsSection(markdown);
  if (section !== null && markdown.slice(section.from, section.to).trim() !== epicStreamsBlock(markdown, tasks)) {
    errors.push("epics.md: раздел «Потоки по эпикам» не совпадает с реестром, поправит pnpm task fix");
  }
  return errors;
}

/** Тот же текст с исправленными ячейками в строках эпиков и разделом потоков; остальное не трогается. */
export function fixEpicCells(markdown, tasks) {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const fixed = markdown
    .split(/\r?\n/)
    .map((line) => {
      const epic = EPIC_ROW_RE.exec(line)?.[1];
      if (epic === undefined) return line;
      let result = line;
      for (const cell of EPIC_CELLS) {
        const bounds = cellBounds(result, cell.fromEnd);
        if (bounds !== null) result = `${result.slice(0, bounds.start + 1)} ${cell.expected(epic, tasks)} ${result.slice(bounds.end)}`;
      }
      return result;
    })
    .join(eol);
  const section = streamsSection(fixed);
  if (section === null) return fixed;
  const block = epicStreamsBlock(fixed, tasks).split("\n").join(eol);
  return `${fixed.slice(0, section.from)}${eol}${block}${eol}${fixed.slice(section.to)}`;
}
