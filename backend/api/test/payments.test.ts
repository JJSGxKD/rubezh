import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { DomainError } from "../src/common/domain-error.js";
import { PaymentsContinueLedger } from "../src/modules/payments/continue-ledger.js";
import { continuePrice, startedMinutes } from "../src/modules/payments/continue-price.js";
import { continueRequestSchema } from "../src/modules/payments/dto/payments.dto.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";

/**
 * Цена и счёт второго шанса (docs/34-stage3-plan.md, WP5). Проверяется то,
 * где оплата обычно ломается: цена со слов клиента, минуты сверх прошедших
 * по часам сервера, второй счёт на уже оплаченное продолжение и счёт к
 * забегу, который уже закончен.
 */

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const RULES = { starsPerMinute: 1, maxStars: 30 };

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true", ...patch } as NodeJS.ProcessEnv);
}

function player(platformUserId = "555000111"): AccountRef {
  return { accountId: randomUUID(), platform: "telegram", platformUserId };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("ожидался отказ");
}

describe("цена второго шанса", () => {
  it("звезда за каждую начатую минуту, не меньше одной", () => {
    expect(continuePrice(0, RULES)).toBe(1);
    expect(continuePrice(59.9, RULES)).toBe(1);
    expect(continuePrice(60, RULES)).toBe(1);
    expect(continuePrice(60.5, RULES)).toBe(2);
    expect(continuePrice(6 * 60 + 30, RULES)).toBe(7);
  });

  it("цена минуты — настройка, а потолок держит цену длинного забега", () => {
    expect(continuePrice(125, { starsPerMinute: 3, maxStars: 30 })).toBe(9);
    expect(continuePrice(3 * 60 * 60, RULES)).toBe(30);
  });

  it("шум плавающей точки не добавляет звезду", () => {
    // Секунды забега — сумма тиков по 1/60: ровно две минуты бывают чуть больше.
    const ticks = 7200;
    const elapsed = Array.from({ length: ticks }).reduce<number>((sum) => sum + 1 / 60, 0);
    expect(elapsed).not.toBe(120);
    expect(startedMinutes(elapsed)).toBe(2);
  });
});

describe("счёт второго шанса", () => {
  let runs: MemoryRunsRepository;
  let purchases: MemoryPurchasesRepository;
  let invoices: FakeStarsApi;
  let service: PaymentsService;
  let me: AccountRef;
  let runId: string;

  async function startRun(owner: AccountRef, startedAtMs: number | null = NOW - 10 * 60_000): Promise<string> {
    const id = randomUUID();
    await runs.start({
      runId: id,
      accountId: owner.accountId,
      difficulty: "normal",
      startingWeaponId: "knife",
      contentHash: "abc",
      startedAt: startedAtMs === null ? null : new Date(startedAtMs),
    });
    return id;
  }

  function build(settings: AppConfig = config()): void {
    service = new PaymentsService(settings, purchases, runs, starsProviders(invoices));
  }

  beforeEach(async () => {
    runs = new MemoryRunsRepository();
    purchases = new MemoryPurchasesRepository();
    invoices = new FakeStarsApi();
    build();
    me = player();
    runId = await startRun(me);
  });

  it("цену считает сервер, а присланная клиентом отбрасывается схемой", async () => {
    const request = continueRequestSchema.parse({ runId, continueNo: 1, elapsedSec: 6 * 60 + 30, priceStars: 1, chargedStars: 1 });

    const offer = await service.quote(me, request, NOW);

    expect(request).not.toHaveProperty("priceStars");
    expect(offer).toEqual({ continueNo: 1, priceStars: 7, chargedStars: 7, mode: "live" });
  });

  it("минут больше, чем прошло по часам сервера, заявить нельзя", async () => {
    // Забег начался десять минут назад; запас — десять секунд.
    expect(await codeOf(service.quote(me, { runId, continueNo: 1, elapsedSec: 10 * 60 + 11 }, NOW))).toBe("elapsed_exceeds_clock");
    await expect(service.quote(me, { runId, continueNo: 1, elapsedSec: 10 * 60 + 9 }, NOW)).resolves.toMatchObject({ priceStars: 11 });
  });

  it("без старта на сервере минуты не посчитать: клиент дошлёт старт и спросит снова", async () => {
    const late = await startRun(me, null);

    expect(await codeOf(service.quote(me, { runId: late, continueNo: 1, elapsedSec: 60 }, NOW))).toBe("run_unverified");
    expect(await codeOf(service.quote(me, { runId: randomUUID(), continueNo: 1, elapsedSec: 60 }, NOW))).toBe("run_unverified");
  });

  it("закрытый забег продолжить нельзя", async () => {
    await runs.finish({
      runId,
      accountId: me.accountId,
      difficulty: "normal",
      startingWeaponId: "knife",
      contentHash: "abc",
      finishedAt: new Date(NOW),
      outcome: "died",
      survivalSec: 300,
      level: 5,
      enemiesKilled: 100,
      weapons: [],
      deathCause: null,
      cheats: false,
      continues: [],
      ranked: true,
      verdict: "ok",
      verdictReasons: [],
    });

    expect(await codeOf(service.invoice(me, { runId, continueNo: 1, elapsedSec: 300 }, NOW))).toBe("continue_unavailable");
  });

  it("продолжений не больше, чем даёт игра", async () => {
    expect(await codeOf(service.quote(me, { runId, continueNo: 2, elapsedSec: 60 }, NOW))).toBe("continue_unavailable");
  });

  it("чужой забег — отказ, а не счёт за чужое продолжение", async () => {
    expect(await codeOf(service.invoice(player("555000222"), { runId, continueNo: 1, elapsedSec: 60 }, NOW))).toBe("validation_failed");
    expect(invoices.sent).toHaveLength(0);
  });

  it("вход разработчика платить не может: у него нет Telegram", async () => {
    const dev: AccountRef = { accountId: me.accountId, platform: "telegram", platformUserId: "dev-1" };

    expect(await codeOf(service.quote(dev, { runId, continueNo: 1, elapsedSec: 60 }, NOW))).toBe("payments_unsupported");
  });

  it("выключенная оплата отвечает как несуществующая", async () => {
    build(config({ PAYMENTS_ENABLED: "false" }));

    expect(await codeOf(service.quote(me, { runId, continueNo: 1, elapsedSec: 60 }, NOW))).toBe("endpoint_disabled");
  });

  it("счёт выставляется на посчитанную цену, а в счёте — id покупки", async () => {
    const invoice = await service.invoice(me, { runId, continueNo: 1, elapsedSec: 125 }, NOW);

    expect(invoice).toMatchObject({ status: "pending", priceStars: 3, chargedStars: 3, mode: "live", invoiceUrl: "https://t.me/$invoice-1" });
    expect(invoices.sent[0]).toMatchObject({ payload: invoice.purchaseId, stars: 3, title: "Второй шанс" });
    expect(invoices.sent[0]?.description).toContain("с 3-й минуты");
    expect(purchases.rows.get(invoice.purchaseId)).toMatchObject({ status: "pending", runId, continueNo: 1, priceStars: 3 });
  });

  it("тестовая оплата: игрок видит настоящую цену, списывается одна звезда, и окно оплаты говорит об этом", async () => {
    build(config({ NODE_ENV: "development", PAYMENTS_TEST_MODE: "true" }));

    const invoice = await service.invoice(me, { runId, continueNo: 1, elapsedSec: 6 * 60 + 30 }, NOW);

    expect(invoice).toMatchObject({ priceStars: 7, chargedStars: 1, mode: "test" });
    expect(invoices.sent[0]).toMatchObject({ stars: 1, title: "Второй шанс — тест" });
    expect(invoices.sent[0]?.description).toContain("Настоящая цена — 7 ⭐");
    expect(purchases.rows.get(invoice.purchaseId)).toMatchObject({ mode: "test", priceStars: 7, chargedStars: 1 });
  });

  it("повторный счёт на то же продолжение — та же покупка, а не вторая", async () => {
    const first = await service.invoice(me, { runId, continueNo: 1, elapsedSec: 125 }, NOW);
    const second = await service.invoice(me, { runId, continueNo: 1, elapsedSec: 130 }, NOW + 1000);

    expect(second.purchaseId).toBe(first.purchaseId);
    expect(purchases.rows.size).toBe(1);
  });

  it("на оплаченное продолжение второй счёт не выставляется: повтор после потерянного ответа не берёт денег дважды", async () => {
    const first = await service.invoice(me, { runId, continueNo: 1, elapsedSec: 125 }, NOW);
    const row = purchases.rows.get(first.purchaseId);
    if (row === undefined) throw new Error("покупки нет");
    Object.assign(row, { status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" });

    const again = await service.invoice(me, { runId, continueNo: 1, elapsedSec: 125 }, NOW + 1000);

    expect(again).toMatchObject({ purchaseId: first.purchaseId, status: "paid", invoiceUrl: null });
    expect(invoices.sent).toHaveLength(1);
  });

  it("Telegram не выставил счёт — повтор безопасен, покупка ждёт того же продолжения", async () => {
    invoices.invoiceFailWith = new TelegramApiError("createInvoiceLink", 0, "сеть недоступна", null);

    expect(await codeOf(service.invoice(me, { runId, continueNo: 1, elapsedSec: 125 }, NOW))).toBe("payments_unavailable");

    invoices.invoiceFailWith = null;
    await service.invoice(me, { runId, continueNo: 1, elapsedSec: 125 }, NOW);
    expect(purchases.rows.size).toBe(1);
  });

  it("состояние покупки видит только её владелец", async () => {
    const { purchaseId } = await service.invoice(me, { runId, continueNo: 1, elapsedSec: 125 }, NOW);

    await expect(service.purchase(me, purchaseId)).resolves.toMatchObject({ purchaseId, status: "pending", granted: false });
    expect(await codeOf(service.purchase(player("555000333"), purchaseId))).toBe("purchase_not_found");
  });
});

describe("сверка итога забега с покупками", () => {
  const RUN = "run-with-continue";

  async function ledgerWith(elapsedSec: number | null, settings: AppConfig = config()) {
    const purchases = new MemoryPurchasesRepository();
    if (elapsedSec !== null) {
      await purchases.openInvoice({ purchaseId: randomUUID(), accountId: "a", runId: RUN, continueNo: 1, elapsedSec, priceStars: 3, chargedStars: 3, mode: "live", invoicedAt: new Date(NOW) });
      const row = [...purchases.rows.values()][0];
      if (row !== undefined) Object.assign(row, { status: "paid", paidAt: new Date(NOW), telegramChargeId: "charge-1" });
    }
    return new PaymentsContinueLedger(settings, purchases, new RunContinues());
  }

  it("оплата за ту же минуту — сошлось; за меньшее число минут, чем прошло, — недоплата", async () => {
    const ledger = await ledgerWith(125);

    await expect(ledger.check(RUN, [130])).resolves.toEqual({ paid: 1, underpaid: false });
    await expect(ledger.check(RUN, [200])).resolves.toEqual({ paid: 1, underpaid: true });
  });

  it("выше потолка цены лишние минуты не стоили ни звезды — это не недоплата", async () => {
    const ledger = await ledgerWith(125, config({ CONTINUE_MAX_STARS: "3" }));

    await expect(ledger.check(RUN, [900])).resolves.toEqual({ paid: 1, underpaid: false });
  });

  it("продолжение без покупки не оплачено", async () => {
    await expect((await ledgerWith(null)).check(RUN, [130])).resolves.toEqual({ paid: 0, underpaid: false });
  });
});

describe("конфигурация оплаты", () => {
  it("без авторизации и чтения обновлений бота оплата не стартует", () => {
    expect(() => loadAppConfig({ NODE_ENV: "test", PAYMENTS_ENABLED: "true" } as NodeJS.ProcessEnv)).toThrow(/AUTH_ENABLED/);
    expect(() => config({ TELEGRAM_BOT_UPDATES: "off" })).toThrow(/TELEGRAM_BOT_UPDATES/);
    expect(config().payments).toEqual({ enabled: true, testMode: false, starsPerMinute: 1, maxStars: 30 });
  });
});
