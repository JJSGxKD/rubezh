import { describe, expect, it } from "vitest";
import { POOL_QUOTA, gameDayOf, gameWeekStartOf, inPlay, pickPool } from "../src/modules/tasks/task-pool.js";
import type { PoolTier, TaskDef } from "../src/modules/tasks/task-rules.js";

/**
 * Ротация заданий (docs/39-retention-mechanics.md П1, T-0104): набор дня и
 * недели считает чистая функция от даты и пула — без записи в базу, одинаково
 * у всех игроков и на всех репликах.
 */

function row(taskId: string, patch: Partial<TaskDef> = {}): TaskDef {
  return {
    taskId,
    period: "daily",
    kind: "runs",
    params: null,
    filter: null,
    tier: null,
    target: 3,
    title: null,
    coins: 100,
    gems: 0,
    shards: 0,
    passPoints: 0,
    sort: 0,
    active: true,
    limit: null,
    image: null,
    ...patch,
  };
}

/** Пул из строк по ступеням: `daily_easy_1`, `daily_easy_2`… */
function pool(period: "daily" | "weekly", sizes: Record<PoolTier, number>): TaskDef[] {
  const defs: TaskDef[] = [];
  for (const tier of ["easy", "medium", "hard"] as const) {
    for (let index = 1; index <= sizes[tier]; index++) defs.push(row(`${period}_${tier}_${String(index)}`, { period, tier }));
  }
  return defs;
}

const DAILY = pool("daily", { easy: 8, medium: 8, hard: 4 });
const WEEKLY = pool("weekly", { easy: 4, medium: 5, hard: 3 });

/** `YYYY-MM-DD` через `days` суток после `2026-10-01`. */
function dayAfter(days: number): string {
  return new Date(Date.UTC(2026, 9, 1 + days)).toISOString().slice(0, 10);
}

function tiersOf(defs: readonly TaskDef[], ids: ReadonlySet<string>): Record<PoolTier, number> {
  const result: Record<PoolTier, number> = { easy: 0, medium: 0, hard: 0 };
  for (const def of defs) if (ids.has(def.taskId) && def.tier !== null) result[def.tier]++;
  return result;
}

describe("игровые сутки и неделя", () => {
  it("сутки меняются в полночь по Москве (21:00 UTC)", () => {
    expect(gameDayOf(new Date("2026-10-13T20:59:59Z"))).toBe("2026-10-13");
    expect(gameDayOf(new Date("2026-10-13T21:00:00Z"))).toBe("2026-10-14");
  });

  it("неделя начинается с понедельника по Москве", () => {
    expect(gameWeekStartOf(new Date("2026-10-18T20:59:59Z"))).toBe("2026-10-12");
    expect(gameWeekStartOf(new Date("2026-10-18T21:00:00Z"))).toBe("2026-10-19");
    expect(gameWeekStartOf(new Date("2026-10-14T09:00:00Z"))).toBe("2026-10-12");
  });
});

describe("набор из пула", () => {
  it("день — пять заданий по 2/2/1, неделя — шесть по 2/3/1", () => {
    expect(POOL_QUOTA).toEqual({ daily: { easy: 2, medium: 2, hard: 1 }, weekly: { easy: 2, medium: 3, hard: 1 } });
    const day = pickPool(DAILY, "daily", "2026-10-14");
    expect(day.size).toBe(5);
    expect(tiersOf(DAILY, day)).toEqual({ easy: 2, medium: 2, hard: 1 });
    const week = pickPool(WEEKLY, "weekly", "2026-10-12");
    expect(week.size).toBe(6);
    expect(tiersOf(WEEKLY, week)).toEqual({ easy: 2, medium: 3, hard: 1 });
  });

  it("одинаков при тех же данных и не зависит от порядка строк на входе", () => {
    const first = pickPool(DAILY, "daily", "2026-10-14");
    expect([...pickPool(DAILY, "daily", "2026-10-14")].sort()).toEqual([...first].sort());
    expect([...pickPool([...DAILY].reverse(), "daily", "2026-10-14")].sort()).toEqual([...first].sort());
    const rotated = [...DAILY.slice(7), ...DAILY.slice(0, 7)];
    expect([...pickPool(rotated, "daily", "2026-10-14")].sort()).toEqual([...first].sort());
  });

  it("за 90 дней побывала каждая из 20 строк, и соседние дни различаются", () => {
    const seen = new Set<string>();
    let differs = false;
    let previous: ReadonlySet<string> | null = null;
    for (let day = 0; day < 90; day++) {
      const picked = pickPool(DAILY, "daily", dayAfter(day));
      for (const id of picked) seen.add(id);
      if (previous !== null && [...picked].some((id) => !previous?.has(id))) differs = true;
      previous = picked;
    }
    expect(seen.size).toBe(20);
    expect(differs).toBe(true);
  });

  it("недельный пул за полгода тоже обходит все 12 строк", () => {
    const seen = new Set<string>();
    for (let week = 0; week < 26; week++) for (const id of pickPool(WEEKLY, "weekly", dayAfter(week * 7))) seen.add(id);
    expect(seen.size).toBe(12);
  });

  it("нет включённых строк ступени — набор всё равно полный, добор из остальных", () => {
    const noHard = DAILY.map((def) => (def.tier === "hard" ? { ...def, active: false } : def));
    for (let day = 0; day < 20; day++) {
      const picked = pickPool(noHard, "daily", dayAfter(day));
      expect(picked.size).toBe(5);
      expect(noHard.filter((def) => picked.has(def.taskId)).every((def) => def.active)).toBe(true);
    }
  });

  it("строк меньше квоты — берётся сколько есть; пул другого срока и строка без ступени в набор не попадают", () => {
    const tiny = [row("daily_a", { tier: "easy" }), row("weekly_a", { period: "weekly", tier: "easy" }), row("always")];
    expect([...pickPool(tiny, "daily", "2026-10-14")]).toEqual(["daily_a"]);
    expect([...pickPool(tiny, "weekly", "2026-10-12")]).toEqual(["weekly_a"]);
    expect(pickPool([], "daily", "2026-10-14").size).toBe(0);
  });

  it("выключенная строка в набор не попадает", () => {
    const off = DAILY.map((def, index) => (index % 2 === 0 ? { ...def, active: false } : def));
    const picked = pickPool(off, "daily", "2026-10-14");
    expect(off.filter((def) => picked.has(def.taskId)).every((def) => def.active)).toBe(true);
  });
});

describe("что в игре", () => {
  it("строки без ступени, достижения и партнёрские видны всегда, невыбранные пула — нет", () => {
    const partner = row("partner_channel", { kind: "channel", target: 1, params: { platform: "telegram", chat: "@x", url: "https://t.me/x" } });
    const achievement = row("ach_runs", { period: "achievement" });
    const manual = row("daily_manual");
    const defs = [...DAILY, ...WEEKLY, partner, achievement, manual];
    const at = new Date("2026-10-14T09:00:00Z");
    const playing = inPlay(defs, at);
    const ids = new Set(playing.map((def) => def.taskId));

    expect(ids.has("partner_channel")).toBe(true);
    expect(ids.has("ach_runs")).toBe(true);
    expect(ids.has("daily_manual")).toBe(true);
    const chosenDaily = pickPool(DAILY, "daily", gameDayOf(at));
    const chosenWeekly = pickPool(WEEKLY, "weekly", gameWeekStartOf(at));
    expect(playing.filter((def) => def.tier !== null && def.period === "daily").map((def) => def.taskId).sort()).toEqual([...chosenDaily].sort());
    expect(playing.filter((def) => def.tier !== null && def.period === "weekly").map((def) => def.taskId).sort()).toEqual([...chosenWeekly].sort());
    expect(playing).toHaveLength(5 + 6 + 3);
  });

  it("за сутки набор дня не меняется, после полуночи по Москве меняется; набор недели держится до понедельника", () => {
    const defs = [...DAILY, ...WEEKLY];
    const idsOf = (period: "daily" | "weekly", at: string) =>
      inPlay(defs, new Date(at))
        .filter((def) => def.period === period)
        .map((def) => def.taskId)
        .sort()
        .join(",");
    expect(idsOf("daily", "2026-10-14T20:59:59Z")).toBe(idsOf("daily", "2026-10-13T21:00:00Z"));
    expect(idsOf("weekly", "2026-10-13T12:00:00Z")).toBe(idsOf("weekly", "2026-10-17T12:00:00Z"));
    // Два соседних дня могут совпасть случайно; за две недели наборы различаются.
    const days = new Set(Array.from({ length: 14 }, (_, index) => idsOf("daily", `${dayAfter(index)}T12:00:00Z`)));
    expect(days.size).toBeGreaterThan(1);
  });
});
