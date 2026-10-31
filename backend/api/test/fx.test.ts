import { randomUUID } from "node:crypto";
import { Decimal, MemoryRateStore, quoteInUsd, rateOf, type RateSource } from "@bh/fx";
import { describe, expect, it } from "vitest";
import { DomainError, ForbiddenError, ValidationError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { FxAlertNotifier, fxAlertText, type FxAlertApi } from "../src/modules/admin-notify/fx-alert-notifier.js";
import { manualRateSchema, sourceLimitSchema, sourceUsedSchema } from "../src/modules/fx/dto/fx.dto.js";
import { FxHooks, type FxAlert } from "../src/modules/fx/fx-hooks.js";
import { FxRefreshBusyError, FxRefreshLimitError, FxRefreshPausedError, FxRefresher, fxSources } from "../src/modules/fx/fx.refresher.js";
import { FxService, FxSourceNotFoundError, type RefreshNowResult } from "../src/modules/fx/fx.service.js";
import type { LimitStore, SourceLimit } from "../src/modules/fx/fx.store.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { switchesOf, targetsOf } from "./helpers/notify-targets.js";
import { environmentSecrets } from "../src/modules/secrets/secrets.service.js";

/**
 * Модуль курсов бэкенда (docs/35-stage4-plan.md, WP9): проход под локом,
 * ключ CoinGecko из окружения, заданные курсы под правом и с аудитом,
 * алерты с окном тишины. Сеть не нужна — источники подставные.
 */

const OWNER_ID = "777000444";
const NOW = new Date("2026-09-25T12:00:00Z");

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ADMIN_TELEGRAM_IDS: OWNER_ID, ...patch } as NodeJS.ProcessEnv);
}

/** Redis на двух командах: `SET … NX` и снятие лока своим токеном. */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    const px = args.indexOf("PX");
    if (px >= 0) this.ttls.set(key, Number(args[px + 1]));
    return "OK";
  }

  async pttl(key: string): Promise<number> {
    return this.values.has(key) ? (this.ttls.get(key) ?? -1) : -2;
  }

  async eval(_script: string, _keys: number, key: string, token: string): Promise<number> {
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key);
    return 1;
  }
}

/** Хранилище ядра в памяти плюс лимиты источников из панели — то же поведение, что у Postgres. */
class MemoryFxStore extends MemoryRateStore implements LimitStore {
  readonly rows = new Map<string, SourceLimit>();

  async limits(): Promise<ReadonlyMap<string, SourceLimit>> {
    return new Map(this.rows);
  }

  async setLimit(source: string, perMonth: number | null, note: string, actor: string, now = new Date()): Promise<void> {
    this.rows.set(source, { perMonth, note, updatedBy: actor, updatedAt: now });
  }

  async resetLimit(source: string): Promise<void> {
    this.rows.delete(source);
  }

  async setUsed(source: string, used: number, month: string, now = new Date()): Promise<void> {
    const state = await this.sourceState(source);
    await this.saveSourceState(source, { usage: { month, used, pausedUntil: state?.usage.pausedUntil ?? null }, nextPollAt: state?.nextPollAt ?? now });
  }

  async pullPollForward(source: string, at: Date): Promise<void> {
    const state = await this.sourceState(source);
    if (state !== null && state.nextPollAt > at) await this.saveSourceState(source, { ...state, nextPollAt: at });
  }
}

function gramSource(usd: string): RateSource & { calls: number } {
  const source = {
    id: "fake",
    currencies: [],
    tariff: { name: "test", perMinute: 60, perMonth: null, minIntervalMs: 60_000 },
    calls: 0,
    async fetch() {
      source.calls++;
      return [quoteInUsd("GRAM", usd, "fake", NOW)];
    },
  };
  return source;
}

/** Обновление «сейчас» в тестах, которым оно не нужно: звать его нельзя. */
const NO_REFRESHER = { refreshNow: async () => Promise.reject(new Error("обновление не ожидалось")) };

describe("проход курсов по расписанию", () => {
  it("идёт под локом и снимает только свой лок", async () => {
    const redis = new FakeRedis();
    const store = new MemoryRateStore();
    const refresher = new FxRefresher(environmentSecrets(config({ FX_ENABLED: "true" })), store, redis as never, new FxHooks(), switchesOf(config({ FX_ENABLED: "true" })));

    const report = await refresher.tick([gramSource("1.43")], NOW);
    expect(report?.accepted).toEqual(["GRAM"]);
    expect(redis.values.has("fx:refresh:lock")).toBe(false);

    // Лок у другой реплики — проход не идёт и чужой лок не трогает.
    redis.values.set("fx:refresh:lock", "other-replica");
    const source = gramSource("1.44");
    expect(await refresher.tick([source], new Date(NOW.getTime() + 120_000))).toBeNull();
    expect(source.calls).toBe(0);
    expect(redis.values.get("fx:refresh:lock")).toBe("other-replica");
  });

  it("недоступный Redis — пропуск прохода, а не падение", async () => {
    const broken = { set: async () => Promise.reject(new Error("ECONNREFUSED")), eval: async () => 0 };
    const refresher = new FxRefresher(environmentSecrets(config({ FX_ENABLED: "true" })), new MemoryRateStore(), broken as never, new FxHooks(), switchesOf(config({ FX_ENABLED: "true" })));
    await expect(refresher.tick([gramSource("1.43")], NOW)).resolves.toBeNull();
  });

  it("отклонённый скачок и молчание уходят слушателям хуков", async () => {
    const hooks = new FxHooks();
    const alerts: FxAlert[] = [];
    hooks.onAlert("test", async (alert) => void alerts.push(alert));
    const store = new MemoryRateStore();
    const refresher = new FxRefresher(environmentSecrets(config({ FX_ENABLED: "true" })), store, new FakeRedis() as never, hooks, switchesOf(config({ FX_ENABLED: "true" })));

    await refresher.tick([gramSource("1.43")], NOW);
    await refresher.tick([gramSource("0.50")], new Date(NOW.getTime() + 120_000));
    await new Promise((resolve) => setImmediate(resolve));

    expect(alerts).toContainEqual({ kind: "rate_rejected", currency: "GRAM", reason: "jump_unconfirmed", candidate: "0.5", previous: "1.43" });
    expect(alerts).toContainEqual({ kind: "rate_stale", currency: "XTR", state: "missing", purpose: "payout" });
  });
});

describe("источники из окружения", () => {
  it("ключ CoinGecko выбирает тариф, платный важнее демо", () => {
    const tariff = (patch: Record<string, string>) => fxSources(environmentSecrets(config(patch))).find((source) => source.id === "coingecko")?.tariff.name;
    expect(tariff({})).toBe("keyless");
    expect(tariff({ FX_COINGECKO_DEMO_KEY: "CG-demo" })).toBe("demo");
    expect(tariff({ FX_COINGECKO_DEMO_KEY: "CG-demo", FX_COINGECKO_PRO_KEY: "CG-pro" })).toBe("pro");
  });

  it("CoinMarketCap: без ключа его нет среди источников, с ключом — есть и идёт после CoinGecko", () => {
    const withKeys = (values: Record<string, string>) => ({ get: (secret: { key: string }) => values[secret.key] ?? null });
    const ids = (values: Record<string, string>) => fxSources(withKeys(values)).map((source) => source.id);
    expect(ids({})).not.toContain("coinmarketcap");
    const keyed = ids({ "fx.coinmarketcap": "12345678-aaaa-4bbb-8ccc-123456789abc" });
    expect(keyed).toContain("coinmarketcap");
    expect(keyed.indexOf("coinmarketcap")).toBe(keyed.indexOf("coingecko") + 1);
  });

  it("ForexRateAPI: без ключа его нет, с ключом — сразу после erapi", () => {
    const ids = (values: Record<string, string>) => fxSources({ get: (secret) => values[secret.key] ?? null }).map((source) => source.id);
    expect(ids({})).toEqual(["cbr", "ecb", "erapi", "coingecko", "tonapi", "binance"]);
    const keyed = ids({ "fx.forexrateapi": "0123456789abcdef0123456789abcdef" });
    expect(keyed.indexOf("forexrateapi")).toBe(keyed.indexOf("erapi") + 1);
  });

  it("tonapi и erapi: без ключей — прежние тарифы, с ключами — свои", () => {
    const tariffs = (values: Record<string, string>) => {
      const sources = fxSources({ get: (secret) => values[secret.key] ?? null });
      return [sources.find((source) => source.id === "tonapi")?.tariff.name, sources.find((source) => source.id === "erapi")?.tariff.name];
    };
    expect(tariffs({})).toEqual(["keyless", "open-access"]);
    expect(tariffs({ "fx.tonapi": "AFTONAPIKEYSECRET1234567890", "fx.erapi": "0123456789abcdef01234567" })).toEqual(["keyed", "keyed"]);
  });

  it("опрос выключен по умолчанию: включённый ходит в интернет", () => {
    expect(switchesOf(config()).fxPolling()).toBe(false);
    expect(switchesOf(config({ FX_ENABLED: "true" })).fxPolling()).toBe(true);
    expect(fxSources(environmentSecrets(config())).map((source) => source.id)).toEqual(["cbr", "ecb", "erapi", "coingecko", "tonapi", "binance"]);
  });
});

describe("заданные курсы", () => {
  function setup() {
    const roles = new MemoryRolesRepository();
    const service = new FxService(new MemoryFxStore(), environmentSecrets(config()), new RolesService(config(), roles, new MemoryAccountRepository()), switchesOf(config()), NO_REFRESHER);
    return { service, roles };
  }
  const owner: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };
  const input = { currency: "XTR" as const, purpose: "payout" as const, price: "0.013", quote: "USD" as const, expiresInDays: 30, note: "вывод звёзд" };

  it("ставится под правом, с аудитом и сроком годности", async () => {
    const { service, roles } = setup();
    const saved = await service.setManual(owner, input, NOW);

    expect(saved).toMatchObject({ currency: "XTR", purpose: "payout", price: "0.013", quote: "USD", usdPerUnit: "0.013", expiresAt: "2026-10-25T12:00:00.000Z" });
    expect(roles.entries[0]).toMatchObject({ action: "fx.manual_rate", target: "XTR:payout", before: null, after: { price: "0.013", quote: "USD" } });
    const overview = await service.overview(NOW);
    expect(overview.manual.map((rate) => [rate.purpose, rate.freshness])).toEqual([["payout", "fresh"]]);
    expect(overview.missing).toEqual(expect.arrayContaining(["RUB", "EUR", "GRAM", "USDT"]));
  });

  it("без права — отказ, у рыночной валюты курс запасной (в долларах и на цену), ноль — ошибка", async () => {
    const { service } = setup();
    await expect(service.setManual({ ...owner, platformUserId: "555" }, input, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setManual(owner, { ...input, currency: "GRAM" as never }, NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.setManual(owner, { ...input, price: "0" }, NOW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("ручной курс рыночной валюты — запасной: в обзоре помечен, «в работе» только пока рыночного курса нет (T-0064)", async () => {
    const store = new MemoryFxStore();
    const service = new FxService(store, environmentSecrets(config()), new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository()), switchesOf(config()), NO_REFRESHER);
    const rub = { currency: "RUB" as const, purpose: "price" as const, price: "0.011", quote: "USD" as const, expiresInDays: 7, note: "источники легли" };

    const saved = await service.setManual(owner, rub, NOW);
    expect(saved).toMatchObject({ currency: "RUB", purpose: "price", quote: "USD", fallback: true });
    expect((await service.overview(NOW)).manual.find((rate) => rate.currency === "RUB")?.fallback).toBe(true);

    // Рыночный курс появился и свежий — запасной остаётся в списке, но не в работе.
    await store.setCurrentRate(rateOf("RUB", new Decimal(1).div("90"), ["cbr"], NOW), NOW);
    expect((await service.overview(NOW)).manual.find((rate) => rate.currency === "RUB")?.fallback).toBe(false);
    // Курс звезды — не запасной никогда.
    expect((await service.setManual(owner, input, NOW)).fallback).toBe(false);
  });

  it("цена звезды в рублях показывается и в долларах по курсу рубля, без курса — честное «нет»", async () => {
    const store = new MemoryFxStore();
    const service = new FxService(store, environmentSecrets(config()), new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository()), switchesOf(config()), NO_REFRESHER);
    const rub = { ...input, purpose: "price" as const, price: "1.72", quote: "RUB" as const };
    expect((await service.setManual(owner, rub, NOW)).usdPerUnit).toBeNull();

    await store.setCurrentRate(rateOf("RUB", new Decimal(1).div("84.6952"), ["cbr"], NOW), NOW);
    const [price] = (await service.overview(NOW)).manual;
    expect(price).toMatchObject({ purpose: "price", price: "1.72", quote: "RUB" });
    expect(Number(price?.usdPerUnit)).toBeCloseTo(0.02031, 5);
  });
});

describe("схема ручного курса (T-0064)", () => {
  const body = { currency: "XTR", purpose: "payout", price: "0.013", expiresInDays: 90, note: "вывод звёзд" };
  const refused = (patch: Record<string, unknown>) => manualRateSchema.safeParse({ ...body, ...patch });
  const RESERVE = "У рыночной валюты ручной курс — запасной: в долларах и только для цен";

  it("звёзды — до 90 дней, любая котировка-фиат, любая цель", () => {
    expect(refused({}).success).toBe(true);
    expect(refused({ expiresInDays: 91 }).success).toBe(false);
    expect(refused({ purpose: "price", quote: "RUB" }).success).toBe(true);
  });

  it("рубль — до 7 дней и только USD и price; остальное — 400 с понятным текстом", () => {
    const rub = { currency: "RUB", purpose: "price", price: "0.011", quote: "USD", expiresInDays: 7 };
    expect(refused(rub).success).toBe(true);
    expect(refused({ ...rub, quote: undefined }).success).toBe(true);
    for (const patch of [{ quote: "EUR" }, { quote: "RUB" }, { purpose: "payout" }]) {
      const result = refused({ ...rub, ...patch });
      expect(result.success).toBe(false);
      expect(!result.success && result.error.issues.map((issue) => issue.message)).toContain(RESERVE);
    }
    expect(refused({ ...rub, expiresInDays: 8 }).success).toBe(false);
  });

  it("Gram и USDT тоже; доллару курс не задают", () => {
    for (const currency of ["GRAM", "USDT", "EUR"]) expect(refused({ currency, purpose: "price", expiresInDays: 3 }).success, currency).toBe(true);
    expect(refused({ currency: "USD", purpose: "price", expiresInDays: 3 }).success).toBe(false);
  });
});

describe("«Обновить сейчас» (T-0064)", () => {
  const cfg = () => config({ FX_ENABLED: "true" });
  const SOURCE = "fake";

  function fake(perMonth: number | null = null): RateSource & { calls: number } {
    const result = {
      id: SOURCE,
      currencies: [],
      tariff: { name: "test", perMinute: 10, perMonth, minIntervalMs: 60_000 },
      calls: 0,
      async fetch() {
        result.calls++;
        return [quoteInUsd("GRAM", "5.41", SOURCE, NOW), quoteInUsd("USDT", "1", SOURCE, NOW)];
      },
    };
    return result;
  }

  function setup() {
    const redis = new FakeRedis();
    const store = new MemoryFxStore();
    const hooks = new FxHooks();
    const alerts: FxAlert[] = [];
    hooks.onAlert("test", async (alert) => void alerts.push(alert));
    const refresher = new FxRefresher(environmentSecrets(cfg()), store, redis as never, hooks, switchesOf(cfg()));
    return { redis, store, refresher, alerts };
  }

  it("опрашивает источник сразу, мимо расписания: курсы приняты, снимок взят, пауза до следующего запроса поставлена", async () => {
    const { redis, store, refresher } = setup();
    const source = fake();
    // Расписание говорит «рано»: обычный проход источник не тронул бы.
    await store.saveSourceState(SOURCE, { usage: { month: "2026-09", used: 3, pausedUntil: null }, nextPollAt: new Date(NOW.getTime() + 3_600_000) });

    const result = await refresher.refreshNow(SOURCE, NOW, [source]);

    expect(source.calls).toBe(1);
    expect(result).toMatchObject({ source: SOURCE, ok: true, error: null });
    expect(result.quotes).toEqual([
      { currency: "GRAM", usdPerUnit: "5.41", status: "accepted" },
      { currency: "USDT", usdPerUnit: "1", status: "accepted" },
    ]);
    expect((await store.snapshot(result.snapshotId))?.rates.has("GRAM")).toBe(true);
    expect((await store.sourceState(SOURCE))?.usage.used).toBe(4);
    // Пауза — 60 000 / perMinute мс; лок снят.
    expect(redis.ttls.get(`fx:poll-gap:${SOURCE}`)).toBe(6_000);
    expect(redis.values.has("fx:refresh:lock")).toBe(false);
  });

  it("источник не ответил — это исход, а не ошибка запроса: причина в ответе, снимок взят, запрос учтён", async () => {
    const { store, refresher, alerts } = setup();
    const broken: RateSource = { ...fake(), fetch: async () => Promise.reject(new Error("HTTP 502")) };

    const result = await refresher.refreshNow(SOURCE, NOW, [broken]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toMatchObject({ ok: false, quotes: [], error: "HTTP 502" });
    expect(result.snapshotId).toBeTruthy();
    expect((await store.sourceState(SOURCE))?.usage.used).toBe(1);
    expect(alerts).toContainEqual({ kind: "source_failed", source: SOURCE, reason: "HTTP 502" });
  });

  it("месячный лимит исчерпан — отказ до опроса; лимит из панели важнее тарифа из кода", async () => {
    const { store, refresher } = setup();
    const source = fake(10);
    await store.saveSourceState(SOURCE, { usage: { month: "2026-09", used: 10, pausedUntil: null }, nextPollAt: NOW });

    await expect(refresher.refreshNow(SOURCE, NOW, [source])).rejects.toBeInstanceOf(FxRefreshLimitError);
    expect(source.calls).toBe(0);

    await store.setLimit(SOURCE, 20, "поставщик поднял тариф", "owner", NOW);
    await expect(refresher.refreshNow(SOURCE, NOW, [source])).resolves.toMatchObject({ ok: true });
    expect(source.calls).toBe(1);
  });

  it("счётчик прошлого месяца лимита не съедает", async () => {
    const { store, refresher } = setup();
    await store.saveSourceState(SOURCE, { usage: { month: "2026-08", used: 10, pausedUntil: null }, nextPollAt: NOW });
    await expect(refresher.refreshNow(SOURCE, NOW, [fake(10)])).resolves.toMatchObject({ ok: true });
  });

  it("с прошлого опроса прошло меньше 60 000 / perMinute — отказ с секундами, источник не тронут", async () => {
    const { redis, refresher } = setup();
    const source = fake();
    redis.values.set(`fx:poll-gap:${SOURCE}`, "1");
    redis.ttls.set(`fx:poll-gap:${SOURCE}`, 4_200);

    const error = await refresher.refreshNow(SOURCE, NOW, [source]).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(FxRefreshPausedError);
    expect((error as FxRefreshPausedError).seconds).toBe(5);
    expect(source.calls).toBe(0);
  });

  it("проход по расписанию тоже ставит паузу: следующий «сейчас» упрётся в неё", async () => {
    const { redis, refresher } = setup();
    await refresher.tick([fake()], NOW);
    expect(redis.ttls.get(`fx:poll-gap:${SOURCE}`)).toBe(6_000);
  });

  it("лок занят — FxRefreshBusyError, источник не тронут, чужой лок цел", async () => {
    const { redis, refresher } = setup();
    const source = fake();
    redis.values.set("fx:refresh:lock", "other-replica");

    await expect(refresher.refreshNow(SOURCE, NOW, [source])).rejects.toBeInstanceOf(FxRefreshBusyError);
    expect(source.calls).toBe(0);
    expect(redis.values.get("fx:refresh:lock")).toBe("other-replica");
  });

  it("недоступный Redis — понятная ошибка, а не молчаливый опрос мимо лока", async () => {
    const { store } = setup();
    const broken = { set: async () => Promise.reject(new Error("ECONNREFUSED")), eval: async () => 0, pttl: async () => -2 };
    const refresher = new FxRefresher(environmentSecrets(cfg()), store, broken as never, new FxHooks(), switchesOf(cfg()));
    const source = fake();

    await expect(refresher.refreshNow(SOURCE, NOW, [source])).rejects.toThrow();
    expect(source.calls).toBe(0);
  });

  describe("в панели: сервис", () => {
    const cfgOwner = () => config();
    const owner: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };
    const result: RefreshNowResult = { source: "coingecko", ok: true, error: null, quotes: [{ currency: "GRAM", usdPerUnit: "5.41", status: "accepted" }], snapshotId: "s1" };

    function serviceWith(refresher: Pick<FxRefresher, "refreshNow">) {
      const roles = new MemoryRolesRepository();
      const service = new FxService(new MemoryFxStore(), environmentSecrets(cfgOwner()), new RolesService(cfgOwner(), roles, new MemoryAccountRepository()), switchesOf(cfgOwner()), refresher);
      return { service, roles };
    }

    it("успех: ответ источника и запись в аудит с источником и исходом", async () => {
      const { service, roles } = serviceWith({ refreshNow: async () => result });

      expect(await service.refreshNow(owner, "coingecko", NOW)).toEqual(result);
      expect(roles.entries).toEqual([expect.objectContaining({ action: "fx.refresh.now", target: "coingecko", actorAccountId: owner.accountId, after: { ok: true, error: null, quotes: [{ currency: "GRAM", status: "accepted" }] } })]);
    });

    it("без права — отказ; неизвестный источник — 404", async () => {
      const { service } = serviceWith({ refreshNow: async () => result });
      await expect(service.refreshNow({ ...owner, platformUserId: "555" }, "coingecko", NOW)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.refreshNow(owner, "нет-такого", NOW)).rejects.toBeInstanceOf(FxSourceNotFoundError);
    });

    it("лимит — 409, пауза — 429 с секундами, занято — 409; тексты из решений, аудита нет", async () => {
      const failing = (error: Error) => serviceWith({ refreshNow: async () => Promise.reject(error) });
      const cases: [Error, number, string][] = [
        [new FxRefreshLimitError(), 409, "Лимит источника на месяц исчерпан"],
        [new FxRefreshPausedError(7), 429, "Источник спрашивали только что — повторите через 7 с"],
        [new FxRefreshBusyError(), 409, "Идёт обновление по расписанию, повторите через минуту"],
      ];
      for (const [error, status, message] of cases) {
        const { service, roles } = failing(error);
        const refusal = await service.refreshNow(owner, "coingecko", NOW).catch((reason: unknown) => reason);
        expect(refusal).toBeInstanceOf(DomainError);
        expect(refusal).toMatchObject({ status, message });
        expect(roles.entries).toEqual([]);
      }
    });
  });
});

describe("алерты курсов в чат команды", () => {
  const chatConfig = () => config({ FX_ENABLED: "true", ADMIN_CHAT_ID: "-1001234567890", TELEGRAM_BOT_TOKEN: "123:TEST" });
  const notifierOf = (cfg: AppConfig, api: FxAlertApi) => new FxAlertNotifier(cfg, targetsOf(cfg), switchesOf(cfg), new FxHooks(), new FakeRedis() as never, api);

  it("одна причина — один алерт за окно тишины", async () => {
    const sent: string[] = [];
    const notifier = notifierOf(chatConfig(), { sendMessage: async (_chat, text) => (sent.push(text), 1) });
    const stale: FxAlert = { kind: "rate_stale", currency: "GRAM", state: "stale", purpose: null };

    await notifier.deliver(stale);
    await notifier.deliver(stale);
    await notifier.deliver({ ...stale, state: "expired" });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("продавать по нему больше нельзя");
  });

  it("выключен без опроса курсов, без чата или без бота", () => {
    const off = (patch: Record<string, string>) => notifierOf(config(patch), { sendMessage: async () => 1 }).enabled;
    expect(off({ ADMIN_CHAT_ID: "-100123", TELEGRAM_BOT_TOKEN: "123:TEST" })).toBe(false);
    expect(off({ FX_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123:TEST" })).toBe(false);
    expect(notifierOf(chatConfig(), { sendMessage: async () => 1 }).enabled).toBe(true);
  });

  it("текст говорит, что случилось и что делать", () => {
    expect(fxAlertText({ kind: "rate_rejected", currency: "GRAM", reason: "jump_unconfirmed", candidate: "0.5", previous: "1.43" })).toContain("не подтвердил второй источник");
    expect(fxAlertText({ kind: "rate_stale", currency: "XTR", state: "missing", purpose: "payout" })).toContain("Поставьте новый в панели");
    expect(fxAlertText({ kind: "source_failed", source: "cbr", reason: "ответ 503" })).toContain("Остальные продолжают");
  });
});

describe("предупреждения о расходе лимита", () => {
  const cfg = () => config({ FX_ENABLED: "true" });
  const SEPTEMBER = "2026-09";
  const due = new Date(NOW.getTime() - 1000);

  /** Источник без месячного лимита в коде — лимит ему задают в панели. */
  function quietSource(): RateSource & { calls: number } {
    const source = {
      id: "fake",
      currencies: [],
      tariff: { name: "test", perMinute: 60, perMonth: null, minIntervalMs: 60_000 },
      calls: 0,
      async fetch() {
        source.calls++;
        return [quoteInUsd("GRAM", "1.43", "fake", NOW)];
      },
    };
    return source;
  }

  async function setup(perMonth: number | null = 10) {
    const store = new MemoryFxStore();
    const redis = new FakeRedis();
    const hooks = new FxHooks();
    const budget: Extract<FxAlert, { kind: "source_budget" }>[] = [];
    hooks.onAlert("test", async (alert) => {
      if (alert.kind === "source_budget") budget.push(alert);
    });
    if (perMonth !== null) await store.setLimit("fake", perMonth, "тест", randomUUID(), NOW);
    const refresher = new FxRefresher(environmentSecrets(cfg()), store, redis as never, hooks, switchesOf(cfg()));
    /** Состояние источника перед проходом: опрос пора делать, в месяце уже `used` запросов. */
    const seed = (used: number, month = SEPTEMBER) => store.saveSourceState("fake", { usage: { month, used, pausedUntil: null }, nextPollAt: due });
    const pass = async (at = NOW) => {
      const report = await refresher.tick([quietSource()], at);
      await new Promise((resolve) => setImmediate(resolve));
      return report;
    };
    return { store, redis, budget, seed, pass };
  }

  it("80% перейдён — одно событие с цифрами и месяцем", async () => {
    const { budget, seed, pass } = await setup();
    await seed(7);
    await pass();
    expect(budget).toEqual([{ kind: "source_budget", source: "fake", month: SEPTEMBER, used: 8, perMonth: 10, threshold: 80 }]);
  });

  it("второй проход в тот же месяц повторно порог не называет, 100% приходит отдельно", async () => {
    const { budget, redis, seed, pass } = await setup();
    await seed(7);
    await pass();
    // Вторая реплика или повтор прохода: счётчик снова проходит 80% — сообщения нет.
    await seed(7);
    await pass();
    expect(budget).toHaveLength(1);
    expect(redis.values.has("fx:budget:fake:2026-09:80")).toBe(true);

    await seed(9);
    await pass();
    expect(budget.map((alert) => alert.threshold)).toEqual([80, 100]);
    expect(budget[1]).toMatchObject({ used: 10, perMonth: 10 });
  });

  it("за один проход через оба порога приходят оба сообщения", async () => {
    const { budget, seed, pass } = await setup(1);
    await seed(0);
    await pass();
    expect(budget.map((alert) => alert.threshold)).toEqual([80, 100]);
  });

  it("новый месяц — порог снова за один раз", async () => {
    const { budget, seed, pass } = await setup();
    await seed(7);
    await pass();
    const october = new Date("2026-10-02T12:00:00Z");
    // Счётчик сентября в октябре не считается: 9 из прошлого месяца — это 0.
    await seed(9);
    await pass(october);
    expect(budget).toHaveLength(1);
    await seed(7, "2026-10");
    await pass(october);
    expect(budget.map((alert) => [alert.month, alert.threshold])).toEqual([
      [SEPTEMBER, 80],
      ["2026-10", 80],
    ]);
  });

  it("без лимита сообщений нет, источник без опроса в этом проходе — тоже", async () => {
    const { budget, seed, pass } = await setup(null);
    await seed(99_999);
    await pass();
    expect(budget).toEqual([]);

    const waiting = await setup();
    await waiting.store.saveSourceState("fake", { usage: { month: SEPTEMBER, used: 8, pausedUntil: null }, nextPollAt: new Date(NOW.getTime() + 3_600_000) });
    await waiting.pass();
    expect(waiting.budget).toEqual([]);
  });

  it("опрос идёт по лимиту из панели, а источник в коде не меняется", async () => {
    const { store, seed } = await setup();
    await seed(7);
    const source = quietSource();
    const refresher = new FxRefresher(environmentSecrets(cfg()), store, new FakeRedis() as never, new FxHooks(), switchesOf(cfg()));
    await refresher.tick([source], NOW);

    // Остаток — две единицы на пять суток: следующий опрос не через минуту, как без лимита.
    const state = await store.sourceState("fake");
    expect((state?.nextPollAt.getTime() ?? 0) - NOW.getTime()).toBeGreaterThan(24 * 3_600_000);
    expect(source.tariff.perMonth).toBeNull();
  });

  it("Redis с порогами недоступен — проход и курсы целы, сообщение не уходит", async () => {
    const { store, seed } = await setup();
    await seed(7);
    class Flaky extends FakeRedis {
      override async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
        if (key.startsWith("fx:budget:")) throw new Error("ECONNRESET");
        return await super.set(key, value, ...args);
      }
    }
    const refresher = new FxRefresher(environmentSecrets(cfg()), store, new Flaky() as never, new FxHooks(), switchesOf(cfg()));
    const report = await refresher.tick([quietSource()], NOW);
    expect(report?.accepted).toEqual(["GRAM"]);
  });
});

describe("лимиты источников в панели", () => {
  const demo = () => config({ FX_COINGECKO_DEMO_KEY: "CG-demo" });
  const owner: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };
  const stranger: AccountRef = { ...owner, accountId: randomUUID(), platformUserId: "555" };
  const MONTH_END = new Date("2026-10-01T00:00:00Z");

  function setup() {
    const roles = new MemoryRolesRepository();
    const store = new MemoryFxStore();
    const cfg = demo();
    const service = new FxService(store, environmentSecrets(cfg), new RolesService(cfg, roles, new MemoryAccountRepository()), switchesOf(cfg), NO_REFRESHER);
    const seed = (used: number, nextPollAt = new Date(NOW.getTime() + 60_000), month = "2026-09") =>
      store.saveSourceState("coingecko", { usage: { month, used, pausedUntil: null }, nextPollAt });
    const view = async () => (await service.overview(NOW)).sources.find((source) => source.source === "coingecko");
    return { service, store, roles, seed, view };
  }

  describe("обзор", () => {
    it("лимит по тарифу из кода и доля израсходованного", async () => {
      const { seed, view } = setup();
      await seed(6_120);
      const source = await view();
      expect(source).toMatchObject({ tariff: "demo", month: "2026-09", used: 6_120, limit: { perMonth: 10_000, from: "tariff" } });
      expect(source?.usedShare).toBeCloseTo(0.612, 6);
    });

    it("лимит из панели важнее тарифа, «без лимита» доли не даёт, сброс возвращает тариф", async () => {
      const { service, seed, view } = setup();
      await seed(6_120);

      await service.setLimit(owner, "coingecko", 20_000, "поставщик поднял тариф", NOW);
      const raised = await view();
      expect(raised).toMatchObject({ tariff: "demo", limit: { perMonth: 20_000, from: "panel" } });
      expect(raised?.usedShare).toBeCloseTo(0.306, 6);

      await service.setLimit(owner, "coingecko", null, "безлимитный план", NOW);
      expect(await view()).toMatchObject({ limit: { perMonth: null, from: "panel" }, usedShare: null });

      await service.resetLimit(owner, "coingecko", NOW);
      expect(await view()).toMatchObject({ limit: { perMonth: 10_000, from: "tariff" } });
    });

    it("источник без месячного лимита в коде: лимита нет, доли нет", async () => {
      const { service } = setup();
      const cbr = (await service.overview(NOW)).sources.find((source) => source.source === "cbr");
      expect(cbr).toMatchObject({ used: 0, limit: { perMonth: null, from: "tariff" }, usedShare: null });
    });

    it("счётчик прошлого месяца в новом — ноль", async () => {
      const { seed, view } = setup();
      await seed(9_000, undefined, "2026-08");
      expect(await view()).toMatchObject({ used: 0, usedShare: 0 });
    });
  });

  describe("правки", () => {
    it("без fx.rates.edit — отказ, ничего не записано", async () => {
      const { service, store, roles, seed } = setup();
      await seed(100);
      await expect(service.setLimit(stranger, "coingecko", 5_000, "хочу", NOW)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.resetLimit(stranger, "coingecko", NOW)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.correctUsed(stranger, "coingecko", 1, "хочу", NOW)).rejects.toBeInstanceOf(ForbiddenError);
      expect(store.rows.size).toBe(0);
      expect((await store.sourceState("coingecko"))?.usage.used).toBe(100);
      expect(roles.entries).toEqual([]);
    });

    it("неизвестный источник — 404", async () => {
      const { service, roles } = setup();
      for (const call of [
        () => service.setLimit(owner, "nope", 5_000, "причина", NOW),
        () => service.resetLimit(owner, "nope", NOW),
        () => service.correctUsed(owner, "nope", 1, "причина", NOW),
      ]) {
        const error = await call().then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(FxSourceNotFoundError);
        expect(error).toMatchObject({ status: 404 });
      }
      expect(roles.entries).toEqual([]);
    });

    it("лимит: аудит «было → стало», первый раз — из тарифа, второй — из панели", async () => {
      const { service, store, roles } = setup();
      await service.setLimit(owner, "coingecko", 20_000, "поставщик поднял тариф", NOW);
      await service.setLimit(owner, "coingecko", null, "безлимитный план", NOW);

      expect(roles.entries[0]).toMatchObject({
        actorAccountId: owner.accountId,
        action: "fx.limit.set",
        target: "coingecko",
        before: { perMonth: 10_000, from: "tariff" },
        after: { perMonth: 20_000, from: "panel", note: "поставщик поднял тариф" },
      });
      expect(roles.entries[1]).toMatchObject({ before: { perMonth: 20_000, from: "panel" }, after: { perMonth: null, from: "panel", note: "безлимитный план" } });
      expect(store.rows.get("coingecko")).toMatchObject({ perMonth: null, note: "безлимитный план", updatedBy: owner.accountId, updatedAt: NOW });
    });

    it("сброс: аудит, строка убрана; сброс без строки — не событие для журнала", async () => {
      const { service, store, roles } = setup();
      await service.resetLimit(owner, "coingecko", NOW);
      expect(roles.entries).toEqual([]);

      await service.setLimit(owner, "coingecko", 500, "тест", NOW);
      await service.resetLimit(owner, "coingecko", NOW);
      expect(store.rows.size).toBe(0);
      expect(roles.entries.at(-1)).toMatchObject({ action: "fx.limit.reset", target: "coingecko", before: { perMonth: 500, from: "panel" }, after: { perMonth: 10_000, from: "tariff" } });
    });

    it("счётчик: новое значение за текущий месяц, аудит «было → стало»", async () => {
      const { service, roles, seed, view } = setup();
      await seed(6_120);
      const corrected = await service.correctUsed(owner, "coingecko", 5_000, "сверились с кабинетом", NOW);

      expect(corrected).toMatchObject({ source: "coingecko", month: "2026-09", used: 5_000 });
      expect((await view())?.used).toBe(5_000);
      expect(roles.entries[0]).toMatchObject({
        action: "fx.used.correct",
        target: "coingecko",
        before: { month: "2026-09", used: 6_120 },
        after: { month: "2026-09", used: 5_000, note: "сверились с кабинетом" },
      });
    });

    it("счётчик источника без состояния и с прошлым месяцем: ложится в текущий", async () => {
      const { service, store, roles, seed } = setup();
      await service.correctUsed(owner, "coingecko", 70, "первый ввод", NOW);
      expect(await store.sourceState("coingecko")).toMatchObject({ usage: { month: "2026-09", used: 70 } });

      await seed(9_000, undefined, "2026-08");
      await service.correctUsed(owner, "coingecko", 70, "после смены месяца", NOW);
      expect(await store.sourceState("coingecko")).toMatchObject({ usage: { month: "2026-09", used: 70 } });
      expect(roles.entries[1]).toMatchObject({ before: { month: "2026-09", used: 0 }, after: { used: 70 } });
    });

    it("лимит поднят у исчерпанного источника — опрос идёт сразу, а не с нового месяца", async () => {
      const { service, store, seed } = setup();
      await seed(10_000, MONTH_END);
      await service.setLimit(owner, "coingecko", 20_000, "поставщик поднял тариф", NOW);

      const next = (await store.sourceState("coingecko"))?.nextPollAt ?? MONTH_END;
      expect(next.getTime()).toBeGreaterThan(NOW.getTime());
      expect(next.getTime()).toBeLessThan(MONTH_END.getTime());
    });

    it("счётчик поправлен у исчерпанного источника — то же самое", async () => {
      const { service, store, seed } = setup();
      await seed(10_000, MONTH_END);
      await service.correctUsed(owner, "coingecko", 9_000, "сверились с кабинетом", NOW);
      expect((await store.sourceState("coingecko"))?.nextPollAt.getTime()).toBeLessThan(MONTH_END.getTime());
    });

    it("правка опрос не откладывает: ближайший срок остаётся, источник без состояния ждёт своего первого опроса", async () => {
      const { service, store, seed } = setup();
      const soon = new Date(NOW.getTime() + 30_000);
      await seed(100, soon);
      await service.setLimit(owner, "coingecko", 500, "урезали тариф", NOW);
      expect((await store.sourceState("coingecko"))?.nextPollAt).toEqual(soon);

      await service.setLimit(owner, "cbr", 500, "тест", NOW);
      expect(await store.sourceState("cbr")).toBeNull();
    });
  });

  describe("границы тела запроса", () => {
    it("лимит — целое от 1 до 100 000 000 или null, причина — 3…200 после trim", () => {
      expect(sourceLimitSchema.parse({ perMonth: 10_000, note: "  причина  " })).toEqual({ perMonth: 10_000, note: "причина" });
      expect(sourceLimitSchema.parse({ perMonth: null, note: "без лимита" }).perMonth).toBeNull();
      expect(sourceLimitSchema.parse({ perMonth: 1, note: "abc" }).perMonth).toBe(1);
      expect(sourceLimitSchema.parse({ perMonth: 100_000_000, note: "abc" }).perMonth).toBe(100_000_000);
      for (const bad of [
        { perMonth: 0, note: "причина" },
        { perMonth: -5, note: "причина" },
        { perMonth: 100_000_001, note: "причина" },
        { perMonth: 1.5, note: "причина" },
        { perMonth: "10", note: "причина" },
        { note: "причина" },
        { perMonth: 100, note: "  ab  " },
        { perMonth: 100, note: "я".repeat(201) },
        { perMonth: 100 },
      ]) {
        expect(sourceLimitSchema.safeParse(bad).success).toBe(false);
      }
    });

    it("счётчик — целое от 0 до 100 000 000", () => {
      expect(sourceUsedSchema.parse({ used: 0, note: "сверка" })).toEqual({ used: 0, note: "сверка" });
      expect(sourceUsedSchema.parse({ used: 100_000_000, note: "сверка" }).used).toBe(100_000_000);
      for (const bad of [{ used: -1, note: "сверка" }, { used: 100_000_001, note: "сверка" }, { used: 0.5, note: "сверка" }, { used: null, note: "сверка" }, { used: 5, note: "  " }]) {
        expect(sourceUsedSchema.safeParse(bad).success).toBe(false);
      }
    });
  });
});

describe("сообщения о расходе лимита", () => {
  const NB = " ";
  const budget = (patch: Partial<Extract<FxAlert, { kind: "source_budget" }>> = {}): FxAlert => ({
    kind: "source_budget",
    source: "coingecko",
    month: "2026-10",
    used: 8_000,
    perMonth: 10_000,
    threshold: 80,
    ...patch,
  });

  it("80%: сколько израсходовано, за какой месяц и до какого числа хватит", () => {
    expect(fxAlertText(budget())).toContain(`CoinGecko: израсходовано 8${NB}000 из 10${NB}000 запросов за октябрь (80%). Курс опрашивается реже, до 1 ноября хватит`);
  });

  it("100%: лимит исчерпан, источник молчит до первого числа, курс берут остальные", () => {
    expect(fxAlertText(budget({ threshold: 100, used: 10_000 }))).toContain(`CoinGecko: лимит 10${NB}000 запросов за октябрь исчерпан. Источник молчит до 1 ноября, курс берут остальные`);
  });

  it("декабрь заканчивается на 1 января следующего года, месяцы — в нужных падежах", () => {
    expect(fxAlertText(budget({ month: "2026-12" }))).toContain("за декабрь");
    expect(fxAlertText(budget({ month: "2026-12" }))).toContain("до 1 января");
    expect(fxAlertText(budget({ month: "2026-03", threshold: 100 }))).toContain("за март");
    expect(fxAlertText(budget({ month: "2026-03", threshold: 100 }))).toContain("до 1 апреля");
    expect(fxAlertText(budget({ month: "2026-08" }))).toContain("до 1 сентября");
  });

  it("источник без красивого имени называется кодом", () => {
    expect(fxAlertText(budget({ source: "newsrc" }))).toContain("newsrc: израсходовано");
  });

  it("по разу за месяц на порог: те же месяц и порог — в чат не идут, порог или месяц другой — идут", async () => {
    const sent: string[] = [];
    const chatCfg = config({ FX_ENABLED: "true", ADMIN_CHAT_ID: "-1001234567890", TELEGRAM_BOT_TOKEN: "123:TEST" });
    const notifier = new FxAlertNotifier(chatCfg, targetsOf(chatCfg), switchesOf(chatCfg), new FxHooks(), new FakeRedis() as never, { sendMessage: async (_chat, text) => (sent.push(text), 1) });

    await notifier.deliver(budget());
    await notifier.deliver(budget());
    await notifier.deliver(budget({ threshold: 100, used: 10_000 }));
    await notifier.deliver(budget({ month: "2026-11" }));
    expect(sent).toHaveLength(3);
  });
});
