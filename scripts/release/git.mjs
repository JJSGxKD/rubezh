import { execFileSync, spawnSync } from "node:child_process";
import { parseStableTag } from "./semver.mjs";

/**
 * Тонкий IO-слой поверх `git` и `gh` для скриптов релиза
 * (docs/09-ci-cd.md §8.1). Аргументы всегда передаются массивом
 * (`execFileSync`, не `execSync` со строкой) — без сборки shell-команд из
 * непроверенных строк (заголовок и текст PR приходят от автора).
 */

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

function gh(args) {
  return run("gh", args);
}

/**
 * Временный сбой GitHub, а не ответ по сути: 5xx, «слишком много запросов»,
 * обрыв соединения. Вычисление версии делает по запросу на каждый коммит после
 * стабильного тега — их сотни, и без повтора один 504 из них роняет весь
 * выпуск. Отказ по сути — 404, 403, неверный аргумент — повтором не лечится.
 */
const TRANSIENT_GH = /HTTP (?:5\d\d|429)\b|timed? ?out|connection (?:reset|refused)|ECONNRESET|ETIMEDOUT|unexpected EOF|TLS handshake/i;

/** Строка ошибки, по которой видно, что сбой временный; `null` — сбой по сути. */
export function transientGhReason(error) {
  if (!(error instanceof Error)) return null;
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const line = `${error.message}\n${stderr}`.split("\n").find((candidate) => TRANSIENT_GH.test(candidate));
  return line === undefined ? null : line.trim().slice(0, 200);
}

/** Паузы перед повторами, мс: до минуты в сумме — GitHub обычно оживает за секунды. */
export const GH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Чтение с повтором при временном сбое. Только чтение: запись при 5xx могла
 * и пройти, и повтор задвоил бы комментарий или PR.
 */
export function withGhRetry(read, { delays = GH_RETRY_DELAYS_MS, sleep = sleepSync, log = (line) => console.error(line) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return read();
    } catch (error) {
      const delay = delays[attempt];
      const reason = transientGhReason(error);
      if (delay === undefined || reason === null) throw error;
      log(`GitHub временно недоступен (${reason}) — повтор ${String(attempt + 1)} из ${String(delays.length)} через ${String(delay / 1000)} с`);
      sleep(delay);
    }
  }
}

function ghRead(args) {
  return withGhRetry(() => gh(args));
}

function git(args) {
  return run("git", args);
}

export function listAllTags() {
  return git(["tag", "--list", "v*"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function listStableTags() {
  return listAllTags().filter((tag) => parseStableTag(tag) !== null);
}

/** Последний стабильный тег по номеру, а не по времени создания — теги ретегируют редко, но лучше не полагаться на порядок. */
export function latestStableTag() {
  const tags = listStableTags();
  if (tags.length === 0) return null;
  return tags
    .map((tag) => ({ tag, version: parseStableTag(tag) }))
    .sort(
      (a, b) =>
        a.version.major - b.version.major || a.version.minor - b.version.minor || a.version.patch - b.version.patch,
    )
    .at(-1).tag;
}

/** Порядок не важен — next-version.mjs берёт максимум меток по всему диапазону. */
export function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const raw = git(["log", range, "--format=%H"]);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function pullRequestsForCommit(sha) {
  const json = ghRead(["api", `repos/{owner}/{repo}/commits/${sha}/pulls`]);
  return JSON.parse(json);
}

/**
 * Влитые PR в ветку — одним запросом, с описаниями: строки журнала
 * обновлений собираются из разделов «Для игроков» (scripts/release/player-notes.mjs).
 * Поля — в форме REST API, как у `pullRequestsForCommit`: разбор общий.
 */
export function mergedPullRequests(baseBranch, limit = 300) {
  const json = ghRead([
    "pr",
    "list",
    "--state",
    "merged",
    "--base",
    baseBranch,
    "--limit",
    String(limit),
    "--json",
    "number,body,mergedAt,mergeCommit,headRefName,baseRefName",
  ]);
  return JSON.parse(json).map((pr) => ({
    number: pr.number,
    body: pr.body ?? "",
    merged_at: pr.mergedAt ?? null,
    merge_commit_sha: pr.mergeCommit?.oid ?? null,
    head: { ref: pr.headRefName },
    base: { ref: pr.baseRefName },
  }));
}

export function viewPr(number) {
  const json = ghRead(["pr", "view", String(number), "--json", "number,title,body,labels,headRefName,baseRefName"]);
  return JSON.parse(json);
}

export function addLabel(number, label) {
  gh(["pr", "edit", String(number), "--add-label", label]);
}

export function listComments(number) {
  const json = ghRead(["pr", "view", String(number), "--json", "comments"]);
  return JSON.parse(json).comments ?? [];
}

export function postComment(number, body) {
  gh(["pr", "comment", String(number), "--body", body]);
}

/**
 * Тег на удалённом одним push, без локального тега. Повторный push на тот же
 * коммит git считает «up-to-date», так что перезапуск шага не падает; тег,
 * уже стоящий на другом коммите, — отказ. Ошибку не бросает: что значит отказ,
 * решает вызывающий (`scripts/release/release-tag.mjs`), а для этого ему нужен
 * текст ответа сервера.
 */
export function pushTag(sha, tag) {
  const result = spawnSync("git", ["push", "origin", `${sha}:refs/tags/${tag}`], { encoding: "utf8" });
  const message = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim();
  return { ok: result.status === 0, message };
}

/**
 * Вершина ветки на удалённом сейчас, вместе с объектами — чтобы проверить,
 * есть ли в ней коммит прогона. Ветки нет — `null`.
 */
export function fetchBranchTip(branch) {
  if (git(["ls-remote", "origin", `refs/heads/${branch}`]) === "") return null;
  git(["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${branch}`]);
  return git(["rev-parse", "FETCH_HEAD"]);
}

/** Коммит, на который указывает тег на удалённом, или `null`, если тега нет. */
export function remoteTagSha(tag) {
  const line = git(["ls-remote", "origin", `refs/tags/${tag}`]);
  return line === "" ? null : line.split(/\s+/)[0];
}

export function deleteRemoteTag(tag) {
  git(["push", "origin", "--delete", `refs/tags/${tag}`]);
}

/** Удаляет релиз (и черновик) по тегу; релиза нет — не ошибка, откатывать нечего. */
export function deleteRelease(tag) {
  const result = spawnSync("gh", ["release", "delete", tag, "--yes"], { encoding: "utf8" });
  if (result.status === 0) return true;
  if (/release not found/i.test(result.stderr ?? "")) return false;
  throw new Error(`релиз ${tag} не удалён: ${(result.stderr || result.error?.message || "").trim()}`);
}

export function remoteBranchExists(branch) {
  return git(["ls-remote", "--heads", "origin", branch]) !== "";
}

/** Предок ли `ancestor` для `descendant` — `merge-base --is-ancestor` отвечает кодом выхода. */
export function isAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) return false;
    throw error;
  }
}

export function pushRef(source, targetBranch) {
  git(["push", "origin", `${source}:refs/heads/${targetBranch}`]);
}

export function openPullRequestExists(head, base) {
  const json = ghRead(["pr", "list", "--head", head, "--base", base, "--state", "open", "--json", "number"]);
  return JSON.parse(json).length > 0;
}

export function createPullRequest({ head, base, title, body }) {
  return gh(["pr", "create", "--head", head, "--base", base, "--title", title, "--body", body]);
}
