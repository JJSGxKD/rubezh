import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

/** То же, но без исключения: `{ ok, stdout, stderr }` — по тексту отказа решает вызывающий. */
export function tryGit(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
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

/** id задач, у которых на origin есть ветка task/T-NNNN. */
export function takenIds() {
  return listLines(["ls-remote", "--heads", "origin", "task/*"])
    .map((line) => /refs\/heads\/task\/(T-\d{4})$/.exec(line)?.[1])
    .filter((id) => id !== undefined);
}

/** Поставить метку на PR: `{ ok, stderr }` — без исключения, решает вызывающий. */
export function addPrLabel(number, label) {
  const result = spawnSync("gh", ["pr", "edit", String(number), "--add-label", label], { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER });
  return { ok: result.status === 0, stderr: (result.stderr ?? "").trim() };
}

/** Снять метку с PR: `{ ok, stderr }` — без исключения, решает вызывающий. */
export function removePrLabel(number, label) {
  const result = spawnSync("gh", ["pr", "edit", String(number), "--remove-label", label], { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER });
  return { ok: result.status === 0, stderr: (result.stderr ?? "").trim() };
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
 * Дата коммита захвата задачи (`chore(tasks): Взять T-NNNN в работу`) в ветке
 * `origin/task/T-NNNN` — ISO-строка или `null`, если ветки или коммита нет.
 */
export function claimedAt(id) {
  const result = tryGit(["log", "-1", "--format=%cI", "--grep", `^chore(tasks): Взять ${id} в работу$`, `origin/task/${id}`]);
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
    .filter((pr) => /^task\/T-\d{4}$/.test(pr.headRefName))
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

/** Всё, что нужно доске, из origin: `{ tasks, errors, epicOrder, repoFiles, taken, prs }`; задачи и файлы — из `base`. */
export function loadRegistryState(base = BASE) {
  const files = readOriginTasks(base);
  const taken = takenIds();
  const { tasks, errors } = readTasks(files);
  const epics = files.find((file) => file.name === "epics.md");
  return {
    tasks,
    errors,
    epicOrder: epics === undefined ? [] : parseEpics(epics.text),
    repoFiles: readOriginFileList(base),
    taken,
    prs: openPrs(),
    claims: Object.fromEntries(taken.map((id) => [id, claimedAt(id)])),
  };
}

/** Текст файла задачи в ветке `task/T-NNNN` на origin — оттуда видно, кто взял; файл ищется наверху и в архиве. */
export function readBranchFile(id, fileName) {
  for (const path of [`tasks/${fileName}`, `tasks/archive/${fileName}`]) {
    const result = tryGit(["show", `origin/task/${id}:${path}`]);
    if (result.ok) return result.stdout;
  }
  return null;
}
