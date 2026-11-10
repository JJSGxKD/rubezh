import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { ABANDONED_CLAIM_HOURS, attemptChangeProblems, checkAheadPr, checkClaim, findAbandonedClaims, fromBranchProblem, hasWorkBeyondClaim, isAbandonedClaim, mergePreviousAttempt, restartClaim, takeOverClaim, unclosedDependenciesOnBase, withoutDependencyFiles } from "../tasks/claim.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { takenIdsOf } from "../tasks/branch.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { outOfZone } from "../tasks/zones.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { dependencyChangedFiles, mergeDependencyBranches } from "../tasks/git-io.mjs";

// Проверка захвата в CI (T-0011, «Решения»): PR ветки task/T-NNNN проходит, только
// если задачу можно было взять по правилам — как это делает `pnpm task claim`.

function task(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    fileName: `${id}-x.md`,
    title: `Задача ${id}`,
    epic: "E0",
    priority: "P1",
    status: "ready",
    owner: "",
    size: "S",
    depends_on: [],
    zones: [`zones/${id}/**`],
    shared: [],
    runner: "any",
    executor: "sonnet-5.5",
    effort: "medium",
    release: "patch",
    design: null,
    ...patch,
  };
}

function check(id: string, tasks: Record<string, unknown>[], taken: string[] = [], prs: unknown[] | null = [], repoFiles: string[] = []): string[] {
  return checkClaim(id, { tasks, taken: [id, ...taken], prs, repoFiles });
}

describe("проверка захвата в CI", () => {
  it("всё в порядке — проходит", () => {
    expect(check("T-0005", [task("T-0001", { status: "done" }), task("T-0005", { depends_on: ["T-0001"] })])).toEqual([]);
  });

  it("задача уже in-progress на базе — проходит", () => {
    expect(check("T-0005", [task("T-0005", { status: "in-progress", owner: "a / b" })])).toEqual([]);
  });

  it("зависимость не done — отказ с её номером", () => {
    const problems = check("T-0005", [task("T-0004"), task("T-0005", { depends_on: ["T-0004"] })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T-0004");
  });

  it("зависимости нет в реестре — отказ с её номером", () => {
    const problems = check("T-0005", [task("T-0005", { depends_on: ["T-0099"] })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T-0099");
  });

  it("зоны пересекаются с задачей, у которой есть ветка, — отказ с её номером", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const problems = check("T-0005", tasks, ["T-0004"], [], ["a/b.ts"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T-0004");
  });

  // Р171 (docs/35-stage4-plan.md): PR на ревью захват соседей не держит — кто вливается вторым, перебазируется.
  it("зоны пересекаются с задачей, чей PR ждёт ревью, — не отказ", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const prs = [{ number: 9, headRefName: "task/T-0004", isDraft: false, labels: [] }];
    expect(checkClaim("T-0005", { tasks, taken: ["T-0005", "T-0004"], prs, repoFiles: ["a/b.ts"] })).toEqual([]);
  });

  // Р172: решает метка — черновик с вопросами, отправленный «на ревью», поток уже оставил.
  it("зоны пересекаются с черновиком «на ревью» или PR «ждёт владельца» — не отказ", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    for (const pr of [
      { number: 9, headRefName: "task/T-0004", isDraft: true, labels: [{ name: "на ревью" }] },
      { number: 9, headRefName: "task/T-0004", isDraft: true, labels: [{ name: "ждёт владельца" }] },
    ]) {
      expect(checkClaim("T-0005", { tasks, taken: ["T-0005", "T-0004"], prs: [pr], repoFiles: ["a/b.ts"] })).toEqual([]);
    }
  });

  it("пересечение с PR «в работе», черновиком без метки или PR на доработке — отказ: там ещё пишут код", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    for (const pr of [
      { number: 9, headRefName: "task/T-0004", isDraft: true, labels: [] },
      { number: 9, headRefName: "task/T-0004", isDraft: false, labels: [{ name: "в работе" }] },
      { number: 9, headRefName: "task/T-0004", isDraft: false, labels: [{ name: "доработка" }] },
    ]) {
      const problems = checkClaim("T-0005", { tasks, taken: ["T-0005", "T-0004"], prs: [pr], repoFiles: ["a/b.ts"] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("T-0004");
    }
  });

  it("пересечение с задачей, взятой позже, — не отказ: держит тот, кто взял первым", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const claims = { "T-0005": "2026-10-27T05:00:00Z", "T-0004": "2026-10-27T06:00:00Z" };
    expect(checkClaim("T-0005", { tasks, taken: ["T-0005", "T-0004"], prs: [], repoFiles: ["a/b.ts"], claims })).toEqual([]);
    // Тот, кто взял позже, по-прежнему упирается в первого.
    expect(checkClaim("T-0004", { tasks, taken: ["T-0005", "T-0004"], prs: [], repoFiles: ["a/b.ts"], claims })).toHaveLength(1);
  });

  it("время захвата неизвестно — пересечение держит, как раньше", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const claims = { "T-0005": "2026-10-27T05:00:00Z" };
    expect(checkClaim("T-0005", { tasks, taken: ["T-0005", "T-0004"], prs: [], repoFiles: ["a/b.ts"], claims })).toHaveLength(1);
  });

  it("пересечение с задачей без ветки и PR — не отказ: занята только та, что взята", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    expect(check("T-0005", tasks, [], [], ["a/b.ts"])).toEqual([]);
  });

  it("пересечение с собственной зависимостью — не отказ, даже если её ветка осталась", () => {
    const tasks = [task("T-0004", { status: "done", zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"], depends_on: ["T-0004"] })];
    expect(check("T-0005", tasks, ["T-0004"], [], ["a/b.ts"])).toEqual([]);
  });

  it("пересечение с уже влитой задачей, чья ветка осталась, — не отказ", () => {
    const tasks = [task("T-0004", { status: "done", zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    expect(check("T-0005", tasks, ["T-0004"], [], ["a/b.ts"])).toEqual([]);
  });

  it("собственные ветка и PR задачи отказа не вызывают", () => {
    const prs = [{ number: 9, headRefName: "task/T-0005", isDraft: false }];
    expect(checkClaim("T-0005", { tasks: [task("T-0005")], taken: ["T-0005"], prs, repoFiles: [] })).toEqual([]);
  });

  it("статус draft на базе — отказ", () => {
    const problems = check("T-0005", [task("T-0005", { status: "draft" })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("draft");
  });

  it("статусы done и cancelled на базе — отказ: брать нечего", () => {
    for (const status of ["done", "cancelled"]) {
      const problems = check("T-0005", [task("T-0005", { status })]);
      expect(problems, status).toHaveLength(1);
      expect(problems[0], status).toContain(status);
    }
  });

  it("задачи нет на базе — отказ", () => {
    const problems = check("T-0005", [task("T-0001")]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T-0005");
  });

  it("несколько нарушений — все в ответе, а не только первое", () => {
    const tasks = [task("T-0003"), task("T-0004", { zones: ["a/**"] }), task("T-0005", { status: "draft", zones: ["a/b.ts"], depends_on: ["T-0003"] })];
    const problems = check("T-0005", tasks, ["T-0004"], [], ["a/b.ts"]);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("без списка PR (нет gh) решают одни ветки", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    expect(check("T-0005", tasks, ["T-0004"], null, ["a/b.ts"])).toHaveLength(1);
  });
});

// Задел (Р178, T-0351): захват поверх веток зависимостей, пока те ждут ревью.

describe("захват заделом: checkClaim с ahead", () => {
  const pr = (id: string, names: string[], extra: Record<string, unknown> = {}) => ({
    number: 40,
    headRefName: `task/${id}`,
    isDraft: false,
    labels: names.map((name) => ({ name })),
    ...extra,
  });
  const tasks = [task("T-0004"), task("T-0005", { depends_on: ["T-0004"] })];
  const run = (prs: unknown[] | null, patch: Record<string, unknown> = {}, list = tasks) =>
    checkClaim("T-0005", { tasks: list, taken: ["T-0005", "T-0004"], prs, repoFiles: [], ...patch });

  it("зависимость «на ревью», «ждёт владельца» или «доработка» — с ahead не отказ", () => {
    for (const status of ["на ревью", "ждёт владельца", "доработка"]) {
      expect(run([pr("T-0004", [status])], { ahead: true }), status).toEqual([]);
    }
  });

  it("без ahead та же зависимость — прежний отказ «не сделана»", () => {
    const problems = run([pr("T-0004", ["на ревью"])]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T-0004");
    expect(problems[0]).toContain("не сделана");
  });

  // Зависимость после захвата вернули на доработку и продолжили: PR задела не должен краснеть на каждом пуше.
  it("с ahead: зависимость «в работе» — не отказ, захват уже состоялся", () => {
    expect(run([pr("T-0004", ["в работе"])], { ahead: true })).toEqual([]);
    expect(run([pr("T-0004", [], { isDraft: true })], { ahead: true })).toEqual([]);
  });

  it("с ahead: зависимость без PR или сама задел — отказ", () => {
    for (const prs of [[], [pr("T-0004", ["задел"], { isDraft: true })], null]) {
      const problems = run(prs, { ahead: true });
      expect(problems, JSON.stringify(prs)).toHaveLength(1);
      expect(problems[0]).toContain("T-0004");
    }
  });

  it("с ahead: зависимость cancelled или не в реестре — отказ", () => {
    expect(run([], { ahead: true }, [task("T-0004", { status: "cancelled" }), tasks[1]])).toHaveLength(1);
    expect(run([], { ahead: true }, [tasks[1]])).toHaveLength(1);
  });

  it("с ahead: две зависимости, одна done, другая на ревью — не отказ; у другой нет PR — отказ", () => {
    const list = [task("T-0003", { status: "done" }), task("T-0004"), task("T-0005", { depends_on: ["T-0003", "T-0004"] })];
    expect(run([pr("T-0004", ["на ревью"])], { ahead: true }, list)).toEqual([]);
    expect(run([], { ahead: true }, list)).toHaveLength(1);
  });

  it("с ahead все зависимости done — не отказ", () => {
    expect(run([], { ahead: true }, [task("T-0004", { status: "done" }), tasks[1]])).toEqual([]);
  });

  it("ahead не отменяет остальные проверки: статус задачи", () => {
    const list = [tasks[0], task("T-0005", { status: "draft", depends_on: ["T-0004"] })];
    const problems = run([pr("T-0004", ["на ревью"])], { ahead: true }, list);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("draft");
  });

  // Задел зон не держит — как «на ревью» (Р178).
  it("зоны пересекаются с PR задела — не отказ: задел зон не держит", () => {
    const list = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const prs = [pr("T-0004", ["задел"], { isDraft: true })];
    expect(checkClaim("T-0005", { tasks: list, taken: ["T-0005", "T-0004"], prs, repoFiles: ["a/b.ts"] })).toEqual([]);
  });
});

describe("PR задела в CI: checkAheadPr", () => {
  const list = [task("T-0004"), task("T-0005", { depends_on: ["T-0004"] })];
  const subject = list[1];
  const pr = (patch: Record<string, unknown> = {}) => ({ number: 41, headRefName: "task/T-0005", isDraft: true, labels: [{ name: "задел" }], ...patch });

  it("черновик с меткой «задел» и незакрытой зависимостью — ок", () => {
    expect(checkAheadPr(pr(), subject, list)).toEqual([]);
  });

  it("не черновик — ошибка с номерами зависимостей", () => {
    const problems = checkAheadPr(pr({ isDraft: false }), subject, list);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T-0004");
    expect(problems[0]).toContain("черновик");
  });

  it("без метки «задел» — ошибка", () => {
    const problems = checkAheadPr(pr({ labels: [{ name: "на ревью" }] }), subject, list);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("«задел»");
  });

  it("не черновик и без метки — обе причины", () => {
    expect(checkAheadPr(pr({ isDraft: false, labels: [] }), subject, list)).toHaveLength(2);
  });

  it("все зависимости done — ок в любом виде", () => {
    const done = [task("T-0004", { status: "done" }), subject];
    for (const patch of [{}, { isDraft: false }, { labels: [] }, { isDraft: false, labels: [{ name: "на ревью" }] }]) {
      expect(checkAheadPr(pr(patch), subject, done), JSON.stringify(patch)).toEqual([]);
    }
  });

  it("зависимостей нет вовсе — ок", () => {
    expect(checkAheadPr(pr({ isDraft: false, labels: [] }), task("T-0006"), [task("T-0006")])).toEqual([]);
  });

  it("PR не найден среди открытых, а зависимости не влиты — ошибка", () => {
    expect(checkAheadPr(undefined, subject, list)).toHaveLength(1);
    expect(checkAheadPr(undefined, task("T-0006"), [task("T-0006")])).toEqual([]);
  });
});

describe("вычитание файлов зависимостей из диффа задела", () => {
  it("убирает только файлы зависимостей, порядок остальных сохраняется", () => {
    expect(withoutDependencyFiles(["a.ts", "b.ts", "c.ts"], ["b.ts", "x.ts"])).toEqual(["a.ts", "c.ts"]);
  });

  it("зависимостей нет — дифф как был", () => {
    expect(withoutDependencyFiles(["a.ts"], [])).toEqual(["a.ts"]);
  });
});

describe("зависимости для вычитания берутся с базы, а не из ветки PR", () => {
  const base = [task("T-0001", { status: "done" }), task("T-0002"), task("T-0003", { depends_on: ["T-0001", "T-0002"] }), task("T-0004")];

  it("незакрытые зависимости задачи на базе, в порядке depends_on", () => {
    expect(unclosedDependenciesOnBase("T-0003", base)).toEqual(["T-0002"]);
  });

  it("зависимость, которой нет в реестре базы, считается незакрытой", () => {
    expect(unclosedDependenciesOnBase("T-0005", [task("T-0005", { depends_on: ["T-0099"] })])).toEqual(["T-0099"]);
  });

  it("задачи нет на базе или зависимостей нет — вычитать нечего", () => {
    expect(unclosedDependenciesOnBase("T-0009", base)).toEqual([]);
    expect(unclosedDependenciesOnBase("T-0004", base)).toEqual([]);
  });

  // PR дописал в ветке чужую задачу в depends_on: на базе её нет, файлы не вычитаются, diff-check красный.
  it("зависимость, дописанная только в ветке, не вычитает файлы: они остаются вне зон", () => {
    const branchTask = task("T-0004", { depends_on: ["T-0002"] });
    expect(branchTask.depends_on).toEqual(["T-0002"]);
    const unclosed = unclosedDependenciesOnBase("T-0004", base);
    expect(unclosed).toEqual([]);
    const changed = withoutDependencyFiles(["zones/T-0004/a.ts", "other/b.ts"], unclosed.length === 0 ? [] : ["other/b.ts"]);
    expect(outOfZone(changed, branchTask)).toEqual(["other/b.ts"]);
  });
});

describe("ветка задела и дифф на настоящем git (временный репозиторий, без сети)", () => {
  let repo = "";

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  }

  function write(path: string, text: string): void {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  // «Удалённая» ветка: локальная ветка, зафиксированная как origin/<имя>.
  function publish(name: string): void {
    git("update-ref", `refs/remotes/origin/${name}`, git("rev-parse", name));
  }

  function dependencyBranch(name: string, files: Record<string, string>): void {
    git("switch", "--quiet", "-c", name, "origin/dev");
    for (const [path, text] of Object.entries(files)) write(path, text);
    git("add", "-A");
    git("commit", "--quiet", "-m", `${name}: правка`);
    publish(name);
    git("switch", "--quiet", "dev");
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "rubezh-ahead-"));
    git("init", "--quiet", "-b", "dev");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    write("base.txt", "база\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "база");
    publish("dev");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("ветка содержит коммиты всех незакрытых зависимостей по порядку", () => {
    dependencyBranch("task/T-0001", { "dep1/a.ts": "a\n" });
    dependencyBranch("task/T-0002", { "dep2/b.ts": "b\n" });
    git("switch", "--quiet", "-c", "task/T-0003", "origin/dev");
    const result = mergeDependencyBranches(["T-0001", "T-0002"], { cwd: repo });
    expect(result).toEqual({ ok: true });
    expect(git("ls-files").split("\n").sort()).toEqual(["base.txt", "dep1/a.ts", "dep2/b.ts"]);
    for (const id of ["T-0001", "T-0002"]) {
      expect(() => git("merge-base", "--is-ancestor", `origin/task/${id}`, "HEAD")).not.toThrow();
    }
    expect(git("status", "--porcelain")).toBe("");
  });

  it("ветки зависимостей конфликтуют — сборка отменена, дерево чистое, названа вторая зависимость", () => {
    dependencyBranch("task/T-0001", { "shared.ts": "из первой\n" });
    dependencyBranch("task/T-0002", { "shared.ts": "из второй\n" });
    git("switch", "--quiet", "-c", "task/T-0003", "origin/dev");
    const result = mergeDependencyBranches(["T-0001", "T-0002"], { cwd: repo });
    expect(result.ok).toBe(false);
    expect(result.dependency).toBe("T-0002");
    expect(result.conflicts).toEqual(["shared.ts"]);
    expect(git("status", "--porcelain")).toBe("");
    // Первая зависимость остаётся влитой: откатывает ветку целиком вызывающий.
    expect(git("ls-files").split("\n")).toContain("shared.ts");
  });

  it("нет ветки зависимости на origin — отказ с её номером, ничего не влито", () => {
    git("switch", "--quiet", "-c", "task/T-0003", "origin/dev");
    const result = mergeDependencyBranches(["T-0009"], { cwd: repo });
    expect(result).toMatchObject({ ok: false, dependency: "T-0009", missing: true });
    expect(git("status", "--porcelain")).toBe("");
  });

  it("файлы зависимостей отделяются от файлов самого задела", () => {
    dependencyBranch("task/T-0001", { "dep1/a.ts": "a\n", "shared/x.ts": "x\n" });
    dependencyBranch("task/T-0002", { "dep2/b.ts": "b\n" });
    git("switch", "--quiet", "-c", "task/T-0003", "origin/dev");
    expect(mergeDependencyBranches(["T-0001", "T-0002"], { cwd: repo })).toEqual({ ok: true });
    write("own/c.ts", "c\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "своё");

    const changed = git("diff", "--name-only", "--no-renames", "origin/dev...HEAD").split("\n");
    expect(changed.sort()).toEqual(["dep1/a.ts", "dep2/b.ts", "own/c.ts", "shared/x.ts"]);

    const { files, missing } = dependencyChangedFiles(["T-0001", "T-0002"], { base: "origin/dev", cwd: repo });
    expect(missing).toEqual([]);
    expect([...files].sort()).toEqual(["dep1/a.ts", "dep2/b.ts", "shared/x.ts"]);
    expect(withoutDependencyFiles(changed, files)).toEqual(["own/c.ts"]);
  });

  it("ветки зависимости нет на origin — она названа в missing, остальные считаются", () => {
    dependencyBranch("task/T-0001", { "dep1/a.ts": "a\n" });
    const { files, missing } = dependencyChangedFiles(["T-0001", "T-0009"], { base: "origin/dev", cwd: repo });
    expect([...files]).toEqual(["dep1/a.ts"]);
    expect(missing).toEqual(["T-0009"]);
  });
});

// T-0371: ветка с одним захватом старше суток не держит зоны, задачу можно перехватить.
describe("брошенный захват: isAbandonedClaim", () => {
  const NOW = Date.parse("2026-11-06T12:00:00Z");
  const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();
  const base = { changedFiles: ["tasks/T-0005-x.md"], lastCommitAt: hoursAgo(25), hasOpenPr: false, taskFileName: "T-0005-x.md", now: NOW };

  it("порог — сутки", () => {
    expect(ABANDONED_CLAIM_HOURS).toBe(24);
  });

  it("только файл задачи, 25 часов, без PR — брошен", () => {
    expect(isAbandonedClaim(base)).toBe(true);
  });

  it("23 часа — захват живой", () => {
    expect(isAbandonedClaim({ ...base, lastCommitAt: hoursAgo(23) })).toBe(false);
  });

  it("файл задачи и ещё один файл — живой", () => {
    expect(isAbandonedClaim({ ...base, changedFiles: ["tasks/T-0005-x.md", "scripts/a.ts"] })).toBe(false);
  });

  it("чужой файл в tasks/ — не файл задачи, живой", () => {
    expect(isAbandonedClaim({ ...base, changedFiles: ["tasks/T-0006-y.md"] })).toBe(false);
  });

  it("открытый PR любого вида — живой", () => {
    expect(isAbandonedClaim({ ...base, hasOpenPr: true })).toBe(false);
  });

  it("время или дифф неизвестны — живой", () => {
    expect(isAbandonedClaim({ ...base, lastCommitAt: null })).toBe(false);
    expect(isAbandonedClaim({ ...base, lastCommitAt: "не дата" })).toBe(false);
    expect(isAbandonedClaim({ ...base, changedFiles: null })).toBe(false);
  });

  it("файл задачи из архива считается файлом задачи", () => {
    expect(isAbandonedClaim({ ...base, changedFiles: ["tasks/archive/T-0005-x.md"] })).toBe(true);
  });
});

describe("брошенный захват: checkClaim", () => {
  const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
  const input = { tasks, taken: ["T-0005", "T-0004"], prs: [], repoFiles: ["a/b.ts"] };

  it("захват соседа брошен — задачу можно брать", () => {
    expect(checkClaim("T-0005", { ...input, abandoned: new Set(["T-0004"]) })).toEqual([]);
  });

  it("захват соседа живой — прежний отказ «зоны пересекаются»", () => {
    for (const abandoned of [undefined, new Set<string>()]) {
      const problems = checkClaim("T-0005", { ...input, abandoned });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("зоны пересекаются с T-0004");
    }
  });
});

describe("перехват брошенного захвата: takeOverClaim", () => {
  type Call = string[];
  function setup(options: { pushError?: string; mergeFails?: boolean; fetchFails?: boolean } = {}) {
    const calls: Call[] = [];
    const files: Record<string, string> = { "T-0005-x.md": "---\nstatus: in-progress\nowner: claude-1 / sonnet-5.5 / medium\n---\nтекст" };
    const result = (ok: boolean, stderr = "") => ({ ok, stdout: "", stderr });
    const tryGit = (args: Call) => {
      calls.push(args);
      if (args[0] === "fetch") return result(options.fetchFails !== true, "fetch упал");
      if (args[0] === "merge" && args[1] === "--no-edit") return result(options.mergeFails !== true, "конфликт");
      if (args[0] === "push") return options.pushError === undefined ? result(true) : result(false, options.pushError);
      return result(true);
    };
    const git = (args: Call) => {
      calls.push(args);
      return args[0] === "log" ? "2026-11-03T10:00:00+00:00" : "";
    };
    const run = () =>
      takeOverClaim({
        id: "T-0005",
        fileName: "T-0005-x.md",
        owner: "claude-9 / sonnet-5.5 / medium",
        git,
        tryGit,
        readFile: (name: string) => files[name],
        writeFile: (name: string, text: string) => {
          files[name] = text;
        },
        rewrite: (text: string, owner: string) => ({ text: text.replace(/^owner:.*$/m, `owner: ${owner}`), problems: [] }),
      });
    return { calls, files, run };
  }

  it("ветка с origin, merge dev, новый owner, коммит и push без --force", () => {
    const { calls, files, run } = setup();
    expect(run()).toEqual({ ok: true });
    const lines = calls.map((call) => call.join(" "));
    expect(lines.some((line) => line.startsWith("fetch origin task/T-0005"))).toBe(true);
    expect(lines.some((line) => line.startsWith("switch -c task/T-0005 origin/task/T-0005"))).toBe(true);
    expect(lines).toContain("merge --no-edit origin/dev");
    expect(files["T-0005-x.md"]).toContain("owner: claude-9 / sonnet-5.5 / medium");
    const commit = calls.find((call) => call[0] === "commit")?.join("\n") ?? "";
    expect(commit).toContain("chore(tasks): Перехватить T-0005 — захват брошен");
    expect(commit).toContain("claude-1 / sonnet-5.5 / medium");
    expect(commit).toContain("2026-11-03T10:00:00+00:00");
    expect(calls.find((call) => call[0] === "push")).toEqual(["push", "origin", "HEAD:refs/heads/task/T-0005"]);
    expect(lines.join(" ")).not.toContain("--force");
    expect(lines.join(" ")).not.toContain("branch -D");
  });

  it("push отклонён — «захват ожил», успеха нет", () => {
    const result = setup({ pushError: "! [rejected] HEAD -> task/T-0005 (non-fast-forward)" }).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Захват ожил");
  });

  it("merge dev с конфликтом — отказ, слияние отменено", () => {
    const { calls, run } = setup({ mergeFails: true });
    expect(run().ok).toBe(false);
    expect(calls.some((call) => call[0] === "merge" && call[1] === "--abort")).toBe(true);
  });

  it("ветку не получить — отказ без коммита", () => {
    const { calls, run } = setup({ fetchFails: true });
    expect(run().ok).toBe(false);
    expect(calls.some((call) => call[0] === "commit")).toBe(false);
  });
});

// T-0390, Р195: снятие застрявшего захвата — попытка задачи и ветка task/T-NNNN-N.

describe("попытки: ветка прежней попытки ничего не держит (checkClaim)", () => {
  // A и B пересекаются зонами; у B действует попытка 2.
  const tasks = [task("T-0001", { zones: ["a/**"] }), task("T-0002", { zones: ["a/b.ts"], attempt: "2" })];
  const repoFiles = ["a/b.ts"];
  const verdict = (branches: string[], prs: unknown[] = []): string[] => checkClaim("T-0001", { tasks, taken: ["T-0001", ...takenIdsOf(branches, tasks)], prs, repoFiles });

  it("на origin только task/T-0002 (попытка 1) с работой — задачу A брать можно", () => {
    expect(verdict(["task/T-0002"])).toEqual([]);
  });

  it("есть task/T-0002-2 — прежняя ошибка «зоны пересекаются»", () => {
    const problems = verdict(["task/T-0002", "task/T-0002-2"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("зоны пересекаются с T-0002");
  });

  it("есть task/T-0002-3 (будущая попытка) — A брать можно", () => {
    expect(verdict(["task/T-0002-3"])).toEqual([]);
  });

  it("открытый PR из ветки прежней попытки зон не держит и задачу занятой не делает", () => {
    const prs = [{ headRefName: "task/T-0002", isDraft: false, labels: [{ name: "в работе" }] }];
    expect(verdict(["task/T-0002"], prs)).toEqual([]);
  });

  it("открытый PR из ветки текущей попытки зоны держит", () => {
    const prs = [{ headRefName: "task/T-0002-2", isDraft: false, labels: [{ name: "в работе" }] }];
    const problems = verdict([], prs);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T-0002");
  });

  it("PR текущей попытки «на ревью» зоны не держит, как и раньше", () => {
    const prs = [{ headRefName: "task/T-0002-2", isDraft: false, labels: [{ name: "на ревью" }] }];
    expect(verdict(["task/T-0002-2"], prs)).toEqual([]);
  });
});

describe("попытки: claim-check принимает только ветку текущей попытки", () => {
  const tasks = [task("T-0119", { attempt: "2" })];
  const input = { tasks, taken: ["T-0119"], prs: [], repoFiles: [] };

  it("ветка текущей попытки — проходит", () => {
    expect(checkClaim("T-0119", { ...input, branchAttempt: 2 })).toEqual([]);
  });

  it("ветка прежней попытки — отказ с текстом Р195 и подсказкой --from", () => {
    const problems = checkClaim("T-0119", { ...input, branchAttempt: 1 });
    expect(problems).toEqual(["ветка task/T-0119 — попытка 1, а у T-0119 действует попытка 2: захват снят тимлидом (Р195). Продолжай веткой task/T-0119-2: pnpm task claim T-0119 --from task/T-0119"]);
  });

  it("ветка будущей попытки — отказ: такой попытки у задачи нет", () => {
    const problems = checkClaim("T-0119", { ...input, branchAttempt: 3 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("task/T-0119-3");
    expect(problems[0]).toContain("попытка 2");
  });

  it("задача без attempt и ветка без суффикса — проходит; без branchAttempt проверка не делается", () => {
    expect(checkClaim("T-0005", { tasks: [task("T-0005")], taken: ["T-0005"], prs: [], repoFiles: [], branchAttempt: 1 })).toEqual([]);
    expect(checkClaim("T-0119", input)).toEqual([]);
  });
});

describe("попытки: брошенный захват считается по ветке текущей попытки", () => {
  const NOW = Date.parse("2026-11-06T12:00:00Z");
  const old = new Date(NOW - 30 * 3_600_000).toISOString();
  const tasks = [task("T-0002", { attempt: "2" })];
  const branchOf = (task_: { id: string }) => ({ changedFiles: [`tasks/${task_.id}-x.md`], lastCommitAt: old });

  it("текущая ветка с одним захватом старше суток — брошена", () => {
    const { abandoned } = findAbandonedClaims({ taken: ["T-0002"], tasks, prs: [], now: NOW, readBranch: branchOf });
    expect([...abandoned]).toEqual(["T-0002"]);
  });

  it("открытый PR ветки прежней попытки не оживляет брошенный захват", () => {
    const prs = [{ headRefName: "task/T-0002", isDraft: false }];
    const { abandoned } = findAbandonedClaims({ taken: ["T-0002"], tasks, prs, now: NOW, readBranch: branchOf });
    expect(abandoned.has("T-0002")).toBe(true);
  });

  it("открытый PR ветки текущей попытки оживляет", () => {
    const prs = [{ headRefName: "task/T-0002-2", isDraft: false }];
    const { abandoned } = findAbandonedClaims({ taken: ["T-0002"], tasks, prs, now: NOW, readBranch: branchOf });
    expect(abandoned.has("T-0002")).toBe(false);
  });

  it("читается именно ветка текущей попытки", () => {
    const asked: string[] = [];
    findAbandonedClaims({ taken: ["T-0002"], tasks, prs: [], now: NOW, readBranch: (t: { id: string; attempt?: string }) => (asked.push(`${t.id}:${t.attempt}`), branchOf(t)) });
    expect(asked).toEqual(["T-0002:2"]);
  });

  it("задача не в работе (done) не рассматривается", () => {
    const done = [task("T-0002", { status: "done" })];
    const { abandoned } = findAbandonedClaims({ taken: ["T-0002"], tasks: done, prs: [], now: NOW, readBranch: branchOf });
    expect(abandoned.size).toBe(0);
  });
});

describe("hasWorkBeyondClaim: в ветке есть работа кроме захвата", () => {
  it("кроме файла задачи изменено что-то ещё — работа есть", () => {
    expect(hasWorkBeyondClaim(["tasks/T-0005-x.md", "scripts/a.ts"], "T-0005-x.md")).toBe(true);
  });

  it("только файл задачи (и в архиве тоже) — работы нет", () => {
    expect(hasWorkBeyondClaim(["tasks/T-0005-x.md"], "T-0005-x.md")).toBe(false);
    expect(hasWorkBeyondClaim(["tasks/archive/T-0005-x.md"], "T-0005-x.md")).toBe(false);
  });

  it("дифф не получен — работы «нет»: гадать по догадке нельзя", () => {
    expect(hasWorkBeyondClaim(null, "T-0005-x.md")).toBe(false);
  });
});

describe("снятие захвата: restartClaim", () => {
  const TEXT = [
    "---",
    "id: T-0119",
    "title: Задача",
    "epic: E0",
    "priority: P1",
    "status: in-progress",
    "owner: claude-10 / sonnet-5.5 / medium",
    "size: S",
    "depends_on: []",
    "zones:",
    "  - zones/T-0119/**",
    "shared: []",
    "runner: any",
    "executor: sonnet-5.5",
    "effort: medium",
    "release: patch",
    "design: null",
    "batch: 4",
    "---",
    "",
    "# T-0119. Заголовок",
    "",
  ].join("\n");
  const FILE = "T-0119-x.md";

  type Call = string[];
  function setup(options: { task?: Record<string, unknown>; reason?: string; headBranch?: string; dirty?: boolean; noBranch?: boolean; text?: string } = {}) {
    const calls: Call[] = [];
    const files: Record<string, string> = { [FILE]: options.text ?? TEXT };
    const result = (ok: boolean, stdout = "", stderr = "") => ({ ok, stdout, stderr });
    const current = options.task ?? task("T-0119", { fileName: FILE, status: "ready" });
    const branch = current.attempt === undefined ? "task/T-0119" : `task/T-0119-${String(current.attempt)}`;
    const tryGit = (args: Call) => {
      calls.push(args);
      if (args[0] === "rev-parse") return result(options.noBranch !== true);
      if (args[0] === "show") return result(true, `---\nowner: claude-10 / sonnet-5.5 / medium\n---\n`);
      if (args[0] === "log") return result(true, "2026-11-06T09:00:00+00:00");
      return result(true);
    };
    const git = (args: Call) => {
      calls.push(args);
      return args[0] === "status" ? (options.dirty === true ? " M a.ts" : "") : "";
    };
    const run = () =>
      restartClaim({
        task: current,
        reason: options.reason ?? "аккаунт заблокирован",
        headBranch: options.headBranch ?? "claude/lead-work",
        git,
        tryGit,
        readFile: (name: string) => files[name],
        writeFile: (name: string, text: string) => {
          files[name] = text;
        },
      });
    return { calls, files, run, branch };
  }

  const commitOf = (calls: Call[]): string => calls.find((call) => call[0] === "commit")?.join("\n") ?? "";

  it("попытка 1 → 2: поле последней строкой шапки, status ready, owner пустой", () => {
    const { files, run } = setup();
    const done = run();
    expect(done).toMatchObject({ ok: true, attempt: 2, branch: "task/T-0119-2", previousBranch: "task/T-0119" });
    const text = files[FILE];
    const header = text.slice(0, text.indexOf("\n---", 4)).split("\n");
    expect(header.at(-1)).toBe("attempt: 2");
    expect(header).toContain("status: ready");
    expect(header).toContain("owner:");
    expect(text.endsWith("# T-0119. Заголовок\n")).toBe(true);
  });

  it("попытка 2 → 3: ветка прежней попытки — task/T-0119-2", () => {
    const text = TEXT.replace("batch: 4", "batch: 4\nattempt: 2");
    const { files, run } = setup({ task: task("T-0119", { fileName: FILE, attempt: "2" }), text });
    expect(run()).toMatchObject({ ok: true, attempt: 3, branch: "task/T-0119-3", previousBranch: "task/T-0119-2" });
    expect(files[FILE].match(/^attempt:.*$/gm)).toEqual(["attempt: 3"]);
  });

  it("коммит с заголовком и телом: причина, прежняя ветка, прежний owner, время; без push и --force", () => {
    const { calls, run } = setup({ reason: "аккаунт заблокирован на GitHub" });
    expect(run().ok).toBe(true);
    const commit = commitOf(calls);
    expect(commit).toContain("chore(tasks): Снять захват T-0119 — попытка 2");
    expect(commit).toContain("аккаунт заблокирован на GitHub");
    expect(commit).toContain("task/T-0119");
    expect(commit).toContain("claude-10 / sonnet-5.5 / medium");
    expect(commit).toContain("2026-11-06T09:00:00+00:00");
    expect(calls.some((call) => call[0] === "push")).toBe(false);
    expect(calls.flat().join(" ")).not.toContain("--force");
    expect(calls.flat().join(" ")).not.toContain("--delete");
  });

  it("коммитится только файл задачи", () => {
    const { calls, run } = setup();
    run();
    const commit = calls.find((call) => call[0] === "commit") ?? [];
    expect(commit.slice(-2)).toEqual(["--", `tasks/${FILE}`]);
  });

  it("ветки текущей попытки на origin нет — «снимать нечего, задача свободна»", () => {
    const { calls, files, run } = setup({ noBranch: true });
    const refused = run();
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("снимать нечего, задача свободна");
    expect(calls.some((call) => call[0] === "commit")).toBe(false);
    expect(files[FILE]).toBe(TEXT);
  });

  it("done, cancelled, draft — «попытки бывают только у задач в работе»", () => {
    for (const status of ["done", "cancelled", "draft"]) {
      const { calls, run } = setup({ task: task("T-0119", { fileName: FILE, status }) });
      const refused = run();
      expect(refused.ok, status).toBe(false);
      expect(refused.message, status).toContain("попытки бывают только у задач в работе");
      expect(calls.some((call) => call[0] === "commit"), status).toBe(false);
    }
  });

  it("статус in-progress на базе допустим", () => {
    expect(setup({ task: task("T-0119", { fileName: FILE, status: "in-progress" }) }).run().ok).toBe(true);
  });

  it("пустая причина — отказ", () => {
    for (const reason of ["", "   "]) {
      const { calls, run } = setup({ reason });
      const refused = run();
      expect(refused.ok, JSON.stringify(reason)).toBe(false);
      expect(refused.message).toContain("причин");
      expect(calls.some((call) => call[0] === "commit")).toBe(false);
    }
  });

  it("рабочая ветка task/* (в том числе с суффиксом) — отказ", () => {
    for (const headBranch of ["task/T-0390", "task/T-0119-2"]) {
      const refused = setup({ headBranch }).run();
      expect(refused.ok, headBranch).toBe(false);
      expect(refused.message, headBranch).toContain("не task/*");
    }
  });

  it("рабочая копия грязная — отказ", () => {
    const { calls, run } = setup({ dirty: true });
    const refused = run();
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("не чистая");
    expect(calls.some((call) => call[0] === "commit")).toBe(false);
  });

  it("рабочая копия отстала: попытка в файле не та, что на базе, — отказ", () => {
    const behind = setup({ task: task("T-0119", { fileName: FILE, attempt: "2" }) });
    const refused = behind.run();
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("origin/dev");
  });
});

describe("--from: только ветка прежней попытки этой же задачи", () => {
  const current = task("T-0119", { attempt: "3" });

  it("ветка попытки 1 и попытки 2 при попытке 3 — годятся", () => {
    expect(fromBranchProblem(current, "task/T-0119", { exists: true })).toBeNull();
    expect(fromBranchProblem(current, "task/T-0119-2", { exists: true })).toBeNull();
  });

  it("чужая задача, текущая и будущая попытка, не ветка задачи — отказ с текстом", () => {
    for (const from of ["task/T-0120", "task/T-0119-3", "task/T-0119-4", "feat/x", "task/T-0119-1"]) {
      expect(fromBranchProblem(current, from, { exists: true }), from).toBe("--from берёт только ветку прежней попытки T-0119");
    }
  });

  it("ветки нет на origin — тот же отказ", () => {
    expect(fromBranchProblem(current, "task/T-0119", { exists: false })).toBe("--from берёт только ветку прежней попытки T-0119");
  });

  it("задача без попытки: прежних веток нет — любой --from отказ", () => {
    expect(fromBranchProblem(task("T-0119"), "task/T-0119", { exists: true })).toBe("--from берёт только ветку прежней попытки T-0119");
  });
});

describe("claim --from: слияние ветки прежней попытки (mergePreviousAttempt)", () => {
  type Call = string[];
  function setup(options: { conflicts?: string[]; mergeFails?: boolean; fetchFails?: boolean } = {}) {
    const calls: Call[] = [];
    const result = (ok: boolean, stdout = "", stderr = "") => ({ ok, stdout, stderr });
    const tryGit = (args: Call) => {
      calls.push(args);
      if (args[0] === "fetch") return result(options.fetchFails !== true, "", "fetch упал");
      if (args[0] === "merge" && args[1] === "--no-edit") return options.conflicts !== undefined || options.mergeFails === true ? result(false, "", "CONFLICT") : result(true);
      if (args[0] === "diff") return result(true, (options.conflicts ?? []).join("\n"));
      return result(true);
    };
    const run = () => mergePreviousAttempt({ from: "task/T-0119", fileName: "T-0119-x.md", base: "origin/dev", tryGit });
    return { calls, run };
  }

  it("без конфликтов: fetch и merge --no-edit origin/<ветка>", () => {
    const { calls, run } = setup();
    expect(run()).toEqual({ ok: true });
    const lines = calls.map((call) => call.join(" "));
    expect(lines[0]).toBe("fetch origin task/T-0119");
    expect(lines).toContain("merge --no-edit origin/task/T-0119");
    expect(lines.some((line) => line.startsWith("merge --abort"))).toBe(false);
  });

  it("конфликт только в файле задачи — берётся версия базы, слияние коммитится", () => {
    const { calls, run } = setup({ conflicts: ["tasks/T-0119-x.md"] });
    expect(run()).toEqual({ ok: true });
    const lines = calls.map((call) => call.join(" "));
    expect(lines).toContain("checkout origin/dev -- tasks/T-0119-x.md");
    expect(lines).toContain("commit --no-edit");
    expect(lines.some((line) => line.startsWith("merge --abort"))).toBe(false);
  });

  it("конфликт в другом файле — merge --abort и отказ со списком файлов", () => {
    const { calls, run } = setup({ conflicts: ["tasks/T-0119-x.md", "packages/core-game/src/content/balance-targets.ts"] });
    const refused = run();
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("packages/core-game/src/content/balance-targets.ts");
    expect(refused.conflicts).toEqual(["tasks/T-0119-x.md", "packages/core-game/src/content/balance-targets.ts"]);
    const lines = calls.map((call) => call.join(" "));
    expect(lines).toContain("merge --abort");
    expect(lines.some((line) => line.startsWith("checkout"))).toBe(false);
    expect(lines).not.toContain("commit --no-edit");
  });

  it("слияние упало без конфликтных файлов — отказ, слияние отменено", () => {
    const { calls, run } = setup({ mergeFails: true });
    expect(run().ok).toBe(false);
    expect(calls.map((call) => call.join(" "))).toContain("merge --abort");
  });

  it("ветку не получить — отказ без слияния", () => {
    const { calls, run } = setup({ fetchFails: true });
    expect(run().ok).toBe(false);
    expect(calls.some((call) => call[0] === "merge")).toBe(false);
  });
});

describe("claim --from на настоящем git (временный репозиторий, без сети)", () => {
  let repo = "";

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  }

  function write(path: string, text: string): void {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  function commitAll(message: string): void {
    git("add", "-A");
    git("commit", "--quiet", "-m", message);
  }

  function tryGit(args: string[]): { ok: boolean; stdout: string; stderr: string } {
    try {
      return { ok: true, stdout: git(...args), stderr: "" };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      return { ok: false, stdout: String(failed.stdout ?? "").trim(), stderr: String(failed.stderr ?? "").trim() };
    }
  }

  const TASK_FILE = "tasks/T-0119-x.md";

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "rubezh-from-"));
    git("init", "--quiet", "-b", "dev");
    // origin — этот же репозиторий: fetch ветки прежней попытки отрабатывает без сети.
    git("remote", "add", "origin", repo);
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    write(TASK_FILE, "---\nstatus: ready\nowner:\nbatch: 4\n---\nтекст\n");
    write("code.ts", "a\n");
    commitAll("база");
    // Старая ветка: захват и работа.
    git("switch", "--quiet", "-c", "task/T-0119");
    write(TASK_FILE, "---\nstatus: in-progress\nowner: claude-10 / sonnet-5.5 / medium\nbatch: 4\n---\nтекст\n");
    write("work.ts", "работа\n");
    commitAll("работа прежней попытки");
    git("update-ref", "refs/remotes/origin/task/T-0119", git("rev-parse", "task/T-0119"));
    git("switch", "--quiet", "dev");
    // Снятие захвата на dev: попытка 2.
    write(TASK_FILE, "---\nstatus: ready\nowner:\nbatch: 4\nattempt: 2\n---\nтекст\n");
    commitAll("снять захват");
    git("update-ref", "refs/remotes/origin/dev", git("rev-parse", "dev"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("работа прежней попытки попадает в ветку новой, попытка 2 остаётся", () => {
    git("switch", "--quiet", "-c", "task/T-0119-2", "origin/dev");
    const merged = mergePreviousAttempt({ from: "task/T-0119", fileName: "T-0119-x.md", base: "origin/dev", tryGit });
    expect(merged.ok).toBe(true);
    expect(git("show", "HEAD:work.ts")).toBe("работа");
    expect(git("show", `HEAD:${TASK_FILE}`)).toContain("attempt: 2");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("конфликт в файле задачи разрешается версией базы", () => {
    // На dev файл задачи правят в тех же строках, что и старая ветка, — будет конфликт.
    write(TASK_FILE, "---\nstatus: ready\nowner: другой\nbatch: 4\nattempt: 2\n---\nтекст dev\n");
    commitAll("правка задачи на dev");
    git("update-ref", "refs/remotes/origin/dev", git("rev-parse", "dev"));
    git("switch", "--quiet", "-c", "task/T-0119-2", "origin/dev");
    const merged = mergePreviousAttempt({ from: "task/T-0119", fileName: "T-0119-x.md", base: "origin/dev", tryGit });
    expect(merged.ok).toBe(true);
    expect(git("show", `HEAD:${TASK_FILE}`)).toContain("текст dev");
    expect(git("show", "HEAD:work.ts")).toBe("работа");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("конфликт в чужом файле — слияние отменено, дерево чистое", () => {
    git("switch", "--quiet", "task/T-0119");
    write("code.ts", "ветка\n");
    commitAll("правка кода в ветке");
    git("update-ref", "refs/remotes/origin/task/T-0119", git("rev-parse", "task/T-0119"));
    git("switch", "--quiet", "dev");
    write("code.ts", "dev\n");
    commitAll("правка кода на dev");
    git("update-ref", "refs/remotes/origin/dev", git("rev-parse", "dev"));
    git("switch", "--quiet", "-c", "task/T-0119-2", "origin/dev");
    const refused = mergePreviousAttempt({ from: "task/T-0119", fileName: "T-0119-x.md", base: "origin/dev", tryGit });
    expect(refused.ok).toBe(false);
    expect(refused.conflicts).toEqual(["code.ts"]);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("show", "HEAD:code.ts")).toBe("dev");
  });
});

describe("diff-check: ветка задачи не меняет attempt", () => {
  const withAttempt = (attempt: string | null): string => `---\nid: T-0119\nstatus: ready\n${attempt === null ? "" : `attempt: ${attempt}\n`}---\nтекст`;

  function problems(base: Record<string, string>, head: Record<string, string>, changed: string[]): string[] {
    return attemptChangeProblems({ changed, readBase: (path: string) => base[path] ?? null, readHead: (path: string) => head[path] ?? null });
  }

  it("попытка та же — ошибок нет, остальные файлы не читаются", () => {
    expect(problems({ "tasks/T-0119-x.md": withAttempt("2") }, { "tasks/T-0119-x.md": withAttempt("2") }, ["tasks/T-0119-x.md", "scripts/a.ts"])).toEqual([]);
  });

  it("ветка подняла attempt своей задачи — ошибка с текстом Р195", () => {
    const found = problems({ "tasks/T-0119-x.md": withAttempt(null) }, { "tasks/T-0119-x.md": withAttempt("2") }, ["tasks/T-0119-x.md"]);
    expect(found).toEqual(["ветка задачи меняет попытку T-0119: снимает захват только тимлид (pnpm task restart)"]);
  });

  it("ветка убрала или изменила attempt — ошибка", () => {
    expect(problems({ "tasks/T-0119-x.md": withAttempt("2") }, { "tasks/T-0119-x.md": withAttempt(null) }, ["tasks/T-0119-x.md"])).toHaveLength(1);
    expect(problems({ "tasks/T-0119-x.md": withAttempt("2") }, { "tasks/T-0119-x.md": withAttempt("3") }, ["tasks/T-0119-x.md"])).toHaveLength(1);
  });

  it("чужая задача: attempt любой задачи tasks/T-*.md ловится", () => {
    const found = problems({ "tasks/T-0200-y.md": "---\nid: T-0200\n---\n" }, { "tasks/T-0200-y.md": "---\nid: T-0200\nattempt: 2\n---\n" }, ["tasks/T-0200-y.md"]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("T-0200");
  });

  it("перенос в архив с той же попыткой — не изменение", () => {
    const base = { "tasks/T-0119-x.md": withAttempt("2") };
    const head = { "tasks/archive/T-0119-x.md": withAttempt("2") };
    expect(problems(base, head, ["tasks/T-0119-x.md", "tasks/archive/T-0119-x.md"])).toEqual([]);
  });

  it("новый файл задачи без attempt — не изменение; с attempt — ошибка", () => {
    expect(problems({}, { "tasks/T-0300-z.md": withAttempt(null) }, ["tasks/T-0300-z.md"])).toEqual([]);
    expect(problems({}, { "tasks/T-0300-z.md": withAttempt("2") }, ["tasks/T-0300-z.md"])).toHaveLength(1);
  });

  it("файлы, не похожие на файлы задач, не читаются", () => {
    expect(problems({}, {}, ["tasks/README.md", "tasks/epics.md", "docs/a.md"])).toEqual([]);
  });
});
