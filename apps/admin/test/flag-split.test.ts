import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { MIN_GROUP, fetchFlagSplit, meanP, normalCdf, proportionP, splitMetrics, verdictOf, type SplitGroup } from "../src/api/flag-split";
import { fakeFetch, json } from "./helpers";

/**
 * Доля флага против остальных (docs/35-stage4-plan.md WP12, часть 10b):
 * вывод у каждой строки — надёжна ли разница, не шум ли она, хватает ли
 * игроков. Числа в проверках — из учебников: z = 1,96 — 2,5% хвоста.
 */

const moment = (values: readonly number[]) => ({ sum: values.reduce((a, b) => a + b, 0), sumSq: values.reduce((a, b) => a + b * b, 0) });

function group(patch: Partial<SplitGroup> = {}): SplitGroup {
  return {
    players: 100,
    d1Eligible: 100,
    d1Returned: 40,
    d7Eligible: 80,
    d7Returned: 16,
    payers: 5,
    stars: { sum: 500, sumSq: 50_000 },
    runs: { sum: 600, sumSq: 5_000 },
    interstitials: { sum: 0, sumSq: 0 },
    rewarded: { sum: 200, sumSq: 600 },
    ...patch,
  };
}

describe("доля флага против остальных", () => {
  it("нормальное распределение: середина, 1,96 и хвосты — как в таблице", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normalCdf(5)).toBeCloseTo(1, 5);
  });

  it("доли: одинаковые — не отличить; 30% против 60% на сотне — надёжно; пустая доля — сравнивать не с чем", () => {
    expect(proportionP(50, 100, 50, 100)).toBeCloseTo(1, 6);
    expect(proportionP(30, 100, 60, 100)).toBeLessThan(0.001);
    expect(proportionP(0, 50, 0, 70)).toBe(1);
    expect(proportionP(5, 0, 5, 10)).toBeNull();
    // 45% против 50% на сотне — обычная случайность.
    expect(proportionP(45, 100, 50, 100)).toBeGreaterThan(0.4);
  });

  it("средние: равные — не отличить, сдвиг на две «сигмы» — надёжно, один игрок — сравнивать не с чем", () => {
    const flat = Array.from({ length: 50 }, (_, index) => index % 2);
    expect(meanP(moment(flat), 50, moment(flat), 50)).toBeCloseTo(1, 6);
    const higher = flat.map((value) => value + 1);
    expect(meanP(moment(higher), 50, moment(flat), 50)).toBeLessThan(0.001);
    expect(meanP(moment([3]), 1, moment(flat), 50)).toBeNull();
    // Разброса нет ни у кого: разные средние — разница точно есть.
    expect(meanP(moment([2, 2]), 2, moment([1, 1]), 2)).toBe(0);
  });

  it("вывод: меньше 30 в любой доле — мало данных; дальше — порог 5%", () => {
    expect(verdictOf(0.001, MIN_GROUP - 1, 500)).toBe("few");
    expect(verdictOf(0.001, MIN_GROUP, MIN_GROUP)).toBe("reliable");
    expect(verdictOf(0.2, 100, 900)).toBe("noise");
    expect(verdictOf(null, 100, 100)).toBe("few");
  });

  it("строки: доля игроков от всех, проценты возвратов, разница со знаком и вывод", () => {
    const rows = splitMetrics(group({ players: 100, d1Returned: 30 }), group({ players: 900, d1Eligible: 900, d1Returned: 540 }));
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("players")).toMatchObject({ share: { value: "100", detail: "10,0% от всех" }, verdict: null });
    expect(byKey.get("d1")).toMatchObject({ share: { value: "30,0%", detail: "30 из 100" }, rest: { value: "60,0%" }, diff: "−30,0 п.п.", verdict: "reliable" });
    expect(rows.map((row) => row.key)).toEqual(["players", "d1", "d7", "payers", "stars", "runs", "interstitials", "rewarded"]);
  });

  it("D7 ещё не созрел — прочерк с объяснением и «мало данных», а не ноль процентов", () => {
    const rows = splitMetrics(group({ d7Eligible: 0, d7Returned: 0 }), group({ d7Eligible: 0, d7Returned: 0 }));
    expect(rows.find((row) => row.key === "d7")).toMatchObject({ share: { value: "—", detail: "рано: нужна неделя" }, diff: null, verdict: "few" });
  });

  it("средние: разница в единицах и процентах; без права на доход строки звёзд нет", () => {
    const rows = splitMetrics(group({ interstitials: { sum: 150, sumSq: 300 } }), group({ stars: null }));
    expect(rows.some((row) => row.key === "stars")).toBe(false);
    expect(rows.find((row) => row.key === "interstitials")).toMatchObject({ share: { value: "1,5", detail: "всего 150 показов" }, rest: { value: "0" }, diff: "+1,5" });
    const runs = splitMetrics(group({ runs: { sum: 540, sumSq: 4_000 } }), group()).find((row) => row.key === "runs");
    expect(runs?.diff).toBe("−0,6 (−10%)");
  });

  it("запрос — флаг и период; флаг не выбран — сервер возьмёт межстраничную", async () => {
    const empty = { flags: [], flag: null, from: null, to: null, split: null };
    const { fetch, calls } = fakeFetch(json(200, { data: empty }), json(200, { data: empty }));
    const api = new AdminApi(fetch);
    expect((await fetchFlagSplit(api, null, {})).ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/v1/admin/funnel/flag-split");
    await fetchFlagSplit(api, "ads.interstitial", { from: "2026-10-01T00:00:00.000Z" });
    expect(calls[1]?.url).toBe("/api/v1/admin/funnel/flag-split?flag=ads.interstitial&from=2026-10-01T00%3A00%3A00.000Z");
  });
});
