import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { deleteRemoteTag, pushTag, remoteTagSha } from "../release/git.mjs";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { rollbackPlan } from "../release/release-tag.mjs";

// Тег релиза (docs/09-ci-cd.md §8.1, «Порядок публикации»): тег ставится
// первым из видимого снаружи, а сбой публикации после него откатывается.

describe("rollbackPlan", () => {
  it("образа под номером ещё нет — тег удаляется, номер достанется следующему прогону", () => {
    expect(rollbackPlan({ imagePushed: false })).toBe("delete");
  });

  it("образ уже в реестре — тег остаётся при нём, иначе образ окажется под номером без тега", () => {
    expect(rollbackPlan({ imagePushed: true })).toBe("keep");
  });
});

describe("тег на настоящем git", () => {
  const originalCwd = process.cwd();
  let root = "";
  let clone = "";

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  }

  function commit(message: string): string {
    git(clone, "commit", "--allow-empty", "--quiet", "-m", message);
    return git(clone, "rev-parse", "HEAD");
  }

  const sha: Record<string, string> = {};

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "release-tag-"));
    const origin = join(root, "origin.git");
    clone = join(root, "clone");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "dev", origin]);
    execFileSync("git", ["clone", "--quiet", origin, clone], { stdio: "ignore" });

    git(clone, "symbolic-ref", "HEAD", "refs/heads/dev");
    sha.first = commit("первый мердж");
    sha.second = commit("второй мердж");
    git(clone, "push", "--quiet", "origin", "dev");

    process.chdir(clone);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("ставит тег на удалённом без локального тега", () => {
    expect(pushTag(sha.second, "v0.5.0-rc.1").ok).toBe(true);
    expect(remoteTagSha("v0.5.0-rc.1")).toBe(sha.second);
    expect(git(clone, "tag", "--list")).toBe("");
  });

  it("повтор на тот же коммит не ошибка — перезапуск шага не падает", () => {
    expect(pushTag(sha.second, "v0.5.0-rc.1").ok).toBe(true);
  });

  it("тег на другом коммите не переставляет, а отказывает с ответом сервера", () => {
    const push = pushTag(sha.first, "v0.5.0-rc.1");
    expect(push.ok).toBe(false);
    expect(push.message).toMatch(/already exists/);
    expect(remoteTagSha("v0.5.0-rc.1")).toBe(sha.second);
  });

  it("откат удаляет тег на удалённом", () => {
    deleteRemoteTag("v0.5.0-rc.1");
    expect(remoteTagSha("v0.5.0-rc.1")).toBeNull();
  });
});
