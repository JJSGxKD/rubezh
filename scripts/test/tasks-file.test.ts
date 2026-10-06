import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { badgeLine, parseFrontmatter, validateTask } from "../tasks/task-file.mjs";

// Шапка задачи — строгое подмножество YAML (tasks/T-0002-task-cli.md, «Решения»):
// разбирает свой парсер, любая другая конструкция — ошибка с номером строки.

const HEADER = [
  "---",
  "id: T-0003",
  "title: Заголовок задачи",
  "epic: E1",
  "priority: P0",
  "status: ready",
  "owner:",
  "size: S",
  "depends_on: [T-0001, T-0002]",
  "zones:",
  "  - a/b.ts",
  "  - c/**",
  "shared: []",
  "runner: any",
  "executor: sonnet-5.5",
  "effort: medium",
  "release: patch",
  "design: null",
  "---",
  "",
  "# T-0003. Заголовок",
];

function headerWith(change: (lines: string[]) => void): string {
  const lines = [...HEADER];
  change(lines);
  return lines.join("\n");
}

function valid(): Record<string, unknown> {
  return {
    id: "T-0003",
    title: "Заголовок задачи",
    epic: "E1",
    priority: "P0",
    status: "ready",
    owner: "",
    size: "S",
    depends_on: ["T-0001"],
    zones: ["a/b.ts", "c/**"],
    shared: [],
    runner: "any",
    executor: "sonnet-5.5",
    effort: "medium",
    release: "patch",
    design: null,
  };
}

describe("разбор шапки задачи", () => {
  it("разбирает строчный список, список строками, пустое значение и null", () => {
    const parsed = parseFrontmatter(HEADER.join("\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toMatchObject({
      id: "T-0003",
      title: "Заголовок задачи",
      owner: "",
      depends_on: ["T-0001", "T-0002"],
      zones: ["a/b.ts", "c/**"],
      shared: [],
      design: null,
    });
    expect(parsed.body).toContain("# T-0003. Заголовок");
  });

  it("отступ табуляцией — ошибка с номером строки", () => {
    const parsed = parseFrontmatter(headerWith((lines) => (lines[10] = "\t- a/b.ts")));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("строка 11");
  });

  it("кавычки — ошибка с номером строки", () => {
    const parsed = parseFrontmatter(headerWith((lines) => (lines[2] = 'title: "Заголовок"')));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("строка 3");
  });

  it("строка без двоеточия — ошибка с номером строки", () => {
    const parsed = parseFrontmatter(headerWith((lines) => lines.splice(4, 0, "просто текст")));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("строка 5");
  });

  it("вложенный объект — ошибка с номером строки", () => {
    const parsed = parseFrontmatter(headerWith((lines) => lines.splice(7, 0, "  inner: 1")));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("строка 8");
  });

  it("нет открывающей или закрывающей черты — ошибка", () => {
    expect(parseFrontmatter("id: T-0003\n").errors).toHaveLength(1);
    expect(parseFrontmatter(HEADER.slice(0, 18).join("\n")).errors).toHaveLength(1);
  });
});

describe("проверка одной задачи", () => {
  it("корректная задача — без ошибок", () => {
    expect(validateTask("T-0003-x.md", valid())).toEqual([]);
  });

  it("нет поля — ошибка называет файл и поле", () => {
    const data = valid();
    delete data.priority;
    const errors = validateTask("T-0003-x.md", data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0003-x.md: поле priority");
  });

  it("лишнее поле — ошибка называет файл и поле", () => {
    const errors = validateTask("T-0003-x.md", { ...valid(), foo: "1" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0003-x.md: поле foo");
  });

  it("неверное перечисление — текст перечисляет допустимое", () => {
    expect(validateTask("T-0003-x.md", { ...valid(), priority: "P5" })).toEqual([
      "T-0003-x.md: поле priority — ожидается P0, P1, P2 или P3, а не P5",
    ]);
    for (const [field, value] of [
      ["status", "started"],
      ["size", "L"],
      ["runner", "robot"],
      ["release", "major"],
      ["executor", "gpt-9"],
      ["effort", "max"],
    ] as const) {
      const errors = validateTask("T-0003-x.md", { ...valid(), [field]: value });
      expect(errors, field).toHaveLength(1);
      expect(errors[0], field).toContain(`T-0003-x.md: поле ${field}`);
    }
  });

  it("id не совпадает с началом имени файла", () => {
    const errors = validateTask("T-0004-x.md", valid());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0004-x.md: поле id");
  });

  it("имя файла не по маске T-NNNN-slug.md", () => {
    const errors = validateTask("task-3.md", valid());
    expect(errors.some((error: string) => error.includes("имя файла"))).toBe(true);
  });

  it("путь в зонах: «..», обратная черта и ведущая «/» запрещены", () => {
    for (const bad of ["../x.ts", "a\\b.ts", "/etc/x"]) {
      const errors = validateTask("T-0003-x.md", { ...valid(), zones: [bad] });
      expect(errors, bad).toHaveLength(1);
      expect(errors[0], bad).toContain("T-0003-x.md: поле zones");
    }
    const errors = validateTask("T-0003-x.md", { ...valid(), shared: ["a/../b"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("поле shared");
  });

  it("зоны у ready и in-progress не пустые", () => {
    for (const status of ["ready", "in-progress"]) {
      const errors = validateTask("T-0003-x.md", { ...valid(), status, owner: "a / m", zones: [] });
      expect(errors, status).toHaveLength(1);
      expect(errors[0], status).toContain("поле zones");
    }
    expect(validateTask("T-0003-x.md", { ...valid(), status: "draft", zones: [] })).toEqual([]);
  });

  it("in-progress без owner", () => {
    const errors = validateTask("T-0003-x.md", { ...valid(), status: "in-progress", owner: "" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T-0003-x.md: поле owner");
  });
});

// Строка значков под заголовком (T-0011, «Решения»): статус самой задачи и по
// значку на каждую зависимость. Ссылка зависимости ведёт на её файл, поэтому
// имена файлов приходят снаружи — из реестра.

const STATUS_URL = "https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status";
const FILE_NAMES = { "T-0001": "T-0001-first.md", "T-0002": "T-0002-second.md" };

describe("строка значков", () => {
  it("без зависимостей — один значок статуса, ведущий на раздел README", () => {
    expect(badgeLine({ id: "T-0003", depends_on: [] }, FILE_NAMES)).toBe(
      `[![статус](${STATUS_URL}/T-0003.json)](README.md#значки-статуса)`,
    );
  });

  it("с двумя зависимостями — три значка, зависимости в порядке depends_on", () => {
    expect(badgeLine({ id: "T-0003", depends_on: ["T-0002", "T-0001"] }, FILE_NAMES)).toBe(
      [
        `[![статус](${STATUS_URL}/T-0003.json)](README.md#значки-статуса)`,
        `[![T-0002](${STATUS_URL}/T-0002.json&label=T-0002)](T-0002-second.md)`,
        `[![T-0001](${STATUS_URL}/T-0001.json&label=T-0001)](T-0001-first.md)`,
      ].join(" "),
    );
  });

  describe("проверка строки в validateTask", () => {
    const fileName = "T-0003-x.md";
    const data = { ...valid(), depends_on: ["T-0001"] };
    const right = badgeLine(data, FILE_NAMES);
    const bodyWith = (...lines: string[]): string => ["", "# T-0003. Заголовок", "", ...lines, "", "## Зачем"].join("\n");

    it("верная строка — без ошибок", () => {
      expect(validateTask(fileName, data, { body: bodyWith(right), fileNames: FILE_NAMES })).toEqual([]);
    });

    it("строки нет — ошибка, в ней — какая строка ожидается", () => {
      const errors = validateTask(fileName, data, { body: bodyWith(), fileNames: FILE_NAMES });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(fileName);
      expect(errors[0]).toContain(right);
    });

    it("строка с другим набором зависимостей — ошибка", () => {
      const other = badgeLine({ ...data, depends_on: ["T-0001", "T-0002"] }, FILE_NAMES);
      const errors = validateTask(fileName, data, { body: bodyWith(other), fileNames: FILE_NAMES });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("значков");
    });

    it("строка не сразу под заголовком — ошибка", () => {
      const errors = validateTask(fileName, data, { body: bodyWith("Текст.", "", right), fileNames: FILE_NAMES });
      expect(errors).toHaveLength(1);
    });

    it("нет заголовка «# T-NNNN. …» — ошибка", () => {
      const errors = validateTask(fileName, data, { body: ["", "# Другое", "", right].join("\n"), fileNames: FILE_NAMES });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("заголовок");
    });

    it("зависимости нет в реестре — строка не проверяется: об этом скажет проверка реестра", () => {
      expect(validateTask(fileName, { ...data, depends_on: ["T-0099"] }, { body: bodyWith("что-то"), fileNames: FILE_NAMES })).toEqual([]);
    });

    it("без тела файла строка не проверяется — как и раньше", () => {
      expect(validateTask(fileName, data)).toEqual([]);
    });
  });
});
