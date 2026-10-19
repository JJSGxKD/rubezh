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

// Ячейка «Задачи» эпика — значки задач (T-0018); собрана руками, а не через код: независимая сверка формата.
function epicsOf(files: { name: string; text: string }[]): string {
  const cell = (epic: string): string => {
    const badges = files
      .filter((file) => file.name.startsWith("T-") && new RegExp(`^epic: ${epic}$`, "m").test(file.text))
      .map((file) => ({ id: file.name.slice(0, 6), name: file.name }))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, name }) => `[![${id}](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/${id}.json&label=${id})](${name})`);
    return badges.length === 0 ? "—" : badges.join(" ");
  };
  return ["| Эпик | Цель | Задачи |", "|---|---|---|", `| **E0. Процесс** | x | ${cell("E0")} |`, `| **E1. Деньги** | y | ${cell("E1")} |`].join("\n");
}

function check(files: { name: string; text: string }[]): string[] {
  return checkRegistry(files, epicsOf(files));
}

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
  // Раздел «PR» обязателен у задач ready и in-progress (T-0146): заголовок корректен, метка равна release.
  const pr = ["## PR", "", "- **Заголовок:** `fix(app-shell): Чинить X`", `- **Метка:** \`release: ${fields.release}\``, ""];
  return { name, text: ["---", ...lines, "---", "", `# ${id}. Задача`, "", badgesOf(id, fields.depends_on), "", ...pr].join("\n") };
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
    expect(check(files)).toEqual([]);
  });

  it("повтор id", () => {
    const errors = check([fileOf("T-0003", {}, "T-0003-a.md"), fileOf("T-0003", {}, "T-0003-b.md")]);
    expect(errors.some((error: string) => error.includes("повтор") && error.includes("T-0003"))).toBe(true);
  });

  it("неизвестный эпик", () => {
    const errors = check([fileOf("T-0003", { epic: "E99" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0003-x.md");
    expect(errors[0]).toContain("E99");
  });

  it("несуществующая зависимость", () => {
    const errors = check([fileOf("T-0003", { depends_on: "[T-0099]" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0099");
  });

  it("цикл из двух задач — ошибка называет цикл", () => {
    const errors = check([fileOf("T-0003", { depends_on: "[T-0004]" }), fileOf("T-0004", { depends_on: "[T-0003]" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0003 → T-0004 → T-0003");
  });

  it("цикл из трёх задач — ошибка называет цикл", () => {
    const errors = check([
        fileOf("T-0005", { depends_on: "[T-0006]" }),
        fileOf("T-0006", { depends_on: "[T-0007]" }),
        fileOf("T-0007", { depends_on: "[T-0005]" }),
      ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0005 → T-0006 → T-0007 → T-0005");
  });

  it("файл T-* с плохой шапкой или именем — ошибка, а не молчание", () => {
    const errors = check([{ name: "T-0003-x.md", text: "без шапки" }, fileOf("T-0004", {}, "T-bad.md")]);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("строка значков в реестре", () => {
  it("строка с зависимостью, которой в шапке нет, — ошибка с именем файла", () => {
    const file = fileOf("T-0002", { depends_on: "[T-0001]" });
    const wrong = { ...file, text: file.text.replace(/\[!\[T-0001\].*$/m, "") };
    const errors = check([fileOf("T-0001"), wrong]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0002-x.md");
    expect(errors[0]).toContain("значков");
  });

  it("ссылка зависимости ведёт на её настоящий файл: с чужим slug строка не проходит", () => {
    const file = fileOf("T-0002", { depends_on: "[T-0001]" });
    const wrong = { ...file, text: file.text.replace("(T-0001-x.md)", "(T-0001-other.md)") };
    const errors = check([fileOf("T-0001"), wrong]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0002-x.md");
  });
});

describe("ячейка «Задачи» эпика в реестре", () => {
  it("номера через запятую вместо значков — ошибка реестра с подсказкой pnpm task fix", () => {
    const files = [fileOf("T-0001"), fileOf("T-0002")];
    const epics = epicsOf(files).replace(/\| \[!\[T-0001\].*? \|$/m, "| T-0001, T-0002 |");
    const errors = checkRegistry(files, epics);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("E0");
    expect(errors[0]).toContain("pnpm task fix");
  });

  it("строка значков с подсказкой pnpm task fix", () => {
    const file = fileOf("T-0002", { depends_on: "[T-0001]" });
    const wrong = { ...file, text: file.text.replace(/\[!\[T-0001\].*$/m, "") };
    const errors = check([fileOf("T-0001"), wrong]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("pnpm task fix");
  });
});

// Пачки очереди (docs/38-release-plan.md): зависимость уходит в main не позже зависящей от неё задачи.
describe("пачки в зависимостях", () => {
  it("зависимость в той же или более ранней пачке — без ошибок", () => {
    const files = [
      fileOf("T-0001", { batch: "1" }),
      fileOf("T-0002", { batch: "1", depends_on: "[T-0001]" }),
      fileOf("T-0003", { batch: "2", depends_on: "[T-0001, T-0002]" }),
    ];
    expect(check(files)).toEqual([]);
  });

  it("зависимость в более поздней пачке — ошибка называет обе задачи и обе пачки", () => {
    const errors = check([fileOf("T-0001", { batch: "3" }), fileOf("T-0002", { batch: "2", depends_on: "[T-0001]" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0002-x.md");
    expect(errors[0]).toContain("T-0002 (пачка 2)");
    expect(errors[0]).toContain("T-0001 (пачка 3)");
  });

  it("пачки сравниваются как числа: зависимость в пачке 10 позже пачки 9", () => {
    const errors = check([fileOf("T-0001", { batch: "10" }), fileOf("T-0002", { batch: "9", depends_on: "[T-0001]" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0002 (пачка 9)");
    expect(errors[0]).toContain("T-0001 (пачка 10)");
  });

  it("задача с пачкой не зависит от задачи без пачки — ошибка называет обе задачи", () => {
    const errors = check([fileOf("T-0001"), fileOf("T-0002", { batch: "1", depends_on: "[T-0001]" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0002-x.md");
    expect(errors[0]).toContain("T-0002 (пачка 1)");
    expect(errors[0]).toContain("T-0001 (без пачки)");
  });

  it("черновик без пачки — такая же зависимость без пачки, это не исключение", () => {
    const errors = check([fileOf("T-0001", { status: "draft" }), fileOf("T-0002", { batch: "1", depends_on: "[T-0001]" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0001 (без пачки)");
  });

  it("сделанная или отменённая зависимость без пачки не мешает", () => {
    for (const status of ["done", "cancelled"]) {
      const files = [fileOf("T-0001", { status }), fileOf("T-0002", { batch: "1", depends_on: "[T-0001]" })];
      expect(check(files), status).toEqual([]);
    }
  });

  it("сделанная зависимость в чужой пачке тоже не мешает: она уже в dev", () => {
    const files = [fileOf("T-0001", { status: "done", batch: "4" }), fileOf("T-0002", { batch: "1", depends_on: "[T-0001]" })];
    expect(check(files)).toEqual([]);
  });

  it("задача без пачки может зависеть от задачи с пачкой", () => {
    expect(check([fileOf("T-0001", { batch: "2" }), fileOf("T-0002", { depends_on: "[T-0001]" })])).toEqual([]);
  });

  it("несколько нарушений — по ошибке на каждую пару", () => {
    const files = [
      fileOf("T-0001", { batch: "5" }),
      fileOf("T-0002"),
      fileOf("T-0003", { batch: "1", depends_on: "[T-0001, T-0002]" }),
    ];
    const errors = check(files);
    expect(errors).toHaveLength(2);
    expect(errors.some((error: string) => error.includes("T-0001 (пачка 5)"))).toBe(true);
    expect(errors.some((error: string) => error.includes("T-0002 (без пачки)"))).toBe(true);
  });

  it("несуществующая зависимость не даёт второй, ложной ошибки про пачки", () => {
    const errors = check([fileOf("T-0002", { batch: "1", depends_on: "[T-0099]" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0099");
    expect(errors[0]).not.toContain("пачк");
  });

  it("поле version в файле задачи — ошибка реестра", () => {
    // Задача с битой шапкой в реестр не попадает, поэтому проверка ячейки эпика может добавить своё: смотрим на нужную ошибку.
    const errors = check([fileOf("T-0001", { version: "v0.8" })]).filter((error: string) => error.includes("version"));
    expect(errors).toEqual(["T-0001-x.md: поле version заменено полем batch — пачкой очереди, tasks/README.md"]);
  });
});
