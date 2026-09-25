import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { PaymentConfirmation } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { PaymentProviderRejectedError, PaymentProviderUnavailableError, PaymentProviders } from "../src/platforms/ports/payment-provider.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramStarsProvider } from "../src/platforms/telegram/telegram-stars-provider.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";

// Порт оплаты (docs/35-stage4-plan.md, §3.11): домен получает ошибки порта,
// а что значит ответ Bot API, знает адаптер Telegram.

const INVOICE = { title: "Второй шанс", description: "…", payload: "p-1", label: "Второй шанс", amount: 3 };

describe("оплата звёздами через порт", () => {
  it("счёт площадки становится счётом Stars", async () => {
    const api = new FakeStarsApi();
    await new TelegramStarsProvider(api, true).createInvoice(INVOICE);
    expect(api.sent).toEqual([{ title: "Второй шанс", description: "…", payload: "p-1", label: "Второй шанс", stars: 3 }]);
  });

  it("отказ Bot API в счёте — «площадка недоступна», а не TelegramApiError", async () => {
    const api = new FakeStarsApi();
    api.invoiceFailWith = new TelegramApiError("createInvoiceLink", 0, "сеть недоступна", null);
    await expect(new TelegramStarsProvider(api, true).createInvoice(INVOICE)).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });

  it("возврат: уже сделанный — не ошибка, `400` — окончательный отказ, сбой сети — временный", async () => {
    const api = new FakeStarsApi();
    const provider = new TelegramStarsProvider(api, true);

    await expect(provider.refund("555", "charge-1")).resolves.toBe("refunded");
    expect(api.refunded).toEqual([{ userId: 555, chargeId: "charge-1" }]);

    api.refundFailWith = new TelegramApiError("refundStarPayment", 400, "Bad Request: CHARGE_ALREADY_REFUNDED", null);
    await expect(provider.refund("555", "charge-1")).resolves.toBe("already_refunded");
    api.refundFailWith = new TelegramApiError("refundStarPayment", 400, "Bad Request: CHARGE_NOT_FOUND", null);
    await expect(provider.refund("555", "charge-1")).rejects.toBeInstanceOf(PaymentProviderRejectedError);
    api.refundFailWith = new TelegramApiError("refundStarPayment", 0, "сеть недоступна", null);
    await expect(provider.refund("555", "charge-1")).rejects.toBeInstanceOf(TelegramApiError);
  });

  it("платить может игрок Telegram, а не аккаунт разработчика", () => {
    const provider = new TelegramStarsProvider(new FakeStarsApi(), true);
    expect(provider.accepts("555000111")).toBe(true);
    expect(provider.accepts("dev-1")).toBe(false);
  });
});

describe("когда продажа имеет смысл", () => {
  const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

  function queue(providers: PaymentProviders): PaymentsQueue {
    const purchases = new MemoryPurchasesRepository();
    return new PaymentsQueue(config(), new PaymentConfirmation(config(), purchases, providers), new PaymentRefunds(purchases, providers), new RunsHooks(), providers);
  }

  it("есть площадка, которая сообщит об оплате, — очередь включена", () => {
    expect(queue(starsProviders(new FakeStarsApi(), true)).enabled).toBe(true);
  });

  it("бот не читает обновления — подтверждение не придёт, и очередь выключена", () => {
    expect(queue(starsProviders(new FakeStarsApi(), false)).enabled).toBe(false);
  });

  it("у площадки без способа оплаты его нет", () => {
    expect(starsProviders().for("max")).toBeNull();
  });
});
