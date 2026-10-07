import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PaymentsAlertNotifier, stuckPurchaseText, type PaymentsAlertApi } from "../src/modules/admin-notify/payments-alert-notifier.js";
import { PaymentsHooks, type StuckPurchase } from "../src/modules/payments/payments-hooks.js";
import type { AdminChats, NotifyTargets } from "../src/modules/settings/notify-targets.js";
import { targetsOf } from "./helpers/notify-targets.js";

/**
 * Сообщение команде о зависшей покупке (tasks/T-0003): один раз на покупку за
 * семь суток, в поток «Покупки», а если его нет — в общий чат.
 */

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ADMIN_CHAT_ID: "-1001234567890", TELEGRAM_BOT_TOKEN: "123:TEST", ...patch } as NodeJS.ProcessEnv);
}

function stuck(patch: Partial<StuckPurchase> = {}): StuckPurchase {
  return {
    purchaseId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    product: "shop_item",
    sku: "starter_pack",
    chargedStars: 50,
    paidAt: new Date("2026-10-06T09:05:00Z"),
    reason: "connection refused",
    ...patch,
  };
}

/** Redis на `SET … NX` и `DEL`: ровно то, чем дедуплицируется сообщение. */
class FakeRedis {
  readonly values = new Map<string, { value: string; args: unknown[] }>();

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
    if (this.values.has(key)) return null;
    this.values.set(key, { value, args });
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

function setup(cfg: AppConfig = config(), targets: NotifyTargets = targetsOf(cfg)) {
  const sent: { chat: unknown; text: string }[] = [];
  const redis = new FakeRedis();
  const hooks = new PaymentsHooks();
  const api: PaymentsAlertApi = { sendMessage: async (chat, text) => (sent.push({ chat, text }), 1) };
  const notifier = new PaymentsAlertNotifier(cfg, targets, hooks, redis as never, api);
  return { notifier, sent, redis, hooks, api };
}

describe("сообщение команде о зависшей покупке", () => {
  it("первое событие по покупке — одно сообщение с товаром, звёздами, аккаунтом, временем и причиной", async () => {
    const { notifier, sent } = setup();

    await notifier.deliver(stuck());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chat).toEqual({ chatId: "-1001234567890", threadId: null });
    expect(sent[0]?.text).toBe(
      [
        "⚠️ Покупка не выдана",
        "Товар: starter_pack, 50 ⭐",
        "Аккаунт: 22222222-2222-4222-8222-222222222222",
        "Оплачена: 2026-10-06 09:05",
        "Причина: connection refused",
        "Проход повторяет выдачу каждые 5 минут; нужна проверка.",
      ].join("\n"),
    );
  });

  it("повтор того же purchaseId — сообщения нет: ключ на семь суток уже стоит", async () => {
    const { notifier, sent, redis } = setup();

    await notifier.deliver(stuck());
    await notifier.deliver(stuck({ reason: "другая причина" }));

    expect(sent).toHaveLength(1);
    const key = redis.values.get("payments:stuck-alert:11111111-1111-4111-8111-111111111111");
    expect(key?.args).toEqual(["EX", 604800, "NX"]);
  });

  it("другая покупка — отдельное сообщение", async () => {
    const { notifier, sent } = setup();

    await notifier.deliver(stuck());
    await notifier.deliver(stuck({ purchaseId: "33333333-3333-4333-8333-333333333333" }));

    expect(sent).toHaveLength(2);
  });

  it("undeliverable — звёзды возвращаются автоматически", async () => {
    const { notifier, sent } = setup();

    await notifier.deliver(stuck({ reason: "undeliverable" }));

    expect(sent[0]?.text).toContain("Звёзды возвращаются автоматически.");
    expect(sent[0]?.text).not.toContain("нужна проверка");
  });

  it("у товара без sku в сообщении стоит название вида товара", () => {
    expect(stuckPurchaseText(stuck({ sku: null, product: "vip" }))).toContain("Товар: vip, 50 ⭐");
  });

  it("свой поток «Покупки» получает сообщение вместо общего чата", async () => {
    const chats = { general: { chatId: "-100", threadId: null }, payments: { chatId: "-100", threadId: 57 } } as AdminChats;
    const { notifier, sent } = setup(config(), { chats: () => chats } as NotifyTargets);

    await notifier.deliver(stuck());

    expect(sent[0]?.chat).toEqual({ chatId: "-100", threadId: 57 });
  });

  it("нет чата — не отправляет и не бросает, ключ не занимается", async () => {
    const cfg = config({ ADMIN_CHAT_ID: "" });
    const { notifier, sent, redis } = setup(cfg);

    await expect(notifier.deliver(stuck())).resolves.toBeUndefined();

    expect(sent).toEqual([]);
    expect(redis.values.size).toBe(0);
  });

  it("Redis недоступен — не бросает и не отправляет", async () => {
    const { notifier, sent } = setup();
    const broken = notifier as unknown as { redis: { set: () => Promise<never> } };
    broken.redis = {
      set: async () => {
        throw new Error("redis down");
      },
    };

    await expect(notifier.deliver(stuck())).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("отправка упала — не бросает и освобождает ключ: следующий проход повторит сообщение", async () => {
    const cfg = config();
    const sent: string[] = [];
    let fail = true;
    const redis = new FakeRedis();
    const notifier = new PaymentsAlertNotifier(cfg, targetsOf(cfg), new PaymentsHooks(), redis as never, {
      sendMessage: async (_chat, text) => {
        if (fail) throw new Error("Telegram недоступен");
        sent.push(text);
        return 1;
      },
    });

    await expect(notifier.deliver(stuck())).resolves.toBeUndefined();
    expect(redis.values.size).toBe(0);

    fail = false;
    await notifier.deliver(stuck());
    expect(sent).toHaveLength(1);
  });

  it("подписывается на событие модуля оплаты, когда есть токен бота", async () => {
    const { notifier, sent, hooks } = setup();
    notifier.onModuleInit();

    await hooks.emitStuck(stuck());

    expect(sent).toHaveLength(1);
  });

  it("без токена бота на событие не подписывается", async () => {
    const { notifier, sent, hooks } = setup(config({ TELEGRAM_BOT_TOKEN: "" }));
    notifier.onModuleInit();

    await hooks.emitStuck(stuck());

    expect(sent).toEqual([]);
  });
});
