import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { createSeason, describeReward, draftProblem, draftReward, fetchSeason, fetchSeasons, publishSeason, rewardDraft, ribbonTotals, saveTier, totalsLines, type PassReward, type PassTier } from "../src/api/pass";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Ленты батл-пасса в панели (tasks/T-0313): сумма наград месяца по ресурсам,
// форма ячейки — вид и число — без случайного, запросы — по своим адресам.

const CAPS = { coins: 20_000, gems: 2_000, shard_common: 500, shard_uncommon: 400, shard_rare: 300, shard_epic: 200, shard_legendary: 100, shard_mythic: 50 };

function tiers(patch: (tier: number) => { free: PassReward; vip: PassReward }): PassTier[] {
  return Array.from({ length: 30 }, (_, index) => ({ tier: index + 1, ...patch(index + 1) }));
}

describe("сумма наград месяца", () => {
  it("считает монеты, самоцветы, осколки по редкостям и бусты — отдельно по лентам и вместе", () => {
    const ribbon = tiers((tier) => ({
      free: tier === 1 ? { coins: 100, shards: { common: 5 }, boost: { id: "fury", count: 1 } } : tier === 2 ? { coins: 150, shards: { common: 5, uncommon: 3 }, boost: { id: "fury", count: 2 } } : { coins: 10 },
      vip: tier % 10 === 0 ? { gems: 10, shards: { epic: 1 } } : { shards: { rare: 2 } },
    }));
    const totals = ribbonTotals(ribbon);
    expect(totals.free.coins).toBe(100 + 150 + 28 * 10);
    expect(totals.free.shards).toEqual({ common: 10, uncommon: 3 });
    expect(totals.free.boosts).toEqual({ fury: 3 });
    expect(totals.vip.gems).toBe(30);
    expect(totals.vip.shards).toEqual({ epic: 3, rare: 54 });
    expect(totals.total.coins).toBe(totals.free.coins);
    expect(totals.total.shards).toEqual({ common: 10, uncommon: 3, rare: 54, epic: 3 });
  });

  it("строки для таблицы — только то, что есть, в порядке «монеты, самоцветы, осколки от обычных к мифическим, бусты»", () => {
    const ribbon = tiers(() => ({ free: { coins: 10, shards: { rare: 1 } }, vip: { gems: 2, shards: { common: 1 }, boost: { id: "aegis", count: 1 } } }));
    expect(totalsLines(ribbonTotals(ribbon).total).map((line) => `${line.title}: ${String(line.amount)}`)).toEqual([
      "Монеты: 300",
      "Самоцветы: 60",
      "Обычные осколки: 30",
      "Редкие осколки: 30",
      "Буст «aegis»: 30",
    ]);
    expect(totalsLines(ribbonTotals(tiers(() => ({ free: { coins: 1 }, vip: { coins: 1 } }))).total)).toEqual([{ key: "coins", title: "Монеты", amount: 60 }]);
  });
});

describe("ячейка награды", () => {
  it("подпись ячейки — все виды награды через точку; пустая — тире", () => {
    expect(describeReward({ coins: 100, gems: 5, shards: { common: 5, epic: 1 }, boost: { id: "fury", count: 2 } })).toBe("100 монет · 5 самоцветов · осколки: обычные 5, эпические 1 · буст «fury» ×2");
    expect(describeReward({})).toBe("—");
  });

  it("форма и награда превращаются друг в друга: пустое и ноль — «нет», числа — целые", () => {
    const reward: PassReward = { coins: 120, shards: { rare: 3 }, boost: { id: "fury", count: 1 } };
    const draft = rewardDraft(reward);
    expect(draft).toMatchObject({ coins: "120", gems: "", rare: "3", common: "", boostId: "fury", boostCount: "1" });
    expect(draftReward(draft)).toEqual(reward);
    expect(draftReward({ ...draft, coins: "0", boostId: "", boostCount: "" })).toEqual({ shards: { rare: 3 } });
  });

  it("форма не пропускает пустую награду, дробное и больше потолка кошелька; буст — только с числом", () => {
    const empty = rewardDraft({});
    expect(draftProblem(empty, CAPS, ["fury"])).toMatch(/ничего нет/);
    expect(draftProblem({ ...empty, coins: "1,5" }, CAPS, ["fury"])).toMatch(/Монеты/);
    expect(draftProblem({ ...empty, coins: "20001" }, CAPS, ["fury"])).toMatch(/не больше 20000/);
    expect(draftProblem({ ...empty, gems: "-1" }, CAPS, ["fury"])).toMatch(/Самоцветы/);
    expect(draftProblem({ ...empty, coins: "5", boostId: "fury", boostCount: "" }, CAPS, ["fury"])).toMatch(/Буст/);
    expect(draftProblem({ ...empty, coins: "5", boostId: "ghost", boostCount: "1" }, CAPS, ["fury"])).toMatch(/Буст/);
    expect(draftProblem({ ...empty, coins: "5", boostId: "fury", boostCount: "1" }, CAPS, ["fury"])).toBeNull();
    expect(draftProblem({ ...empty, mythic: "51" }, CAPS, [])).toMatch(/мифических/);
  });
});

describe("запросы раздела", () => {
  const view = (patch: Record<string, unknown> = {}) => ({
    monthKey: "2026-12",
    phase: "future",
    saved: true,
    published: false,
    publishedAt: null,
    pointsPerTier: 100,
    lockedTiers: 0,
    tiers: tiers(() => ({ free: { coins: 10 }, vip: { gems: 1 } })),
    caps: CAPS,
    boosts: ["fury", "aegis"],
    ...patch,
  });

  it("список, месяц, создание, правка ступени и публикация — по своим адресам", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { currentMonth: "2026-11", nextMonth: "2026-12", months: [{ monthKey: "2026-11", phase: "current", saved: false, published: false }] } }),
      json(200, { data: view() }),
      json(201, { data: view() }),
      json(200, { data: view() }),
      json(200, { data: view({ published: true }) }),
    );
    const api = new AdminApi(fetch);
    const list = await fetchSeasons(api);
    expect(list.ok && list.data.months[0]?.phase).toBe("current");
    expect(calls[0]?.url).toBe("/api/v1/admin/pass/seasons");

    await fetchSeason(api, "2026-12");
    expect(calls[1]?.url).toBe("/api/v1/admin/pass/seasons/2026-12");

    await createSeason(api, "2026-12", "2026-11");
    expect(calls[2]).toMatchObject({ url: "/api/v1/admin/pass/seasons", init: { method: "POST" } });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ month: "2026-12", from: "2026-11" });

    await saveTier(api, "2026-12", 5, { free: { coins: 50 }, vip: { gems: 3 } });
    expect(calls[3]).toMatchObject({ url: "/api/v1/admin/pass/seasons/2026-12/tiers/5", init: { method: "PUT" } });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ free: { coins: 50 }, vip: { gems: 3 } });

    const published = await publishSeason(api, "2026-12");
    expect(calls[4]).toMatchObject({ url: "/api/v1/admin/pass/seasons/2026-12/publish", init: { method: "POST" } });
    expect(published.ok && published.data.published).toBe(true);
  });

  it("создание без источника не шлёт from", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: view() }));
    await createSeason(new AdminApi(fetch), "2026-12", null);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ month: "2026-12" });
  });

  it("409 сервера — «Эту ступень уже прошли игроки» — доходит до экрана как отклонение с текстом", async () => {
    const { fetch } = fakeFetch(json(409, { error: { code: "pass_tier_passed", message: "Эту ступень уже прошли игроки" } }));
    const result = await saveTier(new AdminApi(fetch), "2026-11", 5, { free: { coins: 5 }, vip: { gems: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("Эту ступень уже прошли игроки");
  });

  it("раздел — под правом pass.edit, рядом с заданиями", () => {
    expect(SECTIONS.find((section) => section.id === "pass")?.permission).toBe("pass.edit");
  });
});
