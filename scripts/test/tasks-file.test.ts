import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { badgeLine, checkPrSection, parseFrontmatter, parseOwner, relativeTaskLink, taskBadge, validateTask, withBadgeLine, withTaskLinks } from "../tasks/task-file.mjs";

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
      ["effort", "xhigh"],
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

// Потоки и роли (tasks/README.md, «Исполнители и effort», «Роли и кодовые имена»).
describe("исполнители, автор и поток", () => {
  it("haiku-5.5 — допущенный исполнитель", () => {
    expect(validateTask("T-0003-x.md", { ...valid(), executor: "haiku-5.5" })).toEqual([]);
  });

  it("author необязателен; если есть — кодовое имя роли", () => {
    expect(validateTask("T-0003-x.md", { ...valid(), author: "claude-lead-1" })).toEqual([]);
    expect(validateTask("T-0003-x.md", { ...valid(), author: "claude-review-2" })).toEqual([]);
    for (const bad of ["", "Claude-lead-1", "lead", "claude lead 1"]) {
      const errors = validateTask("T-0003-x.md", { ...valid(), author: bad });
      expect(errors, bad).toHaveLength(1);
      expect(errors[0], bad).toContain("поле author");
    }
  });

  it("batch необязательна; если есть — целое число от 1", () => {
    expect(validateTask("T-0003-x.md", { ...valid(), batch: "1" })).toEqual([]);
    expect(validateTask("T-0003-x.md", { ...valid(), batch: "12" })).toEqual([]);
    for (const bad of ["0", "-1", "1.5", "02", "v0.8", "", "две", null]) {
      const errors = validateTask("T-0003-x.md", { ...valid(), batch: bad });
      expect(errors, String(bad)).toHaveLength(1);
      expect(errors[0], String(bad)).toContain("T-0003-x.md: поле batch");
      expect(errors[0], String(bad)).toContain("пачки");
    }
  });

  it("version больше не допускается: одна ошибка, которая называет замену", () => {
    for (const version of ["v0.8", "v0.10", ""]) {
      const errors = validateTask("T-0003-x.md", { ...valid(), version });
      expect(errors, version).toHaveLength(1);
      expect(errors[0], version).toBe(
        "T-0003-x.md: поле version заменено полем batch — пачкой очереди, tasks/README.md",
      );
    }
  });

  it("шапка с batch разбирается и проходит проверку", () => {
    const parsed = parseFrontmatter(headerWith((lines) => lines.splice(lines.indexOf("---", 1), 0, "batch: 2")));
    expect(parsed.errors).toEqual([]);
    expect(parsed.data.batch).toBe("2");
    expect(validateTask("T-0003-x.md", parsed.data)).toEqual([]);
  });

  it("owner — «аккаунт / исполнитель / уровень»; прежний без уровня тоже читается", () => {
    expect(parseOwner("claude-3 / sonnet-5.5 / medium")).toEqual({ account: "claude-3", executor: "sonnet-5.5", effort: "medium" });
    expect(parseOwner("claude-2 / sonnet-5.5")).toEqual({ account: "claude-2", executor: "sonnet-5.5", effort: null });
    for (const bad of ["", "claude-3", "claude-3 /  / low", "a / b / c / d"]) expect(parseOwner(bad), bad).toBeNull();
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
    // Раздел «PR» совпадает с шапкой valid(): иначе проверка раздела «PR» (T-0146) добавит свою ошибку.
    const PR_SECTION = ["## PR", "", "- **Заголовок:** `fix(app-shell): Чинить X`", "- **Метка:** `release: patch`"];
    const bodyWith = (...lines: string[]): string => ["", "# T-0003. Заголовок", "", ...lines, "", "## Зачем", "", ...PR_SECTION].join("\n");

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
      const errors = validateTask(fileName, data, { body: ["", "# Другое", "", right, "", ...PR_SECTION].join("\n"), fileNames: FILE_NAMES });
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

describe("значок задачи и строка значков под заголовком (T-0018)", () => {
  it("taskBadge — значок с подписью и ссылкой на файл задачи", () => {
    expect(taskBadge("T-0002", "T-0002-task-cli.md")).toBe(`[![T-0002](${STATUS_URL}/T-0002.json&label=T-0002)](T-0002-task-cli.md)`);
  });

  it("badgeLine после рефакторинга даёт прежнюю строку: задача с двумя зависимостями", () => {
    expect(badgeLine({ id: "T-0003", depends_on: ["T-0001", "T-0002"] }, FILE_NAMES)).toBe(
      [
        `[![статус](${STATUS_URL}/T-0003.json)](README.md#значки-статуса)`,
        `[![T-0001](${STATUS_URL}/T-0001.json&label=T-0001)](T-0001-first.md)`,
        `[![T-0002](${STATUS_URL}/T-0002.json&label=T-0002)](T-0002-second.md)`,
      ].join(" "),
    );
  });
});

describe("withBadgeLine", () => {
  const expected = `[![статус](${STATUS_URL}/T-0003.json)](README.md#значки-статуса)`;
  const stale = `[![статус](${STATUS_URL}/T-0003.json)](README.md#значки-статуса) [![T-0009](x)](y.md)`;
  const text = (...middle: string[]): string => ["---", "id: T-0003", "---", "", "# T-0003. Заголовок", ...middle, "## Зачем", "Текст.", ""].join("\n");

  it("устаревшая строка заменяется, остальное побайтно то же", () => {
    expect(withBadgeLine(text("", stale, ""), expected)).toBe(text("", expected, ""));
  });

  it("верная строка — текст не меняется", () => {
    expect(withBadgeLine(text("", expected, ""), expected)).toBe(text("", expected, ""));
  });

  it("строки нет — вставлена под заголовком, после неё пустая строка", () => {
    expect(withBadgeLine(text(""), expected)).toBe(text("", expected, ""));
  });

  it("файл с CRLF — переводы строк остались CRLF", () => {
    const crlf = text("", stale, "").replace(/\n/g, "\r\n");
    const fixed = withBadgeLine(crlf, expected);
    expect(fixed).toBe(text("", expected, "").replace(/\n/g, "\r\n"));
    expect(fixed.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("вставка в файл с CRLF тоже CRLF", () => {
    const fixed = withBadgeLine(text("").replace(/\n/g, "\r\n"), expected);
    expect(fixed.replace(/\r\n/g, "")).not.toContain("\n");
    expect(fixed).toContain(expected);
  });

  it("заголовка нет — текст без изменений", () => {
    const noHeading = "---\nid: T-0003\n---\n\nПросто текст.\n";
    expect(withBadgeLine(noHeading, expected)).toBe(noHeading);
  });
});

describe("раздел «PR» против шапки", () => {
  const fileName = "T-0003-x.md";
  const TITLE_MINOR = "feat(app-shell): Добавить X";

  // Раздел «PR» со строками заголовка и метки; `null` — строки нет.
  const prBody = (title: string | null, label: string | null): string =>
    [
      "# T-0003. Заголовок",
      "",
      "## Что и почему",
      "",
      "Текст.",
      "",
      "## PR",
      "",
      ...(title === null ? [] : [`- **Заголовок:** \`${title}\``]),
      ...(label === null ? [] : [`- **Метка:** \`${label}\``]),
      "",
      "## Для игроков",
      "",
      "- нет",
    ].join("\n");

  it("метка совпадает с шапкой и не ниже типа заголовка — без ошибок", () => {
    expect(checkPrSection(fileName, { ...valid(), release: "minor" }, prBody(TITLE_MINOR, "release: minor"))).toEqual([]);
  });

  it("метка не совпадает с шапкой — ошибка с обоими значениями", () => {
    expect(checkPrSection(fileName, { ...valid(), release: "minor" }, prBody(TITLE_MINOR, "release: patch"))).toEqual([
      `${fileName}: поле release — в шапке minor, в разделе «PR» patch`,
    ]);
  });

  it("метка ниже, чем требует тип заголовка, — ошибка «ниже»", () => {
    expect(
      checkPrSection(fileName, { ...valid(), release: "patch" }, prBody("feat(app-shell): Добавить X", "release: patch")),
    ).toEqual([`${fileName}: поле release — patch ниже minor для заголовка feat(app-shell): Добавить X`]);
  });

  it("feat в области dev требует только patch — без ошибок", () => {
    expect(checkPrSection(fileName, { ...valid(), release: "patch" }, prBody("feat(dev): Добавить X", "release: patch"))).toEqual([]);
  });

  it("docs при метке none — без ошибок", () => {
    expect(checkPrSection(fileName, { ...valid(), release: "none" }, prBody("docs(tasks): Описать X", "release: none"))).toEqual([]);
  });

  it("заголовок не по формату — ошибка с текстом parsePrTitle, минимум по типу не проверяется", () => {
    const errors = checkPrSection(fileName, { ...valid(), release: "minor" }, prBody("Добавить X", "release: minor"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("заголовок не соответствует формату");
  });

  it("нет строки «Метка» — ошибка, заголовок всё равно проверяется", () => {
    expect(checkPrSection(fileName, { ...valid(), release: "patch" }, prBody("fix(app-shell): Чинить X", null))).toEqual([
      `${fileName}: раздел «PR» — нет строки «Метка»`,
    ]);
  });

  it("нет строки «Заголовок» — ошибка", () => {
    expect(checkPrSection(fileName, { ...valid(), release: "patch" }, prBody(null, "release: patch"))).toEqual([
      `${fileName}: раздел «PR» — нет строки «Заголовок»`,
    ]);
  });

  it("проверка идёт только для ready и in-progress: черновик с расхождением — без ошибок", () => {
    const data = { ...valid(), status: "draft", release: "minor" };
    expect(validateTask(fileName, data, { body: prBody(TITLE_MINOR, "release: patch"), fileNames: {} })).toEqual([]);
  });

  it("закрытая задача с расхождением — без ошибок", () => {
    const data = { ...valid(), status: "done", release: "minor" };
    expect(validateTask(fileName, data, { body: prBody(TITLE_MINOR, "release: patch"), fileNames: {} })).toEqual([]);
  });

  it("ready с расхождением — validateTask отдаёт ошибку", () => {
    const data = { ...valid(), status: "ready", release: "minor" };
    const errors = validateTask(fileName, data, { body: prBody(TITLE_MINOR, "release: patch"), fileNames: {} });
    expect(errors).toEqual([`${fileName}: поле release — в шапке minor, в разделе «PR» patch`]);
  });

  it("без тела задачи (захват по шапке) раздел не проверяется", () => {
    expect(validateTask(fileName, { ...valid(), status: "ready", release: "minor" })).toEqual([]);
  });
});

// Архив задач (T-0204): ссылки на файлы задач считаются от папки файла, где они стоят.

describe("относительные ссылки на файлы задач", () => {
  it("relativeTaskLink — четыре сочетания папок", () => {
    expect(relativeTaskLink("T-0001-a.md", "T-0002-b.md")).toBe("T-0002-b.md");
    expect(relativeTaskLink("T-0001-a.md", "archive/T-0002-b.md")).toBe("archive/T-0002-b.md");
    expect(relativeTaskLink("archive/T-0001-a.md", "T-0002-b.md")).toBe("../T-0002-b.md");
    expect(relativeTaskLink("archive/T-0001-a.md", "archive/T-0002-b.md")).toBe("T-0002-b.md");
    expect(relativeTaskLink("archive/T-0001-a.md", "README.md")).toBe("../README.md");
    expect(relativeTaskLink("epics.md", "archive/T-0002-b.md")).toBe("archive/T-0002-b.md");
  });

  const PATHS = { "T-0001": "T-0001-first.md", "T-0002": "archive/T-0002-second.md" };

  it("badgeLine из архива ведёт на README через «../» и на открытую зависимость через «../»", () => {
    const line = badgeLine({ id: "T-0003", path: "archive/T-0003-x.md", depends_on: ["T-0001", "T-0002"] }, PATHS);
    expect(line).toContain("](../README.md#значки-статуса)");
    expect(line).toContain("](../T-0001-first.md)");
    expect(line).toContain("](T-0002-second.md)");
  });

  it("badgeLine сверху ведёт на архивную зависимость через archive/", () => {
    expect(badgeLine({ id: "T-0003", path: "T-0003-x.md", depends_on: ["T-0002"] }, PATHS)).toContain("](archive/T-0002-second.md)");
  });

  describe("withTaskLinks", () => {
    it("ссылка из tasks/ на архивную задачу получает archive/", () => {
      expect(withTaskLinks("см. [T-0002](T-0002-second.md)", "T-0009-x.md", PATHS)).toBe("см. [T-0002](archive/T-0002-second.md)");
    });

    it("верная ссылка из архива на открытую — без изменений, якорь сохраняется", () => {
      expect(withTaskLinks("[шаги](../T-0001-first.md#шаги)", "archive/T-0009-x.md", PATHS)).toBe("[шаги](../T-0001-first.md#шаги)");
      expect(withTaskLinks("[шаги](T-0001-first.md#шаги)", "archive/T-0009-x.md", PATHS)).toBe("[шаги](../T-0001-first.md#шаги)");
    });

    it("задачи нет в реестре и чужие пути — без изменений", () => {
      expect(withTaskLinks("[x](T-9999-x.md) [y](docs/x.md) [z](https://x/T-0002-second.md)", "T-0009-x.md", PATHS)).toBe(
        "[x](T-9999-x.md) [y](docs/x.md) [z](https://x/T-0002-second.md)",
      );
    });

    it("повторный вызов ничего не меняет", () => {
      const once = withTaskLinks("[a](T-0002-second.md) [b](../archive/T-0002-second.md)", "T-0009-x.md", PATHS);
      expect(withTaskLinks(once, "T-0009-x.md", PATHS)).toBe(once);
    });
  });
});
