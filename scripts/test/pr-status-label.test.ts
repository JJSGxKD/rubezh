import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { planStatusLabels } from "../release/pr-status-label.mjs";

// Страховка метки статуса задачи на PR (Р172): что поставить и снять по событию.

const HEAD = "task/T-0042";

function plan(patch: Record<string, unknown>): { add: string[]; remove: string[] } {
  return planStatusLabels({ headRef: HEAD, eventName: "pull_request", action: "opened", labels: [], ...patch });
}

const NOTHING = { add: [], remove: [] };

describe("opened и reopened", () => {
  it("PR без метки статуса получает «на ревью»", () => {
    expect(plan({ action: "opened", labels: ["release: patch"] })).toEqual({ add: ["на ревью"], remove: [] });
    expect(plan({ action: "reopened" })).toEqual({ add: ["на ревью"], remove: [] });
  });

  it("поставленную метку статуса не трогает", () => {
    for (const label of ["в работе", "на ревью", "доработка", "ждёт владельца"]) {
      expect(plan({ action: "opened", labels: [label] })).toEqual(NOTHING);
    }
  });
});

describe("ready_for_review", () => {
  it("«в работе» заменяется на «на ревью»", () => {
    expect(plan({ action: "ready_for_review", labels: ["в работе"] })).toEqual({ add: ["на ревью"], remove: ["в работе"] });
  });

  it("метки нет — ставится «на ревью»", () => {
    expect(plan({ action: "ready_for_review" })).toEqual({ add: ["на ревью"], remove: [] });
  });

  it("«на ревью» уже стоит — не дублируется", () => {
    expect(plan({ action: "ready_for_review", labels: ["на ревью"] })).toEqual(NOTHING);
  });

  it("«доработка» и «ждёт владельца» не затираются, «в работе» рядом с ними снимается", () => {
    expect(plan({ action: "ready_for_review", labels: ["доработка"] })).toEqual(NOTHING);
    expect(plan({ action: "ready_for_review", labels: ["ждёт владельца", "в работе"] })).toEqual({ add: [], remove: ["в работе"] });
  });
});

describe("labeled: меток статуса стало несколько", () => {
  it("остаётся только что поставленная", () => {
    expect(plan({ action: "labeled", labelName: "доработка", labels: ["на ревью", "доработка"] })).toEqual({ add: [], remove: ["на ревью"] });
    expect(plan({ action: "labeled", labelName: "на ревью", labels: ["в работе", "на ревью", "release: patch"] })).toEqual({
      add: [],
      remove: ["в работе"],
    });
  });

  it("снимает все остальные, если их несколько", () => {
    expect(plan({ action: "labeled", labelName: "в работе", labels: ["в работе", "на ревью", "доработка"] })).toEqual({
      add: [],
      remove: ["на ревью", "доработка"],
    });
  });

  it("единственная метка статуса — менять нечего", () => {
    expect(plan({ action: "labeled", labelName: "на ревью", labels: ["на ревью"] })).toEqual(NOTHING);
  });

  it("поставлена не метка статуса — менять нечего, даже если статусов два", () => {
    expect(plan({ action: "labeled", labelName: "release: patch", labels: ["на ревью", "доработка", "release: patch"] })).toEqual(NOTHING);
  });

  it("поставленную метку уже сняли — не гадаем", () => {
    expect(plan({ action: "labeled", labelName: "доработка", labels: ["на ревью"] })).toEqual(NOTHING);
  });
});

describe("pull_request_review", () => {
  const review = (patch: Record<string, unknown>) => plan({ eventName: "pull_request_review", action: "submitted", reviewState: "changes_requested", ...patch });

  it("Request changes: «доработка» ставится, «на ревью» и «в работе» снимаются", () => {
    expect(review({ labels: ["на ревью"] })).toEqual({ add: ["доработка"], remove: ["на ревью"] });
    expect(review({ labels: ["на ревью", "в работе", "release: patch"] })).toEqual({ add: ["доработка"], remove: ["на ревью", "в работе"] });
  });

  it("«ждёт владельца» уступает: статус остаётся один", () => {
    expect(review({ labels: ["ждёт владельца"] })).toEqual({ add: ["доработка"], remove: ["ждёт владельца"] });
  });

  it("«доработка» уже стоит — не дублируется", () => {
    expect(review({ labels: ["доработка"] })).toEqual(NOTHING);
    expect(review({ labels: ["доработка", "на ревью"] })).toEqual({ add: [], remove: ["на ревью"] });
  });

  it("регистр состояния ревью не важен (API отдаёт CHANGES_REQUESTED)", () => {
    expect(review({ reviewState: "CHANGES_REQUESTED", labels: ["на ревью"] })).toEqual({ add: ["доработка"], remove: ["на ревью"] });
  });

  it("Approve и комментарий метки не меняют", () => {
    expect(review({ reviewState: "approved", labels: ["на ревью"] })).toEqual(NOTHING);
    expect(review({ reviewState: "commented", labels: ["на ревью"] })).toEqual(NOTHING);
    expect(review({ reviewState: undefined, labels: ["на ревью"] })).toEqual(NOTHING);
  });

  it("не submitted — ничего", () => {
    expect(review({ action: "dismissed", labels: ["на ревью"] })).toEqual(NOTHING);
  });
});

describe("остальные события и ветки", () => {
  it("ветка не task/T-NNNN — ничего", () => {
    for (const headRef of ["feat/x", "dev", "task/T-12", "task/T-0042-x", undefined]) {
      expect(plan({ headRef })).toEqual(NOTHING);
      expect(plan({ headRef, eventName: "pull_request_review", action: "submitted", reviewState: "changes_requested", labels: ["на ревью"] })).toEqual(NOTHING);
    }
  });

  it("synchronize, edited, unlabeled и чужие события — ничего", () => {
    for (const action of ["synchronize", "edited", "unlabeled", "converted_to_draft"]) {
      expect(plan({ action, labels: [] })).toEqual(NOTHING);
    }
    expect(plan({ eventName: "push" })).toEqual(NOTHING);
  });
});

describe("workflow", () => {
  const ROOT = fileURLToPath(new URL("../..", import.meta.url));
  const read = (name: string) => readFileSync(join(ROOT, ".github/workflows", name), "utf8").replace(/\r\n/g, "\n");

  it("в PR checks страховка идёт раньше проверки, а ready_for_review запускает проверки", () => {
    const workflow = read("pr-checks.yml");
    expect(workflow).toMatch(/types: \[[^\]]*\bready_for_review\b[^\]]*\]/);
    expect(workflow).toMatch(/types: \[[^\]]*\blabeled\b[^\]]*\bunlabeled\b[^\]]*\]/);
    const bot = workflow.indexOf("node scripts/release/pr-status-label.mjs");
    const check = workflow.indexOf("node scripts/release/pr-check.mjs");
    expect(bot).toBeGreaterThan(-1);
    expect(bot).toBeLessThan(check);
  });

  it("отдельный workflow ревью: право записи в PR только у джоба и только для Request changes", () => {
    const workflow = read("pr-status-label.yml");
    expect(workflow).toMatch(/^on:\n {2}pull_request_review:\n {4}types: \[submitted\]$/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).toContain("github.event.review.state == 'changes_requested'");
    expect(workflow).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}pull-requests: write$/m);
    // Скрипт берётся с базовой ветки, а не из кода PR.
    expect(workflow).toContain("ref: ${{ github.event.pull_request.base.ref }}");
  });
});
