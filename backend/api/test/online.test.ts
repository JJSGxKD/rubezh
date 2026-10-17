import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { secretKey, signAccessToken, type AccessTokenClaims } from "../src/modules/auth/access-token.js";
import type { OnlineCounts, OnlinePeak, OnlineRepository, PlatformCounts } from "../src/modules/online/online.repository.js";
import { OnlineService } from "../src/modules/online/online.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Счётчик онлайна (Р107): пороги, интервал пинга, рекорд и поведение при
 * сбое Redis. Хранилище — подмена, Redis проверяет `online.integration.test.ts`.
 */

const NOW = new Date("2026-10-15T12:00:00.000Z");
const CLAIMS: AccessTokenClaims = { accountId: "acc-1", platform: "telegram", platformUserId: "1" };

const zero: PlatformCounts = { app: 0, run: 0, today: 0 };

function counts(total: Partial<PlatformCounts>, at = NOW.getTime()): OnlineCounts {
  const all = { ...zero, ...total };
  return { byPlatform: { telegram: all, max: zero, vk: zero, web: zero }, total: all, at };
}

class FakeRepository implements OnlineRepository {
  stored: OnlineCounts | null = null;
  recounted: OnlineCounts | null = null;
  peakStored: OnlinePeak | null = null;
  touches: unknown[][] = [];
  inRunCalls: unknown[][] = [];
  recountArgs: unknown[] = [];
  failTouch = false;
  failInRun = false;

  async touch(accountId: string, platform: string, nowMs: number, gameDay: string): Promise<void> {
    if (this.failTouch) throw new Error("redis недоступен");
    this.touches.push([accountId, platform, nowMs, gameDay]);
  }
  async setInRun(accountId: string, platform: string, inRun: boolean, nowMs: number): Promise<void> {
    if (this.failInRun) throw new Error("redis недоступен");
    this.inRunCalls.push([accountId, platform, inRun, nowMs]);
  }
  async recount(nowMs: number, windowMs: number, gameDay: string): Promise<OnlineCounts> {
    this.recountArgs = [nowMs, windowMs, gameDay];
    if (this.recounted === null) throw new Error("нет подготовленных чисел");
    return this.recounted;
  }
  async counts(): Promise<OnlineCounts | null> {
    return this.stored;
  }
  async peak(): Promise<OnlinePeak | null> {
    return this.peakStored;
  }
  async setPeak(value: number, atMs: number): Promise<void> {
    this.peakStored = { value, at: atMs };
  }
}

function setup(settings: Record<string, number> = {}) {
  const repository = new FakeRepository();
  const panel = panelSettings(settings);
  return { repository, panel, service: new OnlineService(repository, panel) };
}

describe("пинг: интервал до следующего", () => {
  it("45 с при окне 120 с и пинге 45 с — по умолчанию", async () => {
    const { service, repository } = setup();
    repository.stored = counts({ app: 100 });

    const result = await service.ping(CLAIMS, false, NOW);

    expect(result.nextPingSec).toBe(45);
  });

  it("не больше половины окна: пинг 60 с при окне 100 с — 50 с", async () => {
    const { service, repository } = setup({ [SETTINGS.onlineWindowSec.key]: 100, [SETTINGS.onlinePingSec.key]: 60 });
    repository.stored = counts({ app: 100 });

    expect((await service.ping(CLAIMS, false, NOW)).nextPingSec).toBe(50);
  });

  it("нечётное окно округляется вниз: 31 с — 15 с", async () => {
    const { service } = setup({ [SETTINGS.onlineWindowSec.key]: 31, [SETTINGS.onlinePingSec.key]: 300 });

    expect((await service.ping(CLAIMS, false, NOW)).nextPingSec).toBe(15);
  });
});

describe("пинг: пороги показа", () => {
  it("ниже порога онлайн — null, а «сегодня играли» — число", async () => {
    const { service, repository } = setup();
    repository.stored = counts({ app: 19, today: 240 });

    expect(await service.ping(CLAIMS, false, NOW)).toMatchObject({ online: null, todayPlayed: 240 });
  });

  it("ровно на пороге онлайн виден, а «сегодня играли» — null", async () => {
    const { service, repository } = setup();
    repository.stored = counts({ app: 20, today: 240 });

    expect(await service.ping(CLAIMS, false, NOW)).toMatchObject({ online: 20, todayPlayed: null });
  });

  it("порог из панели действует сразу: 0 показывает любое число", async () => {
    const { service, repository, panel } = setup();
    repository.stored = counts({ app: 3, today: 9 });
    expect((await service.ping(CLAIMS, false, NOW)).online).toBeNull();

    panel.set(SETTINGS.onlineMinShown.key, 0);

    expect((await service.ping(CLAIMS, false, NOW)).online).toBe(3);
  });

  it("«в забеге»: 4 при пороге 5 — null, 5 — 5", async () => {
    const { service, repository } = setup();
    repository.stored = counts({ app: 50, run: 4 });
    expect((await service.ping(CLAIMS, true, NOW)).inRun).toBeNull();

    repository.stored = counts({ app: 50, run: 5 });
    expect((await service.ping(CLAIMS, true, NOW)).inRun).toBe(5);
  });

  it("«в забеге» не зависит от порога онлайна", async () => {
    const { service, repository } = setup();
    repository.stored = counts({ app: 10, run: 8, today: 70 });

    expect(await service.ping(CLAIMS, true, NOW)).toMatchObject({ online: null, inRun: 8, todayPlayed: 70 });
  });

  it("чисел ещё нет — все три null, а интервал всё равно приходит", async () => {
    const { service } = setup();

    expect(await service.ping(CLAIMS, false, NOW)).toEqual({ online: null, inRun: null, todayPlayed: null, nextPingSec: 45 });
  });
});

describe("пинг: отметки в хранилище", () => {
  it("состояние «в забеге» записывается с площадкой аккаунта и временем пинга", async () => {
    const { service, repository } = setup();

    await service.ping(CLAIMS, true, NOW);
    await service.ping(CLAIMS, false, NOW);

    expect(repository.inRunCalls).toEqual([
      ["acc-1", "telegram", true, NOW.getTime()],
      ["acc-1", "telegram", false, NOW.getTime()],
    ]);
  });

  it("сбой Redis при отметке не роняет пинг: числа null, интервал приходит, в лог одна строка", async () => {
    const { service, repository } = setup();
    repository.failInRun = true;
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const result = await service.ping(CLAIMS, true, NOW);

    expect(result.nextPingSec).toBe(45);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ module: "online", event: "ping_failed" });
  });
});

describe("снимок для панели", () => {
  it("без порогов: числа как посчитаны, по площадкам и итогом, с рекордом", async () => {
    const { service, repository } = setup();
    repository.stored = counts({ app: 3, run: 1, today: 9 }, 777);
    repository.peakStored = { value: 41, at: 500 };

    expect(await service.adminSnapshot()).toEqual({
      byPlatform: {
        telegram: { app: 3, run: 1, today: 9 },
        max: zero,
        vk: zero,
        web: zero,
      },
      total: { app: 3, run: 1, today: 9 },
      peak: { value: 41, at: 500 },
      at: 777,
    });
  });

  it("до первого пересчёта — нули и рекорд null", async () => {
    const { service } = setup();

    const snapshot = await service.adminSnapshot();

    expect(snapshot.total).toEqual(zero);
    expect(snapshot.peak).toBeNull();
  });
});

describe("пересчёт и рекорд", () => {
  it("окно и игровые сутки берутся из настроек и времени запуска", async () => {
    const { service, repository } = setup({ [SETTINGS.onlineWindowSec.key]: 60 });
    repository.recounted = counts({ app: 10 });

    await service.recount(new Date("2026-10-15T22:30:00.000Z"));

    // 22:30 UTC — уже 01:30 следующих суток по Москве
    expect(repository.recountArgs).toEqual([new Date("2026-10-15T22:30:00.000Z").getTime(), 60_000, "2026-10-16"]);
  });

  it("30 при рекорде 25 — новый рекорд со временем пересчёта", async () => {
    const { service, repository } = setup();
    repository.recounted = counts({ app: 30 });
    repository.peakStored = { value: 25, at: 1 };

    await service.recount(NOW);

    expect(repository.peakStored).toEqual({ value: 30, at: NOW.getTime() });
  });

  it("20 при рекорде 25 — рекорд прежний", async () => {
    const { service, repository } = setup();
    repository.recounted = counts({ app: 20 });
    repository.peakStored = { value: 25, at: 1 };

    await service.recount(NOW);

    expect(repository.peakStored).toEqual({ value: 25, at: 1 });
  });

  it("первый пересчёт, когда рекорда ещё нет: любое ненулевое число становится рекордом, ноль — нет", async () => {
    const { service, repository } = setup();
    repository.recounted = counts({ app: 0 });
    await service.recount(NOW);
    expect(repository.peakStored).toBeNull();

    repository.recounted = counts({ app: 1 });
    await service.recount(NOW);
    expect(repository.peakStored).toEqual({ value: 1, at: NOW.getTime() });
  });
});

describe("активность из гарда", () => {
  afterEach(() => vi.restoreAllMocks());

  it("отметка уходит в хранилище с площадкой и игровыми сутками по Москве", async () => {
    const { service, repository } = setup();

    service.touch(CLAIMS, new Date("2026-10-15T21:30:00.000Z"));
    await vi.waitFor(() => expect(repository.touches).toHaveLength(1));

    expect(repository.touches[0]).toEqual(["acc-1", "telegram", new Date("2026-10-15T21:30:00.000Z").getTime(), "2026-10-16"]);
  });

  it("сбой Redis не бросает и не ждёт: `touch` возвращается сразу", () => {
    const { service, repository } = setup();
    repository.failTouch = true;
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    expect(service.touch(CLAIMS, NOW)).toBeUndefined();
  });

  it("сбой Redis: предупреждение не чаще раза в минуту", async () => {
    const { service, repository } = setup();
    repository.failTouch = true;
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    for (const offsetSec of [0, 10, 59]) {
      service.touch(CLAIMS, new Date(NOW.getTime() + offsetSec * 1_000));
      await flush();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ module: "online", event: "touch_failed", reason: "redis недоступен" });

    service.touch(CLAIMS, new Date(NOW.getTime() + 61_000));
    await flush();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("AuthGuard отмечает активность", () => {
  const config = loadAppConfig({
    NODE_ENV: "test",
    JWT_ACCESS_SECRET: "ab".repeat(32),
    TELEGRAM_BOT_TOKEN: "123456:TEST",
    DATABASE_URL: "postgresql://localhost:5432/test",
  } as NodeJS.ProcessEnv);

  async function contextWithToken(): Promise<{ request: { headers: Record<string, string>; account?: AccessTokenClaims }; context: never }> {
    const token = await signAccessToken(CLAIMS, secretKey(config.auth.accessSecret), 900, Date.now());
    const request: { headers: Record<string, string>; account?: AccessTokenClaims } = { headers: { authorization: `Bearer ${token}` } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;
    return { request, context };
  }

  it("принятый токен — отметка активности с аккаунтом из токена", async () => {
    const touch = vi.fn();
    const guard = new AuthGuard(config, undefined, { touch });
    const { context } = await contextWithToken();

    expect(await guard.canActivate(context)).toBe(true);

    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch.mock.calls[0]?.[0]).toMatchObject(CLAIMS);
    expect(touch.mock.calls[0]?.[1]).toBeInstanceOf(Date);
  });

  it("отклонённый токен активности не даёт", async () => {
    const touch = vi.fn();
    const guard = new AuthGuard(config, undefined, { touch });
    const request = { headers: { authorization: "Bearer мусор" } };

    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as never)).rejects.toThrow();

    expect(touch).not.toHaveBeenCalled();
  });

  it("без счётчика гард работает как раньше", async () => {
    const guard = new AuthGuard(config);
    const { context } = await contextWithToken();

    expect(await guard.canActivate(context)).toBe(true);
  });

  it("счётчик, упавший синхронно, не роняет запрос", async () => {
    const guard = new AuthGuard(config, undefined, {
      touch: () => {
        throw new Error("сбой");
      },
    });
    const { context } = await contextWithToken();

    expect(await guard.canActivate(context)).toBe(true);
  });
});
