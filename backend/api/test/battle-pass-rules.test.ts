import { describe, expect, it } from "vitest";
import { BOOST_IDS } from "../src/modules/boosts/boost-catalog.js";
import { DEFAULT_RIBBON } from "../src/modules/battle-pass/pass-defaults.js";
import {
  PASS_LANES,
  PASS_TIERS,
  claimBlock,
  claimKey,
  monthBounds,
  monthKeyOf,
  passRewardSchema,
  passRibbonSchema,
  passViewOf,
  rewardLines,
  tierOf,
  type PassReward,
  type PassTierDef,
} from "../src/modules/battle-pass/pass-rules.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import { EARN_REASONS, WALLET_RESOURCES, type WalletResource } from "../src/modules/wallet/wallet-types.js";

/**
 * Чистые правила батл-пасса (docs/35-stage4-plan.md Р46, §3.15; tasks/T-0311):
 * месяц по Москве, ступень по очкам, схема награды и лента по умолчанию.
 * Базы и сети здесь нет.
 */

describe("месяц пасса — по Москве, UTC+3 без перехода на летнее время", () => {
  it("31 октября 20:59:59 UTC — ещё октябрь, 21:00:00 UTC — уже ноябрь", () => {
    expect(monthKeyOf(new Date("2026-10-31T20:59:59.999Z"))).toBe("2026-10");
    expect(monthKeyOf(new Date("2026-10-31T21:00:00.000Z"))).toBe("2026-11");
  });

  it("граница года: 31 декабря 21:00 UTC — январь следующего года", () => {
    expect(monthKeyOf(new Date("2026-12-31T20:59:59.999Z"))).toBe("2026-12");
    expect(monthKeyOf(new Date("2026-12-31T21:00:00.000Z"))).toBe("2027-01");
  });

  it("летом сдвиг тот же: 30 июня 21:00 UTC — июль", () => {
    expect(monthKeyOf(new Date("2026-06-30T20:59:59.999Z"))).toBe("2026-06");
    expect(monthKeyOf(new Date("2026-06-30T21:00:00.000Z"))).toBe("2026-07");
  });

  it("високосный февраль: 29 февраля 2028 по Москве ещё февраль", () => {
    expect(monthKeyOf(new Date("2028-02-29T20:59:59.999Z"))).toBe("2028-02");
    expect(monthKeyOf(new Date("2028-02-29T21:00:00.000Z"))).toBe("2028-03");
  });

  it("границы месяца в UTC: ноябрь 2026 идёт с 31.10 21:00 до 30.11 21:00", () => {
    const bounds = monthBounds("2026-11");
    expect(bounds.startsAt.toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(bounds.endsAt.toISOString()).toBe("2026-11-30T21:00:00.000Z");
  });

  it("границы декабря заходят в следующий год", () => {
    expect(monthBounds("2026-12").endsAt.toISOString()).toBe("2026-12-31T21:00:00.000Z");
    expect(monthBounds("2027-01").startsAt.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });

  it("месяц момента лежит в своих границах, а конец — начало следующего", () => {
    const at = new Date("2026-11-15T12:00:00Z");
    const bounds = monthBounds(monthKeyOf(at));
    expect(bounds.startsAt.getTime()).toBeLessThanOrEqual(at.getTime());
    expect(at.getTime()).toBeLessThan(bounds.endsAt.getTime());
    expect(monthKeyOf(bounds.endsAt)).toBe("2026-12");
  });

  it("кривой ключ месяца — ошибка, а не молчаливый ноль", () => {
    for (const key of ["2026-13", "2026-00", "26-11", "2026-1", "2026/11", ""]) expect(() => monthBounds(key), key).toThrow();
  });
});

describe("ступень по очкам", () => {
  it("250 очков при 100 на ступень — вторая", () => {
    expect(tierOf(250, 100)).toBe(2);
  });

  it("ровно на пороге — ступень взята, на единицу ниже — нет", () => {
    expect(tierOf(99, 100)).toBe(0);
    expect(tierOf(100, 100)).toBe(1);
    expect(tierOf(2_999, 100)).toBe(29);
    expect(tierOf(3_000, 100)).toBe(30);
  });

  it("4 000 очков — потолок в 30 ступеней, очки сверх копятся, но ступеней не дают", () => {
    expect(tierOf(4_000, 100)).toBe(30);
    expect(tierOf(2_000_000_000, 100)).toBe(30);
  });

  it("ноль очков — нулевая ступень; шаг в настройке меняет ступень", () => {
    expect(tierOf(0, 100)).toBe(0);
    expect(tierOf(250, 50)).toBe(5);
    expect(tierOf(250, 1_000)).toBe(0);
  });

  it("шаг не больше нуля — ошибка настройки, а не деление на ноль", () => {
    expect(() => tierOf(10, 0)).toThrow();
    expect(() => tierOf(10, -5)).toThrow();
    expect(() => tierOf(10, 1.5)).toThrow();
  });
});

describe("награда ступени: схема без случайного и без обликов", () => {
  it("принимает монеты, самоцветы, осколки по редкостям и буст", () => {
    const reward = { coins: 100, gems: 10, shards: { common: 5, epic: 1 }, boost: { id: "fury", count: 1 } };
    expect(passRewardSchema.parse(reward)).toEqual(reward);
  });

  it("поля облика нет до T-0315: лишнее поле отвергается, а не молча теряется", () => {
    expect(passRewardSchema.safeParse({ coins: 10, appearance: { id: "x" } }).success).toBe(false);
  });

  it("пустая награда — ошибка: ступень без награды игроку не нужна", () => {
    expect(passRewardSchema.safeParse({}).success).toBe(false);
    expect(passRewardSchema.safeParse({ shards: {} }).success).toBe(false);
  });

  it("отрицательное, дробное и нулевое количество отвергается", () => {
    for (const reward of [{ coins: -1 }, { coins: 0 }, { coins: 1.5 }, { gems: -5 }, { shards: { common: 0 } }, { shards: { common: 2.5 } }, { boost: { id: "fury", count: 0 } }]) {
      expect(passRewardSchema.safeParse(reward).success, JSON.stringify(reward)).toBe(false);
    }
  });

  it("незнакомая редкость осколка и незнакомый буст отвергаются: выдавать нечего", () => {
    expect(passRewardSchema.safeParse({ shards: { shiny: 1 } }).success).toBe(false);
    expect(passRewardSchema.safeParse({ boost: { id: "no_such_boost", count: 1 } }).success).toBe(false);
  });

  it("опечатка в панели не пройдёт: больше суточного потолка кошелька за одну награду нельзя", () => {
    const cap = WALLET_DAILY_CAPS.pass_reward.coins ?? 0;
    expect(passRewardSchema.safeParse({ coins: cap }).success).toBe(true);
    expect(passRewardSchema.safeParse({ coins: cap + 1 }).success).toBe(false);
  });

  it("строки кошелька: только ненулевое, осколки — ресурсами shard_<редкость>, буст в кошелёк не идёт", () => {
    const reward: PassReward = { coins: 100, shards: { uncommon: 3, common: 5 }, boost: { id: "fury", count: 1 } };
    expect(rewardLines(reward)).toEqual([
      { resource: "coins", amount: 100 },
      { resource: "shard_common", amount: 5 },
      { resource: "shard_uncommon", amount: 3 },
    ]);
    expect(rewardLines({ boost: { id: "fury", count: 1 } })).toEqual([]);
  });
});

describe("лента по умолчанию — работает, даже если ленту месяца не завели", () => {
  const ribbon: readonly PassTierDef[] = DEFAULT_RIBBON;

  it("проходит схему ленты и состоит из 30 ступеней подряд", () => {
    expect(passRibbonSchema.safeParse(ribbon).success).toBe(true);
    expect(ribbon).toHaveLength(PASS_TIERS);
    expect(ribbon.map((tier) => tier.tier)).toEqual(Array.from({ length: PASS_TIERS }, (_, index) => index + 1));
  });

  it("обликов нет: ни у одной награды, ни у одной ленты", () => {
    expect(JSON.stringify(ribbon)).not.toContain("appearance");
  });

  it("бесплатная лента: монеты растут лесенкой от 100 до 600 на каждой ступени", () => {
    const coins = ribbon.map((tier) => tier.free.coins ?? 0);
    expect(coins[0]).toBe(100);
    expect(coins[PASS_TIERS - 1]).toBe(600);
    for (let index = 1; index < coins.length; index++) expect(coins[index], `ступень ${String(index + 1)}`).toBeGreaterThanOrEqual(coins[index - 1] ?? 0);
  });

  it("в бесплатной ленте есть обычные и добротные осколки и бусты на 5-й, 15-й и 25-й — только они", () => {
    const withBoost = ribbon.filter((tier) => tier.free.boost !== undefined).map((tier) => tier.tier);
    expect(withBoost).toEqual([5, 15, 25]);
    expect(ribbon.some((tier) => (tier.free.shards?.common ?? 0) > 0)).toBe(true);
    expect(ribbon.some((tier) => (tier.free.shards?.uncommon ?? 0) > 0)).toBe(true);
    for (const tier of ribbon) if (tier.free.boost !== undefined) expect(BOOST_IDS, tier.free.boost.id).toContain(tier.free.boost.id);
  });

  it("VIP-лента: самоцветы от 10 до 40, редкие и эпические осколки, эпический осколок на 30-й", () => {
    const gems = ribbon.map((tier) => tier.vip.gems ?? 0).filter((value) => value > 0);
    expect(Math.min(...gems)).toBe(10);
    expect(Math.max(...gems)).toBe(40);
    expect(ribbon.some((tier) => (tier.vip.shards?.rare ?? 0) > 0)).toBe(true);
    expect(ribbon.some((tier) => (tier.vip.shards?.epic ?? 0) > 0)).toBe(true);
    expect(ribbon[PASS_TIERS - 1]?.vip.shards?.epic ?? 0).toBeGreaterThan(0);
  });

  it("на VIP-ленте нет монет и бустов, на бесплатной — самоцветов: ленты не размываются", () => {
    for (const tier of ribbon) {
      expect(tier.free.gems, `free ${String(tier.tier)}`).toBeUndefined();
      expect(tier.vip.coins, `vip ${String(tier.tier)}`).toBeUndefined();
    }
  });

  it("суточный потолок pass_reward — ровно вдвое от суммы обеих лент по умолчанию, ресурса сверх ленты в нём нет", () => {
    const sums = new Map<WalletResource, number>();
    for (const tier of ribbon) {
      for (const lane of PASS_LANES) {
        for (const line of rewardLines(tier[lane])) sums.set(line.resource, (sums.get(line.resource) ?? 0) + line.amount);
      }
    }
    const caps = WALLET_DAILY_CAPS.pass_reward;
    expect(Object.keys(caps).sort()).toEqual([...sums.keys()].sort());
    for (const [resource, sum] of sums) expect(caps[resource], resource).toBe(sum * 2);
  });

  it("pass_reward — причина начисления из ничего, а не обмен: потолок обязателен", () => {
    expect(EARN_REASONS).toContain("pass_reward");
    for (const resource of WALLET_RESOURCES) if (WALLET_DAILY_CAPS.pass_reward[resource] !== undefined) expect(WALLET_DAILY_CAPS.pass_reward[resource]).toBeGreaterThan(0);
  });
});

describe("лента месяца из базы", () => {
  const good = (): PassTierDef[] => DEFAULT_RIBBON.map((tier) => ({ ...tier }));

  it("29 ступеней и 31 — ошибка, ровно 30 — можно", () => {
    expect(passRibbonSchema.safeParse(good().slice(0, 29)).success).toBe(false);
    expect(passRibbonSchema.safeParse([...good(), { tier: 31, free: { coins: 1 }, vip: { gems: 1 } }]).success).toBe(false);
    expect(passRibbonSchema.safeParse(good()).success).toBe(true);
  });

  it("номера обязаны идти подряд с единицы: перестановка и пропуск отвергаются", () => {
    const swapped = good();
    [swapped[0], swapped[1]] = [swapped[1] as PassTierDef, swapped[0] as PassTierDef];
    expect(passRibbonSchema.safeParse(swapped).success).toBe(false);
    const gap = good().map((tier, index) => (index === 3 ? { ...tier, tier: 99 } : tier));
    expect(passRibbonSchema.safeParse(gap).success).toBe(false);
  });

  it("сумма по ресурсу сверх суточного потолка кошелька — ошибка: потолок молча срезал бы награду игрока", () => {
    const cap = WALLET_DAILY_CAPS.pass_reward.gems ?? 0;
    const over = good().map((tier) => (tier.tier === 1 ? { ...tier, vip: { gems: Math.floor(cap / 2) + 1 } } : tier));
    expect(passRibbonSchema.safeParse(over).success).toBe(false);
  });
});

describe("право на забор", () => {
  const base = { tier: 5, lane: "free", points: 500, pointsPerTier: 100, vipNow: false, claimed: new Set<string>() } as const;

  it("ступень достигнута, не забрана — можно", () => {
    expect(claimBlock(base)).toBeNull();
    expect(claimBlock({ ...base, tier: 1 })).toBeNull();
  });

  it("ступень выше достигнутой — не достигнута, и с VIP тоже", () => {
    expect(claimBlock({ ...base, tier: 6 })).toBe("tier_not_reached");
    expect(claimBlock({ ...base, tier: 6, lane: "vip", vipNow: true })).toBe("tier_not_reached");
  });

  it("повтор — уже забрана; лента у ступени своя", () => {
    const claimed = new Set([claimKey(5, "free")]);
    expect(claimBlock({ ...base, claimed })).toBe("already_claimed");
    expect(claimBlock({ ...base, lane: "vip", vipNow: true, claimed })).toBeNull();
  });

  it("VIP-лента без VIP закрыта, с VIP открыта", () => {
    expect(claimBlock({ ...base, lane: "vip" })).toBe("vip_required");
    expect(claimBlock({ ...base, lane: "vip", vipNow: true })).toBeNull();
  });

  it("VIP, купленный на 12-й ступени, открывает VIP-награды 1…12 — условие в моменте забора, а не ступени", () => {
    const points = 1_250;
    for (let tier = 1; tier <= 12; tier++) expect(claimBlock({ ...base, tier, lane: "vip", points, vipNow: true }), String(tier)).toBeNull();
    expect(claimBlock({ ...base, tier: 13, lane: "vip", points, vipNow: true })).toBe("tier_not_reached");
  });

  it("порядок отказов: не достигнута важнее забранной, забранная важнее VIP — игроку говорят самое точное", () => {
    const claimed = new Set([claimKey(5, "vip")]);
    expect(claimBlock({ ...base, tier: 9, lane: "vip", claimed })).toBe("tier_not_reached");
    expect(claimBlock({ ...base, lane: "vip", claimed })).toBe("already_claimed");
  });

  it("ступени вне 1…30 не забираются никогда", () => {
    const rich = { ...base, points: 100_000 };
    expect(claimBlock({ ...rich, tier: 0 })).toBe("tier_not_reached");
    expect(claimBlock({ ...rich, tier: 31 })).toBe("tier_not_reached");
  });
});

describe("ответ GET /pass", () => {
  const at = new Date("2026-11-10T09:00:00Z");

  it("месяц, конец в UTC, очки, ступень, шаг, VIP и по ступеням: обе награды и что забрано", () => {
    const view = passViewOf({ monthKey: monthKeyOf(at), points: 250, pointsPerTier: 100, vip: true, ribbon: DEFAULT_RIBBON, claimed: new Set([claimKey(1, "free"), claimKey(2, "vip")]) });
    expect(view).toMatchObject({ monthKey: "2026-11", endsAt: "2026-11-30T21:00:00.000Z", points: 250, tier: 2, pointsPerTier: 100, vip: true });
    expect(view.tiers).toHaveLength(PASS_TIERS);
    expect(view.tiers[0]).toEqual({ tier: 1, free: DEFAULT_RIBBON[0]?.free, vip: DEFAULT_RIBBON[0]?.vip, claimed: { free: true, vip: false } });
    expect(view.tiers[1]?.claimed).toEqual({ free: false, vip: true });
    expect(view.tiers[2]?.claimed).toEqual({ free: false, vip: false });
  });

  it("очки сверх тридцатой ступени остаются в ответе, ступень — тридцать", () => {
    const view = passViewOf({ monthKey: "2026-11", points: 4_000, pointsPerTier: 100, vip: false, ribbon: DEFAULT_RIBBON, claimed: new Set() });
    expect(view).toMatchObject({ points: 4_000, tier: 30, vip: false });
  });
});
