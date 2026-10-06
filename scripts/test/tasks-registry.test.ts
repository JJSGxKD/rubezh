import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { checkRegistry, parseEpics } from "../tasks/registry.mjs";

// Реестр задач проверяется целиком: уникальные id, известные эпики,
// существующие зависимости, нет циклов.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TASKS_DIR = join(ROOT, "tasks");

const EPICS = ["| Эпик | Цель |", "|---|---|", "| **E0. Процесс** | x |", "| **E1. Деньги** | y |"].join("\n");

const STATUS_URL = "https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status";

// Строка значков под заголовком (T-0011): написана руками, а не через badgeLine, — это независимая сверка формата.
function badgesOf(id: string, dependsOn: string): string {
  const deps = dependsOn.replace(/[[\]]/g, "").split(",").map((dep) => dep.trim()).filter((dep) => dep !== "");
  return [
    `[![статус](${STATUS_URL}/${id}.json)](README.md#значки-статуса)`,
    ...deps.map((dep) => `[![${dep}](${STATUS_URL}/${dep}.json&label=${dep})](${dep}-x.md)`),
  ].join(" ");
}

function fileOf(id: string, patch: Record<string, string> = {}, name = `${id}-x.md`): { name: string; text: string } {
  const fields: Record<string, string> = {
    id,
    title: "Задача",
    epic: "E0",
    priority: "P1",
    status: "ready",
    owner: "",
    size: "S",
    depends_on: "[]",
    zones: "[a.ts]",
    shared: "[]",
    runner: "any",
    executor: "sonnet-5.5",
    effort: "medium",
    release: "patch",
    design: "null",
    ...patch,
  };
  const lines = Object.entries(fields).map(([key, value]) => `${key}:${value === "" ? "" : ` ${value}`}`);
  return { name, text: ["---", ...lines, "---", "", `# ${id}. Задача`, "", badgesOf(id, fields.depends_on), ""].join("\n") };
}

describe("реестр задач", () => {
  it("настоящий реестр tasks/ без ошибок", () => {
    const files = readdirSync(TASKS_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => ({ name, text: readFileSync(join(TASKS_DIR, name), "utf8") }));
    const epics = readFileSync(join(TASKS_DIR, "epics.md"), "utf8");
    expect(checkRegistry(files, epics)).toEqual([]);
  });

  it("эпики берутся по «**E<число>.» в первой колонке, порядок сохраняется", () => {
    expect(parseEpics(EPICS)).toEqual(["E0", "E1"]);
  });

  it("корректный набор и посторонние файлы каталога — без ошибок", () => {
    const files = [
      fileOf("T-0001"),
      fileOf("T-0002", { depends_on: "[T-0001]", epic: "E1" }),
      { name: "README.md", text: "# не задача" },
      { name: "inbox.md", text: "мусор без шапки" },
      { name: "_template.md", text: "---\nid: T-NNNN\n---" },
    ];
    expect(checkRegistry(files, EPICS)).toEqual([]);
  });

  it("повтор id", () => {
    const errors = checkRegistry([fileOf("T-0003", {}, "T-0003-a.md"), fileOf("T-0003", {}, "T-0003-b.md")], EPICS);
    expect(errors.some((error: string) => error.includes("повтор") && error.includes("T-0003"))).toBe(true);
  });

  it("неизвестный эпик", () => {
    const errors = checkRegistry([fileOf("T-0003", { epic: "E99" })], EPICS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0003-x.md");
    expect(errors[0]).toContain("E99");
  });

  it("несуществующая зависимость", () => {
    const errors = checkRegistry([fileOf("T-0003", { depends_on: "[T-0099]" })], EPICS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0099");
  });

  it("цикл из двух задач — ошибка называет цикл", () => {
    const errors = checkRegistry(
      [fileOf("T-0003", { depends_on: "[T-0004]" }), fileOf("T-0004", { depends_on: "[T-0003]" })],
      EPICS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0003 → T-0004 → T-0003");
  });

  it("цикл из трёх задач — ошибка называет цикл", () => {
    const errors = checkRegistry(
      [
        fileOf("T-0005", { depends_on: "[T-0006]" }),
        fileOf("T-0006", { depends_on: "[T-0007]" }),
        fileOf("T-0007", { depends_on: "[T-0005]" }),
      ],
      EPICS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0005 → T-0006 → T-0007 → T-0005");
  });

  it("файл T-* с плохой шапкой или именем — ошибка, а не молчание", () => {
    const errors = checkRegistry([{ name: "T-0003-x.md", text: "без шапки" }, fileOf("T-0004", {}, "T-bad.md")], EPICS);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("строка значков в реестре", () => {
  it("строка с зависимостью, которой в шапке нет, — ошибка с именем файла", () => {
    const file = fileOf("T-0002", { depends_on: "[T-0001]" });
    const wrong = { ...file, text: file.text.replace(/\[!\[T-0001\].*$/m, "") };
    const errors = checkRegistry([fileOf("T-0001"), wrong], EPICS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0002-x.md");
    expect(errors[0]).toContain("значков");
  });

  it("ссылка зависимости ведёт на её настоящий файл: с чужим slug строка не проходит", () => {
    const file = fileOf("T-0002", { depends_on: "[T-0001]" });
    const wrong = { ...file, text: file.text.replace("(T-0001-x.md)", "(T-0001-other.md)") };
    const errors = checkRegistry([fileOf("T-0001"), wrong], EPICS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0002-x.md");
  });
});
