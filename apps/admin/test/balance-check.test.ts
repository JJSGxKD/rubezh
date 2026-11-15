import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchCheck, startCheck } from "../src/api/content";
import {
  CHECK_POLL_LIMIT_MS,
  CHECK_POLL_MS,
  corridorRow,
  edgeLevel,
  formatMetric,
  isStale,
  parseCheckOutcome,
  railSteps,
  rowMark,
  staleNote,
  type CheckOutcome,
  type CorridorLine,
} from "../src/screens/balance/check/check-rules";
import { fakeFetch, json } from "./helpers";

// Проверка черновика в «Балансе» (tasks/T-0305): «у края» в 10 % от границы,
// «устарела» при смене хэша, рельсы зелёные только при всех проверках и
// свежем прогоне. Логика без DOM.

const DODGING: CorridorLine = {
  id: "dodgingMedianSec",
  title: "Медиана уклоняющегося",
  corridor: { min: 180, max: 300 },
  baseCorridor: { min: 180, max: 300 },
  base: { value: 245, verdict: "in" },
  draft: { value: 220, verdict: "in" },
};

const DEATHS: CorridorLine = {
  id: "dodgingDeathsBeforeMinuteRatioMax",
  title: "Умерли до минуты",
  corridor: { min: null, max: 0.2 },
  baseCorridor: { min: null, max: 0.2 },
  base: { value: 0.14, verdict: "in" },
  draft: { value: 0.19, verdict: "in" },
};

function outcome(corridors: CorridorLine[], extra: Partial<CheckOutcome> = {}): CheckOutcome {
  return { schemaProblems: [], contentProblems: [], report: { timeout: false, seeds: 20, scenarios: [], corridors }, ...extra };
}

describe("edgeLevel: «у края» — в 10 % от границы", () => {
  it("двусторонний коридор: запас — десятая часть его ширины", () => {
    // ширина 120, запас 12: край — 192 снизу и 288 сверху
    expect(edgeLevel(240, { min: 180, max: 300 })).toBe("ok");
    expect(edgeLevel(191, { min: 180, max: 300 })).toBe("edge");
    expect(edgeLevel(192, { min: 180, max: 300 })).toBe("ok");
    expect(edgeLevel(289, { min: 180, max: 300 })).toBe("edge");
    expect(edgeLevel(288, { min: 180, max: 300 })).toBe("ok");
  });

  it("граница — это ещё внутри, за ней — вне коридора", () => {
    expect(edgeLevel(300, { min: 180, max: 300 })).toBe("edge");
    expect(edgeLevel(301, { min: 180, max: 300 })).toBe("out");
    expect(edgeLevel(179, { min: 180, max: 300 })).toBe("out");
  });

  it("односторонний коридор: запас — десятая часть самой границы", () => {
    expect(edgeLevel(0.19, { min: null, max: 0.2 })).toBe("edge");
    expect(edgeLevel(0.17, { min: null, max: 0.2 })).toBe("ok");
    expect(edgeLevel(0.21, { min: null, max: 0.2 })).toBe("out");
    expect(edgeLevel(5, { min: 100, max: null })).toBe("out");
    expect(edgeLevel(105, { min: 100, max: null })).toBe("edge");
    expect(edgeLevel(500, { min: 100, max: null })).toBe("ok");
  });
});

describe("строка метрики", () => {
  it("время — минуты и секунды, доля — проценты", () => {
    expect(formatMetric("dodgingMedianSec", 245)).toBe("4:05");
    expect(formatMetric("dodgingMedianSec", 59.6)).toBe("1:00");
    expect(formatMetric("dodgingDeathsBeforeMinuteRatioMax", 0.14)).toBe("14 %");
  });

  it("сценарий из задачи: 4:05 → 3:40 ✓ и 14 % → 19 % · у края", () => {
    const median = corridorRow(DODGING);
    expect(median.text).toBe("4:05 → 3:40");
    expect(median.level).toBe("ok");
    expect(rowMark(median)).toBe("✓");

    const deaths = corridorRow(DEATHS);
    expect(deaths.text).toBe("14 % → 19 %");
    expect(deaths.level).toBe("edge");
    expect(rowMark(deaths)).toBe("· у края");
  });

  it("вне коридора — ✗, по вердикту сервера", () => {
    const row = corridorRow({ ...DODGING, draft: { value: 150, verdict: "below" } });
    expect(row.level).toBe("out");
    expect(rowMark(row)).toBe("✗ вне коридора");
  });

  it("считать было не из чего — прочерк без отметки", () => {
    const row = corridorRow({ ...DODGING, draft: null });
    expect(row.level).toBe("none");
    expect(row.text).toBe("4:05 → —");
    expect(rowMark(row)).toBe("");
  });
});

describe("устарела", () => {
  it("прогон устарел, когда хэш черновика сменился", () => {
    expect(isStale("aaa", "aaa")).toBe(false);
    expect(isStale("aaa", "bbb")).toBe(true);
  });

  it("нет прогона — устаревать нечему", () => {
    expect(isStale(null, "bbb")).toBe(false);
  });

  it("пометка называет последнюю правку", () => {
    expect(staleNote("Волк · урон 7 → 9")).toBe("Прогнана до правки «Волк · урон 7 → 9» — устарела");
    expect(staleNote(null)).toBe("Прогнана до правки — устарела");
  });
});

describe("рельсы шагов", () => {
  const ok = [DODGING];

  it("все зелёные при чистой схеме, проверках и симуляции в коридорах", () => {
    const rails = railSteps({ outcome: outcome(ok), status: "done", stale: false, running: false });
    expect(rails.steps.map((s) => s.state)).toEqual(["ok", "ok", "ok"]);
    expect(rails.ready).toBe(true);
  });

  it("«у края» — всё ещё зелёное: в коридоре", () => {
    const rails = railSteps({ outcome: outcome([DEATHS]), status: "done", stale: false, running: false });
    expect(rails.ready).toBe(true);
  });

  it("проблема схемы краснит схему и не даёт судить о дальнейшем", () => {
    const rails = railSteps({ outcome: outcome(ok, { schemaProblems: [{ path: "enemies[0].hp", message: "не число" }] }), status: "done", stale: false, running: false });
    expect(rails.steps.map((s) => s.state)).toEqual(["fail", "idle", "idle"]);
    expect(rails.ready).toBe(false);
  });

  it("проблема контента краснит проверки, симуляция остаётся своим цветом", () => {
    const rails = railSteps({ outcome: outcome(ok, { contentProblems: [{ path: "waves", message: "бюджет убывает" }] }), status: "done", stale: false, running: false });
    expect(rails.steps[0]?.state).toBe("ok");
    expect(rails.steps[1]?.state).toBe("fail");
    expect(rails.ready).toBe(false);
  });

  it("метрика вне коридора краснит симуляцию", () => {
    const out: CorridorLine = { ...DODGING, draft: { value: 150, verdict: "below" } };
    const rails = railSteps({ outcome: outcome([out]), status: "done", stale: false, running: false });
    expect(rails.steps[2]?.state).toBe("fail");
    expect(rails.ready).toBe(false);
  });

  it("таймаут прогона — симуляция красная", () => {
    const timed = outcome(ok, { report: { timeout: true, seeds: 20, scenarios: [], corridors: ok } });
    expect(railSteps({ outcome: timed, status: "timeout", stale: false, running: false }).steps[2]?.state).toBe("fail");
  });

  it("устаревший прогон не даёт «готово», даже если всё было зелёное", () => {
    const rails = railSteps({ outcome: outcome(ok), status: "done", stale: true, running: false });
    expect(rails.steps.map((s) => s.state)).toEqual(["stale", "stale", "stale"]);
    expect(rails.ready).toBe(false);
  });

  it("пока считается — шаги в работе, до первого прогона — пусты", () => {
    expect(railSteps({ outcome: null, status: "queued", stale: false, running: true }).steps.map((s) => s.state)).toEqual(["run", "run", "run"]);
    const idle = railSteps({ outcome: null, status: null, stale: false, running: false });
    expect(idle.steps.map((s) => s.state)).toEqual(["idle", "idle", "idle"]);
    expect(idle.ready).toBe(false);
  });

  it("упавшая проверка — не зелёная", () => {
    expect(railSteps({ outcome: null, status: "failed", stale: false, running: false }).ready).toBe(false);
  });
});

describe("разбор отчёта сервера", () => {
  it("итог воркера разбирается, лишние поля не мешают", () => {
    const parsed = parseCheckOutcome({ checkId: "x", schemaProblems: [], contentProblems: [{ path: "a", message: "б" }], elapsedMs: 5, report: { timeout: false, seeds: 2, scenarios: [], corridors: [DODGING] } });
    expect(parsed?.contentProblems).toHaveLength(1);
    expect(parsed?.report?.corridors[0]?.id).toBe("dodgingMedianSec");
  });

  it("ошибка воркера и мусор — не итог", () => {
    expect(parseCheckOutcome({ error: "boom" })).toBeNull();
    expect(parseCheckOutcome(null)).toBeNull();
  });
});

describe("опрос", () => {
  it("раз в 2 с и не дольше 3 минут", () => {
    expect(CHECK_POLL_MS).toBe(2_000);
    expect(CHECK_POLL_LIMIT_MS).toBe(180_000);
  });
});

describe("запросы проверки", () => {
  const view = { checkId: "c1", draftId: "d1", snapshotHash: "h1", status: "queued", report: null, createdAt: "2026-10-25T10:00:00.000Z" };

  it("запуск — POST /drafts/:id/check", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { check: view, reused: false } }));
    const result = await startCheck(new AdminApi(fetch), "d1");
    expect(result.ok && result.data.check.checkId).toBe("c1");
    expect(calls[0]?.url).toContain("/content/drafts/d1/check");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("статус — GET /checks/:id", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { ...view, status: "done" } }));
    const result = await fetchCheck(new AdminApi(fetch), "c1");
    expect(result.ok && result.data.status).toBe("done");
    expect(calls[0]?.url).toContain("/content/checks/c1");
  });
});
