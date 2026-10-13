import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { checkEpicCells, epicStreamsCell, epicTasksCell, fixEpicCells } from "../tasks/epics.mjs";

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

// Столбец «Потоки» перед «Задачи»: значок, какие потоки запускать для эпика сейчас.
const STREAMS_URL = "https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status";
const BOARD = "https://github.com/JJSGxKD/rubezh/blob/task-board/README.md#потоки-сейчас";
const streams = (epic: string): string => `[![потоки](${STREAMS_URL}/epic-${epic}.json)](${BOARD})`;

function epicsWithStreams(s0: string, e0: string, s1: string, e1: string): string {
  return [
    "# Эпики",
    "",
    "Текст, где есть | и **E0.** вне таблицы.",
    "",
    "| Эпик | Цель | Приоритет | Потоки | Задачи |",
    "|---|---|---|---|---|",
    `| **E0. Процесс** | Цель нулевого | P0 | ${s0} | ${e0} |`,
    `| **E1. Деньги** | Цель первого | P0 | ${s1} | ${e1} |`,
    "| **E2. Тест** | Цель второго | P1 | — | — |",
    "",
  ].join("\n");
}

describe("ячейка «Потоки» эпика", () => {
  it("значок читает epic-<эпик>.json и ведёт на раздел «Потоки сейчас» доски", () => {
    expect(epicStreamsCell("E0", TASKS)).toBe(streams("E0"));
  });

  it("в эпике нет задач — тире", () => {
    expect(epicStreamsCell("E2", TASKS)).toBe("—");
  });

  it("совпадает — ошибок нет", () => {
    expect(checkEpicCells(epicsWithStreams(streams("E0"), E0, streams("E1"), E1), TASKS)).toEqual([]);
  });

  it("расхождение — ошибка с названием ячейки и ожидаемым значением", () => {
    const errors = checkEpicCells(epicsWithStreams("—", E0, streams("E1"), E1), TASKS);
    expect(errors).toEqual([
      `epics.md: эпик E0 — ячейка «Потоки» не совпадает с реестром, поправит pnpm task fix; ожидается: ${streams("E0")}`,
    ]);
  });

  it("обе ячейки неверны — две ошибки, по одной на ячейку", () => {
    const errors = checkEpicCells(epicsWithStreams("—", "T-0002", streams("E1"), E1), TASKS);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("«Потоки»");
    expect(errors[1]).toContain("«Задачи»");
  });

  it("правка чинит обе ячейки и не трогает остальное", () => {
    const broken = epicsWithStreams("—", "T-0002, T-0011", "[x](y)", "—");
    const fixed = fixEpicCells(broken, TASKS);
    expect(fixed).toBe(epicsWithStreams(streams("E0"), E0, streams("E1"), E1));
    expect(checkEpicCells(fixed, TASKS)).toEqual([]);
    expect(fixed).toContain("Текст, где есть | и **E0.** вне таблицы.");
    expect(fixed).toContain("| Цель нулевого | P0 |");
  });

  it("исправный текст не меняется", () => {
    const text = epicsWithStreams(streams("E0"), E0, streams("E1"), E1);
    expect(fixEpicCells(text, TASKS)).toBe(text);
  });

  it("таблица без столбца «Потоки» разбирается как раньше: вторая с конца ячейка — не «Потоки»", () => {
    const text = epics(E0, E1);
    expect(checkEpicCells(text, TASKS)).toEqual([]);
    expect(fixEpicCells(text, TASKS)).toBe(text);
  });
});
