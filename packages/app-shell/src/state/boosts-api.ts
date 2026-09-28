import { z } from "zod/mini";
import { apiRequest, type ApiFailure, type ApiRequest, type ApiResult } from "./api-request";
import { reportError, track, useShell } from "./shell";
import { loadWallet } from "./wallet-api";

/**
 * Бусты на забег (docs/35-stage4-plan.md §3.5, Р39, Р17). Цены знает сервер:
 * клиент показывает каталог и называет, какие бусты взять, а сколько
 * списать, решает сервер. Покупка — только с сетью: буст — расходник, и
 * списание без сети дало бы двойное использование.
 *
 * Отдельным чанком: экран выбора перед забегом грузит его, только когда
 * вход есть, а первой загрузке каталог ни к чему.
 */

const priceSchema = z.object({ id: z.string(), resource: z.string(), amount: z.number() });
const catalogSchema = z.object({ boosts: z.array(priceSchema), maxPerRun: z.number() });
const activationSchema = z.object({ runId: z.string(), boosts: z.array(z.string()), cost: z.record(z.string(), z.number()) });
const refundSchema = z.object({ refunded: z.boolean() });

export type BoostPriceView = z.infer<typeof priceSchema>;
export type BoostCatalog = z.infer<typeof catalogSchema>;

export interface BoostsApi {
  catalog(): Promise<ApiResult<BoostCatalog>>;
  activate(runId: string, boosts: readonly string[]): Promise<ApiResult<z.infer<typeof activationSchema>>>;
  refund(runId: string): Promise<ApiResult<z.infer<typeof refundSchema>>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createBoostsApi(request: ApiRequest = apiRequest): BoostsApi {
  return {
    catalog: () => request("/api/v1/boosts", catalogSchema, { method: "GET" }),
    activate: (runId, boosts) => request("/api/v1/boosts/activate", activationSchema, { method: "POST", body: { runId, boosts: [...boosts] } }),
    refund: (runId) => request("/api/v1/boosts/refund", refundSchema, { method: "POST", body: { runId } }),
  };
}

function disabled(api: BoostsApi | undefined): boolean {
  return api === undefined && useShell.getState().capabilities.auth === undefined;
}

export async function loadBoostCatalog(api?: BoostsApi): Promise<ApiResult<BoostCatalog>> {
  if (disabled(api)) return { ok: false, failure: "disabled" };
  return await (api ?? createBoostsApi()).catalog();
}

export type BuyResult = { ok: true; runId: string; boosts: string[] } | { ok: false; failure: ApiFailure; code?: string };

/**
 * Купить бусты на новый забег. id забега заводит оболочка: на него сервер
 * записывает покупку, и итог должен прийти с тем же id. Повтор нажатия с
 * тем же id — тот же ответ без списания.
 */
export async function buyBoosts(runId: string, boosts: readonly string[], catalog: BoostCatalog, api?: BoostsApi): Promise<BuyResult> {
  if (disabled(api)) return { ok: false, failure: "disabled" };
  const response = await (api ?? createBoostsApi()).activate(runId, boosts);
  if (!response.ok) return response.code === undefined ? { ok: false, failure: response.failure } : { ok: false, failure: response.failure, code: response.code };
  for (const id of response.data.boosts) {
    const price = catalog.boosts.find((boost) => boost.id === id);
    track("boost_used", { boost: id, source: price?.resource ?? "unknown", amount: price?.amount ?? 0, count: response.data.boosts.length });
  }
  // Шапка должна показать списание сразу, а не после забега.
  if (api === undefined) void loadWallet();
  return { ok: true, runId: response.data.runId, boosts: response.data.boosts };
}

/**
 * Забег не начался — движок не загрузился: бусты возвращаются. Не дошла
 * просьба — сервер вернёт сам фоновым проходом, поэтому ошибка здесь только
 * пишется, а не показывается игроку.
 */
export async function refundBoosts(runId: string, api?: BoostsApi): Promise<void> {
  if (disabled(api)) return;
  const response = await (api ?? createBoostsApi()).refund(runId);
  if (!response.ok) reportError("boosts", `возврат бустов забега ${runId}: ${response.failure}`);
  else if (api === undefined) void loadWallet();
}
