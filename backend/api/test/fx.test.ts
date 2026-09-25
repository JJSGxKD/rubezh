import { randomUUID } from "node:crypto";
import { Decimal, MemoryRateStore, quoteInUsd, rateOf, type RateSource } from "@bh/fx";
import { describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { FxAlertNotifier, fxAlertText } from "../src/modules/admin-notify/fx-alert-notifier.js";
import { FxHooks, type FxAlert } from "../src/modules/fx/fx-hooks.js";
import { FxRefresher, fxSources } from "../src/modules/fx/fx.refresher.js";
import { FxService } from "../src/modules/fx/fx.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

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

  async set(key: string, value: string, ..._args: unknown[]): Promise<"OK" | null> {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async eval(_script: string, _keys: number, key: string, token: string): Promise<number> {
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key);
    return 1;
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

describe("проход курсов по расписанию", () => {
  it("идёт под локом и снимает только свой лок", async () => {
    const redis = new FakeRedis();
    const store = new MemoryRateStore();
    const refresher = new FxRefresher(config({ FX_ENABLED: "true" }), store, redis as never, new FxHooks());

    const report = await refresher.tick([gramSource("1.43")], NOW);
    expect(report?.accepted).toEqual(["GRAM"]);
    expect(redis.values.size).toBe(0);

    // Лок у другой реплики — проход не идёт и чужой лок не трогает.
    redis.values.set("fx:refresh:lock", "other-replica");
    const source = gramSource("1.44");
    expect(await refresher.tick([source], new Date(NOW.getTime() + 120_000))).toBeNull();
    expect(source.calls).toBe(0);
    expect(redis.values.get("fx:refresh:lock")).toBe("other-replica");
  });

  it("недоступный Redis — пропуск прохода, а не падение", async () => {
    const broken = { set: async () => Promise.reject(new Error("ECONNREFUSED")), eval: async () => 0 };
    const refresher = new FxRefresher(config({ FX_ENABLED: "true" }), new MemoryRateStore(), broken as never, new FxHooks());
    await expect(refresher.tick([gramSource("1.43")], NOW)).resolves.toBeNull();
  });

  it("отклонённый скачок и молчание уходят слушателям хуков", async () => {
    const hooks = new FxHooks();
    const alerts: FxAlert[] = [];
    hooks.onAlert("test", async (alert) => void alerts.push(alert));
    const store = new MemoryRateStore();
    const refresher = new FxRefresher(config({ FX_ENABLED: "true" }), store, new FakeRedis() as never, hooks);

    await refresher.tick([gramSource("1.43")], NOW);
    await refresher.tick([gramSource("0.50")], new Date(NOW.getTime() + 120_000));
    await new Promise((resolve) => setImmediate(resolve));

    expect(alerts).toContainEqual({ kind: "rate_rejected", currency: "GRAM", reason: "jump_unconfirmed", candidate: "0.5", previous: "1.43" });
    expect(alerts).toContainEqual({ kind: "rate_stale", currency: "XTR", state: "missing", purpose: "payout" });
  });
});

describe("источники из окружения", () => {
  it("ключ CoinGecko выбирает тариф, платный важнее демо", () => {
    const tariff = (patch: Record<string, string>) => fxSources(config(patch)).find((source) => source.id === "coingecko")?.tariff.name;
    expect(tariff({})).toBe("keyless");
    expect(tariff({ FX_COINGECKO_DEMO_KEY: "CG-demo" })).toBe("demo");
    expect(tariff({ FX_COINGECKO_DEMO_KEY: "CG-demo", FX_COINGECKO_PRO_KEY: "CG-pro" })).toBe("pro");
  });

  it("опрос выключен по умолчанию: включённый ходит в интернет", () => {
    expect(config().fx.enabled).toBe(false);
    expect(fxSources(config()).map((source) => source.id)).toEqual(["cbr", "ecb", "erapi", "coingecko", "tonapi", "binance"]);
  });
});

describe("заданные курсы", () => {
  function setup() {
    const roles = new MemoryRolesRepository();
    const service = new FxService(new MemoryRateStore(), config(), new RolesService(config(), roles, new MemoryAccountRepository()));
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

  it("без права — отказ, рыночная валюта руками не ставится, ноль — ошибка", async () => {
    const { service } = setup();
    await expect(service.setManual({ ...owner, platformUserId: "555" }, input, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setManual(owner, { ...input, currency: "GRAM" as never }, NOW)).rejects.toThrow("только валюты площадки");
    await expect(service.setManual(owner, { ...input, price: "0" }, NOW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("цена звезды в рублях показывается и в долларах по курсу рубля, без курса — честное «нет»", async () => {
    const store = new MemoryRateStore();
    const service = new FxService(store, config(), new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository()));
    const rub = { ...input, purpose: "price" as const, price: "1.72", quote: "RUB" as const };
    expect((await service.setManual(owner, rub, NOW)).usdPerUnit).toBeNull();

    await store.setCurrentRate(rateOf("RUB", new Decimal(1).div("84.6952"), ["cbr"], NOW), NOW);
    const [price] = (await service.overview(NOW)).manual;
    expect(price).toMatchObject({ purpose: "price", price: "1.72", quote: "RUB" });
    expect(Number(price?.usdPerUnit)).toBeCloseTo(0.02031, 5);
  });
});

describe("алерты курсов в чат команды", () => {
  const chatConfig = () => config({ FX_ENABLED: "true", ADMIN_CHAT_ID: "-1001234567890", TELEGRAM_BOT_TOKEN: "123:TEST" });

  it("одна причина — один алерт за окно тишины", async () => {
    const sent: string[] = [];
    const notifier = new FxAlertNotifier(chatConfig(), new FxHooks(), new FakeRedis() as never, { sendMessage: async (_chat, text) => (sent.push(text), 1) });
    const stale: FxAlert = { kind: "rate_stale", currency: "GRAM", state: "stale", purpose: null };

    await notifier.deliver(stale);
    await notifier.deliver(stale);
    await notifier.deliver({ ...stale, state: "expired" });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("продавать по нему больше нельзя");
  });

  it("выключен без опроса курсов, без чата или без бота", () => {
    const off = (patch: Record<string, string>) => new FxAlertNotifier(config(patch), new FxHooks(), new FakeRedis() as never, { sendMessage: async () => 1 }).enabled;
    expect(off({ ADMIN_CHAT_ID: "-100123", TELEGRAM_BOT_TOKEN: "123:TEST" })).toBe(false);
    expect(off({ FX_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123:TEST" })).toBe(false);
    expect(new FxAlertNotifier(chatConfig(), new FxHooks(), new FakeRedis() as never, { sendMessage: async () => 1 }).enabled).toBe(true);
  });

  it("текст говорит, что случилось и что делать", () => {
    expect(fxAlertText({ kind: "rate_rejected", currency: "GRAM", reason: "jump_unconfirmed", candidate: "0.5", previous: "1.43" })).toContain("не подтвердил второй источник");
    expect(fxAlertText({ kind: "rate_stale", currency: "XTR", state: "missing", purpose: "payout" })).toContain("Поставьте новый в панели");
    expect(fxAlertText({ kind: "source_failed", source: "cbr", reason: "ответ 503" })).toContain("Остальные продолжают");
  });
});
