import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { classify, nextTasks } from "../tasks/board.mjs";

// Доска задач: каждая задача — ровно в одной колонке.

const EPIC_ORDER = ["E0", "E1", "E2"];

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

function ids(entries: { task: { id: string } }[]): string[] {
  return entries.map((entry) => entry.task.id);
}

const FIXTURE = [
  task("T-0001", { status: "done" }),
  task("T-0002", { status: "cancelled" }),
  task("T-0003", { status: "draft" }),
  task("T-0004"), // ветка и открытый PR → на ревью
  task("T-0005"), // ветка без PR → в работе
  task("T-0006", { depends_on: ["T-0005"] }), // ждёт T-0005
  task("T-0007"), // свободна
];
const TAKEN = ["T-0004", "T-0005"];
const PRS = [{ number: 21, headRefName: "task/T-0004", isDraft: false }];

describe("доска задач", () => {
  const board = classify(FIXTURE, TAKEN, PRS, [], EPIC_ORDER);

  it("каждая задача — в своей колонке", () => {
    expect(ids(board.done)).toEqual(["T-0001"]);
    expect(ids(board.cancelled)).toEqual(["T-0002"]);
    expect(ids(board.draft)).toEqual(["T-0003"]);
    expect(ids(board.review)).toEqual(["T-0004"]);
    expect(ids(board.inProgress)).toEqual(["T-0005"]);
    expect(ids(board.blocked)).toEqual(["T-0006"]);
    expect(ids(board.free)).toEqual(["T-0007"]);
  });

  it("ни одна задача не пропала и не задвоилась", () => {
    const all = Object.values(board).flat() as { task: { id: string } }[];
    expect(ids(all).sort()).toEqual(FIXTURE.map((item) => item.id).sort());
  });

  it("заблокированной — причина: какая зависимость не сделана", () => {
    expect(board.blocked[0].reason).toContain("T-0005");
  });

  it("у задачи на ревью виден номер PR", () => {
    expect(board.review[0].pr).toBe(21);
  });

  it("PR в черновике — это ещё «в работе»", () => {
    const draftPr = [{ number: 21, headRefName: "task/T-0004", isDraft: true }];
    const result = classify(FIXTURE, TAKEN, draftPr, [], EPIC_ORDER);
    expect(ids(result.review)).toEqual([]);
    expect(ids(result.inProgress).sort()).toEqual(["T-0004", "T-0005"]);
  });

  it("без списка PR (нет gh) «на ревью» сливается с «в работе»", () => {
    const result = classify(FIXTURE, TAKEN, null, [], EPIC_ORDER);
    expect(ids(result.review)).toEqual([]);
    expect(ids(result.inProgress).sort()).toEqual(["T-0004", "T-0005"]);
  });

  it("зависимость, которой нет в реестре, блокирует и называется", () => {
    const result = classify([task("T-0008", { depends_on: ["T-0099"] })], [], [], [], EPIC_ORDER);
    expect(result.blocked[0].reason).toContain("T-0099");
  });

  it("зависимость в статусе done не блокирует", () => {
    const result = classify([task("T-0001", { status: "done" }), task("T-0002", { depends_on: ["T-0001"] })], [], [], [], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0002"]);
  });
});

describe("пересечение зон на доске", () => {
  it("зоны пересекаются с задачей в работе — заблокирована, причина называет её", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const result = classify(tasks, ["T-0004"], [], ["a/b.ts"], EPIC_ORDER);
    expect(ids(result.blocked)).toEqual(["T-0005"]);
    expect(result.blocked[0].reason).toContain("T-0004");
  });

  it("пересечение с задачей на ревью тоже блокирует", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const prs = [{ number: 7, headRefName: "task/T-0004", isDraft: false }];
    const result = classify(tasks, ["T-0004"], prs, ["a/b.ts"], EPIC_ORDER);
    expect(ids(result.blocked)).toEqual(["T-0005"]);
  });

  it("пересечение с другой свободной задачей не блокирует: занята только та, у которой есть ветка", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const result = classify(tasks, [], [], ["a/b.ts"], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0004", "T-0005"]);
  });

  it("задача с готовой зависимостью не блокируется зонами done-задачи", () => {
    const tasks = [task("T-0001", { status: "done", zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const result = classify(tasks, [], [], ["a/b.ts"], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0005"]);
  });
});

describe("порядок в колонке «Свободно»", () => {
  const tasks = [
    task("T-0010", { priority: "P2", epic: "E0" }),
    task("T-0011", { priority: "P0", epic: "E2" }),
    task("T-0012", { priority: "P0", epic: "E1" }),
    task("T-0013", { priority: "P0", epic: "E1" }),
    task("T-0014", { priority: "P1", epic: "E0" }),
  ];

  it("по приоритету, затем по порядку эпика, затем по id", () => {
    const result = classify(tasks, [], [], [], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0012", "T-0013", "T-0011", "T-0014", "T-0010"]);
  });

  it("эпик, которого нет в epics.md, идёт последним среди своего приоритета", () => {
    const result = classify([task("T-0020", { epic: "E9" }), task("T-0021", { epic: "E2" })], [], [], [], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0021", "T-0020"]);
  });
});

describe("следующая задача", () => {
  const free = classify(
    [
      task("T-0030", { runner: "human" }),
      task("T-0031", { runner: "local" }),
      task("T-0032", { runner: "any" }),
      task("T-0033", { runner: "any", executor: "other-model" }),
    ],
    [],
    [],
    [],
    EPIC_ORDER,
  ).free;

  it("по умолчанию — только runner: any; human не показывается никогда", () => {
    expect(ids(nextTasks(free, {}))).toEqual(["T-0032", "T-0033"]);
  });

  it("local включает any", () => {
    expect(ids(nextTasks(free, { runner: "local" }))).toEqual(["T-0031", "T-0032", "T-0033"]);
  });

  it("--executor оставляет задачи только этого исполнителя", () => {
    expect(ids(nextTasks(free, { runner: "local", executor: "sonnet-5.5" }))).toEqual(["T-0031", "T-0032"]);
  });
});
