import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { isServicePr } from "../release/branches.mjs";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { commitsSince, isAncestor, latestStableTag } from "../release/git.mjs";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { syncAction } from "../release/sync-dev.mjs";

// Ветка dev (docs/09-ci-cd.md §8.1): служебные PR без метки, синк main → dev
// и — главное — выбор базы версии, проверенный на настоящем git.

describe("служебные PR", () => {
  it("релизный dev → main и синк main → dev — служебные", () => {
    expect(isServicePr("dev", "main")).toBe(true);
    expect(isServicePr("main", "dev")).toBe(true);
  });

  it("PR фичи в dev, срочное исправление в main и стек — обычные", () => {
    expect(isServicePr("feature", "dev")).toBe(false);
    expect(isServicePr("hotfix", "main")).toBe(false);
    expect(isServicePr("docs/week-to-stage", "docs/close-stage2")).toBe(false);
  });
});

describe("syncAction", () => {
  it("без ветки dev синка нет", () => {
    expect(syncAction({ devExists: false, mainInDev: false, devInMain: false })).toBe("none");
  });

  it("dev уже содержит main — синка нет", () => {
    expect(syncAction({ devExists: true, mainInDev: true, devInMain: false })).toBe("none");
  });

  it("dev не ушёл вперёд за время релиза — перемотка без PR", () => {
    expect(syncAction({ devExists: true, mainInDev: false, devInMain: true })).toBe("fast-forward");
  });

  it("ветки разошлись — PR, потому что слияние разного кода должен увидеть человек", () => {
    expect(syncAction({ devExists: true, mainInDev: false, devInMain: false })).toBe("pull-request");
  });
});

describe("база версии на настоящем git", () => {
  const originalCwd = process.cwd();
  let repo = "";

  function git(...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  }

  function commit(message: string): string {
    git("commit", "--allow-empty", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  }

  function mergeInto(target: string, source: string, message: string): string {
    git("checkout", "--quiet", target);
    git("merge", "--no-ff", "--quiet", "-m", message, source);
    return git("rev-parse", "HEAD");
  }

  const sha: Record<string, string> = {};

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "release-branches-"));
    git("init", "--quiet", "-b", "main");
    commit("init");
    git("tag", "v0.1.0");

    git("checkout", "--quiet", "-b", "dev");
    git("checkout", "--quiet", "-b", "feature-a");
    sha.a = commit("фича A");
    sha.mergeA = mergeInto("dev", "feature-a", "PR фичи A в dev");

    sha.release = mergeInto("main", "dev", "релизный PR dev → main");
    git("tag", "v0.2.0");
    sha.devAfterRelease = git("rev-parse", "dev");

    git("checkout", "--quiet", "-b", "feature-b", "dev");
    sha.b = commit("фича B");
    sha.mergeB = mergeInto("dev", "feature-b", "PR фичи B в dev");

    process.chdir(repo);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it("тег релиза недостижим из dev — «ближайшая достижимая» база откатилась бы к прошлой версии", () => {
    const reachableFromDev = git("tag", "--merged", "dev").split("\n");
    expect(reachableFromDev).toContain("v0.1.0");
    expect(reachableFromDev).not.toContain("v0.2.0");
  });

  it("максимальный тег отсекает выпущенное: в диапазоне dev только новое", () => {
    git("checkout", "--quiet", "dev");
    expect(latestStableTag()).toBe("v0.2.0");

    const range = commitsSince("v0.2.0");
    expect(new Set(range)).toEqual(new Set([sha.b, sha.mergeB]));
    expect(range).not.toContain(sha.a);
    expect(range).not.toContain(sha.mergeA);
  });

  it("срочное исправление в main сдвигает базу dev, но не возвращает в диапазон выпущенное", () => {
    git("checkout", "--quiet", "main");
    sha.hotfix = commit("срочное исправление");
    git("tag", "v0.2.1");

    git("checkout", "--quiet", "dev");
    expect(latestStableTag()).toBe("v0.2.1");
    expect(new Set(commitsSince("v0.2.1"))).toEqual(new Set([sha.b, sha.mergeB]));
  });

  it("решение синка: сразу после релиза — перемотка, после расхождения — PR", () => {
    expect(isAncestor(sha.devAfterRelease, sha.release)).toBe(true);
    expect(isAncestor("dev", "main")).toBe(false);
    expect(isAncestor("main", "dev")).toBe(false);
  });
});
