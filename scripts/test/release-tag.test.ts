import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { deleteRemoteTag, fetchBranchTip, isAncestor, pushTag, remoteTagSha } from "../release/git.mjs";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { createReleaseTag, isWorkflowsRefusal, rollbackPlan, supersededNotice, tipStatus } from "../release/release-tag.mjs";

// Тег релиза (docs/09-ci-cd.md §8.1, «Порядок публикации», «Выпускается
// вершина ветки»): тег ставится первым из видимого снаружи и только на
// вершину ветки, а сбой публикации после него откатывается.

// Ответ GitHub из прогона 35887102572 (23.09.2026) — дословно.
const WORKFLOWS_REFUSAL =
  "! [remote rejected] v0.5.0-rc.6 -> v0.5.0-rc.6 (refusing to allow a GitHub App to create or update workflow " +
  "`.github/workflows/ci.yml` without `workflows` permission)";

const HEAD = "f1d5f4477aa1d24607f9b87f7589bcf7f17fdb4b";
const NEXT = "44bb3f65613699925334592b5852f19477159112";

describe("tipStatus", () => {
  it("коммит — вершина ветки: тег ставится", () => {
    expect(tipStatus({ branch: "dev", head: HEAD, tip: HEAD, headInTip: true })).toBe("current");
  });

  it("в ветку влили следующий PR: коммит обогнан, его выпустит прогон вершины", () => {
    expect(tipStatus({ branch: "dev", head: HEAD, tip: NEXT, headInTip: true })).toBe("superseded");
  });

  it("коммита в ветке нет — ошибка, а не молчаливый пропуск", () => {
    expect(() => tipStatus({ branch: "dev", head: HEAD, tip: NEXT, headInTip: false })).toThrow(/история переписана/);
  });

  it("ветки нет — ошибка", () => {
    expect(() => tipStatus({ branch: "dev", head: HEAD, tip: null, headInTip: false })).toThrow(/ветки dev/);
  });
});

describe("isWorkflowsRefusal", () => {
  it("узнаёт отказ GitHub из-за .github/workflows", () => {
    expect(isWorkflowsRefusal(WORKFLOWS_REFUSAL)).toBe(true);
  });

  it("не путает его с занятым тегом", () => {
    expect(isWorkflowsRefusal("! [rejected] v0.5.0-rc.6 -> v0.5.0-rc.6 (already exists)")).toBe(false);
  });
});

describe("createReleaseTag", () => {
  type Push = { ok: boolean; message: string };

  // Вершины ветки по порядку вызовов: до push и после отказа.
  function fakeIo(tips: Array<string | null>, push: Push) {
    const calls = { push: 0 };
    let tipCall = 0;
    return {
      calls,
      io: {
        fetchBranchTip: () => tips[Math.min(tipCall++, tips.length - 1)] ?? null,
        isAncestor: (ancestor: string, descendant: string) => ancestor === HEAD && descendant === NEXT,
        pushTag: () => {
          calls.push += 1;
          return push;
        },
      },
    };
  }

  const args = { branch: "dev", head: HEAD, version: "v0.5.0-rc.6" };

  it("вершина — тег ставится", () => {
    const { io } = fakeIo([HEAD], { ok: true, message: "* [new tag]" });
    expect(createReleaseTag(args, io)).toMatchObject({ created: true });
  });

  it("ветка ушла до тега — push не делается вовсе", () => {
    const { io, calls } = fakeIo([NEXT], { ok: true, message: "" });
    expect(createReleaseTag(args, io)).toMatchObject({ created: false, tip: NEXT, refusal: null });
    expect(calls.push).toBe(0);
  });

  it("ветка ушла между проверкой и push, GitHub отказал — это обгон, а не ошибка", () => {
    const { io } = fakeIo([HEAD, NEXT], { ok: false, message: WORKFLOWS_REFUSAL });
    expect(createReleaseTag(args, io)).toMatchObject({ created: false, tip: NEXT, refusal: WORKFLOWS_REFUSAL });
  });

  it("отказ при неушедшей ветке — ошибка с ответом сервера", () => {
    const { io } = fakeIo([HEAD, HEAD], { ok: false, message: "! [rejected] v0.5.0-rc.6 (already exists)" });
    expect(() => createReleaseTag(args, io)).toThrow(/already exists/);
  });

  it("отказ из-за workflow при неушедшей ветке — ошибка с подсказкой, где разбор", () => {
    const { io } = fakeIo([HEAD, HEAD], { ok: false, message: WORKFLOWS_REFUSAL });
    expect(() => createReleaseTag(args, io)).toThrow(/правило GitHub поменялось/);
  });
});

describe("supersededNotice", () => {
  it("называет номер, оба коммита и где разбор", () => {
    const notice = supersededNotice({ branch: "dev", head: HEAD, tip: NEXT, version: "v0.5.0-rc.6", refusal: null });
    expect(notice).toContain("v0.5.0-rc.6");
    expect(notice).toContain("f1d5f44");
    expect(notice).toContain("44bb3f6");
    expect(notice).toContain("«Выпускается вершина ветки»");
    expect(notice).not.toContain("GitHub отказал");
  });

  it("говорит об отказе GitHub, если обгон заметили по нему", () => {
    const notice = supersededNotice({
      branch: "dev",
      head: HEAD,
      tip: NEXT,
      version: "v0.5.0-rc.6",
      refusal: WORKFLOWS_REFUSAL,
    });
    expect(notice).toContain("GitHub отказал");
  });
});

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

  it("вершина ветки берётся с удалённого, а не из локальной копии", () => {
    expect(fetchBranchTip("dev")).toBe(sha.second);
    expect(fetchBranchTip("нет-такой-ветки")).toBeNull();
  });

  it("в ветку влили следующий PR — тег на прежнюю вершину не ставится", () => {
    // Второй клон — «следующий мердж», пока первый собирал релиз.
    const other = join(root, "other");
    execFileSync("git", ["clone", "--quiet", "--branch", "dev", join(root, "origin.git"), other], { stdio: "ignore" });
    git(other, "commit", "--allow-empty", "--quiet", "-m", "следующий мердж");
    git(other, "push", "--quiet", "origin", "dev");
    const next = git(other, "rev-parse", "HEAD");

    const io = { fetchBranchTip, isAncestor, pushTag };
    const result = createReleaseTag({ branch: "dev", head: sha.second, version: "v0.5.0-rc.2" }, io);
    expect(result).toMatchObject({ created: false, tip: next });
    expect(remoteTagSha("v0.5.0-rc.2")).toBeNull();
  });
});
