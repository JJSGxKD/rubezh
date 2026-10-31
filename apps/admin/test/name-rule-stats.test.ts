import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import type { NameRule } from "../src/api/name-rules";
import {
  STATS_WINDOWS,
  fetchStats,
  lastHitText,
  sortRules,
  statsById,
  statsViewSchema,
  topRules,
  trackedNote,
  unusedRules,
  type NameRuleStats,
} from "../src/api/name-rule-stats";
import { fakeFetch, json } from "./helpers";

// Статистика срабатываний правил фильтра имён в панели (tasks/T-0340): слой API
// с Zod на границе и чистые функции блока «Что срабатывает» — топ, «не
// срабатывали», подпись «последний раз», оговорка про начало учёта, сортировка.

const TODAY = new Date("2026-10-30T12:00:00Z");

const IDS = Array.from({ length: 7 }, (_, index) => `00000000-0000-4000-8000-00000000000${String(index + 1)}`);

function rule(index: number, patch: Partial<NameRule> = {}): NameRule {
  return {
    ruleId: IDS[index] ?? "",
    category: "brand",
    kind: "exact",
    pattern: `пример-${String(index)}`,
    active: true,
    note: null,
    updatedAt: `2026-10-${String(10 + index)}T10:00:00.000Z`,
    updatedBy: null,
    ...patch,
  };
}

function stats(rows: { index: number; hits: number; lastDay?: string | null }[], patch: Partial<NameRuleStats> = {}): NameRuleStats {
  const rules = rows.map((row) => ({ ruleId: IDS[row.index] ?? "", hits: row.hits, lastDay: row.lastDay ?? (row.hits > 0 ? "2026-10-29" : null) }));
  return { days: 30, since: "2026-10-01", trackedSince: "2026-09-01", totalHits: rules.reduce((sum, item) => sum + item.hits, 0), rules, ...patch };
}

describe("слой API статистики", () => {
  it("окна — 7, 30 и 90 суток", () => {
    expect([...STATS_WINDOWS]).toEqual([7, 30, 90]);
  });

  it("fetchStats: адрес с окном, ответ разобран схемой", async () => {
    const body = stats([{ index: 0, hits: 4 }, { index: 1, hits: 0 }]);
    const { fetch, calls } = fakeFetch(json(200, { data: body }), json(200, { data: { days: 30 } }));
    const api = new AdminApi(fetch);

    const answer = await fetchStats(api, 7);
    expect(calls[0]?.url).toBe("/api/v1/admin/name-rules/stats?days=7");
    expect(answer.ok && answer.data.rules).toHaveLength(2);
    expect(answer.ok && answer.data.totalHits).toBe(4);

    // Ответ без обязательных полей — ошибка разбора, а не пустая таблица.
    expect((await fetchStats(api, 30)).ok).toBe(false);
    expect(statsViewSchema.safeParse(body).success).toBe(true);
    expect(statsViewSchema.safeParse({ ...body, rules: [{ ruleId: "a", hits: "много", lastDay: null }] }).success).toBe(false);
  });

  it("statsById: правило → число за окно и последний день", () => {
    const view = stats([{ index: 0, hits: 4, lastDay: "2026-10-29" }, { index: 1, hits: 0, lastDay: "2026-08-01" }, { index: 2, hits: 0, lastDay: null }]);
    const byId = statsById(view);
    expect(byId.get(IDS[0] ?? "")).toEqual({ hits: 4, lastDay: "2026-10-29" });
    expect(byId.get(IDS[1] ?? "")).toEqual({ hits: 0, lastDay: "2026-08-01" });
    expect(byId.get(IDS[2] ?? "")).toEqual({ hits: 0, lastDay: null });
    expect(byId.get("нет")).toBeUndefined();
  });
});

describe("топ и «не срабатывали»", () => {
  const rules = [rule(0), rule(1), rule(2), rule(3), rule(4), rule(5), rule(6)];

  it("topRules: только с hits > 0, по убыванию, при равенстве — по шаблону; пять по умолчанию", () => {
    const view = stats([
      { index: 0, hits: 5 },
      { index: 1, hits: 9 },
      { index: 2, hits: 5 },
      { index: 3, hits: 1 },
      { index: 4, hits: 2 },
      { index: 5, hits: 3 },
      { index: 6, hits: 0 },
    ]);
    const top = topRules(rules, view);
    expect(top.map((item) => item.rule.pattern)).toEqual(["пример-1", "пример-0", "пример-2", "пример-5", "пример-4"]);
    expect(top.map((item) => item.hits)).toEqual([9, 5, 5, 3, 2]);
    expect(topRules(rules, view, 2)).toHaveLength(2);
  });

  it("topRules: нет срабатываний — пусто; правило без данных в ответе не падает", () => {
    expect(topRules(rules, stats([{ index: 0, hits: 0 }]))).toEqual([]);
    expect(topRules(rules, stats([]))).toEqual([]);
  });

  it("unusedRules: действующие с hits === 0; выключенные «лишними» не считаются", () => {
    const list = [rule(0), rule(1, { active: false }), rule(2), rule(3)];
    const view = stats([{ index: 0, hits: 3 }, { index: 1, hits: 0 }, { index: 2, hits: 0 }]);
    // Правило 3 в ответе нет — сервер ещё не знает о нём (создано только что): счёт нулевой, оно «не срабатывало».
    expect(unusedRules(list, view).map((item) => item.pattern)).toEqual(["пример-2", "пример-3"]);
  });
});

describe("подписи", () => {
  it("lastHitText: сегодня, вчера, число и месяц, прочерк", () => {
    expect(lastHitText("2026-10-30", TODAY)).toBe("сегодня");
    expect(lastHitText("2026-10-29", TODAY)).toBe("вчера");
    expect(lastHitText("2026-10-12", TODAY)).toMatch(/^12 окт/u);
    expect(lastHitText("2026-03-02", TODAY)).toMatch(/^2 мар/u);
    expect(lastHitText(null, TODAY)).toBe("—");
  });

  it("lastHitText: сутки считаются по UTC, а не по часам браузера", () => {
    const lateEvening = new Date("2026-10-30T23:30:00Z");
    expect(lastHitText("2026-10-30", lateEvening)).toBe("сегодня");
    expect(lastHitText("2026-10-29", lateEvening)).toBe("вчера");
  });

  it("trackedNote: учёт с даты, если окно раньше учёта; null — учёта ещё нет; окно покрыто — без оговорки", () => {
    expect(trackedNote(stats([], { since: "2026-10-01", trackedSince: "2026-10-20" }), TODAY)).toMatch(/^Учёт ведётся с 20 окт/u);
    expect(trackedNote(stats([], { since: "2026-10-01", trackedSince: "2026-10-20" }), TODAY)).toContain("раньше срабатывания не считались");
    expect(trackedNote(stats([], { since: "2026-10-01", trackedSince: null }), TODAY)).toContain("Учёт");
    expect(trackedNote(stats([], { since: "2026-10-01", trackedSince: "2026-10-01" }), TODAY)).toBeNull();
    expect(trackedNote(stats([], { since: "2026-10-01", trackedSince: "2026-09-01" }), TODAY)).toBeNull();
  });
});

describe("сортировка списка правил", () => {
  const list = [rule(0), rule(1), rule(2), rule(3)];
  const view = stats([{ index: 0, hits: 3 }, { index: 1, hits: 9 }, { index: 2, hits: 3 }, { index: 3, hits: 0 }]);
  const patterns = (rules: readonly NameRule[]) => rules.map((item) => item.pattern);

  it("«недавно изменённые» — по updatedAt по убыванию", () => {
    expect(patterns(sortRules(list, view, "recent"))).toEqual(["пример-3", "пример-2", "пример-1", "пример-0"]);
  });

  it("«чаще срабатывают» и «реже срабатывают»: стабильно — равные остаются в исходном порядке", () => {
    expect(patterns(sortRules(list, view, "most"))).toEqual(["пример-1", "пример-0", "пример-2", "пример-3"]);
    expect(patterns(sortRules(list, view, "least"))).toEqual(["пример-3", "пример-0", "пример-2", "пример-1"]);
  });

  it("вход не меняется; без статистики порядок исходный, у режима «recent» — по дате", () => {
    const copy = [...list];
    sortRules(list, view, "most");
    expect(list).toEqual(copy);
    expect(patterns(sortRules(list, null, "most"))).toEqual(patterns(list));
  });
});
