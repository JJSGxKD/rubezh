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

/** Файлы каталога tasks/ в `base` (по умолчанию origin/dev): `[{ name, text }]`. */
export function readOriginTasks(base = BASE) {
  const names = listLines(["ls-tree", "--name-only", base, "tasks/"])
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

/** Открытые PR или `null`, если `gh` нет или он не авторизован. */
export function openPrs() {
  const result = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName,isDraft"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Влитые в dev PR веток задач из ответа `gh`: `[{ number, headRefName, login, mergedAt }]` или `null`, если
 * ответ не массив. Аккаунт мог быть удалён — тогда `author: null`, и `login` равен `null`, а PR остаётся.
 */
export function parseMergedTaskPrs(parsed) {
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter(
      (pr) =>
        typeof pr?.headRefName === "string" &&
        /^task\/T-\d{4}$/.test(pr.headRefName) &&
        typeof pr.number === "number" &&
        typeof pr.mergedAt === "string",
    )
    .map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
      login: typeof pr.author?.login === "string" ? pr.author.login : null,
      mergedAt: pr.mergedAt,
    }));
}

/** Влитые в dev PR задач или `null`, если `gh` нет или он не авторизован. */
export function mergedTaskPrs() {
  const result = spawnSync(
    "gh",
    ["pr", "list", "--state", "merged", "--base", "dev", "--limit", "1000", "--json", "number,headRefName,author,mergedAt"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER },
  );
  if (result.status !== 0) return null;
  try {
    return parseMergedTaskPrs(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

/** Всё, что нужно доске, из origin: `{ tasks, errors, epicOrder, repoFiles, taken, prs }`; задачи и файлы — из `base`. */
export function loadRegistryState(base = BASE) {
  const files = readOriginTasks(base);
  const { tasks, errors } = readTasks(files);
  const epics = files.find((file) => file.name === "epics.md");
  return {
    tasks,
    errors,
    epicOrder: epics === undefined ? [] : parseEpics(epics.text),
    repoFiles: readOriginFileList(base),
    taken: takenIds(),
    prs: openPrs(),
  };
}

/** Текст файла задачи в ветке `task/T-NNNN` на origin — оттуда видно, кто взял. */
export function readBranchFile(id, fileName) {
  const result = tryGit(["show", `origin/task/${id}:tasks/${fileName}`]);
  return result.ok ? result.stdout : null;
}
