import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { ABANDONED_CLAIM_HOURS, checkAheadPr, checkClaim, isAbandonedClaim, takeOverClaim, unclosedDependenciesOnBase, withoutDependencyFiles } from "../tasks/claim.mjs";
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
