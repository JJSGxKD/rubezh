import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { MAX_LEVEL } from "../src/modules/progress/progress-rules.js";
import type { ProgressService } from "../src/modules/progress/progress.service.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import { WheelSpentError } from "../src/modules/wheel/wheel-errors.js";
import { WHEEL_COIN_BASE, WHEEL_SECTORS, pickSector, sectorOdds, sectorReward, totalWeight } from "../src/modules/wheel/wheel-rules.js";
import type { NewWheelSpin, WheelRepository, WheelSpinRow } from "../src/modules/wheel/wheel.repository.js";
import { WheelController } from "../src/modules/wheel/wheel.controller.js";
import { WheelService, cryptoRoll, viewOf, type WheelPlayer, type WheelRoll, type WheelSource } from "../src/modules/wheel/wheel.service.js";
import { AdCooldownError, AdNotCompletedError } from "../src/modules/ads/ads-errors.js";
import { maxRewardsPerDay } from "../src/modules/ads/ads-rules.js";
import type { AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import { panelSettings } from "./helpers/settings.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAds, adBlock } from "./helpers/memory-ads.js";

/**
 * Колесо (docs/35-stage4-plan.md Р45, WP13; docs/07-monetization-and-ads.md
 * §7): сектор выбирает сервер, шансы на экране совпадают с выпадением,
 * бесплатная крутка — одна в московские сутки, обрыв посреди крутки не даёт
 * второй попытки. Крутка за рекламу (WP12) — только по досмотренной сессии
 * показа, одна на сессию и в растущий кулдаун места.
 */

const ME = "00000000-0000-4000-8000-00000000e001";
const PLAYER: WheelPlayer = { accountId: ME, platform: "telegram" };
const FREE: WheelSource = { kind: "free" };
const MINUTE = 60_000;
const HOUR = 3_600_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));

/** Московские сутки без перехода на летнее время: UTC+3. */
function moscowDay(at: Date): number {
  return Math.floor((at.getTime() + 3 * HOUR) / (24 * HOUR));
}

class MemoryWheel implements WheelRepository {
  readonly rows: (WheelSpinRow & { accountId: string; day: number; adSessionId: string | null })[] = [];
  /** сколько раз сервис пытался записать крутку — видно, бросал ли он заново */
  inserts = 0;

  async freeToday(accountId: string, at: Date): Promise<WheelSpinRow | null> {
    const row = this.rows.find((candidate) => candidate.accountId === accountId && candidate.adSessionId === null && candidate.day === moscowDay(at));
    return row === undefined ? null : spinOf(row);
  }

  async insertFree(accountId: string, spin: NewWheelSpin, at: Date): Promise<WheelSpinRow | null> {
    this.inserts++;
    if (this.rows.some((row) => row.accountId === accountId && row.adSessionId === null && row.day === moscowDay(at))) return null;
    return this.push({ ...spin, spinId: `spin-${String(this.rows.length + 1)}`, granted: false, accountId, day: moscowDay(at), adSessionId: null });
  }

  async insertAd(accountId: string, adSessionId: string, spin: NewWheelSpin, at: Date): Promise<WheelSpinRow | null> {
    this.inserts++;
    if (this.rows.some((row) => row.adSessionId === adSessionId)) return null;
    return this.push({ ...spin, spinId: `spin-${String(this.rows.length + 1)}`, granted: false, accountId, day: moscowDay(at), adSessionId });
  }

  async byAdSession(accountId: string, adSessionId: string): Promise<WheelSpinRow | null> {
    const row = this.rows.find((candidate) => candidate.adSessionId === adSessionId && candidate.accountId === accountId);
    return row === undefined ? null : spinOf(row);
  }

  async markGranted(spinId: string): Promise<void> {
    const row = this.rows.find((candidate) => candidate.spinId === spinId);
    if (row !== undefined) row.granted = true;
  }

  private push(row: MemoryWheel["rows"][number]): WheelSpinRow {
    this.rows.push(row);
    return spinOf(row);
  }
}

function spinOf(row: WheelSpinRow): WheelSpinRow {
  return { spinId: row.spinId, sector: row.sector, resource: row.resource, amount: row.amount, granted: row.granted };
}

class FakeWallet {
  readonly grants: GrantInput[] = [];
  readonly keys = new Set<string>();
  /** оборвать следующее начисление — как сеть до базы посреди крутки */
  failNext = false;

  async grant(input: GrantInput): Promise<GrantResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("кошелёк недоступен");
    }
    const duplicate = this.keys.has(input.idempotencyKey);
    if (!duplicate) {
      this.keys.add(input.idempotencyKey);
      this.grants.push(input);
    }
    return { credited: duplicate ? 0 : input.amount, balance: 0, duplicate };
  }
}

/** Бросок по очереди из списка — какой сектор выпадет, решает тест. */
function rolls(...values: number[]): WheelRoll {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

/** Бросок, выбирающий сектор `sector`: начало его отрезка весов. */
function rollFor(sector: number): number {
  return WHEEL_SECTORS.slice(0, sector).reduce((sum, candidate) => sum + candidate.weight, 0);
}

function setup(roll: WheelRoll = rolls(0), level = 1, blocks: AdBlockRow[] = [adBlock("adsgram", 10)]) {
  const repository = new MemoryWheel();
  const wallet = new FakeWallet();
  const progress = { view: async () => ({ level }) } as unknown as ProgressService;
  const adsRepository = new MemoryAds();
  adsRepository.blocks = blocks;
  const passes = new AdPasses();
  const ads = new AdsService(adsRepository, () => 0, passes, panelSettings());
  const service = new WheelService(repository, progress, wallet as unknown as WalletService, ads, roll);
  return { repository, wallet, service, ads, adsRepository, passes };
}

/** Реклама досмотрена: выдача показа в месте колеса и досмотр от SDK. */
async function watched(ads: AdsService, at: Date): Promise<string> {
  const offer = await ads.offer({ ...PLAYER, device: "android" }, "wheel_spin", at);
  if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
  await ads.report(ME, offer.sessionId, { kind: "completed" }, at);
  return offer.sessionId;
}

/** Детерминированный генератор для распределения: тест должен падать одинаково на любом запуске. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("числа колеса", () => {
  it("веса — целые и в сумме сотня: шанс сектора читается процентами", () => {
    expect(WHEEL_SECTORS.every((sector) => Number.isInteger(sector.weight) && sector.weight > 0)).toBe(true);
    expect(totalWeight(WHEEL_SECTORS)).toBe(100);
    expect(sectorOdds(WHEEL_SECTORS).reduce((sum, odds) => sum + odds, 0)).toBeCloseTo(1);
  });

  it("самоцветов на колесе нет — ни в секторах, ни в потолке кошелька", () => {
    expect(WHEEL_SECTORS.map((sector) => sector.resource)).not.toContain("gems");
    expect(WALLET_DAILY_CAPS.wheel_reward.gems).toBeUndefined();
  });

  it("монеты — доли базы уровня, осколки уровнем не растут", () => {
    const coins = WHEEL_SECTORS.find((sector) => sector.resource === "coins" && sector.share === 1);
    const shards = WHEEL_SECTORS.find((sector) => sector.resource === "shard_common");
    if (coins === undefined || shards === undefined) throw new Error("нет сектора монет ×1 или осколков");
    expect(sectorReward(coins, 1)).toEqual({ resource: "coins", amount: WHEEL_COIN_BASE });
    expect(sectorReward(coins, 21)).toEqual({ resource: "coins", amount: 140 });
    expect(sectorReward(shards, 1)).toEqual(sectorReward(shards, MAX_LEVEL));
  });

  it("крутка в среднем — около сотни монет на первом уровне: повод зайти, а не заработок", () => {
    const odds = sectorOdds(WHEEL_SECTORS);
    const mean = WHEEL_SECTORS.reduce((sum, sector, index) => sum + (sector.resource === "coins" ? sectorReward(sector, 1).amount * (odds[index] ?? 0) : 0), 0);
    expect(mean).toBeGreaterThan(80);
    expect(mean).toBeLessThan(120);
  });

  it("честный игрок не упирается в суточный потолок и со всеми крутками суток, выпавшими самыми щедрыми", () => {
    // Бесплатная и все за рекламу, которые пропустит растущий кулдаун.
    const spins = 1 + (maxRewardsPerDay("wheel_spin") ?? 0);
    expect(spins).toBe(7);
    for (const resource of ["coins", "shard_common", "shard_uncommon"] as const) {
      const best = Math.max(...WHEEL_SECTORS.filter((sector) => sector.resource === resource).map((sector) => sectorReward(sector, MAX_LEVEL).amount));
      expect(spins * best, resource).toBeLessThanOrEqual(WALLET_DAILY_CAPS.wheel_reward[resource] ?? 0);
    }
  });

  it("бросок делит сумму весов на отрезки секторов без щелей и нахлёстов", () => {
    const total = totalWeight(WHEEL_SECTORS);
    const hits = new Array<number>(WHEEL_SECTORS.length).fill(0);
    for (let roll = 0; roll < total; roll++) {
      const sector = pickSector(WHEEL_SECTORS, roll);
      hits[sector] = (hits[sector] ?? 0) + 1;
    }
    expect(hits).toEqual(WHEEL_SECTORS.map((sector) => sector.weight));
    expect(() => pickSector(WHEEL_SECTORS, total)).toThrow(RangeError);
  });

  it("на двадцати тысячах круток выпадение совпадает с шансами на экране", () => {
    const random = mulberry32(20260930);
    const total = totalWeight(WHEEL_SECTORS);
    const spins = 20_000;
    const hits = new Array<number>(WHEEL_SECTORS.length).fill(0);
    for (let spin = 0; spin < spins; spin++) {
      const sector = pickSector(WHEEL_SECTORS, Math.floor(random() * total));
      hits[sector] = (hits[sector] ?? 0) + 1;
    }
    const odds = sectorOdds(WHEEL_SECTORS);
    // Хи-квадрат при семи степенях свободы: 24,3 — порог значимости 0,001.
    const chiSquare = hits.reduce((sum, hit, index) => {
      const expected = spins * (odds[index] ?? 0);
      return sum + (hit - expected) ** 2 / expected;
    }, 0);
    expect(chiSquare).toBeLessThan(24.3);
    hits.forEach((hit, index) => expect(hit / spins, `сектор ${String(index)}`).toBeCloseTo(odds[index] ?? 0, 1));
  });

  it("настоящий бросок — целый и внутри суммы весов", () => {
    const total = totalWeight(WHEEL_SECTORS);
    for (let spin = 0; spin < 2_000; spin++) {
      const roll = cryptoRoll(total);
      expect(Number.isInteger(roll) && roll >= 0 && roll < total).toBe(true);
    }
  });
});

describe("крутка", () => {
  it("сектор выбирает сервер, награда ложится в кошелёк ключом крутки", async () => {
    const jackpot = WHEEL_SECTORS.findIndex((sector) => sector.resource === "coins" && sector.share === 10);
    const { service, wallet } = setup(rolls(rollFor(jackpot)));
    const result = await service.spin(PLAYER, FREE, NOON);

    expect(result).toMatchObject({ sector: jackpot, resource: "coins", amount: 1000, credited: 1000 });
    expect(result.view.free).toBe(false);
    expect(wallet.grants).toEqual([
      { accountId: ME, resource: "coins", amount: 1000, reason: "wheel_reward", source: "wheel:spin-1", idempotencyKey: "wheel_reward:spin-1", at: NOON },
    ]);
  });

  it("бесплатная крутка — одна в московские сутки: 23:58 и 23:59 — одни, 00:01 — уже другие", async () => {
    const { service } = setup();
    const lateEvening = new Date(Date.UTC(2026, 8, 30, 20, 58));
    await service.spin(PLAYER, FREE, lateEvening);
    await expect(service.spin(PLAYER, FREE, new Date(lateEvening.getTime() + 60_000))).rejects.toBeInstanceOf(WheelSpentError);
    expect((await service.view(PLAYER, new Date(lateEvening.getTime() + 60_000))).free).toBe(false);

    const afterMidnight = new Date(Date.UTC(2026, 8, 30, 21, 1));
    expect((await service.view(PLAYER, afterMidnight)).free).toBe(true);
    await expect(service.spin(PLAYER, FREE, afterMidnight)).resolves.toMatchObject({ credited: expect.any(Number) });
  });

  it("обрыв посреди крутки: повтор дожимает тот же сектор, а не бросает заново", async () => {
    const { service, wallet, repository } = setup(rolls(rollFor(2), rollFor(3)));
    wallet.failNext = true;
    await expect(service.spin(PLAYER, FREE, NOON)).rejects.toThrow(/кошелёк недоступен/);
    expect(await service.badge(ME, NOON)).toBe(1);
    expect((await service.view(PLAYER, NOON)).free).toBe(true);

    const retry = await service.spin(PLAYER, FREE, new Date(NOON.getTime() + 60_000));
    expect(retry.sector).toBe(2);
    expect(wallet.grants).toHaveLength(1);
    expect(repository.rows).toHaveLength(1);
    await expect(service.spin(PLAYER, FREE, new Date(NOON.getTime() + 120_000))).rejects.toBeInstanceOf(WheelSpentError);
  });

  it("две крутки разом начисляют сутки однажды", async () => {
    const { service, wallet } = setup(rolls(rollFor(0), rollFor(7)));
    const results = await Promise.allSettled([service.spin(PLAYER, FREE, NOON), service.spin(PLAYER, FREE, NOON)]);
    const credited = results.filter((result) => result.status === "fulfilled").map((result) => result.value.credited);
    expect(credited.reduce((sum, value) => sum + value, 0)).toBe(wallet.grants[0]?.amount);
    expect(wallet.grants).toHaveLength(1);
  });

  it("знак меню горит, пока бесплатная крутка суток ждёт", async () => {
    const { service } = setup();
    expect(await service.badge(ME, NOON)).toBe(1);
    await service.spin(PLAYER, FREE, NOON);
    expect(await service.badge(ME, NOON)).toBe(0);
    expect(await service.badge(ME, new Date(NOON.getTime() + 24 * HOUR))).toBe(1);
  });
});

describe("крутка за рекламу", () => {
  it("только по досмотренной сессии места; награда — тем же путём, бесплатная крутка суток остаётся", async () => {
    const { service, ads, wallet } = setup(rolls(rollFor(1)));
    const offer = await ads.offer({ ...PLAYER, device: "android" }, "wheel_spin", NOON);
    if (!offer.available) throw new Error("показа нет");
    await expect(service.spin(PLAYER, { kind: "ad", sessionId: offer.sessionId }, NOON)).rejects.toBeInstanceOf(AdNotCompletedError);

    await ads.report(ME, offer.sessionId, { kind: "completed" }, NOON);
    const result = await service.spin(PLAYER, { kind: "ad", sessionId: offer.sessionId }, NOON);
    expect(result).toMatchObject({ sector: 1, view: { free: true, ad: { available: true, readyAt: new Date(NOON.getTime() + 120 * MINUTE).toISOString() } } });
    expect(wallet.grants).toEqual([expect.objectContaining({ reason: "wheel_reward", idempotencyKey: "wheel_reward:spin-1" })]);
    expect((await service.view(PLAYER, NOON)).free).toBe(true);
  });

  it("одна сессия — одна крутка: повтор дожимает тот же сектор и не начисляет второй раз", async () => {
    const { service, ads, wallet, repository } = setup(rolls(rollFor(2), rollFor(5)));
    const sessionId = await watched(ads, NOON);
    wallet.failNext = true;
    await expect(service.spin(PLAYER, { kind: "ad", sessionId }, NOON)).rejects.toThrow(/кошелёк недоступен/);

    const retry = await service.spin(PLAYER, { kind: "ad", sessionId }, new Date(NOON.getTime() + MINUTE));
    expect(retry.sector).toBe(2);
    const again = await service.spin(PLAYER, { kind: "ad", sessionId }, new Date(NOON.getTime() + 2 * MINUTE));
    expect(again.sector).toBe(2);
    expect(repository.rows).toHaveLength(1);
    expect(wallet.grants).toHaveLength(1);
  });

  it("вторая реклама — только после кулдауна места, и каждый следующий длиннее", async () => {
    const { service, ads } = setup();
    await service.spin(PLAYER, { kind: "ad", sessionId: await watched(ads, NOON) }, NOON);
    // Выдача в кулдаун закрыта; сессию, выданную до забора, не пропустит забор.
    expect(await ads.offer({ ...PLAYER, device: "android" }, "wheel_spin", new Date(NOON.getTime() + 60 * MINUTE))).toMatchObject({ available: false, reason: "cooldown" });

    const second = await watched(ads, new Date(NOON.getTime() + 120 * MINUTE));
    const view = (await service.spin(PLAYER, { kind: "ad", sessionId: second }, new Date(NOON.getTime() + 120 * MINUTE))).view;
    expect(view.ad.readyAt).toBe(new Date(NOON.getTime() + 300 * MINUTE).toISOString());
  });

  it("VIP крутит без ролика и без сетей: сессия выдаётся выполненной, кулдаун места тот же", async () => {
    const { service, ads, passes, wallet } = setup(rolls(rollFor(3)), 1, []);
    passes.register("vip", async () => true);
    expect((await service.view(PLAYER, NOON)).ad).toEqual({ available: true, readyAt: null, pass: "vip" });

    const offer = await ads.offer({ ...PLAYER, device: null }, "wheel_spin", NOON);
    if (!offer.available) throw new Error("показа нет");
    expect(offer.pass).toBe("vip");
    const result = await service.spin(PLAYER, { kind: "ad", sessionId: offer.sessionId }, NOON);
    expect(result).toMatchObject({ sector: 3, view: { ad: { pass: "vip", readyAt: new Date(NOON.getTime() + 120 * MINUTE).toISOString() } } });
    expect(wallet.grants).toEqual([expect.objectContaining({ reason: "wheel_reward" })]);
  });

  it("две сессии, выданные до кулдауна, дают одну крутку", async () => {
    const { service, ads, wallet } = setup(rolls(0), 1, [adBlock("adsgram", 10), adBlock("adsonar", 20)]);
    const first = await watched(ads, NOON);
    const second = await watched(ads, NOON);
    await service.spin(PLAYER, { kind: "ad", sessionId: first }, NOON);
    await expect(service.spin(PLAYER, { kind: "ad", sessionId: second }, NOON)).rejects.toBeInstanceOf(AdCooldownError);
    expect(wallet.grants).toHaveLength(1);
  });

  it("экран знает, есть ли реклама для площадки игрока: блок «везде» сети Telegram в VK кнопки не даёт", async () => {
    const { service } = setup(rolls(0), 1, [adBlock("adsgram", 10)]);
    expect((await service.view(PLAYER, NOON)).ad).toEqual({ available: true, readyAt: null, pass: null });
    expect((await service.view({ accountId: ME, platform: "vk" }, NOON)).ad).toEqual({ available: false, readyAt: null, pass: null });
  });
});

describe("колесо на экране", () => {
  it("сектора — в порядке колеса, с наградой уровня и шансом", () => {
    const view = viewOf(21, true, { available: false, readyAt: null, pass: null });
    expect(view.free).toBe(true);
    expect(view.sectors).toHaveLength(WHEEL_SECTORS.length);
    expect(view.sectors[0]).toEqual({ resource: "coins", amount: 70, odds: 0.24 });
    expect(view.sectors.map((sector) => sector.resource)).toEqual(WHEEL_SECTORS.map((sector) => sector.resource));
  });
});

describe("колесо по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(service: WheelService): Promise<NestFastifyApplication> {
    @Module({
      controllers: [WheelController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: WheelService, useValue: service },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  it("без токена — 401; чужое тело — 400; реклама без досмотра и вторая бесплатная за сутки — 409 с кодом", async () => {
    const { service } = setup();
    const server = await start(service);
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };

    expect((await server.inject({ method: "GET", url: "/api/v1/wheel" })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/api/v1/wheel/spin", payload: { source: "free" } })).statusCode).toBe(401);

    const view = await server.inject({ method: "GET", url: "/api/v1/wheel", headers });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ data: { free: boolean; sectors: unknown[] } }>().data).toMatchObject({ free: true, sectors: expect.any(Array) });

    for (const payload of [{ source: "ad" }, { source: "ad", sessionId: "short" }, { source: "free", sessionId: "AAAAAAAAAAAAAAAA" }, { source: "free", sector: 3 }, {}]) {
      expect((await server.inject({ method: "POST", url: "/api/v1/wheel/spin", headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const unwatched = await server.inject({ method: "POST", url: "/api/v1/wheel/spin", headers, payload: { source: "ad", sessionId: "AAAAAAAAAAAAAAAA" } });
    expect(unwatched.statusCode).toBe(409);
    expect(unwatched.json<{ error: { code: string } }>().error.code).toBe("ad_not_completed");

    const spin = await server.inject({ method: "POST", url: "/api/v1/wheel/spin", headers, payload: { source: "free" } });
    expect(spin.statusCode).toBe(200);
    expect(spin.json<{ data: { sector: number; view: { free: boolean } } }>().data).toMatchObject({ sector: 0, view: { free: false } });

    const again = await server.inject({ method: "POST", url: "/api/v1/wheel/spin", headers, payload: { source: "free" } });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe("wheel_spent");
  });
});
