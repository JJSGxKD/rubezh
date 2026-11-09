import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { attemptOf, currentBranchOf, parseTaskBranch, previousAttemptBranches, takenIdsOf, taskBranch } from "./branch.mjs";
import { findAbandonedClaims, hasWorkBeyondClaim } from "./claim.mjs";
import { isTaskFile, parseEpics, readTasks } from "./registry.mjs";

/**
 * Тонкий слой поверх `git` и `gh` для `pnpm task`. Аргументы всегда массивом
 * (`execFileSync`, не строка для shell): id задачи и владелец приходят из
 * командной строки. Тестами не покрыт — читает состояние живого репозитория
 * (образец — scripts/release/git.mjs).
 */

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Источник правды о задачах: файлы в origin/dev, а не рабочая копия — доска одна на любой ветке. */
export const BASE = "origin/dev";
const MAX_BUFFER = 64 * 1024 * 1024;

export function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Без исключения, в заданном каталоге: `{ ok, stdout, stderr }`. */
function tryGitIn(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

/** То же, но без исключения: `{ ok, stdout, stderr }` — по тексту отказа решает вызывающий. */
export function tryGit(args) {
  return tryGitIn(ROOT, args);
}

export function fetchOrigin() {
  const result = tryGit(["fetch", "origin", "--prune", "--quiet"]);
  if (!result.ok) throw new Error(`git fetch origin не удался: ${result.stderr}`);
}

function listLines(args) {
  const out = git(args);
  return out === "" ? [] : out.split("\n");
}

/**
 * Файлы `tasks/` и `tasks/archive/` в `base` (по умолчанию origin/dev):
 * `[{ name, text }]`, где `name` — путь от `tasks/` (`T-….md` или `archive/T-….md`).
 */
export function readOriginTasks(base = BASE) {
  const names = listLines(["ls-tree", "--name-only", base, "tasks/", "tasks/archive/"])
    .map((path) => path.replace(/^tasks\//, ""))
    .filter((name) => name.endsWith(".md") && (isTaskFile(name) || name === "epics.md"));
  return names.map((name) => ({ name, text: git(["show", `${base}:tasks/${name}`]) }));
}

export function readOriginFileList(base = BASE) {
  return listLines(["ls-tree", "-r", "--name-only", base]);
}

/** Имена веток задач на origin: `task/T-NNNN` и `task/T-NNNN-N`. Какая из них действующая, решает попытка задачи (`takenIdsOf`). */
export function remoteTaskBranches() {
  return listLines(["ls-remote", "--heads", "origin", "task/*"])
    .map((line) => (line.split("\t")[1] ?? "").replace(/^refs\/heads\//, ""))
    .filter((name) => parseTaskBranch(name) !== null);
}

/** Сколько ждать ответа `gh`, мс: сеть бывает мертва, а зависшая команда мерджа хуже отказа. */
export const GH_TIMEOUT_MS = 60_000;

/**
 * `gh` с таймаутом: `{ ok, stdout, stderr, timedOut }` — без исключения, решает
 * вызывающий. Аргументы массивом, как у `git`. Зависший процесс убивается.
 */
export function gh(args, timeoutMs = GH_TIMEOUT_MS) {
  const result = spawnSync("gh", args, { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: timeoutMs, killSignal: "SIGKILL" });
  const timedOut = result.error?.code === "ETIMEDOUT";
  const stderr = timedOut ? `gh не ответил за ${String(Math.round(timeoutMs / 1000))} с` : (result.stderr ?? "").trim();
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr, timedOut };
}

/** Текст файла по пути в коммите `ref` (SHA или ветка) или `null`, если коммита или файла нет. */
export function readFileAt(ref, path) {
  const result = tryGit(["show", `${ref}:${path}`]);
  return result.ok ? result.stdout : null;
}

/** Есть ли коммит `sha` в локальном репозитории. */
export function hasCommit(sha) {
  return tryGit(["cat-file", "-e", `${sha}^{commit}`]).ok;
}

/** Вывод `git diff --numstat --no-renames base...head` (изменения PR от общего предка) или `null`, если дифф не получился. */
export function diffNumstat(base, head) {
  const result = tryGit(["-c", "core.quotepath=off", "diff", "--numstat", "--no-renames", `${base}...${head}`]);
  return result.ok ? result.stdout : null;
}

/** `base` — предок `head`: ветка не отстала от базы. Любой сбой git — «нет». */
export function isAncestor(base, head) {
  return tryGit(["merge-base", "--is-ancestor", base, head]).ok;
}

/** Код команд в `scripts/tasks` рабочей копии совпадает с `base`: нет ни правок, ни новых файлов. */
export function toolsMatchBase(base) {
  if (!tryGit(["diff", "--quiet", base, "--", "scripts/tasks"]).ok) return false;
  const untracked = tryGit(["ls-files", "--others", "--exclude-standard", "--", "scripts/tasks"]);
  return untracked.ok && untracked.stdout === "";
}

/**
 * Влить в текущую ветку ветки зависимостей `<remote>/task/T-NNNN` по порядку
 * `deps` (Р178, сборка ветки задела). `branchOf(id)` — ветка зависимости (по умолчанию первой попытки;
 * вызывающий подставляет ветку текущей попытки зависимости, Р195). Перемотка допустима, редактор сообщения не
 * открывается. Первая неудача останавливает сборку и откатывает недовлитое
 * слияние (`merge --abort`); уже влитые зависимости остаются — ветку целиком
 * откатывает вызывающий. Возвращает `{ ok: true }` или `{ ok: false, dependency,
 * missing, conflicts, stderr }`: `missing` — ветки зависимости нет на `remote`,
 * `conflicts` — файлы с конфликтом.
 */
export function mergeDependencyBranches(deps, { cwd = ROOT, remote = "origin", branchOf = taskBranch } = {}) {
  for (const id of deps) {
    const ref = `${remote}/${branchOf(id)}`;
    if (!tryGitIn(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok) {
      return { ok: false, dependency: id, missing: true, conflicts: [], stderr: `ветки ${ref} нет` };
    }
    const merged = tryGitIn(cwd, ["merge", "--no-edit", ref]);
    if (merged.ok) continue;
    const conflicts = tryGitIn(cwd, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter((line) => line !== "");
    tryGitIn(cwd, ["merge", "--abort"]);
    return { ok: false, dependency: id, missing: false, conflicts, stderr: merged.stderr || merged.stdout };
  }
  return { ok: true };
}

/**
 * Файлы, которые меняют ветки зависимостей относительно `base` (Р178, п. 6):
 * `{ files, missing }`, `files` — без повторов, `missing` — зависимости, чьей
 * ветки на `remote` нет (их файлы неизвестны).
 */
export function dependencyChangedFiles(deps, { base, cwd = ROOT, remote = "origin", branchOf = taskBranch }) {
  const files = new Set();
  const missing = [];
  for (const id of deps) {
    const result = tryGitIn(cwd, ["-c", "core.quotepath=off", "diff", "--name-only", "--no-renames", `${base}...${remote}/${branchOf(id)}`]);
    if (!result.ok) {
      missing.push(id);
      continue;
    }
    for (const path of result.stdout.split("\n")) if (path !== "") files.add(path);
  }
  return { files: [...files], missing };
}

/** Имя файла задачи `T-NNNN-<slug>.md` наверху `tasks/` в `base` или `null`. */
export function taskFileNameAt(base, id) {
  const names = listLines(["ls-tree", "--name-only", base, "tasks/"]).map((path) => path.replace(/^tasks\//, ""));
  return names.find((name) => name.startsWith(`${id}-`) && name.endsWith(".md")) ?? null;
}

/**
 * `owner/repo` из адреса `origin` или `null`. Разбираем сами, а не отдаём `gh`
 * подстановку `{owner}/{repo}`: в облачной сессии Claude Code `origin` смотрит
 * на прокси (`http://…@127.0.0.1:…/git/<owner>/<repo>`), и `gh` репозиторий по
 * нему не узнаёт.
 */
export function repoSlugFromUrl(url) {
  const match = /[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec((url ?? "").trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function repoSlug() {
  const result = tryGit(["remote", "get-url", "origin"]);
  return result.ok ? repoSlugFromUrl(result.stdout) : null;
}

/** Метка через REST: GraphQL, на котором стоит `gh pr edit`, в облачной сессии закрыт прокси. */
function labelRest(number, label, add) {
  const slug = repoSlug();
  if (slug === null) return { ok: false, stderr: "не разобрать адрес origin" };
  const path = `repos/${slug}/issues/${String(number)}/labels`;
  const result = add ? gh(["api", "-X", "POST", path, "-f", `labels[]=${label}`]) : gh(["api", "-X", "DELETE", `${path}/${encodeURIComponent(label)}`]);
  return { ok: result.ok, stderr: result.stderr };
}

/** Поставить метку на PR: `{ ok, stderr }` — без исключения, решает вызывающий. */
export function addPrLabel(number, label) {
  const result = spawnSync("gh", ["pr", "edit", String(number), "--add-label", label], { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (result.status === 0) return { ok: true, stderr: "" };
  const rest = labelRest(number, label, true);
  return rest.ok ? rest : { ok: false, stderr: (result.stderr ?? "").trim() || rest.stderr };
}

/** Снять метку с PR: `{ ok, stderr }` — без исключения, решает вызывающий. */
export function removePrLabel(number, label) {
  const result = spawnSync("gh", ["pr", "edit", String(number), "--remove-label", label], { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (result.status === 0) return { ok: true, stderr: "" };
  const rest = labelRest(number, label, false);
  return rest.ok ? rest : { ok: false, stderr: (result.stderr ?? "").trim() || rest.stderr };
}

/**
 * Сколько открытых PR читает доска. GraphQL GitHub не пускает запрос дороже
 * 500 000 узлов, а поле `commits` стоит около 10 000 на PR: при 200 запрос
 * отклонялся целиком, и все задачи с PR выглядели «в работе». 40 — с запасом.
 */
export const OPEN_PRS_LIMIT = 40;

/** Открытые PR с метками (по ним видна «Доработка»), описанием и состоянием проверок (кого ждёт PR) или `null`, если `gh` нет или он не авторизован. */
export function openPrs() {
  const result = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", String(OPEN_PRS_LIMIT), "--json", "number,headRefName,isDraft,labels,body,createdAt,statusCheckRollup,commits"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (result.status !== 0) {
    const rest = openPrsRest();
    if (rest !== null) return rest;
    // Причина — в лог: без неё доска молча сливает «На ревью» с «В работе».
    const reason = (result.stderr ?? "").split(/\r?\n/).find((line) => line.trim() !== "") ?? `код ${String(result.status)}`;
    console.error(`предупреждение: gh pr list не ответил — ${reason.trim()}`);
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed) && parsed.length >= OPEN_PRS_LIMIT) {
      console.error(`предупреждение: открытых PR не меньше ${String(OPEN_PRS_LIMIT)} — доска видит только их, подними OPEN_PRS_LIMIT`);
    }
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * PR из ответа REST `GET /repos/{owner}/{repo}/pulls` в форме `gh pr list --json`:
 * `{ number, headRefName, isDraft, labels, body, createdAt }` или `null` для
 * записи без номера и ветки. Состояния проверок и коммитов REST в списке не
 * отдаёт — у таких PR доска не видит красный CI и кругов доработки, но метки
 * («доработка», «на ревью») и черновик видит.
 */
export function prFromRest(item) {
  if (typeof item !== "object" || item === null) return null;
  const number = item.number;
  const headRefName = item.head?.ref;
  if (typeof number !== "number" || typeof headRefName !== "string") return null;
  const labels = Array.isArray(item.labels) ? item.labels.filter((label) => typeof label?.name === "string").map((label) => ({ name: label.name })) : [];
  return {
    number,
    headRefName,
    isDraft: item.draft === true,
    labels,
    body: typeof item.body === "string" ? item.body : "",
    createdAt: typeof item.created_at === "string" ? item.created_at : null,
  };
}

/**
 * Открытые PR через REST — запасной путь для облачной сессии Claude Code: её
 * прокси закрывает GraphQL GitHub, на котором стоит `gh pr list`, а REST
 * пропускает. `null` — не получилось и так.
 */
function openPrsRest() {
  const slug = repoSlug();
  if (slug === null) return null;
  const result = gh(["api", `repos/${slug}/pulls?state=open&per_page=100`]);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return null;
    console.error("предупреждение: gh pr list не ответил, открытые PR прочитаны через REST — без состояния проверок");
    return parsed.map(prFromRest).filter((pr) => pr !== null);
  } catch {
    return null;
  }
}

/**
 * Дата коммита захвата задачи (`chore(tasks): Взять T-NNNN в работу`) в ветке её текущей попытки
 * на origin — ISO-строка или `null`, если ветки или коммита нет. Если захват перехвачен, берётся
 * коммит «Перехватить …».
 */
export function claimedAt(task) {
  // Два заголовка: захват и перехват брошенного захвата (T-0371) — время считается от позднего.
  const result = tryGit(["log", "-1", "--format=%cI", "--grep", `^chore(tasks): Взять ${task.id} в работу$`, "--grep", `^chore(tasks): Перехватить ${task.id} — захват брошен$`, `origin/${currentBranchOf(task)}`]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

/**
 * Влитые в dev PR из ответа `gh`: `[{ number, headRefName, baseRefName, login, mergedAt, body, commits,
 * reviews, comments }]` или `null`, если ответ не массив. Аккаунт мог быть удалён — тогда `author: null`,
 * и `login` равен `null`, а PR остаётся. Записи без номера или даты слияния отбрасываются; отсутствующие
 * `body`, `commits`, `reviews` и `comments` — пусты.
 */
export function parseMergedPrs(parsed) {
  if (!Array.isArray(parsed)) return null;
  const list = (value) => (Array.isArray(value) ? value : []);
  return parsed
    .filter((pr) => typeof pr?.headRefName === "string" && typeof pr.number === "number" && typeof pr.mergedAt === "string")
    .map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
      baseRefName: typeof pr.baseRefName === "string" ? pr.baseRefName : "",
      login: typeof pr.author?.login === "string" ? pr.author.login : null,
      mergedAt: pr.mergedAt,
      body: typeof pr.body === "string" ? pr.body : "",
      commits: list(pr.commits),
      reviews: list(pr.reviews),
      comments: list(pr.comments),
    }));
}

/** Из влитых PR — только ветки задач `task/T-NNNN` в виде `{ number, headRefName, login, mergedAt }` для `taskCredits`. */
export function taskPrsOf(prs) {
  return prs
    .filter((pr) => parseTaskBranch(pr.headRefName) !== null)
    .map(({ number, headRefName, login, mergedAt }) => ({ number, headRefName, login, mergedAt }));
}

/** Влитые в задачи PR из ответа `gh`; `null`, если ответ не массив. */
export function parseMergedTaskPrs(parsed) {
  const prs = parseMergedPrs(parsed);
  return prs === null ? null : taskPrsOf(prs);
}

/**
 * Влитые в dev PR одним вызовом `gh` (раздел «Вклад» и «Готово») или `null`, если `gh` нет, он не авторизован
 * или ответ не разобрался.
 */
export function mergedPrs() {
  const result = spawnSync(
    "gh",
    ["pr", "list", "--state", "merged", "--base", "dev", "--limit", "1000", "--json", "number,headRefName,baseRefName,author,mergedAt,body,commits,reviews,comments"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER },
  );
  if (result.status !== 0) return null;
  try {
    return parseMergedPrs(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

/**
 * Добавленные в `origin/dev` файлы задач `tasks/T-NNNN-….md`: `[{ fileName, addedAt }]`, дата — коммита
 * появления. `--diff-filter=A` вместе с поиском переименований не засчитывает переезд в архив (T-0204)
 * новым файлом. Нет репозитория или истории — пустой список.
 */
export function addedTaskSpecs(base = BASE) {
  const result = tryGit(["log", base, "--diff-filter=A", "--find-renames", "--name-status", "--format=@%cI", "--", "tasks"]);
  if (!result.ok) return [];
  const specs = new Map();
  let addedAt = "";
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("@")) {
      addedAt = line.slice(1);
      continue;
    }
    const match = /^A\ttasks\/(?:archive\/)?(T-\d{4}-[^/]+\.md)$/.exec(line);
    if (match === null) continue;
    const id = match[1].slice(0, 6);
    // Коммиты идут от новых к старым: последняя запись по задаче — самая ранняя.
    specs.set(id, { fileName: match[1], addedAt });
  }
  return [...specs.values()];
}

/** Дата последнего коммита ветки `origin/<ветка>` (ISO) или `null`, если git не ответил. */
export function lastCommitAt(branch) {
  const result = tryGit(["log", "-1", "--format=%cI", `origin/${branch}`]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

/** Файлы, изменённые веткой `origin/<ветка>` относительно `base`, или `null`, если дифф не получился. */
export function branchChangedFiles(branch, base = BASE) {
  const result = tryGit(["-c", "core.quotepath=off", "diff", "--name-only", "--no-renames", `${base}...origin/${branch}`]);
  return result.ok ? result.stdout.split("\n").filter((line) => line !== "") : null;
}

/**
 * Задачи с попыткой от 2, у которых в ветке прежней попытки есть работа кроме захвата (Р195):
 * `Map<id, ветка>` — самая поздняя из таких веток. Только свободные задачи (ветки текущей попытки
 * нет): остальным подсказка `--from` не нужна. Два вызова git на ветку.
 */
function findPreviousWork(tasks, taken, branches, base) {
  const busy = new Set(taken);
  const found = new Map();
  for (const task of tasks) {
    if (attemptOf(task) < 2 || busy.has(task.id) || (task.status !== "ready" && task.status !== "in-progress")) continue;
    const withWork = previousAttemptBranches(task, branches).find((branch) => hasWorkBeyondClaim(branchChangedFiles(branch, base), task.fileName));
    if (withWork !== undefined) found.set(task.id, withWork);
  }
  return found;
}

/**
 * Всё, что нужно доске, из origin: `{ tasks, errors, epicOrder, repoFiles, taken, prs, claims, abandoned,
 * lastCommits, previousWork }`; задачи и файлы — из `base`. `taken` — задачи с веткой текущей попытки
 * (Р195), ветки прежних попыток в него не входят.
 */
export function loadRegistryState(base = BASE) {
  const files = readOriginTasks(base);
  const { tasks, errors } = readTasks(files);
  const branches = remoteTaskBranches();
  const taken = takenIdsOf(branches, tasks);
  const epics = files.find((file) => file.name === "epics.md");
  const prs = openPrs();
  const { abandoned, lastCommits } = findAbandonedClaims({
    taken,
    tasks,
    prs,
    now: Date.now(),
    readBranch: (task) => ({ changedFiles: branchChangedFiles(currentBranchOf(task), base), lastCommitAt: lastCommitAt(currentBranchOf(task)) }),
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return {
    tasks,
    errors,
    epicOrder: epics === undefined ? [] : parseEpics(epics.text),
    repoFiles: readOriginFileList(base),
    taken,
    prs,
    claims: Object.fromEntries(taken.map((id) => [id, claimedAt(byId.get(id) ?? { id })])),
    abandoned,
    lastCommits,
    previousWork: findPreviousWork(tasks, taken, branches, base),
  };
}

/** Текст файла задачи в ветке её текущей попытки на origin — оттуда видно, кто взял; файл ищется наверху и в архиве. */
export function readBranchFile(task) {
  for (const path of [`tasks/${task.fileName}`, `tasks/archive/${task.fileName}`]) {
    const result = tryGit(["show", `origin/${currentBranchOf(task)}:${path}`]);
    if (result.ok) return result.stdout;
  }
  return null;
}
