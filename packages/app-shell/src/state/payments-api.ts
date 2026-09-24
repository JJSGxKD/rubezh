import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";

/**
 * Клиент оплаты второго шанса (docs/34-stage3-plan.md, WP5). **Цены в
 * запросе нет** (Р5.1): клиент говорит, какой забег и на какой секунде он
 * хочет продолжить, а сколько это стоит, отвечает сервер.
 */

export interface ContinueRequest {
  runId: string;
  /** какое по счёту продолжение забега, с единицы */
  continueNo: number;
  /** секунда забега, на которой игрок умер */
  elapsedSec: number;
}

const modeSchema = z.enum(["live", "test"]);

const offerSchema = z.object({
  continueNo: z.number(),
  priceStars: z.number(),
  chargedStars: z.number(),
  mode: modeSchema,
});

const invoiceSchema = z.object({
  continueNo: z.number(),
  priceStars: z.number(),
  chargedStars: z.number(),
  mode: modeSchema,
  purchaseId: z.string(),
  status: z.enum(["pending", "paid"]),
  invoiceUrl: z.nullable(z.string()),
});

const purchaseSchema = z.object({
  purchaseId: z.string(),
  status: z.enum(["pending", "paid", "refunded"]),
  granted: z.boolean(),
});

export type ContinueOffer = z.infer<typeof offerSchema>;
export type ContinueInvoice = z.infer<typeof invoiceSchema>;
export type PurchaseState = z.infer<typeof purchaseSchema>;

export interface PaymentsApi {
  quote(request: ContinueRequest): Promise<ApiResult<ContinueOffer>>;
  invoice(request: ContinueRequest): Promise<ApiResult<ContinueInvoice>>;
  purchase(purchaseId: string): Promise<ApiResult<PurchaseState>>;
}

const PREFIX = "/api/v1/payments";

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createPaymentsApi(request: ApiRequest = apiRequest): PaymentsApi {
  return {
    quote: (body) => request(`${PREFIX}/continue/quote`, offerSchema, { method: "POST", body }),
    invoice: (body) => request(`${PREFIX}/continue/invoice`, invoiceSchema, { method: "POST", body }),
    purchase: (purchaseId) => request(`${PREFIX}/${encodeURIComponent(purchaseId)}`, purchaseSchema, { method: "GET" }),
  };
}
