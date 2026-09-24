import { describe, expect, it } from "vitest";
import type { RunReportClient } from "../../packages/app-shell/src/state/diagnostic-reports";
import { circling, recordHeadlessRun } from "../../packages/core-game/test/helpers/recorded-run";
import { RUN_RECORDING_EVENT_KINDS } from "../../packages/core-game/src/run-api";
import { RECORDING_EVENT_KINDS, submitRunReportSchema } from "../../backend/api/src/modules/diagnostics/dto/run-report.dto.js";

// Запись забега на трёх сторонах: движок пишет, оболочка кладёт в конверт,
// приёмник разбирает своей схемой (docs/28-diagnostics.md §3.3, §5.1). Схема
// приёмника живёт в бэкенде отдельно от типов движка — разойдутся, и записи
// тестеров молча получат 400 и выпадут из очереди.

const CLIENT: RunReportClient = {
  screenMode: "fullscreen",
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
  clientErrors: 0,
  evictedReports: 0,
};

describe("схема записи забега", () => {
  it("приёмник принимает настоящую запись движка без потерь полей", () => {
    const recording = recordHeadlessRun({ seed: 42, maxTicks: 5_000, steer: circling(200) });
    const parsed = submitRunReportSchema.safeParse({ recording, client: CLIENT });

    expect(parsed.error?.issues ?? []).toEqual([]);
    // Схема строгая к форме, но не выбрасывает поля движка: повтору нужно всё.
    expect(parsed.data?.recording).toEqual(recording);
  });

  it("и запись со вторым шансом: продолжение не теряется по дороге", () => {
    // Без поля в схеме приёмник молча выбросил бы тики продолжений, и повтор
    // продолженного забега разошёлся бы с оригиналом.
    const recording = recordHeadlessRun({ seed: 99, maxTicks: 40_000, difficultyId: "hard", steer: () => null, continues: true });
    const parsed = submitRunReportSchema.safeParse({ recording, client: CLIENT });

    expect(recording.continues?.length).toBeGreaterThan(0);
    expect(parsed.data?.recording).toEqual(recording);
  });

  it("виды событий движка и приёмника совпадают", () => {
    expect([...RECORDING_EVENT_KINDS].sort()).toEqual([...RUN_RECORDING_EVENT_KINDS].sort());
  });

  it("и запись погибшего игрока с причиной смерти", () => {
    const recording = recordHeadlessRun({ seed: 7, maxTicks: 40_000, difficultyId: "hard", steer: () => null });
    expect(recording.outcome).toBe("died");
    expect(submitRunReportSchema.safeParse({ recording, client: CLIENT }).success).toBe(true);
  });
});
