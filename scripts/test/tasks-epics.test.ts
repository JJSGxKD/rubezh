import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { checkEpicCells, epicStreamsBlock, epicTasksCell, fixEpicCells, STREAMS_END, STREAMS_START } from "../tasks/epics.mjs";

// Ячейка «Задачи» в tasks/epics.md — живые значки задач эпика (T-0018).

const URL = "https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status";
const badge = (id: string, name: string): string => `[![${id}](${URL}/${id}.json&label=${id})](${name})`;

const TASKS = [
  { id: "T-0011", epic: "E0", fileName: "T-0011-b.md" },
  { id: "T-0002", epic: "E0", fileName: "T-0002-a.md" },
  { id: "T-0016", epic: "E0", fileName: "T-0016-c.md" },
  { id: "T-0003", epic: "E1", fileName: "T-0003-d.md" },
];
const E0 = [badge("T-0002", "T-0002-a.md"), badge("T-0011", "T-0011-b.md"), badge("T-0016", "T-0016-c.md")].join(" ");
const E1 = badge("T-0003", "T-0003-d.md");

function epics(e0: string, e1: string): string {
  return [
    "# Эпики",
    "",
    "Текст, где есть | и **E0.** вне таблицы.",
    "",
    "| Эпик | Цель | Приоритет | Задачи |",
    "|---|---|---|---|",
    `| **E0. Процесс** | Цель нулевого | P0 | ${e0} |`,
    `| **E1. Деньги** | Цель первого | P0 | ${e1} |`,
    "| **E2. Тест** | Цель второго | P1 | — |",
    "",
  ].join("\n");
}

describe("ячейка «Задачи» эпика", () => {
  it("значки задач эпика по возрастанию id, через пробел", () => {
    expect(epicTasksCell("E0", TASKS)).toBe(E0);
  });

  it("задач нет — тире", () => {
    expect(epicTasksCell("E2", TASKS)).toBe("—");
  });

  it("задача чужого эпика не попадает", () => {
    expect(epicTasksCell("E1", TASKS)).toBe(E1);
  });

  it("берутся задачи в любом статусе", () => {
    expect(epicTasksCell("E1", [{ id: "T-0005", epic: "E1", fileName: "T-0005-x.md", status: "draft" }])).toBe(badge("T-0005", "T-0005-x.md"));
  });
});

describe("проверка ячеек эпиков", () => {
  it("совпадает — ошибок нет", () => {
    expect(checkEpicCells(epics(E0, E1), TASKS)).toEqual([]);
  });

  it("номера через запятую — ошибка с эпиком и ожидаемой ячейкой", () => {
    const errors = checkEpicCells(epics("T-0002, T-0011, T-0016", E1), TASKS);
    expect(errors).toEqual([
      `epics.md: эпик E0 — ячейка «Задачи» не совпадает с реестром, поправит pnpm task fix; ожидается: ${E0}`,
    ]);
  });

  it("пробелы по краям ячейки расхождением не считаются", () => {
    const text = epics(E0, E1).replace(`| ${E0} |`, `|    ${E0}   |`);
    expect(checkEpicCells(text, TASKS)).toEqual([]);
  });
});

describe("правка ячеек эпиков", () => {
  const broken = epics("T-0002, T-0011", "—");

  it("после правки проверка пуста", () => {
    expect(checkEpicCells(fixEpicCells(broken, TASKS), TASKS)).toEqual([]);
  });

  it("строки вне таблицы и ячейки «Цель» и «Приоритет» не меняются", () => {
    const fixed = fixEpicCells(broken, TASKS);
    expect(fixed).toBe(epics(E0, E1));
    expect(fixed).toContain("Текст, где есть | и **E0.** вне таблицы.");
    expect(fixed).toContain("| Цель нулевого | P0 |");
  });

  it("исправный текст не меняется", () => {
    expect(fixEpicCells(epics(E0, E1), TASKS)).toBe(epics(E0, E1));
  });
});

// Раздел «Потоки по эпикам» под таблицей: значок, какие потоки запускать для эпика сейчас.
// В таблице значки широкие и нечитаемы, поэтому — по строке на эпик.
const STREAMS_URL = "https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status";
const BOARD = "https://github.com/JJSGxKD/rubezh/blob/task-board/README.md#потоки-сейчас";
const streamsLine = (title: string, epic: string): string => `- **${title}** — [![потоки](${STREAMS_URL}/epic-${epic}.json)](${BOARD})`;
const BLOCK = [streamsLine("E0. Процесс", "E0"), streamsLine("E1. Деньги", "E1")].join("\n");

function epicsWithSection(block: string): string {
  return [epics(E0, E1), "## Потоки по эпикам", "", STREAMS_START, block, STREAMS_END, ""].join("\n");
}

describe("раздел «Потоки по эпикам»", () => {
  it("по строке на эпик с задачами, в порядке таблицы; эпик без задач пропускается", () => {
    expect(epicStreamsBlock(epics(E0, E1), TASKS)).toBe(BLOCK);
  });

  it("совпадает — ошибок нет", () => {
    expect(checkEpicCells(epicsWithSection(BLOCK), TASKS)).toEqual([]);
  });

  it("расхождение — одна ошибка про раздел", () => {
    const errors = checkEpicCells(epicsWithSection(streamsLine("E0. Процесс", "E0")), TASKS);
    expect(errors).toEqual(["epics.md: раздел «Потоки по эпикам» не совпадает с реестром, поправит pnpm task fix"]);
  });

  it("правка ставит раздел между метками и не трогает остальное", () => {
    const fixed = fixEpicCells(epicsWithSection("старое"), TASKS);
    expect(fixed).toBe(epicsWithSection(BLOCK));
    expect(checkEpicCells(fixed, TASKS)).toEqual([]);
    expect(fixed).toContain("| Цель нулевого | P0 |");
  });

  it("исправный текст не меняется", () => {
    const text = epicsWithSection(BLOCK);
    expect(fixEpicCells(text, TASKS)).toBe(text);
  });

  it("без меток раздел не требуется и не появляется", () => {
    const text = epics(E0, E1);
    expect(checkEpicCells(text, TASKS)).toEqual([]);
    expect(fixEpicCells(text, TASKS)).toBe(text);
  });

  it("задача в архиве — ссылка ведёт на archive/ (T-0204)", () => {
    const tasks = [{ id: "T-0002", epic: "E0", fileName: "T-0002-a.md", path: "archive/T-0002-a.md", status: "done" }];
    expect(epicTasksCell("E0", tasks)).toBe(badge("T-0002", "archive/T-0002-a.md"));
  });
});
