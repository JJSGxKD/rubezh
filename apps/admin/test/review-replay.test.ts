import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchRunReplay, reasonTitle, repeatRunReplay, reviewRowSchema, runReplaySchema, type RunReplay } from "../src/api/review";
import { REPLAY_SEC_TOLERANCE, replayBadge, replayRepeatChanges, replayRows, replayTickText } from "../src/screens/review/run-report-view";
import { fakeFetch, json } from "./helpers";

/**
 * Перепроверка забега повтором в разборе (tasks/T-0319): исход и тик в очереди,
 * таблица «заявлено / повтор», «Повторить снова». Форма ответа — `ReplayView`
 * сервера (`backend/api/src/modules/runs/run-replay.service.ts`).
 */

const RUN = "4d1c7a0e-5a39-4c1b-8f35-1d2e3f4a5b6c";

function sample(patch: Partial<RunReplay> = {}): RunReplay {
  return {
    verdict: "mismatch",
    required: true,
    divergedTick: 1800,
    replayedAt: "2026-11-14T12:00:00.000Z",
    reason: "свёртка минуты разошлась",
    durationMs: 812,
    claimed: { survivalSec: 61.5, level: 3, enemiesKilled: 40 },
    replayed: { ticks: 3600, survivalSec: 55, level: 3, enemiesKilled: 31, checksum: 5 },
    hasProof: true,
    canRepeat: true,
    ...patch,
  };
}

describe("очередь разбора", () => {
  const row = { runId: RUN, accountId: "a1", displayName: null, verdict: "suspicious", verdictReasons: ["replay_mismatch"], difficulty: "hard", survivalSec: 61, level: 3, enemiesKilled: 40, finishedAt: "2026-11-14T12:00:00.000Z" };

  it("строка с исходом повтора читается, без исхода — тоже: сервер мог обновиться раньше панели", () => {
    expect(reviewRowSchema.parse({ ...row, replay: { verdict: "mismatch", divergedTick: 1800 } }).replay).toEqual({ verdict: "mismatch", divergedTick: 1800 });
    expect(reviewRowSchema.parse(row).replay).toBeUndefined();
    // Исход, которого панель не знает, не роняет очередь.
    expect(reviewRowSchema.safeParse({ ...row, replay: { verdict: "новый", divergedTick: null } }).success).toBe(true);
  });

  it("причина replay_mismatch названа словами", () => {
    expect(reasonTitle("replay_mismatch")).toBe("повтор забега на сервере разошёлся с записью");
  });
});

describe("слова исхода", () => {
  it("каждый исход сервера — свой цвет и текст; расхождение — красным, наша сторона — предупреждением", () => {
    expect(replayBadge("match")).toEqual({ tone: "success", text: "совпал" });
    expect(replayBadge("mismatch").tone).toBe("danger");
    for (const ours of ["content_mismatch", "broken", "timeout"]) expect(replayBadge(ours).tone).toBe("warning");
    expect(replayBadge("pending").text).toBe("ожидает");
    expect(replayBadge("no_proof").text).toBe("записи нет");
    expect(replayBadge("not_replayable").tone).toBe("neutral");
  });

  it("не назначался и незнакомый исход — без падения", () => {
    expect(replayBadge(null)).toEqual({ tone: "neutral", text: "не назначался" });
    expect(replayBadge("future_outcome")).toEqual({ tone: "neutral", text: "future_outcome" });
  });

  it("тик расхождения: число с разрядами или прочерк", () => {
    expect(replayTickText(1800)).toBe("тик 1 800");
    expect(replayTickText(null)).toBe("—");
  });
});

describe("таблица «заявлено / повтор»", () => {
  it("расходящиеся строки подсвечены, сошедшаяся — нет", () => {
    const rows = replayRows(sample());
    expect(rows.map((row) => [row.label, row.claimed, row.replayed, row.differs])).toEqual([
      ["Время", "61,5 с", "55,0 с", true],
      ["Уровень", "3", "3", false],
      ["Убийств", "40", "31", true],
    ]);
  });

  it("время в пределах секунды — не расхождение: клиент округляет в любую сторону", () => {
    expect(REPLAY_SEC_TOLERANCE).toBe(1);
    expect(replayRows(sample({ replayed: { ticks: 1, survivalSec: 60.6, level: 3, enemiesKilled: 40, checksum: 1 } }))[0]?.differs).toBe(false);
    expect(replayRows(sample({ replayed: { ticks: 1, survivalSec: 60.4, level: 3, enemiesKilled: 40, checksum: 1 } }))[0]?.differs).toBe(true);
  });

  it("повтор не дошёл до итога — справа прочерки и ничего не подсвечено", () => {
    const rows = replayRows(sample({ replayed: null, verdict: "timeout" }));
    expect(rows.map((row) => [row.replayed, row.differs])).toEqual([
      ["—", false],
      ["—", false],
      ["—", false],
    ]);
  });
});

describe("«Повторить снова»", () => {
  it("окно говорит заранее: прежний исход, сброс, приоритет, журнал", () => {
    expect(replayRepeatChanges({ verdict: "mismatch" }).map((change) => change.label)).toEqual(["Прежний исход", "Исход", "Очередь", "Журнал действий"]);
    expect(replayRepeatChanges({ verdict: "mismatch" })[0]?.value).toBe("разошёлся");
    expect(replayRepeatChanges({ verdict: null })[0]?.value).toBe("повтора не было");
  });

  it("запросы — GET и POST по адресу забега, ответ разбирается схемой", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: sample() }), json(200, { data: sample({ verdict: "pending", canRepeat: false, divergedTick: null, replayed: null }) }));
    const api = new AdminApi(fetch);

    const read = await fetchRunReplay(api, RUN);
    const repeated = await repeatRunReplay(api, RUN);

    expect(read.ok && read.data.verdict).toBe("mismatch");
    expect(repeated.ok && repeated.data.verdict).toBe("pending");
    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      [`/api/v1/admin/runs/${RUN}/replay`, "GET"],
      [`/api/v1/admin/runs/${RUN}/replay`, "POST"],
    ]);
  });

  it("отказ сервера — 409 с текстом: панель покажет его в окне", async () => {
    const { fetch } = fakeFetch(json(409, { error: { code: "run_replay_pending", message: "Повтор этого забега уже идёт" } }));
    const refused = await repeatRunReplay(new AdminApi(fetch), RUN);
    expect(!refused.ok && refused.error.status).toBe(409);
  });

  it("схема принимает забег без повтора: исход пуст", () => {
    expect(runReplaySchema.safeParse(sample({ verdict: null, replayed: null, divergedTick: null, replayedAt: null, reason: null, durationMs: null, required: false })).success).toBe(true);
  });
});
