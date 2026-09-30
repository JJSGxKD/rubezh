import type { InvoiceStatus } from "@bh/shared-types";
import type { ApiResult } from "./api-request";
import { isDelivered, type ShopApi, type ShopInvoice } from "./shop-api";
import { track } from "./shell";

/**
 * Покупка в магазине — набора или VIP (docs/35-stage4-plan.md §3.6, WP10).
 * Та же цепочка, что у второго шанса (`continue-purchase.ts`): счёт на
 * сервере, окно оплаты площадки, ожидание подтверждения.
 *
 * **Товар выдаёт сервер, а не окно оплаты** (Р13): `paid` от окна — только
 * подсказка перестать ждать; купленным товар считается, когда сервер скажет,
 * что он лёг на счёт. Не дождались — ничего не пропало: сервер выдаст
 * оплаченное сам, экран увидит это при следующем заходе.
 */

/** Как часто спрашивать сервер о покупке, пока ждём подтверждения. */
export const CONFIRM_POLL_MS = 1_000;
/** Сколько ждать подтверждения, прежде чем сказать «ещё подтверждается» — как у второго шанса. */
export const CONFIRM_TIMEOUT_MS = 45_000;

export type ShopProduct = "shop_item" | "vip";

/** Что покупаем и почём — по витрине: для разреза событий, если счёт так и не выставится. */
export interface BuyRequest {
  product: ShopProduct;
  sku: string;
  priceStars: number;
  chargedStars: number;
  mode: "live" | "test";
  order(): Promise<ApiResult<ShopInvoice>>;
}

/**
 * - `done` — товар на счету;
 * - `cancelled` — игрок закрыл окно оплаты;
 * - `retry` — не вышло, повтор может помочь: сеть, неудачная оплата, долгое
 *   подтверждение (оплаченное сервер выдаст и без экрана);
 * - `refused` — сервер отказал, повтор не поможет: код отказа — что сказать игроку.
 */
export type BuyOutcome =
  | { kind: "done" }
  | { kind: "cancelled" }
  | { kind: "retry"; reason: "offline" | "payment_failed" | "slow_confirmation" }
  | { kind: "refused"; code: string };

export interface BuyDeps {
  api: Pick<ShopApi, "purchase">;
  openInvoice: ((url: string) => Promise<InvoiceStatus>) | undefined;
  wait(ms: number): Promise<void>;
  now(): number;
}

export async function buy(request: BuyRequest, deps: BuyDeps): Promise<BuyOutcome> {
  const invoice = await request.order();
  if (!invoice.ok) {
    const reason = invoice.code ?? invoice.failure;
    track("purchase_failed", { ...fieldsOf(request), reason });
    return retryable(invoice) ? { kind: "retry", reason: "offline" } : { kind: "refused", code: reason };
  }
  const fields = { ...fieldsOf(request), priceStars: invoice.data.priceStars, chargedStars: invoice.data.chargedStars, mode: invoice.data.mode };
  track("purchase_initiated", fields);
  // Разовый товар уже оплачен: ответ на прошлую покупку потерялся — ждём выдачи, а не платим снова.
  if (invoice.data.status === "paid" || invoice.data.invoiceUrl === null) return await confirm(invoice.data.purchaseId, fields, deps);

  const status = deps.openInvoice === undefined ? "unsupported" : await deps.openInvoice(invoice.data.invoiceUrl);
  switch (status) {
    case "paid":
    case "pending":
      return await confirm(invoice.data.purchaseId, fields, deps);
    case "cancelled":
      track("purchase_failed", { ...fields, reason: "cancelled" });
      return { kind: "cancelled" };
    case "failed":
      track("purchase_failed", { ...fields, reason: "failed" });
      return { kind: "retry", reason: "payment_failed" };
    case "unsupported":
      track("purchase_failed", { ...fields, reason: "unsupported" });
      return { kind: "refused", code: "payments_unsupported" };
  }
}

async function confirm(purchaseId: string, fields: Record<string, string | number>, deps: BuyDeps): Promise<BuyOutcome> {
  const deadline = deps.now() + CONFIRM_TIMEOUT_MS;
  while (deps.now() < deadline) {
    const state = await deps.api.purchase(purchaseId);
    if (state.ok && isDelivered(state.data)) {
      track("purchase_completed", fields);
      return { kind: "done" };
    }
    await deps.wait(CONFIRM_POLL_MS);
  }
  track("purchase_failed", { ...fields, reason: "timeout" });
  return { kind: "retry", reason: "slow_confirmation" };
}

/** Сеть, недоступный сервер или площадка, не выставившая счёт, — повтор может помочь; отказ по существу — нет. */
function retryable(answer: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  if (answer.failure === "offline") return true;
  return answer.failure === "unavailable" && (answer.code === undefined || answer.code === "payments_unavailable");
}

/** Разрез событий покупки (docs/22-analytics-and-metrics.md §3.3): тестовые оплаты отделяются режимом. */
function fieldsOf(request: BuyRequest): Record<string, string | number> {
  return { product: request.product, sku: request.sku, priceStars: request.priceStars, chargedStars: request.chargedStars, mode: request.mode };
}
