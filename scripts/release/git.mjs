import { execFileSync } from "node:child_process";
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
  const json = gh(["api", `repos/{owner}/{repo}/commits/${sha}/pulls`]);
  return JSON.parse(json);
}

export function viewPr(number) {
  const json = gh(["pr", "view", String(number), "--json", "number,title,body,labels,headRefName,baseRefName"]);
  return JSON.parse(json);
}

export function addLabel(number, label) {
  gh(["pr", "edit", String(number), "--add-label", label]);
}

export function listComments(number) {
  const json = gh(["pr", "view", String(number), "--json", "comments"]);
  return JSON.parse(json).comments ?? [];
}

export function postComment(number, body) {
  gh(["pr", "comment", String(number), "--body", body]);
}

export function createTag(tag) {
  git(["tag", tag]);
  git(["push", "origin", tag]);
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
  const json = gh(["pr", "list", "--head", head, "--base", base, "--state", "open", "--json", "number"]);
  return JSON.parse(json).length > 0;
}

export function createPullRequest({ head, base, title, body }) {
  return gh(["pr", "create", "--head", head, "--base", base, "--title", title, "--body", body]);
}

export function createRelease(tag, notesStartTag) {
  const args = ["release", "create", tag, "--generate-notes"];
  if (notesStartTag) args.push("--notes-start-tag", notesStartTag);
  gh(args);
}
