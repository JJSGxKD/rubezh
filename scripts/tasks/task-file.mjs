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

import { posix } from "node:path";
import { minimumReleaseLevel, parsePrTitle } from "../release/pr-check.mjs";
import { compareReleaseLevels } from "../release/semver.mjs";
import { matches } from "./zones.mjs";

export const FILE_NAME_RE = /^(T-\d{4})-[a-z0-9-]+\.md$/;
const ID_RE = /^T-\d{4}$/;

/** Владелец и репозиторий в адресе значка: его читает shields.io из ветки task-board. */
export const REPOSITORY = "JJSGxKD/rubezh";
export const STATUS_URL = `https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/${REPOSITORY}/task-board/status`;
const EPIC_RE = /^E\d+$/;

export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const STATUSES = ["draft", "ready", "in-progress", "done", "cancelled"];
export const SIZES = ["S", "M"];
export const RUNNERS = ["any", "local", "owner", "human"];
export const RELEASES = ["none", "patch", "minor"];
/** Кто вливает PR задачи: `lead` — тимлид (умолчание), `self` — сам поток (Р176, tasks/README.md, «Самостоятельный мердж»). */
export const MERGES = ["self", "lead"];
export const EFFORTS = ["low", "medium", "high", "extra"];
/** Повторяет таблицу исполнителей в tasks/README.md («Исполнители и effort»): новый исполнитель — правка и там, и здесь. */
export const EXECUTORS = ["sonnet-5.5", "haiku-5.5"];

/** Все поля шапки в порядке из tasks/README.md; других полей у задачи нет. */
export const FIELDS = [
  "id",
  "title",
  "epic",
  "priority",
  "status",
  "owner",
  "author",
  "size",
  "depends_on",
  "zones",
  "shared",
  "runner",
  "executor",
  "effort",
  "release",
  "merge",
  "design",
  "batch",
];

/** Необязательные поля: задачи, заведённые до них, остаются как были. */
export const OPTIONAL_FIELDS = new Set(["author", "batch", "merge"]);

const SELF_MERGE_FORBIDDEN_MODULES = ["payments", "wallet", "shop", "auth", "ads", "referrals", "partners", "restrictions", "roles", "secrets", "antifraud", "runs"];

/**
 * Пути, где `merge: self` запрещён (Р176): деньги, авторизация, миграции,
 * конкурентность, антифрод, прод и экраны игрока. Повторяет
 * tasks/README.md, «Самостоятельный мердж»: новый запрет — правка и там, и здесь.
 */
export const SELF_MERGE_FORBIDDEN = [
  "backend/api/prisma/**",
  ...SELF_MERGE_FORBIDDEN_MODULES.map((module) => `backend/api/src/modules/${module}/**`),
  "backend/api/src/platforms/**",
  "infra/**",
  ".github/**",
  "packages/app-shell/src/screens/**",
  "apps/web-*/**",
  "packages/adapter-*/**",
];

/** Начало текста ошибки `merge: self`; за ним через двоеточие идёт, что именно мешает. */
export const SELF_MERGE_MESSAGE = "merge: self — только для задач без денег, авторизации, миграций, конкурентности, антифрода, прода и экранов игрока (Р176)";

/**
 * Задевает ли путь или шаблон зоны шаблон запрета. Зона шире запрета
 * (`backend/**`) тоже задевает его, поэтому проверяются оба направления: зона
 * как путь под шаблон запрета и условный путь запрета под шаблон зоны.
 * Подстановка в середине пути (звёздочка вместо имени модуля) может проскользнуть: это
 * страховка, а не замена суждения тимлида.
 */
function touchesForbidden(zone, forbidden) {
  if (matches(zone, [forbidden])) return true;
  const sample = forbidden.replaceAll("**", "x").replaceAll("*", "x");
  if (matches(sample, [zone])) return true;
  // Каталог без шаблонов и без «/» на конце: `backend/api/prisma`.
  return !/[*?]/.test(zone) && forbidden.startsWith(`${zone.replace(/\/$/, "")}/`);
}

/**
 * Что мешает `merge: self` у задачи: список причин, пустой — ничего. Читает
 * `effort`, `runner`, `zones` и `shared`; значение самого `merge` не смотрит.
 */
export function selfMergeProblems(data) {
  const reasons = [];
  if (data.effort === "extra") reasons.push("effort: extra");
  if (data.runner === "owner" || data.runner === "human") reasons.push(`runner: ${data.runner}`);
  for (const field of ["zones", "shared"]) {
    if (!Array.isArray(data[field])) continue;
    for (const path of data[field]) {
      if (typeof path !== "string") continue;
      const forbidden = SELF_MERGE_FORBIDDEN.find((pattern) => touchesForbidden(path, pattern));
      if (forbidden !== undefined) reasons.push(`${field}: ${path} задевает ${forbidden}`);
    }
  }
  return reasons;
}

/** Пачка очереди, с которой задача уходит в main (docs/38-release-plan.md): целое число от 1 без ведущих нулей. */
export const BATCH_RE = /^[1-9]\d*$/;

/**
 * Номер пачки задачи или `null`, если пачки нет либо поле не число: в шапке
 * это строка (`batch: 2`), разбор значений своего типа не делает.
 */
export function batchNumber(task) {
  const raw = task?.batch;
  return typeof raw === "string" && BATCH_RE.test(raw) ? Number(raw) : null;
}

/** Поля, которые заменены другими: старое имя больше не допускается, а ошибка называет замену. */
const REPLACED_FIELDS = { version: "поле version заменено полем batch — пачкой очереди, tasks/README.md" };

/** Кодовое имя роли (tasks/README.md, «Роли и кодовые имена»): `claude-lead-1`, `claude-review-2`. */
const CODE_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

/**
 * `owner` — поток, взявший задачу: «аккаунт / исполнитель / уровень»
 * (`claude-3 / sonnet-5.5 / medium`). У задач, взятых до потоков, уровня нет —
 * `effort: null`. Не похоже на владельца — `null`.
 */
export function parseOwner(owner) {
  const parts = String(owner ?? "")
    .split(" / ")
    .map((part) => part.trim());
  if (parts.some((part) => part === "") || parts.length < 2 || parts.length > 3) return null;
  return { account: parts[0], executor: parts[1], effort: parts[2] ?? null };
}

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

/** Значок задачи в чужой строке значков (зависимость, ячейка эпика): подпись — её id, ссылка `link` — на файл. */
export function taskBadge(id, link) {
  return `[![${id}](${STATUS_URL}/${id}.json&label=${id})](${link})`;
}

/**
 * Ссылка из файла `fromPath` на `toPath`: оба — пути от `tasks/` (`T-0001-x.md`,
 * `archive/T-0001-x.md`), разделитель всегда «/». Из `tasks/` в архив —
 * `archive/T-…md`, из архива наверх — `../T-…md`, внутри архива — `T-…md`.
 */
export function relativeTaskLink(fromPath, toPath) {
  return posix.relative(posix.dirname(fromPath), toPath);
}

/**
 * Строка значков под заголовком задачи: статус самой задачи и по значку на
 * каждую зависимость в порядке `depends_on`. Ссылки считаются от папки файла
 * задачи (`task.path`), поэтому `paths` — `{ "T-NNNN": "T-NNNN-slug.md" }` или
 * `"archive/T-NNNN-slug.md"` по реестру.
 */
export function badgeLine(task, paths) {
  const from = task.path ?? paths[task.id] ?? "";
  const badges = [`[![статус](${STATUS_URL}/${task.id}.json)](${relativeTaskLink(from, "README.md")}#значки-статуса)`];
  for (const id of task.depends_on) {
    const dependencyPath = paths[id];
    if (dependencyPath === undefined) throw new Error(`badgeLine: для зависимости ${id} не передан путь файла`);
    badges.push(taskBadge(id, relativeTaskLink(from, dependencyPath)));
  }
  return badges.join(" ");
}

/** Цель ссылки на файл задачи: префикс (пусто, `../`, `archive/`, `../archive/`), имя, необязательный якорь. */
const TASK_LINK_RE = /\]\(((?:\.\.\/)?(?:archive\/)?)(T-(\d{4}))-[a-z0-9-]+\.md(#[^)]*)?\)/g;

/**
 * Текст, где каждая ссылка на файл задачи переписана на верный путь по реестру
 * (`paths`) от файла `fromPath`; якорь сохраняется. Ссылки на чужие пути,
 * внешние адреса и задачи вне реестра не трогаются.
 */
export function withTaskLinks(text, fromPath, paths) {
  return text.replace(TASK_LINK_RE, (whole, _prefix, id, _digits, anchor) => {
    const target = paths[id];
    if (target === undefined) return whole;
    return `](${relativeTaskLink(fromPath, target)}${anchor ?? ""})`;
  });
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
function badgeProblem(data, body, paths, path) {
  // Зависимости нет в реестре — файл для ссылки взять негде; об этом скажет проверка реестра.
  if (data.depends_on.some((id) => paths[id] === undefined)) return null;
  const expected = badgeLine({ ...data, path: path ?? paths[data.id] }, paths);
  const lines = body.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!new RegExp(`^# ${data.id}\\. .+`).test(lines[0] ?? "")) {
    return `ожидается заголовок «# ${data.id}. …» и под ним строка значков: ${expected}; поправит pnpm task fix`;
  }
  if (lines[1] !== expected) {
    return `под заголовком нет строки значков или она не совпадает с depends_on; ожидается: ${expected}; поправит pnpm task fix`;
  }
  return null;
}

const PR_TITLE_LINE_RE = /^- \*\*Заголовок:\*\* `(.+)`\s*$/;
const PR_LABEL_LINE_RE = /^- \*\*Метка:\*\* `release: (\S+)`\s*$/;

/** Строки раздела «## PR» — от него до следующего `## ` или конца файла. */
function prSectionLines(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## PR\s*$/.test(line));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Раздел «PR» спецификации (tasks/T-0146) должен совпадать с шапкой: в нём
 * есть заголовок и метка, метка равна полю `release`, а поле `release` не
 * ниже того, что требует тип заголовка. Иначе исполнитель берёт метку из
 * одного места, и PR уходит на доработку уже после открытия.
 *
 * Вызывает `validateTask` только для `ready` и `in-progress`: у черновика
 * спецификация не дописана, закрытая задача историю не меняет.
 */
export function checkPrSection(fileName, data, body) {
  const prefix = `${fileName}: раздел «PR»`;
  const lines = prSectionLines(body);
  const titleMatch = lines.map((line) => PR_TITLE_LINE_RE.exec(line)).find((match) => match !== null);
  const labelMatch = lines.map((line) => PR_LABEL_LINE_RE.exec(line)).find((match) => match !== null);
  const errors = [];

  if (titleMatch === undefined) errors.push(`${prefix} — нет строки «Заголовок»`);
  if (labelMatch === undefined) errors.push(`${prefix} — нет строки «Метка»`);

  if (titleMatch !== undefined) {
    const title = parsePrTitle(titleMatch[1]);
    if (!title.valid) {
      errors.push(`${prefix} — заголовок: ${title.errors.join("; ")}`);
    } else {
      const minimum = minimumReleaseLevel(title, 0);
      if (compareReleaseLevels(data.release, minimum) < 0) {
        errors.push(`${fileName}: поле release — ${data.release} ниже ${minimum} для заголовка ${titleMatch[1]}`);
      }
    }
  }

  if (labelMatch !== undefined && labelMatch[1] !== data.release) {
    errors.push(`${fileName}: поле release — в шапке ${data.release}, в разделе «PR» ${labelMatch[1]}`);
  }

  return errors;
}

/**
 * Проверяет одну задачу: `fileName` — имя файла без каталога, `data` — то, что
 * вернул `parseFrontmatter`. Возвращает список ошибок вида
 * `T-0003-x.md: поле priority — ожидается P0, P1, P2 или P3, а не P5`.
 *
 * `context` — `{ body, paths, path }`: текст файла после шапки, пути файлов
 * реестра и путь самой задачи (см. `badgeLine`). Без него строка значков не проверяется: так
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
    if (!Object.hasOwn(data, field) && !OPTIONAL_FIELDS.has(field)) fail(field, "отсутствует");
  }
  for (const field of Object.keys(data)) {
    if (Object.hasOwn(REPLACED_FIELDS, field)) errors.push(`${fileName}: ${REPLACED_FIELDS[field]}`);
    else if (!FIELDS.includes(field)) fail(field, "лишнее, такого поля у задачи нет");
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
  expectEnum("merge", MERGES);

  if (Object.hasOwn(data, "owner") && text("owner") === null) fail("owner", `ожидается строка или пусто, а не ${show(data.owner)}`);
  if (Object.hasOwn(data, "batch") && (text("batch") === null || !BATCH_RE.test(data.batch))) {
    fail("batch", `ожидается номер пачки очереди — целое число от 1, например 2, а не ${show(data.batch)}`);
  }
  if (Object.hasOwn(data, "author") && (text("author") === null || !CODE_NAME_RE.test(data.author))) {
    fail("author", `ожидается кодовое имя вида claude-lead-1, а не ${show(data.author)}`);
  }
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

  if (data.merge === "self") {
    const reasons = selfMergeProblems(data);
    if (reasons.length > 0) errors.push(`${fileName}: ${SELF_MERGE_MESSAGE}: ${reasons.join("; ")}`);
  }

  const working = data.status === "ready" || data.status === "in-progress";
  if (working && Array.isArray(data.zones) && data.zones.length === 0) {
    fail("zones", `у задачи в статусе ${data.status} зоны не могут быть пустыми`);
  }
  if (data.status === "in-progress" && text("owner") === "") fail("owner", "у задачи in-progress должно быть указано, кто её взял");

  if (context !== undefined && (data.status === "ready" || data.status === "in-progress")) {
    errors.push(...checkPrSection(fileName, data, context.body));
  }

  if (context !== undefined && errors.length === 0) {
    const problem = badgeProblem(data, context.body, context.paths ?? context.fileNames, context.path);
    if (problem !== null) errors.push(`${fileName}: ${problem}`);
  }

  return errors;
}
