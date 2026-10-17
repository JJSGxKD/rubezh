import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита сопровождения на чистом JS, типов у неё нет и не нужно
import { CHECK_STEP, DOWN_STEP } from "../ops/uptime-check.mjs";

// Workflow внешней проверки (tasks/T-0088): без записи развёртывания на каждый
// прогон, а «прод лежит» — отдельный упавший шаг, по которому следующий прогон
// отличает падение прода от падения самого прогона. YAML-парсера в
// зависимостях нет — файл читается текстом.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// На Windows рабочая копия может быть с CRLF.
const workflow = readFileSync(join(ROOT, ".github/workflows/uptime.yml"), "utf8").replace(/\r\n/g, "\n");

describe("uptime.yml", () => {
  it("секрет бота — из окружения telegram, но без записи развёртывания", () => {
    expect(workflow).toMatch(/^ {4}environment:\n {6}name: telegram\n {6}deployment: false$/m);
  });

  it("шаг проверки имеет id check", () => {
    expect(workflow).toContain(`- name: ${CHECK_STEP}\n        id: check\n`);
  });

  it("шаг «Прод недоступен» идёт после проверки, падает только при state == down", () => {
    const check = workflow.indexOf(`- name: ${CHECK_STEP}`);
    const down = workflow.indexOf(`- name: ${DOWN_STEP}`);
    expect(check).toBeGreaterThan(-1);
    expect(down).toBeGreaterThan(check);
    const block = workflow.slice(down);
    expect(block).toContain("if: steps.check.outputs.state == 'down'");
    expect(block).toContain("run: exit 1");
  });

  it("continue-on-error нет: иначе упавший шаг не ронял бы прогон", () => {
    expect(workflow).not.toContain("continue-on-error");
  });
});
