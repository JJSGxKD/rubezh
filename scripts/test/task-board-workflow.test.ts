import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// concurrency у workflow пересчёта значков: пропущенный по `if` джоб не должен
// отменять настоящий пересчёт после мерджа (tasks/T-0016). YAML-парсера в
// зависимостях нет — файл читается текстом.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// На Windows рабочая копия может быть с CRLF.
const workflow = readFileSync(join(ROOT, ".github/workflows/task-board.yml"), "utf8").replace(/\r\n/g, "\n");

describe("task-board.yml: concurrency", () => {
  it("у workflow нет concurrency верхнего уровня", () => {
    expect(workflow).not.toMatch(/^concurrency:/m);
  });

  it("concurrency объявлен у джоба board", () => {
    const fromJob = workflow.slice(workflow.indexOf("  board:"));
    expect(fromJob).toMatch(/^ {4}concurrency:\n {6}group: task-board\n {6}cancel-in-progress: true$/m);
  });

  it("группа объявлена один раз", () => {
    expect(workflow.split("group: task-board").length - 1).toBe(1);
  });
});
