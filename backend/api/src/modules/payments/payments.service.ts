import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { FeatureSwitches } from "../settings/feature-switches.js";
import { DisabledError, ValidationError } from "../../common/domain-error.js";
import type { AccountRef } from "../roles/roles.service.js";
import { CONTINUES_PER_RUN } from "../runs/run-rules.js";
import { RUNS_REPOSITORY, type RunsRepository } from "../runs/runs.repository.js";
import { PaymentProviders, PaymentProviderUnavailableError, type ProviderInvoice } from "../../platforms/ports/payment-provider.js";
import { continuePrice } from "./continue-price.js";
import type { ContinueRequest } from "./dto/payments.dto.js";
import { continueInvoice, shopInvoice, type ShopInvoiceText } from "./invoice-text.js";
import {
  ContinueUnavailableError,
  ElapsedExceedsClockError,
  PaymentsUnavailableError,
  PaymentsUnsupportedError,
  PurchaseNotFoundError,
  RunUnverifiedError,
} from "./payments-errors.js";
import { isGranted, type PaymentMode, type PurchaseProduct, type PurchaseStatus, type StoredPurchase } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Второй шанс за деньги площадки (docs/34-stage3-plan.md, WP5): цена и счёт.
 * Счёт выставляет способ оплаты площадки аккаунта (порт оплаты), подтверждение
 * приносит её адаптер — у Telegram это обновление бота
 * (`platforms/telegram/telegram-payments.handler.ts`).
 *
 * **Цену считает сервер** (Р5.1) — по секунде забега, которую сообщил
 * клиент, но не больше, чем прошло по часам сервера от начала забега
 * (Р5.2). Заявить меньше можно: итог забега потом приезжает с секундой
 * каждого продолжения, и недоплату ловит вердикт забега.
 *
 * **Право на продолжение выдаёт подтверждение от площадки**, а не ответ
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
  product: PurchaseProduct;
  /** забег и номер продолжения — у второго шанса; у товара магазина — пусто */
  runId: string | null;
  continueNo: number | null;
  /** товар каталога — у покупки в магазине */
  sku: string | null;
  status: PurchaseStatus;
  /** право выдано: оплата подтверждена, возврат выданное не отзывает */
  granted: boolean;
  /** товар лёг на счёт игрока; у второго шанса совпадает с `granted` */
  fulfilled: boolean;
  priceStars: number;
  chargedStars: number;
  mode: PaymentMode;
}

/** Что магазин продаёт этим счётом: цену и текст решает магазин, оплату — этот модуль. */
export interface ShopOrder {
  /** товар каталога или VIP */
  product: Exclude<PurchaseProduct, "continue_run">;
  sku: string;
  priceStars: number;
  /** разовый товар — один на аккаунт */
  once: boolean;
  /**
   * Подписка: площадка списывает цену каждый такой период сама. Площадка без
   * подписок или с другим периодом такой товар не продаёт.
   */
  subscriptionPeriodSec?: number;
  text: ShopInvoiceText;
}

export interface ShopInvoice {
  purchaseId: string;
  sku: string;
  /** `paid` — разовый товар уже куплен: счёт не нужен */
  status: "pending" | "paid";
  invoiceUrl: string | null;
  priceStars: number;
  chargedStars: number;
  mode: PaymentMode;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
    @Inject(RUNS_REPOSITORY) private readonly runs: Pick<RunsRepository, "find">,
    private readonly providers: PaymentProviders,
    private readonly switches: FeatureSwitches,
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
      return { ...offerOf(outcome.purchase, offer.continueNo), purchaseId: outcome.purchase.purchaseId, status: "paid", invoiceUrl: null };
    }

    const { purchase } = outcome;
    const invoiceUrl = await this.invoiceLink(account, purchase, continueInvoice({ ...purchase, elapsedSec: purchase.elapsedSec ?? request.elapsedSec }));
    this.log("log", "invoice_created", {
      accountId: account.accountId,
      runId: purchase.runId,
      purchaseId: purchase.purchaseId,
      priceStars: purchase.priceStars,
      chargedStars: purchase.chargedStars,
      mode: purchase.mode,
    });
    return { ...offerOf(purchase, offer.continueNo), purchaseId: purchase.purchaseId, status: "pending", invoiceUrl };
  }

  /**
   * Счёт на товар магазина или VIP (WP10): та же цепочка, что у второго
   * шанса, — проверка перед оплатой, подтверждение через очередь, возвраты.
   * Выдачу делает хозяин товара, зарегистрировав её в `PurchaseFulfillment`.
   * У подписки площадка потом списывает каждый период по этому же счёту —
   * продления записывает подтверждение оплаты.
   */
  async shopInvoice(account: AccountRef, order: ShopOrder, nowMs = Date.now()): Promise<ShopInvoice> {
    this.assertEnabled();
    const provider = this.providers.for(account.platform);
    if (provider === null || !provider.accepts(account.platformUserId)) throw new PaymentsUnsupportedError();
    if (order.subscriptionPeriodSec !== undefined && provider.subscriptionPeriodSec !== order.subscriptionPeriodSec) throw new PaymentsUnsupportedError();
    const { mode, chargedStars } = this.charge(order.priceStars);
    const outcome = await this.purchases.openShopInvoice({
      purchaseId: randomUUID(),
      accountId: account.accountId,
      product: order.product,
      sku: order.sku,
      onceKey: order.once ? onceKeyOf(order.sku, account.accountId) : null,
      priceStars: order.priceStars,
      chargedStars,
      mode,
      invoicedAt: new Date(nowMs),
    });
    if (outcome.kind === "foreign") throw new ValidationError("Некорректный товар");
    const { purchase } = outcome;
    const base = { purchaseId: purchase.purchaseId, sku: order.sku, priceStars: purchase.priceStars, chargedStars: purchase.chargedStars, mode: purchase.mode };
    if (outcome.kind === "paid") return { ...base, status: "paid", invoiceUrl: null };

    const text = shopInvoice({ purchaseId: purchase.purchaseId, priceStars: purchase.priceStars, chargedStars: purchase.chargedStars, mode: purchase.mode, text: order.text });
    const invoiceUrl = await this.invoiceLink(account, purchase, order.subscriptionPeriodSec === undefined ? text : { ...text, subscriptionPeriodSec: order.subscriptionPeriodSec });
    this.log("log", "invoice_created", { accountId: account.accountId, sku: order.sku, purchaseId: purchase.purchaseId, priceStars: purchase.priceStars, chargedStars: purchase.chargedStars, mode: purchase.mode });
    return { ...base, status: "pending", invoiceUrl };
  }

  /** Какие разовые товары аккаунт уже купил — магазин их не предлагает. */
  async ownedOnce(account: AccountRef, skus: readonly string[]): Promise<Set<string>> {
    const keys = new Map(skus.map((sku) => [onceKeyOf(sku, account.accountId), sku]));
    const owned = await this.purchases.ownedOnce(account.accountId, [...keys.keys()]);
    return new Set(owned.flatMap((key) => keys.get(key) ?? []));
  }

  /**
   * Состояние покупки — его опрашивает клиент, ожидая подтверждения от Telegram.
   * Видно и при выключенной оплате: стоп-кран закрывает только новые счета и
   * цены, а игрок, оплативший до выключения, должен узнать, что покупка
   * засчитана и выдана.
   */
  async purchase(account: AccountRef, purchaseId: string): Promise<PurchaseView> {
    const purchase = await this.purchases.byId(purchaseId);
    // Чужая покупка неотличима от несуществующей: иначе ответ подтверждал бы,
    // что такой id есть.
    if (purchase === null || purchase.accountId !== account.accountId) throw new PurchaseNotFoundError();
    const granted = isGranted(purchase);
    return {
      purchaseId: purchase.purchaseId,
      product: purchase.product,
      runId: purchase.runId,
      continueNo: purchase.continueNo,
      sku: purchase.sku,
      status: purchase.status,
      granted,
      fulfilled: purchase.product === "continue_run" ? granted : purchase.fulfilledAt !== null,
      priceStars: purchase.priceStars,
      chargedStars: purchase.chargedStars,
      mode: purchase.mode,
    };
  }

  private async offer(account: AccountRef, request: ContinueRequest, nowMs: number): Promise<ContinueOffer> {
    this.assertEnabled();
    const provider = this.providers.for(account.platform);
    if (provider === null || !provider.accepts(account.platformUserId)) throw new PaymentsUnsupportedError();
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
    return { continueNo: request.continueNo, priceStars, ...this.charge(priceStars) };
  }

  /**
   * Сколько спишется за цену и в каком режиме. Тестовая оплата (Р14): цена
   * настоящая — её игрок и видит, — а списывается одна звезда, и та вернётся
   * сразу после подтверждения. Витрина показывает то же, что окажется в счёте.
   */
  charge(priceStars: number): { mode: PaymentMode; chargedStars: number } {
    const { mode } = this;
    return { mode, chargedStars: mode === "test" ? 1 : priceStars };
  }

  /** Режим оплаты: тестовый — только в разработке (Р14). */
  get mode(): PaymentMode {
    return this.config.payments.testMode ? "test" : "live";
  }

  private async invoiceLink(account: AccountRef, purchase: StoredPurchase, invoice: ProviderInvoice): Promise<string> {
    const provider = this.providers.for(account.platform);
    if (provider === null) throw new PaymentsUnsupportedError();
    try {
      return await provider.createInvoice(invoice);
    } catch (error: unknown) {
      if (!(error instanceof PaymentProviderUnavailableError)) throw error;
      // Строка покупки остаётся ждать оплаты: повтор запроса выставит счёт на
      // неё же, а не заведёт вторую.
      this.log("warn", "invoice_failed", { purchaseId: purchase.purchaseId, reason: error.message });
      throw new PaymentsUnavailableError();
    }
  }

  private assertEnabled(): void {
    // 404, а не 403: выключенная оплата не подтверждает, что она есть.
    // Выключают её на ходу из панели — стоп-кран на случай, если с продажей
    // что-то не так; уже оплаченное засчитывается и без неё.
    if (!this.switches.payments()) throw new DisabledError("Оплата выключена");
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

function offerOf(purchase: StoredPurchase, continueNo: number): ContinueOffer {
  return {
    continueNo: purchase.continueNo ?? continueNo,
    priceStars: purchase.priceStars,
    chargedStars: purchase.chargedStars,
    mode: purchase.mode,
  };
}

/** Ключ разового товара: одна строка покупки на товар и аккаунт. */
function onceKeyOf(sku: string, accountId: string): string {
  return `${sku}:${accountId}`;
}
