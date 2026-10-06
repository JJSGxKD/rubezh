import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { COLUMNS, classify, nextTasks } from "./board.mjs";
import { BASE, ROOT, fetchOrigin, git, loadRegistryState, readBranchFile, tryGit } from "./git-io.mjs";
import { checkRegistry } from "./registry.mjs";
import { parseFrontmatter, validateTask } from "./task-file.mjs";
import { outOfZone } from "./zones.mjs";

/**
 * `pnpm task` — доска задач, захват и проверка зон (tasks/README.md).
 * Логика — чистые функции в соседних файлах, покрытые тестами; здесь только
 * разбор командной строки, вывод и вызовы git.
 */

const USAGE = `Команды:
  pnpm task check                          проверить реестр tasks/ в рабочей копии
  pnpm task board [--all]                  доска из origin/dev (--all — и отменённые)
  pnpm task next [--runner any|local] [--executor <модель>]
                                           свободные задачи, лучшая — первой
  pnpm task claim T-NNNN --owner "<аккаунт / модель>"
                                           захватить задачу веткой task/T-NNNN
  pnpm task release T-NNNN --yes           отдать задачу: удалить ветку task/T-NNNN
  pnpm task diff-check [--base <ref>]      файлы PR задачи — только в её зонах`;

const TASK_ID_RE = /^T-\d{4}$/;
const BOOLEAN_FLAGS = new Set(["yes", "all"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`у флага --${name} нет значения`);
      flags[name] = value;
      index += 1;
    }
  }
  return { positional, flags };
}

function taskLine({ task, reason, pr }, owner) {
  const parts = [task.id.padEnd(7), `${task.priority} ${task.size} ${task.runner}`.padEnd(14), `${task.executor}/${task.effort}`.padEnd(18), task.title];
  const notes = [];
  if (owner !== undefined) notes.push(`взял: ${owner}`);
  if (pr !== undefined) notes.push(`PR ${String(pr)}`);
  if (reason !== undefined) notes.push(reason);
  return `  ${parts.join("  ")}${notes.length > 0 ? `\n${" ".repeat(10)}↳ ${notes.join("; ")}` : ""}`;
}

/** Кто взял задачу: поле owner из её ветки на origin (на dev оно пустое — статус живёт в ветке). */
function ownerOf(task) {
  const text = readBranchFile(task.id, task.fileName);
  const owner = text === null ? "" : (parseFrontmatter(text).data.owner ?? "");
  return owner === "" ? "неизвестно" : owner;
}

function printState(state) {
  for (const error of state.errors) console.error(`предупреждение: в реестре на ${BASE} ошибка — ${error}`);
  if (state.prs === null) {
    console.error("предупреждение: gh недоступен или не авторизован — «На ревью» слита с «В работе»");
  }
}

function loadBoard() {
  fetchOrigin();
  const state = loadRegistryState();
  printState(state);
  return { state, board: classify(state.tasks, state.taken, state.prs, state.repoFiles, state.epicOrder) };
}

function runBoard(flags) {
  const { board } = loadBoard();
  for (const column of COLUMNS) {
    if (column.key === "cancelled" && flags.all !== true) continue;
    const entries = board[column.key];
    console.log(`\n${column.title} (${String(entries.length)})`);
    const busy = column.key === "inProgress" || column.key === "review";
    for (const entry of entries) console.log(taskLine(entry, busy ? ownerOf(entry.task) : undefined));
  }
}

function runNext(flags) {
  const { board } = loadBoard();
  const entries = nextTasks(board.free, { runner: flags.runner ?? "any", executor: flags.executor });
  if (entries.length === 0) {
    console.log("Свободных задач с такими условиями нет. Всё занято или заблокировано — `pnpm task board`.");
    return;
  }
  console.log("Свободные задачи, лучшая — первой:");
  for (const entry of entries) console.log(taskLine(entry));
}

function runCheck() {
  const dir = join(ROOT, "tasks");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  const errors = checkRegistry(files, readFileSync(join(dir, "epics.md"), "utf8"));
  if (errors.length > 0) {
    for (const error of errors) console.error(`ошибка  ${error}`);
    process.exit(1);
  }
  console.log(`Реестр задач в порядке: ${String(files.filter((file) => file.name.startsWith("T-")).length)} задач.`);
}

/** Строки `status` и `owner` в шапке; остальное в файле не трогаем. */
function withClaim(text, owner) {
  const end = text.indexOf("\n---", 4);
  const header = text
    .slice(0, end)
    .replace(/^status: .*$/m, "status: in-progress")
    .replace(/^owner:.*$/m, `owner: ${owner}`);
  return header + text.slice(end);
}

function runClaim(positional, flags) {
  const id = positional[0];
  if (id === undefined || !TASK_ID_RE.test(id)) fail("Укажи задачу: pnpm task claim T-NNNN --owner \"аккаунт / модель\"");
  const owner = flags.owner;
  if (owner === undefined || !owner.includes(" / ")) fail("Укажи владельца в виде «аккаунт / модель»: --owner \"claude-2 / sonnet-5.5\"");
  const model = owner.split(" / ").at(-1).trim();

  if (git(["status", "--porcelain"]) !== "") fail("Рабочая копия не чистая: закоммить или убери изменения, потом бери задачу.");

  const { board } = loadBoard();
  const all = COLUMNS.flatMap((column) => board[column.key].map((entry) => ({ ...entry, column })));
  const found = all.find((entry) => entry.task.id === id);
  if (found === undefined) fail(`Задачи ${id} нет в ${BASE}.`);
  if (found.column.key !== "free") {
    fail(`Задача ${id} не свободна: колонка «${found.column.title}»${found.reason === undefined ? "" : ` — ${found.reason}`}.`);
  }
  const { task } = found;
  if (task.executor !== model) fail(`Задача для ${task.executor}, а не для ${model}: ${id} не берётся (tasks/README.md, «Исполнители и effort»).`);

  const branch = `task/${id}`;
  if (tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    fail(`Локальная ветка ${branch} уже есть: удали её (git branch -D ${branch}) или вернись на неё и продолжай работу.`);
  }

  const previous = git(["branch", "--show-current"]) || git(["rev-parse", "HEAD"]);
  const returnBack = () => {
    tryGit(["switch", previous]);
    tryGit(["branch", "-D", branch]);
  };

  git(["switch", "-c", branch, BASE]);
  const file = join(ROOT, "tasks", task.fileName);
  const updated = withClaim(readFileSync(file, "utf8"), owner);
  const parsed = parseFrontmatter(updated);
  const problems = [...parsed.errors, ...validateTask(task.fileName, parsed.data)];
  if (problems.length > 0) {
    returnBack();
    fail(`Файл задачи после захвата не прошёл бы проверку (owner с кавычками или пустой?):\n${problems.join("\n")}`);
  }
  writeFileSync(file, updated);
  git(["commit", "--quiet", "-m", `chore(tasks): Взять ${id} в работу`, "--", `tasks/${task.fileName}`]);

  const pushed = tryGit(["push", "origin", `HEAD:refs/heads/${branch}`]);
  if (!pushed.ok) {
    returnBack();
    if (/rejected|already exists|non-fast-forward|fetch first/i.test(pushed.stderr)) fail(`Задачу ${id} уже взяли: ветка ${branch} на origin появилась раньше. Выбери другую — pnpm task next.`);
    fail(`Push не удался, ветка ${branch} убрана локально:\n${pushed.stderr}`);
  }

  console.log(`Задача ${id} взята: ветка ${branch}, владелец «${owner}».`);
  console.log(`Уровень effort в сессии — ${task.effort}. Дальше — тесты первым коммитом (tasks/README.md, шаг 5).`);
}

function runRelease(positional, flags) {
  const id = positional[0];
  if (id === undefined || !TASK_ID_RE.test(id)) fail("Укажи задачу: pnpm task release T-NNNN --yes");
  const branch = `task/${id}`;
  if (flags.yes !== true) {
    console.log(`Будет выполнено: git push origin --delete ${branch}\nЭто освободит задачу. Отдавай только свою ветку. Подтверди флагом --yes.`);
    return;
  }
  git(["push", "origin", "--delete", branch]);
  console.log(`Ветка ${branch} удалена на origin, задача ${id} свободна. Закрой PR, если он был, с причиной в комментарии.`);
}

function runDiffCheck(flags) {
  const head = process.env.GITHUB_HEAD_REF || git(["branch", "--show-current"]);
  const match = /^task\/(T-\d{4})$/.exec(head);
  if (match === null) {
    console.log(`Ветка «${head}» — не ветка задачи, проверка зон пропущена.`);
    return;
  }
  const id = match[1];
  const base = flags.base ?? BASE;

  const dir = join(ROOT, "tasks");
  const fileName = readdirSync(dir).find((name) => name.startsWith(`${id}-`) && name.endsWith(".md"));
  if (fileName === undefined) fail(`ошибка  ветка ${head}, а файла tasks/${id}-*.md в ней нет`);
  const parsed = parseFrontmatter(readFileSync(join(dir, fileName), "utf8"));
  const problems = [...parsed.errors, ...validateTask(fileName, parsed.data)];
  if (problems.length > 0) fail(problems.map((problem) => `ошибка  ${fileName}: ${problem}`).join("\n"));

  // Без поиска переименований: переименование — это и удаление старого пути, а он тоже должен быть в зонах.
  const diff = git(["diff", "--name-only", "--no-renames", `${base}...HEAD`]);
  const changed = diff === "" ? [] : diff.split("\n");
  const outside = outOfZone(changed, { ...parsed.data, fileName });
  if (outside.length > 0) {
    console.error(`ошибка  PR задачи ${id} меняет файлы вне её зон (zones, shared и сам файл задачи):`);
    for (const path of outside) console.error(`  ${path}`);
    console.error("Понадобился файл вне зон — это вопрос тимлидам: черновик PR с разделом «Вопросы» (tasks/README.md).");
    process.exit(1);
  }
  console.log(`Проверка зон ${id}: ${String(changed.length)} файлов, все в зонах задачи.`);
}

function main(argv) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "check":
      return runCheck();
    case "board":
      return runBoard(flags);
    case "next":
      return runNext(flags);
    case "claim":
      return runClaim(positional, flags);
    case "release":
      return runRelease(positional, flags);
    case "diff-check":
      return runDiffCheck(flags);
    default:
      console.error(USAGE);
      return process.exit(command === undefined ? 0 : 1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
