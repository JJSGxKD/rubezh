import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { COLUMNS, REWORK_LABEL, classify, nextTasks, statusBadge } from "./board.mjs";
import { contributions, freeBadge, renderBoardPage, taskCredits } from "./board-page.mjs";
import { checkClaim } from "./claim.mjs";
import { fixEpicCells } from "./epics.mjs";
import { BASE, ROOT, fetchOrigin, git, loadRegistryState, mergedTaskPrs, readBranchFile, removePrLabel, tryGit } from "./git-io.mjs";
import { checkRegistry, readTasks } from "./registry.mjs";
import { badgeLine, parseFrontmatter, parseOwner, validateTask, withBadgeLine } from "./task-file.mjs";
import { outOfZone } from "./zones.mjs";

/**
 * `pnpm task` — доска задач, захват и проверка зон (tasks/README.md).
 * Логика — чистые функции в соседних файлах, покрытые тестами; здесь только
 * разбор командной строки, вывод и вызовы git.
 */

const USAGE = `Команды:
  pnpm task check                          проверить реестр tasks/ в рабочей копии
  pnpm task board [--all]                  доска из origin/dev (--all — и отменённые)
  pnpm task next [--runner any|local] [--executor <модель>] [--effort <уровень>]
                                           доработка и свободные задачи, лучшая — первой
  pnpm task claim T-NNNN --owner "<аккаунт / модель / уровень>"
                                           захватить задачу веткой task/T-NNNN
  pnpm task resume T-NNNN --owner "<аккаунт / модель / уровень>"
                                           продолжить PR с меткой «доработка», чей бы он ни был
  pnpm task release T-NNNN --yes           отдать задачу: удалить ветку task/T-NNNN
  pnpm task diff-check [--base <ref>]      файлы PR задачи — только в её зонах
  pnpm task fix                            поставить строки значков и ячейки «Задачи» в эпиках
  pnpm task claim-check [--base <ref>]     задачу можно было взять: статус, зависимости, зоны
  pnpm task status-json --out <каталог>    значки статуса: <каталог>/status/T-NNNN.json на задачу`;

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
  const parts = [task.id.padEnd(7), (task.version ?? "—").padEnd(6), `${task.priority} ${task.size} ${task.runner}`.padEnd(14), `${task.executor}/${task.effort}`.padEnd(18), task.title];
  const notes = [];
  if (owner !== undefined) notes.push(`взял: ${owner}`);
  if (pr !== undefined) notes.push(`PR ${String(pr)}`);
  if (reason !== undefined) notes.push(reason);
  return `  ${parts.join("  ")}${notes.length > 0 ? `\n${" ".repeat(10)}↳ ${notes.join("; ")}` : ""}`;
}

/** Кто взял задачу: поле owner из её ветки на origin (на dev оно пустое — статус живёт в ветке). */
function ownerOf(task, emptyIfUnknown = false) {
  const text = readBranchFile(task.id, task.fileName);
  const owner = text === null ? "" : (parseFrontmatter(text).data.owner ?? "");
  return owner === "" && !emptyIfUnknown ? "неизвестно" : owner;
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
    const busy = column.key === "inProgress" || column.key === "review" || column.key === "rework";
    for (const entry of entries) console.log(taskLine(entry, busy ? ownerOf(entry.task) : undefined));
  }
}

function runNext(flags) {
  const { board } = loadBoard();
  const filters = { runner: flags.runner ?? "any", executor: flags.executor, effort: flags.effort };
  const rework = nextTasks(board.rework, filters);
  const free = nextTasks(board.free, filters);
  if (rework.length === 0 && free.length === 0) {
    console.log("Задач с такими условиями нет. Всё занято или заблокировано — `pnpm task board`.");
    return;
  }
  // Доработка — раньше новых: ответ уже дан, и PR ждёт только исполнителя.
  if (rework.length > 0) {
    console.log("На доработке — сначала их, командой pnpm task resume:");
    for (const entry of rework) console.log(taskLine(entry, ownerOf(entry.task)));
  }
  if (free.length > 0) {
    console.log("Свободные задачи, лучшая — первой:");
    for (const entry of free) console.log(taskLine(entry));
  }
}

/**
 * Поток из `--owner`: «аккаунт / модель / уровень», и модель с уровнем —
 * ровно те, что у задачи (tasks/README.md, «Исполнители и effort»).
 */
function ownerFor(task, flags, command) {
  const owner = parseOwner(flags.owner);
  if (owner === null || owner.effort === null) {
    fail(`Укажи поток в виде «аккаунт / модель / уровень»: pnpm task ${command} ${task?.id ?? "T-NNNN"} --owner "claude-3 / sonnet-5.5 / medium"`);
  }
  if (task !== undefined) {
    if (task.executor !== owner.executor) fail(`Задача для ${task.executor}, а не для ${owner.executor}: ${task.id} не берётся (tasks/README.md, «Исполнители и effort»).`);
    if (task.effort !== owner.effort) fail(`Задача на уровне ${task.effort}, а поток — ${owner.effort}: ${task.id} берёт поток своего уровня.`);
  }
  return `${owner.account} / ${owner.executor} / ${owner.effort}`;
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

function runFix() {
  const dir = join(ROOT, "tasks");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  const { tasks } = readTasks(files);
  const fileNames = Object.fromEntries(tasks.map((task) => [task.id, task.fileName]));
  const changed = [];

  for (const file of files.filter((candidate) => candidate.name.startsWith("T-"))) {
    const data = tasks.find((task) => task.fileName === file.name);
    // Битая шапка или зависимость без файла — править нечего: об этом скажет `pnpm task check`.
    if (data === undefined || data.depends_on.some((id) => fileNames[id] === undefined)) continue;
    const text = withBadgeLine(file.text, badgeLine(data, fileNames));
    if (text !== file.text) changed.push({ name: file.name, text });
  }
  const epics = files.find((file) => file.name === "epics.md");
  if (epics !== undefined) {
    const text = fixEpicCells(epics.text, tasks);
    if (text !== epics.text) changed.push({ name: epics.name, text });
  }

  for (const file of changed) {
    writeFileSync(join(dir, file.name), file.text);
    console.log(`поправлено: tasks/${file.name}`);
  }
  if (changed.length === 0) console.log("Править нечего.");
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
  if (id === undefined || !TASK_ID_RE.test(id)) fail("Укажи задачу: pnpm task claim T-NNNN --owner \"аккаунт / модель / уровень\"");
  ownerFor(undefined, flags, "claim");

  if (git(["status", "--porcelain"]) !== "") fail("Рабочая копия не чистая: закоммить или убери изменения, потом бери задачу.");

  const { board } = loadBoard();
  const all = COLUMNS.flatMap((column) => board[column.key].map((entry) => ({ ...entry, column })));
  const found = all.find((entry) => entry.task.id === id);
  if (found === undefined) fail(`Задачи ${id} нет в ${BASE}.`);
  if (found.column.key !== "free") {
    fail(`Задача ${id} не свободна: колонка «${found.column.title}»${found.reason === undefined ? "" : ` — ${found.reason}`}.`);
  }
  const { task } = found;
  const owner = ownerFor(task, flags, "claim");

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

/** Строка `owner` в шапке; статус и остальное не трогаем. */
function withOwner(text, owner) {
  const end = text.indexOf("\n---", 4);
  return text.slice(0, end).replace(/^owner:.*$/m, `owner: ${owner}`) + text.slice(end);
}

/**
 * Продолжить PR на доработке (tasks/README.md, «Доработка»): ветка задачи с
 * origin, `owner` — новый поток, коммит и push без `--force`. Push — замок:
 * кто продолжил первым, того коммит и лёг; второй получит отказ. Потом с PR
 * снимается метка, и задача уходит из «Доработки».
 */
function runResume(positional, flags) {
  const id = positional[0];
  if (id === undefined || !TASK_ID_RE.test(id)) fail("Укажи задачу: pnpm task resume T-NNNN --owner \"аккаунт / модель / уровень\"");
  ownerFor(undefined, flags, "resume");
  if (git(["status", "--porcelain"]) !== "") fail("Рабочая копия не чистая: закоммить или убери изменения, потом продолжай задачу.");

  const { board } = loadBoard();
  const found = board.rework.find((entry) => entry.task.id === id);
  if (found === undefined) fail(`Задача ${id} не на доработке: у её PR нет метки «${REWORK_LABEL}». Что можно взять — pnpm task next.`);
  const { task, pr } = found;
  const owner = ownerFor(task, flags, "resume");

  const branch = `task/${id}`;
  const remote = `origin/${branch}`;
  const previous = git(["branch", "--show-current"]) || git(["rev-parse", "HEAD"]);
  const hadLocal = tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  if (hadLocal) {
    // Непушнутые коммиты — чужая или своя прежняя работа: затирать их нельзя.
    if (git(["rev-list", `${remote}..${branch}`]) !== "") {
      fail(`В локальной ${branch} есть коммиты, которых нет на origin: запушь их или удали ветку (git branch -D ${branch}), потом продолжай.`);
    }
    git(["switch", "--quiet", branch]);
    git(["merge", "--ff-only", "--quiet", remote]);
  } else git(["switch", "--quiet", "-c", branch, remote]);
  const start = git(["rev-parse", "HEAD"]);
  const returnBack = () => {
    tryGit(["reset", "--hard", "--quiet", start]);
    tryGit(["switch", previous]);
    if (!hadLocal) tryGit(["branch", "-D", branch]);
  };

  const file = join(ROOT, "tasks", task.fileName);
  const before = readFileSync(file, "utf8");
  const updated = withOwner(before, owner);
  const message = `chore(tasks): Продолжить ${id} после ответа`;
  // Тот же поток вернулся к своему PR — менять в файле нечего, но замку нужен коммит.
  if (updated === before) git(["commit", "--quiet", "--allow-empty", "-m", message]);
  else {
    writeFileSync(file, updated);
    git(["commit", "--quiet", "-m", message, "--", `tasks/${task.fileName}`]);
  }

  const pushed = tryGit(["push", "origin", `HEAD:refs/heads/${branch}`]);
  if (!pushed.ok) {
    returnBack();
    if (/rejected|non-fast-forward|fetch first/i.test(pushed.stderr)) fail(`Задачу ${id} уже продолжает другой поток: его коммит лёг в ${branch} раньше. Выбери другую — pnpm task next.`);
    fail(`Push не удался, ветка ${branch} возвращена как была:\n${pushed.stderr}`);
  }

  const unlabeled = removePrLabel(pr, REWORK_LABEL);
  if (!unlabeled.ok) {
    console.error(`Метку «${REWORK_LABEL}» с PR #${String(pr)} снять не удалось — сними руками, иначе задачу возьмёт ещё один поток:\n${unlabeled.stderr}`);
  }
  console.log(`Задача ${id} продолжается: ветка ${branch}, PR #${String(pr)}, владелец «${owner}».`);
  console.log("Дальше — ответы и замечания в PR, затем перебазирование на dev, если он ушёл вперёд (tasks/README.md, «Доработка»).");
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

/** Ветка PR в виде `task/T-NNNN` → id; иначе `null`: проверки только для веток задач. */
function taskIdOfHead() {
  const head = process.env.GITHUB_HEAD_REF || git(["branch", "--show-current"]);
  const match = /^task\/(T-\d{4})$/.exec(head);
  if (match === null) console.log(`Ветка «${head}» — не ветка задачи, проверка захвата пропущена.`);
  return match === null ? null : { id: match[1], head };
}

function runClaimCheck(flags) {
  const found = taskIdOfHead();
  if (found === null) return;
  const base = flags.base ?? BASE;
  const state = loadRegistryState(base);
  for (const error of state.errors) console.error(`предупреждение: в реестре на ${base} ошибка — ${error}`);
  const problems = checkClaim(found.id, state);
  if (problems.length > 0) {
    console.error(`ошибка  PR ветки ${found.head} взят в обход порядка (tasks/README.md, «Как взять задачу»):`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("Захватывай задачу командой pnpm task claim; если задачу брать нельзя — отдай её (pnpm task release) и выбери другую.");
    process.exit(1);
  }
  console.log(`Проверка захвата ${found.id}: задачу можно было брать.`);
}

function runStatusJson(flags) {
  if (flags.out === undefined) fail("Укажи каталог: pnpm task status-json --out <каталог>");
  const { board } = loadBoard();
  const dir = join(flags.out, "status");
  mkdirSync(dir, { recursive: true });
  const owners = new Map();
  let count = 0;
  for (const column of COLUMNS) {
    for (const entry of board[column.key]) {
      const busy = column.key === "inProgress" || column.key === "review" || column.key === "rework";
      const owner = busy ? ownerOf(entry.task, true) : undefined;
      if (busy) owners.set(entry.task.id, owner);
      const badge = statusBadge({ ...entry, column: column.key, owner });
      writeFileSync(join(dir, `${entry.task.id}.json`), `${JSON.stringify(badge)}\n`);
      count += 1;
    }
  }
  writeFileSync(join(dir, "free.json"), `${JSON.stringify(freeBadge(board.free.length))}\n`);

  // Один вызов gh: от него зависят и раздел «Вклад», и его пометка «нет данных».
  const mergedPrs = mergedTaskPrs();
  const credits = taskCredits(board.done, mergedPrs);
  const page = renderBoardPage({
    board,
    owners,
    credits,
    people: contributions(credits),
    githubAvailable: mergedPrs !== null,
    now: new Date(),
  });
  writeFileSync(join(flags.out, "README.md"), page);
  console.log(`Значки статуса: ${String(count)} задач → ${dir}`);
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
    case "resume":
      return runResume(positional, flags);
    case "release":
      return runRelease(positional, flags);
    case "diff-check":
      return runDiffCheck(flags);
    case "fix":
      return runFix();
    case "claim-check":
      return runClaimCheck(flags);
    case "status-json":
      return runStatusJson(flags);
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
