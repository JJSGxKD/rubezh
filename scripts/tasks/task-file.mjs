/**
 * Файл задачи реестра (tasks/README.md, «Поля задачи»): разбор шапки и
 * проверка полей. Чистые функции без обращения к диску и git — их покрывают
 * тесты (scripts/test/tasks-file.test.ts).
 *
 * Шапка — строгое подмножество YAML, а не YAML: пары «ключ: значение», пустое
 * значение, `null`, строчный список `[a, b]` и список строками `  - элемент`.
 * Своего разбора достаточно, а библиотека разбора и права на новую
 * зависимость в этот инструмент не нужны.
 */

export const FILE_NAME_RE = /^(T-\d{4})-[a-z0-9-]+\.md$/;
const ID_RE = /^T-\d{4}$/;

/** Владелец и репозиторий в адресе значка: его читает shields.io из ветки task-board. */
export const REPOSITORY = "JJSGxKD/rubezh";
export const STATUS_URL = `https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/${REPOSITORY}/task-board/status`;
const EPIC_RE = /^E\d+$/;

export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const STATUSES = ["draft", "ready", "in-progress", "done", "cancelled"];
export const SIZES = ["S", "M"];
export const RUNNERS = ["any", "local", "human"];
export const RELEASES = ["none", "patch", "minor"];
export const EFFORTS = ["low", "medium", "high", "extra"];
/** Повторяет таблицу исполнителей в tasks/README.md («Исполнители и effort»): новый исполнитель — правка и там, и здесь. */
export const EXECUTORS = ["sonnet-5.5"];

/** Все поля шапки в порядке из tasks/README.md; других полей у задачи нет. */
export const FIELDS = [
  "id",
  "title",
  "epic",
  "priority",
  "status",
  "owner",
  "size",
  "depends_on",
  "zones",
  "shared",
  "runner",
  "executor",
  "effort",
  "release",
  "design",
];

const KEY_VALUE_RE = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ ](.*))?$/;
const LIST_ITEM_RE = /^ {2}- (.*)$/;

function startsWithQuote(value) {
  return value.startsWith('"') || value.startsWith("'");
}

function parseInlineList(value, lineNo, errors) {
  if (!value.endsWith("]")) {
    errors.push(`строка ${lineNo}: строчный список не закрыт «]»`);
    return [];
  }
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  const items = inner.split(",").map((item) => item.trim());
  for (const item of items) {
    if (item === "" || startsWithQuote(item)) {
      errors.push(`строка ${lineNo}: в строчном списке нужны элементы без кавычек, разделённые запятой`);
      return [];
    }
  }
  return items;
}

/**
 * Разбирает текст файла задачи: `{ data, body, errors }`. Ошибки называют
 * номер строки файла (с единицы); при ошибках `data` может быть неполным.
 */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  const errors = [];
  const data = {};

  if (lines[0] !== "---") {
    return { data, body: text, errors: ["строка 1: файл должен начинаться с шапки — строки «---»"] };
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return { data, body: "", errors: ["строка 1: шапка не закрыта строкой «---»"] };
  }

  let openKey = null;
  for (let index = 1; index < end; index += 1) {
    const lineNo = index + 1;
    const line = lines[index];
    if (line.trim() === "") continue;
    if (/^\s*\t/.test(line)) {
      errors.push(`строка ${lineNo}: отступ табуляцией не допускается, нужны пробелы`);
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item !== null) {
      const value = item[1].trim();
      if (openKey === null) {
        errors.push(`строка ${lineNo}: элемент списка без ключа над ним`);
      } else if (startsWithQuote(value) || value === "") {
        errors.push(`строка ${lineNo}: элемент списка должен быть без кавычек и не пустым`);
      } else {
        if (data[openKey] === "") data[openKey] = [];
        data[openKey].push(value);
      }
      continue;
    }

    if (/^\s/.test(line)) {
      errors.push(`строка ${lineNo}: вложенные значения не поддерживаются — только «  - элемент» под ключом`);
      continue;
    }

    const pair = KEY_VALUE_RE.exec(line);
    if (pair === null) {
      errors.push(`строка ${lineNo}: ожидается «ключ: значение», а не «${line.trim()}»`);
      openKey = null;
      continue;
    }

    const key = pair[1];
    const value = (pair[2] ?? "").trim();
    openKey = null;
    if (Object.hasOwn(data, key)) {
      errors.push(`строка ${lineNo}: ключ ${key} повторяется`);
    } else if (value === "") {
      data[key] = "";
      openKey = key;
    } else if (value === "null") {
      data[key] = null;
    } else if (value.startsWith("[")) {
      data[key] = parseInlineList(value, lineNo, errors);
    } else if (startsWithQuote(value)) {
      errors.push(`строка ${lineNo}: кавычки в значении не допускаются`);
    } else if (value === "|" || value === ">") {
      errors.push(`строка ${lineNo}: многострочные значения не поддерживаются`);
    } else {
      data[key] = value;
    }
  }

  return { data, body: lines.slice(end + 1).join("\n"), errors };
}

function joinOr(values) {
  return values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")} или ${values.at(-1)}`;
}

function show(value) {
  return Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
}

function pathProblem(path) {
  if (path.startsWith("/")) return "путь должен быть относительным, без ведущего «/»";
  if (path.includes("\\")) return "в пути нужен «/», а не «\\»";
  if (path.split("/").includes("..")) return "«..» в пути не допускается";
  return null;
}

/** Значок задачи в чужой строке значков (зависимость, ячейка эпика): подпись — её id, ссылка — на файл. */
export function taskBadge(id, fileName) {
  return `[![${id}](${STATUS_URL}/${id}.json&label=${id})](${fileName})`;
}

/**
 * Строка значков под заголовком задачи: статус самой задачи и по значку на
 * каждую зависимость в порядке `depends_on`. Ссылка зависимости ведёт на её
 * файл, поэтому `fileNames` — `{ "T-NNNN": "T-NNNN-slug.md" }` по реестру.
 */
export function badgeLine(task, fileNames) {
  const badges = [`[![статус](${STATUS_URL}/${task.id}.json)](README.md#значки-статуса)`];
  for (const id of task.depends_on) {
    const dependencyFile = fileNames[id];
    if (dependencyFile === undefined) throw new Error(`badgeLine: для зависимости ${id} не передано имя файла`);
    badges.push(taskBadge(id, dependencyFile));
  }
  return badges.join(" ");
}

/**
 * Текст файла задачи с верной строкой значков `expected`: устаревшая строка
 * (начинается с `[![статус](`) под заголовком «# T-NNNN. …» заменяется на
 * месте, а если её нет — вставляется под заголовком с пустыми строками
 * вокруг. Шапка, остальной текст и переводы строк (LF или CRLF) не
 * меняются; заголовка нет — текст как был, об этом скажет `pnpm task check`.
 */
export function withBadgeLine(text, expected) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^# T-\d{4}\. /.test(line));
  if (heading === -1) return text;

  let next = heading + 1;
  while (next < lines.length && lines[next].trim() === "") next += 1;
  if (lines[next]?.startsWith("[![статус](") === true) {
    lines[next] = expected;
  } else {
    lines.splice(heading + 1, next - heading - 1, "", expected, "");
  }
  return lines.join(eol);
}

/** Ошибка строки значков или `null`: сразу под заголовком «# T-NNNN. …» должна стоять ровно `badgeLine`. */
function badgeProblem(data, body, fileNames) {
  // Зависимости нет в реестре — файл для ссылки взять негде; об этом скажет проверка реестра.
  if (data.depends_on.some((id) => fileNames[id] === undefined)) return null;
  const expected = badgeLine(data, fileNames);
  const lines = body.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!new RegExp(`^# ${data.id}\\. .+`).test(lines[0] ?? "")) {
    return `ожидается заголовок «# ${data.id}. …» и под ним строка значков: ${expected}; поправит pnpm task fix`;
  }
  if (lines[1] !== expected) {
    return `под заголовком нет строки значков или она не совпадает с depends_on; ожидается: ${expected}; поправит pnpm task fix`;
  }
  return null;
}

/**
 * Проверяет одну задачу: `fileName` — имя файла без каталога, `data` — то, что
 * вернул `parseFrontmatter`. Возвращает список ошибок вида
 * `T-0003-x.md: поле priority — ожидается P0, P1, P2 или P3, а не P5`.
 *
 * `context` — `{ body, fileNames }`: текст файла после шапки и имена файлов
 * реестра (см. `badgeLine`). Без него строка значков не проверяется: так
 * проверяется шапка отдельно от тела, например при захвате.
 */
export function validateTask(fileName, data, context) {
  const errors = [];
  const fail = (field, message) => errors.push(`${fileName}: поле ${field} — ${message}`);

  const nameMatch = FILE_NAME_RE.exec(fileName);
  if (nameMatch === null) {
    errors.push(`${fileName}: имя файла должно быть T-NNNN-slug.md (slug — строчная латиница, цифры, дефис)`);
  }

  for (const field of FIELDS) {
    if (!Object.hasOwn(data, field)) fail(field, "отсутствует");
  }
  for (const field of Object.keys(data)) {
    if (!FIELDS.includes(field)) fail(field, "лишнее, такого поля у задачи нет");
  }

  const text = (field) => (typeof data[field] === "string" ? data[field] : null);
  const expectEnum = (field, allowed) => {
    if (!Object.hasOwn(data, field)) return;
    if (!allowed.includes(data[field])) fail(field, `ожидается ${joinOr(allowed)}, а не ${show(data[field])}`);
  };

  if (Object.hasOwn(data, "id")) {
    if (text("id") === null || !ID_RE.test(data.id)) fail("id", `ожидается T-NNNN, а не ${show(data.id)}`);
    else if (nameMatch !== null && nameMatch[1] !== data.id) fail("id", `${data.id} не совпадает с началом имени файла (${nameMatch[1]})`);
  }
  if (Object.hasOwn(data, "title") && (text("title") === null || data.title === "")) fail("title", "ожидается непустая строка");
  if (Object.hasOwn(data, "epic") && (text("epic") === null || !EPIC_RE.test(data.epic))) {
    fail("epic", `ожидается номер эпика вида E1, а не ${show(data.epic)}`);
  }
  expectEnum("priority", PRIORITIES);
  expectEnum("status", STATUSES);
  expectEnum("size", SIZES);
  expectEnum("runner", RUNNERS);
  expectEnum("executor", EXECUTORS);
  expectEnum("effort", EFFORTS);
  expectEnum("release", RELEASES);

  if (Object.hasOwn(data, "owner") && text("owner") === null) fail("owner", `ожидается строка или пусто, а не ${show(data.owner)}`);
  if (Object.hasOwn(data, "design") && data.design !== null && (text("design") === null || data.design === "")) {
    fail("design", `ожидается путь к макету или null, а не ${show(data.design)}`);
  }

  if (Object.hasOwn(data, "depends_on")) {
    if (!Array.isArray(data.depends_on)) fail("depends_on", "ожидается список");
    else for (const id of data.depends_on) if (!ID_RE.test(id)) fail("depends_on", `ожидается T-NNNN, а не ${id}`);
  }

  for (const field of ["zones", "shared"]) {
    if (!Object.hasOwn(data, field)) continue;
    if (!Array.isArray(data[field])) {
      fail(field, "ожидается список путей");
      continue;
    }
    for (const path of data[field]) {
      const problem = pathProblem(path);
      if (problem !== null) fail(field, `${problem}: ${path}`);
    }
  }

  const working = data.status === "ready" || data.status === "in-progress";
  if (working && Array.isArray(data.zones) && data.zones.length === 0) {
    fail("zones", `у задачи в статусе ${data.status} зоны не могут быть пустыми`);
  }
  if (data.status === "in-progress" && text("owner") === "") fail("owner", "у задачи in-progress должно быть указано, кто её взял");

  if (context !== undefined && errors.length === 0) {
    const problem = badgeProblem(data, context.body, context.fileNames);
    if (problem !== null) errors.push(`${fileName}: ${problem}`);
  }

  return errors;
}
