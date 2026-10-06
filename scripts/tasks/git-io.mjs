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

/** Файлы каталога tasks/ в origin/dev: `[{ name, text }]`. */
export function readOriginTasks() {
  const names = listLines(["ls-tree", "--name-only", BASE, "tasks/"])
    .map((path) => path.replace(/^tasks\//, ""))
    .filter((name) => name.endsWith(".md") && (isTaskFile(name) || name === "epics.md"));
  return names.map((name) => ({ name, text: git(["show", `${BASE}:tasks/${name}`]) }));
}

export function readOriginFileList() {
  return listLines(["ls-tree", "-r", "--name-only", BASE]);
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

/** Всё, что нужно доске, из origin: `{ tasks, errors, epicOrder, repoFiles, taken, prs }`. */
export function loadRegistryState() {
  const files = readOriginTasks();
  const { tasks, errors } = readTasks(files);
  const epics = files.find((file) => file.name === "epics.md");
  return {
    tasks,
    errors,
    epicOrder: epics === undefined ? [] : parseEpics(epics.text),
    repoFiles: readOriginFileList(),
    taken: takenIds(),
    prs: openPrs(),
  };
}

/** Текст файла задачи в ветке `task/T-NNNN` на origin — оттуда видно, кто взял. */
export function readBranchFile(id, fileName) {
  const result = tryGit(["show", `origin/task/${id}:tasks/${fileName}`]);
  return result.ok ? result.stdout : null;
}
