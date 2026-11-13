import { describe, expect, it } from "vitest";
import { mergeAdditions } from "../src/modules/content/content-merge.js";
import { publishBlockReason } from "../src/modules/content/content-publish-rules.js";
import type { ContentCheckRecord } from "../src/modules/content/content.repository.js";

/**
 * Чистые правила публикации контента (tasks/T-0306): когда проверка годится
 * для публикации и как «Взять из кода» дописывает в черновик новое. Без базы —
 * живая база и маршруты в `content-publish.integration.test.ts`.
 */

const bounds = { min: 150, max: 480 };
function line(verdict: "in" | "below" | "above" | null, title = "Уклоняющийся бот: медиана жизни, с") {
  return {
    id: "dodgingMedianSec",
    title,
    corridor: bounds,
    baseCorridor: bounds,
    draft: verdict === null ? null : { value: 300, verdict },
    base: { value: 300, verdict: "in" },
  };
}

function check(status: ContentCheckRecord["status"], report: unknown, snapshotHash = "h1"): ContentCheckRecord {
  return { checkId: "c1", draftId: "d1", snapshotHash, status, report, createdAt: new Date(0) };
}

function done(overrides: Record<string, unknown> = {}): ContentCheckRecord {
  return check("done", { schemaProblems: [], contentProblems: [], report: { timeout: false, seeds: 20, scenarios: [], corridors: [line("in")] }, elapsedMs: 1, ...overrides });
}

describe("publishBlockReason: можно ли публиковать по проверке", () => {
  it("зелёная проверка того же снимка — можно", () => {
    expect(publishBlockReason({ latest: done(), forSnapshot: done() })).toBeNull();
  });

  it("метрика «у края» — ещё в коридоре: можно; одна «вне коридора» — нельзя, и называется она", () => {
    const edge = done({ report: { timeout: false, seeds: 2, scenarios: [], corridors: [line("in"), line("in")] } });
    expect(publishBlockReason({ latest: edge, forSnapshot: edge })).toBeNull();
    const out = done({ report: { timeout: false, seeds: 2, scenarios: [], corridors: [line("in"), line("above", "Первый сундук, с")] } });
    expect(publishBlockReason({ latest: out, forSnapshot: out })).toContain("Первый сундук, с");
    const below = done({ report: { timeout: false, seeds: 2, scenarios: [], corridors: [line("below")] } });
    expect(publishBlockReason({ latest: below, forSnapshot: below })).not.toBeNull();
  });

  it("метрика, которую не из чего считать, не мешает, пока есть хоть одна посчитанная", () => {
    const part = done({ report: { timeout: false, seeds: 2, scenarios: [], corridors: [line(null), line("in")] } });
    expect(publishBlockReason({ latest: part, forSnapshot: part })).toBeNull();
    const none = done({ report: { timeout: false, seeds: 2, scenarios: [], corridors: [line(null)] } });
    expect(publishBlockReason({ latest: none, forSnapshot: none })).toContain("метрик");
    const empty = done({ report: { timeout: false, seeds: 2, scenarios: [], corridors: [] } });
    expect(publishBlockReason({ latest: empty, forSnapshot: empty })).toContain("метрик");
  });

  it("проблемы схемы и контента — причина с путём и текстом воркера", () => {
    const schema = done({ schemaProblems: [{ path: "enemies.0.hp", message: "должно быть больше 0" }] });
    expect(publishBlockReason({ latest: schema, forSnapshot: schema })).toMatch(/enemies\.0\.hp.*должно быть больше 0/);
    const content = done({ contentProblems: [{ path: "timeline", message: "бюджет убывает" }, { path: "enemies", message: "второе" }] });
    const reason = publishBlockReason({ latest: content, forSnapshot: content }) ?? "";
    expect(reason).toContain("бюджет убывает");
    expect(reason).toContain("ещё 1");
  });

  it("отчёт без симуляции и отчёт с таймаутом — нельзя", () => {
    const noReport = done({ report: null });
    expect(publishBlockReason({ latest: noReport, forSnapshot: noReport })).toContain("симуляц");
    const timeout = done({ report: { timeout: true, seeds: 2, scenarios: [], corridors: [line("in")] } });
    expect(publishBlockReason({ latest: timeout, forSnapshot: timeout })).toContain("предел времени");
    const byStatus = check("timeout", { schemaProblems: [], contentProblems: [], report: { timeout: true, seeds: 2, scenarios: [], corridors: [] } });
    expect(publishBlockReason({ latest: byStatus, forSnapshot: byStatus })).toContain("предел времени");
  });

  it("проверки по этому снимку нет: не было вовсе или черновик менялся после неё", () => {
    expect(publishBlockReason({ latest: null, forSnapshot: null })).toContain("Проверить");
    expect(publishBlockReason({ latest: done(), forSnapshot: null })).toContain("менялся после проверки");
  });

  it("проверка ещё идёт — ждать; отчёт чужой формы — повторить проверку, а не публиковать", () => {
    const waiting = check("queued", null);
    expect(publishBlockReason({ latest: waiting, forSnapshot: waiting })).toContain("идёт");
    const garbage = check("done", { error: "сбой" });
    expect(publishBlockReason({ latest: garbage, forSnapshot: garbage })).toContain("не разобрался");
    const nothing = check("done", null);
    expect(publishBlockReason({ latest: nothing, forSnapshot: nothing })).toContain("не разобрался");
  });
});

describe("mergeAdditions: «Взять из кода» только добавляет", () => {
  it("новые поля объекта добавляются, значения существующих не меняются", () => {
    const result = mergeAdditions({ hp: 7, speed: 3 }, { hp: 999, speed: 1, size: 1.5, nested: { a: 1 } });
    expect(result.merged).toEqual({ hp: 7, speed: 3, size: 1.5, nested: { a: 1 } });
    expect(result.added).toBe(2);
  });

  it("элементы списка с id: новые добавляются в конец, существующие сливаются по id, порядок и значения целы", () => {
    const target = { enemies: [{ id: "b", hp: 5 }, { id: "a", hp: 1 }] };
    const source = { enemies: [{ id: "a", hp: 100, size: 2 }, { id: "c", hp: 9 }, { id: "b", hp: 50 }] };
    const result = mergeAdditions(target, source);
    expect(result.merged).toEqual({ enemies: [{ id: "b", hp: 5 }, { id: "a", hp: 1, size: 2 }, { id: "c", hp: 9 }] });
    expect(result.added).toBe(2);
  });

  it("список без id сливается по позиции: новые поля внутрь, длина и значения те же", () => {
    const result = mergeAdditions({ levels: [{ damage: 1 }, { damage: 2 }] }, { levels: [{ damage: 10, status: 0.1 }, { damage: 20 }, { damage: 30 }] });
    expect(result.merged).toEqual({ levels: [{ damage: 1, status: 0.1 }, { damage: 2 }] });
    expect(result.added).toBe(1);
  });

  it("списки чисел, типы, не совпавшие с кодом, и null остаются как в черновике", () => {
    const target = { a: [1, 2], b: 5, c: null, d: { x: 1 }, e: "text" };
    const source = { a: [1, 2, 3], b: { y: 2 }, c: { z: 1 }, d: [1], e: "other" };
    const result = mergeAdditions(target, source);
    expect(result.merged).toEqual(target);
    expect(result.added).toBe(0);
  });

  it("исходные значения не меняются на месте, добавленное — копия, а не общая ссылка", () => {
    const target = { list: [{ id: "a" }] };
    const added = { id: "n", inner: { k: 1 } };
    const source = { list: [{ id: "a" }, added] };
    const before = JSON.stringify(target);
    const result = mergeAdditions(target, source);
    expect(JSON.stringify(target)).toBe(before);
    (result.merged as { list: { inner?: { k: number } }[] }).list[1]!.inner!.k = 99;
    expect(added.inner.k).toBe(1);
  });

  it("ключ __proto__ из кода не меняет прототип", () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as unknown;
    const result = mergeAdditions({}, source);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result.merged)).toBe(Object.prototype);
    expect((result.merged as { ok: number }).ok).toBe(1);
  });
});
