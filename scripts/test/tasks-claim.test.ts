import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { checkClaim } from "../tasks/claim.mjs";

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

  it("зоны пересекаются с задачей, у которой открытый PR, — отказ", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const prs = [{ number: 9, headRefName: "task/T-0004", isDraft: false }];
    const problems = checkClaim("T-0005", { tasks, taken: ["T-0005"], prs, repoFiles: ["a/b.ts"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T-0004");
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
