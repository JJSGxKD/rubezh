import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError, ValidationError } from "../../common/domain-error.js";
import type { AccountRef } from "../roles/roles.service.js";
import { CONTINUES_PER_RUN } from "../runs/run-rules.js";
import { RUNS_REPOSITORY, type RunsRepository } from "../runs/runs.repository.js";
import { TelegramApiError, TELEGRAM_BOT_API, type TelegramBotApi } from "../telegram/telegram-bot-api.js";
import { continuePrice } from "./continue-price.js";
import type { ContinueRequest } from "./dto/payments.dto.js";
import { continueInvoice } from "./invoice-text.js";
import {
  ContinueUnavailableError,
  ElapsedExceedsClockError,
  PaymentsUnavailableError,
  PaymentsUnsupportedError,
  PurchaseNotFoundError,
  RunUnverifiedError,
} from "./payments-errors.js";
import { isGranted, isTelegramUserId, type PaymentMode, type PurchaseStatus, type StoredPurchase } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Второй шанс за Telegram Stars (docs/34-stage3-plan.md, WP5): цена и счёт.
 * Подтверждение оплаты приходит обновлением бота — `payments-bot.handler.ts`.
 *
 * **Цену считает сервер** (Р5.1) — по секунде забега, которую сообщил
 * клиент, но не больше, чем прошло по часам сервера от начала забега
 * (Р5.2). Заявить меньше можно: итог забега потом приезжает с секундой
 * каждого продолжения, и недоплату ловит вердикт забега.
 *
 * **Право на продолжение выдаёт подтверждение от Telegram**, а не ответ
 * `openInvoice` в клиенте (Р13): клиент только ждёт, пока покупка станет
 * оплаченной.
 */

export interface ContinueOffer {
  continueNo: number;
  /** цена по правилу Р5.1 — её показывает клиент */
  priceStars: number;
  /** сколько спишется на самом деле */
  chargedStars: number;
  mode: PaymentMode;
}

export interface ContinueInvoice extends ContinueOffer {
  purchaseId: string;
  /** `paid` — это продолжение уже оплачено, счёт не нужен: так повтор запроса после потерянного ответа не берёт денег дважды */
  status: "pending" | "paid";
  /** ссылка для `openInvoice`; `null` у оплаченного */
  invoiceUrl: string | null;
}

export interface PurchaseView {
  purchaseId: string;
  runId: string;
  continueNo: number;
  status: PurchaseStatus;
  /** продолжение выдано: оплата подтверждена, возврат выданное не отзывает */
  granted: boolean;
  priceStars: number;
  chargedStars: number;
  mode: PaymentMode;
}

export type InvoiceBotApi = Pick<TelegramBotApi, "createInvoiceLink">;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
    @Inject(RUNS_REPOSITORY) private readonly runs: Pick<RunsRepository, "find">,
    @Inject(TELEGRAM_BOT_API) private readonly api: InvoiceBotApi,
  ) {}

  /** Сколько стоит продолжить — без записи и без обращения к Telegram: спрашивают на каждой смерти. */
  async quote(account: AccountRef, request: ContinueRequest, nowMs = Date.now()): Promise<ContinueOffer> {
    return await this.offer(account, request, nowMs);
  }

  async invoice(account: AccountRef, request: ContinueRequest, nowMs = Date.now()): Promise<ContinueInvoice> {
    const offer = await this.offer(account, request, nowMs);
    const outcome = await this.purchases.openInvoice({
      purchaseId: randomUUID(),
      accountId: account.accountId,
      runId: request.runId,
      continueNo: offer.continueNo,
      elapsedSec: request.elapsedSec,
      priceStars: offer.priceStars,
      chargedStars: offer.chargedStars,
      mode: offer.mode,
      invoicedAt: new Date(nowMs),
    });
    if (outcome.kind === "foreign") throw new ValidationError("Некорректный забег");
    if (outcome.kind === "paid") {
      return { ...offerOf(outcome.purchase), purchaseId: outcome.purchase.purchaseId, status: "paid", invoiceUrl: null };
    }

    const { purchase } = outcome;
    const invoiceUrl = await this.invoiceLink(purchase);
    this.log("log", "invoice_created", {
      accountId: account.accountId,
      runId: purchase.runId,
      purchaseId: purchase.purchaseId,
      priceStars: purchase.priceStars,
      chargedStars: purchase.chargedStars,
      mode: purchase.mode,
    });
    return { ...offerOf(purchase), purchaseId: purchase.purchaseId, status: "pending", invoiceUrl };
  }

  /** Состояние покупки — его опрашивает клиент, ожидая подтверждения от Telegram. */
  async purchase(account: AccountRef, purchaseId: string): Promise<PurchaseView> {
    this.assertEnabled();
    const purchase = await this.purchases.byId(purchaseId);
    // Чужая покупка неотличима от несуществующей: иначе ответ подтверждал бы,
    // что такой id есть.
    if (purchase === null || purchase.accountId !== account.accountId) throw new PurchaseNotFoundError();
    return {
      purchaseId: purchase.purchaseId,
      runId: purchase.runId,
      status: purchase.status,
      granted: isGranted(purchase),
      ...offerOf(purchase),
    };
  }

  private async offer(account: AccountRef, request: ContinueRequest, nowMs: number): Promise<ContinueOffer> {
    this.assertEnabled();
    if (account.platform !== "telegram" || !isTelegramUserId(account.platformUserId)) throw new PaymentsUnsupportedError();
    if (request.continueNo > CONTINUES_PER_RUN) throw new ContinueUnavailableError("Продолжения этого забега закончились");

    const run = await this.runs.find(request.runId);
    if (run !== null && run.accountId !== account.accountId) throw new ValidationError("Некорректный забег");
    // Строки нет — старт ещё не дошёл; время начала неизвестно — старт
    // опоздал. В обоих случаях минуты по часам сервера не посчитать.
    if (run === null || run.startedAt === null) throw new RunUnverifiedError();
    if (run.status === "finished") throw new ContinueUnavailableError("Забег уже закончен");

    const wallClockSec = (nowMs - run.startedAt.getTime()) / 1000;
    if (request.elapsedSec > wallClockSec + this.config.runs.wallClockToleranceSec) {
      this.log("warn", "elapsed_exceeds_clock", { accountId: account.accountId, runId: run.runId, elapsedSec: request.elapsedSec, wallClockSec });
      throw new ElapsedExceedsClockError();
    }
    // Второе продолжение — только после оплаченного первого: иначе номер
    // продолжения ничего не значил бы, а ключ счёта перестал бы быть ключом.
    if (request.continueNo > 1 && (await this.purchases.grantedContinues(run.runId)) < request.continueNo - 1) {
      throw new ValidationError("Некорректное продолжение");
    }

    const priceStars = continuePrice(request.elapsedSec, this.config.payments);
    // Тестовая оплата (Р14): цена настоящая — её игрок и видит, — а
    // списывается одна звезда, и та вернётся сразу после подтверждения.
    const mode: PaymentMode = this.config.payments.testMode ? "test" : "live";
    return { continueNo: request.continueNo, priceStars, chargedStars: mode === "test" ? 1 : priceStars, mode };
  }

  private async invoiceLink(purchase: StoredPurchase): Promise<string> {
    try {
      return await this.api.createInvoiceLink(continueInvoice(purchase));
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError)) throw error;
      // Строка покупки остаётся ждать оплаты: повтор запроса выставит счёт на
      // неё же, а не заведёт вторую.
      this.log("warn", "invoice_failed", { purchaseId: purchase.purchaseId, reason: error.message });
      throw new PaymentsUnavailableError();
    }
  }

  private assertEnabled(): void {
    // 404, а не 403: выключенная оплата не подтверждает, что она есть.
    if (!this.config.payments.enabled) throw new DisabledError("Оплата выключена");
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

function offerOf(purchase: StoredPurchase): ContinueOffer {
  return {
    continueNo: purchase.continueNo,
    priceStars: purchase.priceStars,
    chargedStars: purchase.chargedStars,
    mode: purchase.mode,
  };
}
