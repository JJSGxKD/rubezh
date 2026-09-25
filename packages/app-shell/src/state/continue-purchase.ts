import type { RunResult } from "@bh/shared-types";
import { create } from "zustand";
import type { ApiResult } from "./api-request";
import { createPaymentsApi, type ContinueOffer, type ContinueRequest, type PaymentsApi } from "./payments-api";
import { markPaymentsOff } from "./payments-availability";
import { useRun } from "./run";
import { useRuns } from "./runs";
import { track, useShell } from "./shell";

/**
 * Покупка второго шанса на экране смерти (docs/34-stage3-plan.md, WP5,
 * шаг 3). Едет в чанке экрана смерти; можно ли вообще предложить покупку,
 * решает крошечный `payments-availability.ts` в первой загрузке.
 *
 * **Продолжение даёт сервер, а не окно оплаты** (Р13). `paid` от окна —
 * подсказка, что можно перестать ждать: клиент опрашивает покупку, пока
 * сервер не скажет `granted`, и только тогда шлёт движку `continueRun`.
 *
 * Не дождались — звёзды не пропадают: не взятое продолжение сервер вернёт
 * сам, когда забег закончится (`payment-refunds.ts`). Поэтому уход с экрана
 * посреди оплаты ничего не ломает, и держать игрока здесь незачем.
 */

/**
 * - `loading` — узнаём цену;
 * - `ready` — цена известна, можно купить;
 * - `buying` — счёт выставляется или открыто окно оплаты;
 * - `confirming` — окно сказало «оплачено», ждём подтверждения сервера;
 * - `retry` — не вышло, но повтор может помочь: сеть, неудачная оплата,
 *   долгое подтверждение;
 * - `unavailable` — купить нельзя, и повтор не поможет.
 */
export type ContinueStage =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; offer: ContinueOffer }
  | { kind: "buying"; offer: ContinueOffer }
  | { kind: "confirming"; offer: ContinueOffer; purchaseId: string }
  | { kind: "retry"; reason: RetryReason; offer: ContinueOffer | null; purchaseId: string | null }
  | { kind: "unavailable"; reason: UnavailableReason };

export type RetryReason = "offline" | "payment_failed" | "slow_confirmation";
/** `not_offered` — оплаты нет; `unverified` — сервер не видел старта забега; `used_up` — продолжения кончились. */
export type UnavailableReason = "not_offered" | "unverified" | "used_up";

export interface ContinuePurchaseStore {
  stage: ContinueStage;
  /** забег, чей второй шанс покупаем: ответы по чужому забегу отбрасываются */
  request: ContinueRequest | null;
  prepare(result: RunResult): Promise<void>;
  buy(): Promise<void>;
  /** повторить то, что не вышло: цену, покупку или ожидание подтверждения */
  retry(): Promise<void>;
  reset(): void;
}

/** Как часто спрашивать сервер о покупке, пока ждём подтверждения. */
export const CONFIRM_POLL_MS = 1_000;
/**
 * Сколько ждать подтверждения, прежде чем сказать «ещё подтверждается».
 * Обычно оно приходит за секунды; дольше — сбой где-то между Telegram и
 * сервером, и игроку честнее сказать это, чем крутить ожидание без конца.
 */
export const CONFIRM_TIMEOUT_MS = 45_000;
/** Пауза перед вторым вопросом о цене: старт забега мог ещё уходить из очереди. */
const UNVERIFIED_RETRY_MS = 1_500;

let api: PaymentsApi = createPaymentsApi();

export function setPaymentsApiForTests(next: PaymentsApi): void {
  api = next;
}

export const useContinuePurchase = create<ContinuePurchaseStore>((set, get) => {
  /** Всё ещё тот же забег на экране смерти — иначе ответ опоздал и ничего не решает. */
  const current = (request: ContinueRequest): boolean => get().request === request;

  async function quote(request: ContinueRequest, secondTry = false): Promise<void> {
    // Без старта забега на сервере цены нет, а старт мог ещё лежать в очереди.
    await useRuns.getState().flush("continue");
    const answer = await api.quote(request);
    if (!current(request)) return;
    if (answer.ok) {
      set({ stage: { kind: "ready", offer: answer.data } });
      return;
    }
    if (answer.code === "run_unverified" && !secondTry) {
      await wait(UNVERIFIED_RETRY_MS);
      if (current(request)) await quote(request, true);
      return;
    }
    settleFailure(answer);
  }

  /** Отказ сервера — в состояние экрана. */
  function settleFailure(answer: Extract<ApiResult<unknown>, { ok: false }>, offer: ContinueOffer | null = null): void {
    if (answer.failure === "disabled" || answer.code === "payments_unsupported") {
      markPaymentsOff();
      unavailable("not_offered");
      return;
    }
    if (answer.code === "run_unverified") return unavailable("unverified");
    if (answer.code === "continue_unavailable") return unavailable("used_up");
    if (answer.failure === "rejected") return unavailable("not_offered");
    set({ stage: { kind: "retry", reason: "offline", offer, purchaseId: null } });
  }

  function unavailable(reason: UnavailableReason): void {
    set({ stage: { kind: "unavailable", reason } });
    // Купить нельзя — ждать решения на экране смерти незачем: забег
    // закрывается смертью, и рекорд с местом появляются сразу. Забег
    // разработчика ждёт: у него есть бесплатное продолжение.
    if (!useRun.getState().devRun) useRun.getState().declineContinue();
  }

  async function purchase(request: ContinueRequest, offer: ContinueOffer): Promise<void> {
    set({ stage: { kind: "buying", offer } });
    track("purchase_initiated", purchaseFields(offer));
    const invoice = await api.invoice(request);
    if (!current(request)) return;
    if (!invoice.ok) {
      track("purchase_failed", { ...purchaseFields(offer), reason: invoice.code ?? invoice.failure });
      settleFailure(invoice, offer);
      return;
    }
    // Это продолжение уже оплачено: ответ на прошлый запрос потерялся.
    if (invoice.data.status === "paid" || invoice.data.invoiceUrl === null) {
      await confirm(request, offer, invoice.data.purchaseId);
      return;
    }

    const openInvoice = useShell.getState().adapter.openInvoice;
    const status = openInvoice === undefined ? "unsupported" : await openInvoice(invoice.data.invoiceUrl);
    if (!current(request)) return;
    switch (status) {
      case "paid":
      case "pending":
        await confirm(request, offer, invoice.data.purchaseId);
        return;
      case "cancelled":
        track("purchase_failed", { ...purchaseFields(offer), reason: "cancelled" });
        set({ stage: { kind: "ready", offer } });
        return;
      case "failed":
        track("purchase_failed", { ...purchaseFields(offer), reason: "failed" });
        set({ stage: { kind: "retry", reason: "payment_failed", offer, purchaseId: null } });
        return;
      case "unsupported":
        track("purchase_failed", { ...purchaseFields(offer), reason: "unsupported" });
        markPaymentsOff();
        unavailable("not_offered");
        return;
    }
  }

  async function confirm(request: ContinueRequest, offer: ContinueOffer, purchaseId: string): Promise<void> {
    set({ stage: { kind: "confirming", offer, purchaseId } });
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await api.purchase(purchaseId);
      if (!current(request)) return;
      if (state.ok && state.data.granted) {
        track("purchase_completed", purchaseFields(offer));
        set({ stage: { kind: "idle" }, request: null });
        useRun.getState().continueRun("premium");
        return;
      }
      await wait(CONFIRM_POLL_MS);
      if (!current(request)) return;
    }
    track("purchase_failed", { ...purchaseFields(offer), reason: "timeout" });
    set({ stage: { kind: "retry", reason: "slow_confirmation", offer, purchaseId } });
  }

  return {
    stage: { kind: "idle" },
    request: null,

    async prepare(result: RunResult): Promise<void> {
      if (get().request?.runId === result.runId) return;
      const request: ContinueRequest = {
        runId: result.runId,
        continueNo: result.continues.length + 1,
        elapsedSec: result.survivalSec,
      };
      set({ request, stage: { kind: "loading" } });
      await quote(request);
    },

    async buy(): Promise<void> {
      const { request, stage } = get();
      if (request === null || stage.kind !== "ready") return;
      await purchase(request, stage.offer);
    },

    async retry(): Promise<void> {
      const { request, stage } = get();
      if (request === null || stage.kind !== "retry") return;
      if (stage.purchaseId !== null && stage.offer !== null) return await confirm(request, stage.offer, stage.purchaseId);
      if (stage.offer !== null) return await purchase(request, stage.offer);
      set({ stage: { kind: "loading" } });
      await quote(request);
    },

    reset(): void {
      set({ stage: { kind: "idle" }, request: null });
    },
  };
});

/** Разрез событий покупки (docs/22-analytics-and-metrics.md §3.3): тестовые оплаты отделяются режимом. */
function purchaseFields(offer: ContinueOffer): Record<string, string | number> {
  return {
    product: "continue_run",
    priceStars: offer.priceStars,
    chargedStars: offer.chargedStars,
    mode: offer.mode,
    continueNo: offer.continueNo,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
