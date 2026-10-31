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
import { CONTINUE_RATE, continueGems, continuePrice, starsToGems } from "../src/modules/payments/continue-price.js";
import { RunGemContinueController } from "../src/modules/runs/run-gem-continue.controller.js";
import { RunGemContinueService } from "../src/modules/runs/run-gem-continue.service.js";
import type { GemBuyOutcome, GemContinuePurchase, GemContinueRow, RunGemContinuesRepository } from "../src/modules/runs/run-gem-continues.repository.js";
import { RunContinues, type ContinueLedger } from "../src/modules/runs/run-continues.js";
import { RUNS_LIMITS } from "../src/modules/runs/runs-limits.js";
import { InsufficientBalance } from "../src/modules/wallet/wallet-ledger.js";
import { emptyBalances } from "../src/modules/wallet/wallet-types.js";
import { compensationGemsForStars } from "../src/modules/wipe/compensation-rules.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";

/**
 * Второй шанс за самоцветы (docs/35-stage4-plan.md Р162, tasks/T-0324):
 * цена — цена в звёздах по курсу 6 к 5; покупка — свой незаконченный забег,
 * старт виден серверу, часы сервера не опровергают заявленную секунду;
 * списание и строка продолжения — одно целое, повтор не списывает дважды;
 * номер, взятый другим способом, не продаётся; итог забега сверяется с
 * книгой так же, как со звёздами.
 */

const ME = "00000000-0000-4000-8000-00000000d001";
const OTHER = "00000000-0000-4000-8000-00000000d002";
const MINUTE = 60_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);
const RULES = { starsPerMinute: 1, maxStars: 30 };

describe("цена второго шанса в самоцветах", () => {
  it("минута при звезде за минуту — два самоцвета, десять звёзд — двенадцать", () => {
    expect(continueGems(60, RULES)).toBe(2);
    expect(continueGems(600, RULES)).toBe(12);
    expect(continueGems(10 * 60, { starsPerMinute: 10, maxStars: 100 })).toBe(120);
    expect(continueGems(60, { starsPerMinute: 10, maxStars: 100 })).toBe(12);
  });

  it("начатая минута считается целой, нулевая и отрицательная секунда — первой минутой", () => {
    expect(continueGems(0, RULES)).toBe(2);
    expect(continueGems(-5, RULES)).toBe(2);
    expect(continueGems(1, RULES)).toBe(2);
    expect(continueGems(61, RULES)).toBe(3);
    // Шум плавающей точки не стоит самоцвета: секунды забега — сумма тиков.
    expect(continueGems(120.00000000000001, RULES)).toBe(continueGems(120, RULES));
  });

  it("потолок звёзд даёт потолок самоцветов", () => {
    expect(continueGems(30 * 60, RULES)).toBe(36);
    expect(continueGems(31 * 60, RULES)).toBe(36);
    expect(continueGems(86_400, RULES)).toBe(36);
    expect(continueGems(86_400, { starsPerMinute: 1, maxStars: 3 })).toBe(4);
  });

  it("всегда целое, равно переводу цены в звёздах и не убывает с секундой", () => {
    let previous = 0;
    for (let sec = 0; sec <= 4_000; sec += 7) {
      const gems = continueGems(sec, RULES);
      expect(Number.isInteger(gems), `секунда ${String(sec)}`).toBe(true);
      expect(gems, `секунда ${String(sec)}`).toBe(starsToGems(continuePrice(sec, RULES)));
      expect(gems).toBeGreaterThanOrEqual(previous);
      previous = gems;
    }
  });
});

describe("курс переехал из компенсации, числа те же", () => {
  it("курс в цене товара — тот же, что видит компенсация: 6 самоцветов за 5 звёзд", () => {
    expect(CONTINUE_RATE).toEqual({ gems: 6, stars: 5 });
    expect(compensationGemsForStars(10)).toBe(starsToGems(10));
  });

  it("компенсация после вайпа считает то же, что до переезда курса", () => {
    const before: [number, number][] = [
      [0, 0],
      [1, 2],
      [3, 4],
      [5, 6],
      [10, 12],
      [30, 36],
      [50, 60],
      [51, 62],
    ];
    for (const [stars, gems] of before) {
      expect(compensationGemsForStars(stars), `${String(stars)} ⭐`).toBe(gems);
      expect(starsToGems(stars), `${String(stars)} ⭐`).toBe(gems);
    }
  });
});

/**
 * Хранилище в памяти: покупка — одно целое. Не хватило самоцветов — не
 * записано ничего; номер занят рекламой — тоже (так база видит таблицу
 * рекламных продолжений внутри той же транзакции).
 */
class MemoryGemContinues implements RunGemContinuesRepository {
  readonly rows: GemContinueRow[] = [];
  /** номера, занятые рекламой в базе, но ещё не видные книге сервиса */
  readonly adRows = new Map<string, number[]>();
  /** ключи списания, уже занятые в журнале кошелька, хотя строки продолжения нет */
  readonly busyKeys = new Set<string>();
  charged = 0;

  constructor(public gems: number) {}

  async find(runId: string, continueNo: number): Promise<GemContinueRow | null> {
    return this.rows.find((row) => row.runId === runId && row.continueNo === continueNo) ?? null;
  }

  async buy(purchase: GemContinuePurchase): Promise<GemBuyOutcome> {
    const existing = await this.find(purchase.runId, purchase.continueNo);
    if (existing !== null) return existing.accountId === purchase.accountId ? { status: "repeat", row: existing } : { status: "taken" };
    if ((this.adRows.get(purchase.runId) ?? []).includes(purchase.continueNo)) return { status: "taken" };
    // Занятый ключ списания без строки — отказ, как у базы: ни строки, ни списания.
    if (this.busyKeys.has(`continue:${purchase.runId}:${String(purchase.continueNo)}`)) return { status: "taken" };
    if (this.gems < purchase.priceGems) throw new InsufficientBalance("gems", purchase.priceGems);
    this.gems -= purchase.priceGems;
    this.charged += purchase.priceGems;
    const row = { runId: purchase.runId, continueNo: purchase.continueNo, accountId: purchase.accountId, elapsedSec: purchase.elapsedSec, priceGems: purchase.priceGems, grantedAt: purchase.at };
    this.rows.push(row);
    return { status: "bought", row };
  }

  async forRun(runId: string): Promise<{ continueNo: number; elapsedSec: number }[]> {
    return this.rows.filter((row) => row.runId === runId).map((row) => ({ continueNo: row.continueNo, elapsedSec: row.elapsedSec }));
  }
}

/** Книга звёзд или рекламы: номера, уже выданные другим способом. */
class OtherLedger implements ContinueLedger {
  readonly bought = new Map<string, number[]>();
  async check(runId: string): Promise<{ paid: number; underpaid: boolean }> {
    return { paid: (this.bought.get(runId) ?? []).length, underpaid: false };
  }
  async granted(runId: string): Promise<number[]> {
    return this.bought.get(runId) ?? [];
  }
}

const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

function setup(gems = 100) {
  const runs = new MemoryRunsRepository();
  const repository = new MemoryGemContinues(gems);
  const wallet = { balances: async () => ({ ...emptyBalances(), gems: repository.gems }) };
  const continues = new RunContinues();
  const others = new OtherLedger();
  continues.provide(others);
  const service = new RunGemContinueService(config(), runs, repository, wallet, continues);
  service.onModuleInit();
  return { runs, repository, continues, others, service };
}

async function started(runs: MemoryRunsRepository, runId: string, accountId = ME, startedAt: Date | null = NOON): Promise<void> {
  await runs.start({ runId, accountId, difficulty: "normal", startingWeaponId: "spark", contentHash: "c0ffee", startedAt });
}

describe("можно ли продолжить за самоцветы", () => {
  it("незнакомый, чужой и без времени старта забег — одинаково «не видел старта»; записанный — «закончен»", async () => {
    const { service, runs } = setup();
    expect(await service.view(ME, "nope", 120)).toEqual({ status: "unavailable", reason: "unverified" });
    await started(runs, "foreign", OTHER);
    expect(await service.view(ME, "foreign", 120)).toEqual({ status: "unavailable", reason: "unverified" });
    await started(runs, "no-clock", ME, null);
    expect(await service.view(ME, "no-clock", 120)).toEqual({ status: "unavailable", reason: "unverified" });
    await started(runs, "done");
    const row = runs.rows.get("done");
    if (row !== undefined) row.status = "finished";
    expect(await service.view(ME, "done", 120)).toEqual({ status: "unavailable", reason: "finished" });
  });

  it("свежий забег — первое продолжение с ценой от начатых минут и балансом", async () => {
    const { service, runs } = setup(50);
    await started(runs, "run-1");
    expect(await service.view(ME, "run-1", 125)).toEqual({ status: "available", continueNo: 1, priceGems: 4, balance: 50 });
    expect(await service.view(ME, "run-1", 30)).toEqual({ status: "available", continueNo: 1, priceGems: 2, balance: 50 });
  });

  it("не хватает самоцветов — всё равно «доступно»: кнопка покажет цену и нехватку", async () => {
    const { service, runs } = setup(1);
    await started(runs, "run-1");
    expect(await service.view(ME, "run-1", 125)).toEqual({ status: "available", continueNo: 1, priceGems: 4, balance: 1 });
  });

  it("продолжение уже взято любым способом — «продолжения кончились»", async () => {
    const { service, runs, others } = setup();
    await started(runs, "stars");
    others.bought.set("stars", [1]);
    expect(await service.view(ME, "stars", 125)).toEqual({ status: "unavailable", reason: "used_up" });
    await started(runs, "gems");
    await service.buy(ME, "gems", { continueNo: 1, elapsedSec: 125 }, at(3));
    expect(await service.view(ME, "gems", 125)).toEqual({ status: "unavailable", reason: "used_up" });
  });
});

describe("покупка продолжения за самоцветы", () => {
  it("списывает цену, пишет строку и отдаёт номер, цену и остаток; книга продолжений знает номер", async () => {
    const { service, runs, repository, continues } = setup(50);
    await started(runs, "run-1");

    expect(await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 125 }, at(3))).toEqual({ continueNo: 1, priceGems: 4, balance: 46 });
    expect(repository.rows).toEqual([{ runId: "run-1", continueNo: 1, accountId: ME, elapsedSec: 125, priceGems: 4, grantedAt: at(3) }]);
    expect(await continues.taken("run-1")).toEqual(new Set([1]));
  });

  it("репозиторий ответил «занято» (ключ списания без строки) — 409 continue_taken, ничего не списано и не записано", async () => {
    const { service, runs, repository, continues } = setup(50);
    await started(runs, "run-1");
    repository.busyKeys.add("continue:run-1:1");

    await expect(service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 125 }, at(3))).rejects.toMatchObject({ code: "continue_taken", status: 409 });

    expect(repository.rows).toEqual([]);
    expect(repository.gems).toBe(50);
    expect(await continues.taken("run-1")).toEqual(new Set());
  });

  it("повтор того же номера — тот же ответ, без второго списания; даже когда забег уже закончен", async () => {
    const { service, runs, repository } = setup(50);
    await started(runs, "run-1");
    const first = await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 125 }, at(3));

    // Ответ потерялся — клиент повторяет, секунда уже другая.
    expect(await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 130 }, at(4))).toEqual(first);
    const row = runs.rows.get("run-1");
    if (row !== undefined) row.status = "finished";
    expect(await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 130 }, at(5))).toEqual(first);
    expect(repository.charged).toBe(4);
    expect(repository.gems).toBe(46);
  });

  it("параллельный повтор, которого ещё не было видно в начале, получает прежний ответ, а не «уже взято»", async () => {
    const { service, runs, repository } = setup(50);
    await started(runs, "run-1");
    const first = await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 125 }, at(3));

    // Копия запроса проверила «нет ли уже» до записи первой, а дальше увидела номер в книге.
    const real = repository.find.bind(repository);
    let calls = 0;
    repository.find = async (runId, continueNo) => (calls++ === 0 ? null : await real(runId, continueNo));
    expect(await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 125 }, at(3))).toEqual(first);
    expect(repository.charged).toBe(4);
  });

  it("номер уже взят звёздами или рекламой — 409 continue_taken, баланс не тронут", async () => {
    const { service, runs, repository, others } = setup(50);
    await started(runs, "stars");
    others.bought.set("stars", [1]);
    await expect(service.buy(ME, "stars", { continueNo: 1, elapsedSec: 125 }, at(3))).rejects.toMatchObject({ code: "continue_taken", status: 409 });

    // Реклама записалась между проверкой и покупкой: сервис её ещё не видит, база — видит.
    await started(runs, "ad");
    repository.adRows.set("ad", [1]);
    await expect(service.buy(ME, "ad", { continueNo: 1, elapsedSec: 125 }, at(3))).rejects.toMatchObject({ code: "continue_taken", status: 409 });
    expect(repository.gems).toBe(50);
    expect(repository.rows).toEqual([]);
  });

  it("мало самоцветов — 409 insufficient_funds с самоцветами и нехваткой, строки нет", async () => {
    const { service, runs, repository } = setup(3);
    await started(runs, "run-1");
    await expect(service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 125 }, at(3))).rejects.toMatchObject({
      code: "insufficient_funds",
      status: 409,
      resource: "gems",
      needed: 4,
      balance: 3,
    });
    expect(repository.rows).toEqual([]);
    expect(repository.gems).toBe(3);
    // Цена на секунду раньше помещается в баланс.
    expect(await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 70 }, at(3))).toMatchObject({ priceGems: 3, balance: 0 });
  });

  it("секунд больше, чем прошло по часам сервера, — отказ; допуск часов — нет", async () => {
    const { service, runs, repository } = setup(50);
    await started(runs, "run-1");
    await expect(service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 400 }, at(3))).rejects.toMatchObject({ code: "elapsed_exceeds_clock", status: 400 });
    expect(repository.rows).toEqual([]);
    // 180 с по часам сервера плюс допуск (RUNS_WALL_CLOCK_TOLERANCE_SEC = 10).
    expect(await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 190 }, at(3))).toMatchObject({ continueNo: 1 });
  });

  it("чужой, незнакомый и без времени старта забег — «не видел старта»; закончен — «продолжать нечего»", async () => {
    const { service, runs, repository } = setup(50);
    await expect(service.buy(ME, "nope", { continueNo: 1, elapsedSec: 60 }, at(3))).rejects.toMatchObject({ code: "run_unverified", status: 409 });
    await started(runs, "foreign", OTHER);
    await expect(service.buy(ME, "foreign", { continueNo: 1, elapsedSec: 60 }, at(3))).rejects.toMatchObject({ code: "run_unverified", status: 409 });
    await started(runs, "no-clock", ME, null);
    await expect(service.buy(ME, "no-clock", { continueNo: 1, elapsedSec: 60 }, at(3))).rejects.toMatchObject({ code: "run_unverified", status: 409 });
    await started(runs, "done");
    const row = runs.rows.get("done");
    if (row !== undefined) row.status = "finished";
    await expect(service.buy(ME, "done", { continueNo: 1, elapsedSec: 60 }, at(3))).rejects.toMatchObject({ code: "continue_unavailable", status: 409 });
    expect(repository.rows).toEqual([]);
    expect(repository.gems).toBe(50);
  });

  it("сверх числа продолжений за забег — «продолжать нечего», в том числе второе без первого", async () => {
    const { service, runs, repository } = setup(50);
    await started(runs, "run-1");
    await expect(service.buy(ME, "run-1", { continueNo: 2, elapsedSec: 60 }, at(3))).rejects.toMatchObject({ code: "continue_unavailable", status: 409 });
    expect(repository.rows).toEqual([]);
  });
});

describe("книга продолжений за самоцветы и сверка итога", () => {
  it("оплаченное продолжение не даёт unpaid; повтор без покупки — не оплачено", async () => {
    const { service, runs, continues } = setup(50);
    await started(runs, "run-1");
    expect(await continues.check("run-1", [125])).toEqual({ paid: 0, underpaid: false });
    await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 125 }, at(3));
    expect(await continues.check("run-1", [125])).toEqual({ paid: 1, underpaid: false });
    expect(await service.granted("run-1")).toEqual([1]);
    expect(await service.granted("other-run")).toEqual([]);
  });

  it("секунда в итоге на минуту позже оплаченной — недоплата; в той же минуте, раньше и выше потолка — нет", async () => {
    const { service, runs, continues } = setup(100);
    await started(runs, "run-1");
    await service.buy(ME, "run-1", { continueNo: 1, elapsedSec: 125 }, at(3));
    expect(await continues.check("run-1", [185])).toEqual({ paid: 1, underpaid: true });
    expect(await continues.check("run-1", [150])).toEqual({ paid: 1, underpaid: false });
    expect(await continues.check("run-1", [60])).toEqual({ paid: 1, underpaid: false });

    await started(runs, "capped");
    await service.buy(ME, "capped", { continueNo: 1, elapsedSec: 2_400 }, at(60));
    expect(await continues.check("capped", [3_000])).toEqual({ paid: 1, underpaid: false });
  });

  it("продолжение без строки об уплате в итоге не считается, лишняя секунда не недоплата", async () => {
    const { continues } = setup();
    expect(await continues.check("nothing", [100])).toEqual({ paid: 0, underpaid: false });
    expect(await continues.check("nothing", [])).toEqual({ paid: 0, underpaid: false });
  });

  it("без авторизации книга не подключается: базы нет, сверять нечего", async () => {
    const disabled = loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const continues = new RunContinues();
    const repository = new MemoryGemContinues(10);
    const service = new RunGemContinueService(disabled, new MemoryRunsRepository(), repository, { balances: async () => emptyBalances() }, continues);
    service.onModuleInit();
    repository.rows.push({ runId: "run-1", continueNo: 1, accountId: ME, elapsedSec: 60, priceGems: 2, grantedAt: NOON });
    expect(await continues.check("run-1", [60])).toEqual({ paid: 0, underpaid: false });
  });
});

describe("второй шанс за самоцветы по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(service: RunGemContinueService, limiter = new RateLimiter(unavailableRedis)): Promise<NestFastifyApplication> {
    @Module({
      controllers: [RunGemContinueController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: RunGemContinueService, useValue: service },
        { provide: RateLimiter, useValue: limiter },
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  const tokenOf = async (accountId = ME) =>
    await signAccessToken({ accountId, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());

  it("без токена — 401; кривые забег, секунда и тело — 400", async () => {
    const { service } = setup();
    const server = await start(service);
    const headers = { authorization: `Bearer ${await tokenOf()}` };
    const url = "/api/v1/runs/run-http-1/continues/gems";

    expect((await server.inject({ method: "GET", url: `${url}?elapsedSec=60` })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url, payload: { continueNo: 1, elapsedSec: 60 } })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/v1/runs/short/continues/gems?elapsedSec=60", headers })).statusCode).toBe(400);
    for (const query of ["", "?elapsedSec=", "?elapsedSec=abc", "?elapsedSec=-1", "?elapsedSec=1e3", "?elapsedSec=86401", "?elapsedSec=60&elapsedSec=70"]) {
      expect((await server.inject({ method: "GET", url: `${url}${query}`, headers })).statusCode, query).toBe(400);
    }
    for (const payload of [{}, { continueNo: 1 }, { elapsedSec: 60 }, { continueNo: 0, elapsedSec: 60 }, { continueNo: 1.5, elapsedSec: 60 }, { continueNo: 6, elapsedSec: 60 }, { continueNo: 1, elapsedSec: -1 }, { continueNo: 1, elapsedSec: 86_401 }, { continueNo: 1, elapsedSec: "60" }, { continueNo: 1, elapsedSec: 60, extra: true }]) {
      expect((await server.inject({ method: "POST", url, headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("GET отдаёт цену и баланс, POST — покупку; повтор — тот же ответ; отказы — 409 с кодом", async () => {
    const { service, runs, repository } = setup(10);
    const now = Date.now();
    await started(runs, "run-http-1", ME, new Date(now - 125_000));
    await started(runs, "run-http-2", ME, new Date(now - 125_000));
    const server = await start(service);
    const headers = { authorization: `Bearer ${await tokenOf()}` };
    const url = "/api/v1/runs/run-http-1/continues/gems";

    expect((await server.inject({ method: "GET", url: `${url}?elapsedSec=120`, headers })).json()).toEqual({
      data: { status: "available", continueNo: 1, priceGems: 3, balance: 10 },
    });
    const bought = await server.inject({ method: "POST", url, headers, payload: { continueNo: 1, elapsedSec: 120 } });
    expect(bought.statusCode).toBe(200);
    expect(bought.json()).toEqual({ data: { continueNo: 1, priceGems: 3, balance: 7 } });
    const again = await server.inject({ method: "POST", url, headers, payload: { continueNo: 1, elapsedSec: 120 } });
    expect(again.json()).toEqual(bought.json());
    expect(repository.gems).toBe(7);
    expect((await server.inject({ method: "GET", url: `${url}?elapsedSec=120`, headers })).json()).toEqual({ data: { status: "unavailable", reason: "used_up" } });

    const second = "/api/v1/runs/run-http-2/continues/gems";
    const exceeded = await server.inject({ method: "POST", url: second, headers, payload: { continueNo: 1, elapsedSec: 4_000 } });
    expect(exceeded.statusCode).toBe(400);
    expect(exceeded.json()).toMatchObject({ error: { code: "elapsed_exceeds_clock" } });
    repository.gems = 1;
    const poor = await server.inject({ method: "POST", url: second, headers, payload: { continueNo: 1, elapsedSec: 120 } });
    expect(poor.statusCode).toBe(409);
    expect(poor.json()).toMatchObject({ error: { code: "insufficient_funds" } });
  });

  it("чужой забег по HTTP неотличим от незнакомого", async () => {
    const { service, runs } = setup();
    await started(runs, "run-http-1", OTHER);
    const server = await start(service);
    const headers = { authorization: `Bearer ${await tokenOf()}` };
    const url = "/api/v1/runs/run-http-1/continues/gems";

    expect((await server.inject({ method: "GET", url: `${url}?elapsedSec=60`, headers })).json()).toEqual({ data: { status: "unavailable", reason: "unverified" } });
    const refused = await server.inject({ method: "POST", url, headers, payload: { continueNo: 1, elapsedSec: 60 } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "run_unverified" } });
  });

  it("лимит запросов по аккаунту: сверх него — 429, а покупка не доходит до сервиса", async () => {
    const { service, runs, repository } = setup(10);
    await started(runs, "run-http-1", ME, new Date(Date.now() - 125_000));
    const limiter = new RateLimiter(unavailableRedis);
    await limiter.consume(RUNS_LIMITS.gemContinue, ME, RUNS_LIMITS.gemContinue.limit);
    const server = await start(service, limiter);
    const headers = { authorization: `Bearer ${await tokenOf()}` };

    const limited = await server.inject({ method: "POST", url: "/api/v1/runs/run-http-1/continues/gems", headers, payload: { continueNo: 1, elapsedSec: 60 } });
    expect(limited.statusCode).toBe(429);
    expect((await server.inject({ method: "GET", url: "/api/v1/runs/run-http-1/continues/gems?elapsedSec=60", headers })).statusCode).toBe(429);
    expect(repository.rows).toEqual([]);
    // Лимит по аккаунту: чужой игрок его не делит.
    const other = await server.inject({ method: "GET", url: "/api/v1/runs/run-http-1/continues/gems?elapsedSec=60", headers: { authorization: `Bearer ${await tokenOf(OTHER)}` } });
    expect(other.statusCode).toBe(200);
  });
});
