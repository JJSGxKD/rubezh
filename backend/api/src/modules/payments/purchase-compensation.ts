import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DomainError, ForbiddenError, ValidationError } from "../../common/domain-error.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { PaymentFeedSources } from "./payment-feed-sources.js";
import type { FeedMark } from "./payment-timeline.js";
import { CompensationFailedError, PurchaseActionUnavailableError, PurchaseNotFoundError } from "./payments-errors.js";
import { PaymentsHooks } from "./payments-hooks.js";
import {
  COMPENSATION_REASON,
  COMPENSATION_RESOURCE,
  COMPENSATION_TEXTS,
  compensationBlock,
  compensationKey,
  compensationTimeline,
  equivalentGems,
  overCeilingText,
  recentManualGrants,
  suggestedGems,
  type ManualGrant,
} from "./purchase-compensation-rules.js";
import { PURCHASE_COMPENSATION_REPOSITORY, type CompensationRow, type PurchaseCompensationRepository } from "./purchase-compensation.repository.js";
import type { StoredPurchase } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Компенсация самоцветами за сбой оплаты (docs/35-stage4-plan.md, Р209, WP53,
 * tasks/T-0435): из карточки платежа, одним действием, без риска начислить
 * дважды. Право — `payments.compensate` (только владелец) — и на предложение,
 * и на начисление.
 *
 * **Порядок записи — строка, затем кошелёк, затем отметка.** Вставка строки
 * занимает покупку (первичный ключ — вторую не пустит), `WalletService.grant`
 * с ключом `compensation:<покупка>` кладёт самоцветы, `credited_at` ставится
 * последним. Упало между — строка есть, отметки нет: повтор доначислит **ту же**
 * сумму из строки (ключ кошелька не даст начислить дважды), а новая сумма из
 * запроса игнорируется. Журнал действий, сообщение команде и строка лога идут
 * один раз — тем вызовом, который поставил отметку.
 *
 * Свою покупку и тестовую оплату компенсировать нельзя — кроме входа
 * разработчика, где владелец и игрок один человек (`compensationBlock`).
 */

/** Сколько последних записей кошелька читает предложение, чтобы найти ручные начисления за 30 суток. */
const MANUAL_SCAN_LIMIT = 100;

const NOTE_MIN = 3;
const NOTE_MAX = 200;

export interface CompensationPreview {
  purchaseId: string;
  /** `null` — можно; иначе — почему нельзя, текстом из решений */
  blockedReason: string | null;
  chargedStars: number;
  equivalentGems: number | null;
  multiplier: number;
  suggestedGems: number | null;
  maxGems: number;
  existing: { gems: number; suggested: number | null; note: string; actorName: string | null; createdAt: Date; credited: boolean } | null;
  /** «Кошелёк ±» игроку в плюс за 30 суток — чтобы не начислить дважды */
  recentManual: ManualGrant[];
}

export interface CompensationResult {
  purchaseId: string;
  gems: number;
  balance: number;
  /** доначислена ранее записанная строка: сумма взята из неё, а не из запроса */
  repaired: boolean;
}

/** Строка, с которой идёт начисление, и откуда она взялась. */
interface Claim {
  row: CompensationRow;
  repaired: boolean;
}

@Injectable()
export class PurchaseCompensations implements OnModuleInit {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
    @Inject(PURCHASE_COMPENSATION_REPOSITORY) private readonly compensations: PurchaseCompensationRepository,
    private readonly wallet: WalletService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly roles: RolesService,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly hooks: PaymentsHooks,
    private readonly sources: PaymentFeedSources,
  ) {}

  /** Карточка платежа получает строки, пометки и действие компенсации, не зная об этом модуле. */
  onModuleInit(): void {
    this.sources.register("compensation", {
      timeline: async (purchase) => {
        const row = await this.compensations.byPurchase(purchase.purchaseId);
        return row === null ? [] : [compensationTimeline(row, await this.nameOf(row.actorAccountId))];
      },
      marks: async (purchaseIds) => {
        const rows = await this.compensations.byPurchases(purchaseIds);
        const marked = new Map<string, readonly FeedMark[]>();
        for (const [purchaseId, row] of rows) if (row.creditedAt !== null) marked.set(purchaseId, ["compensated"]);
        return marked;
      },
      actions: async (purchase) => {
        const row = await this.compensations.byPurchase(purchase.purchaseId);
        // Актёра источник не знает: свою покупку отсекает сервис при самом действии.
        return compensationBlock(purchase, { devLogin: this.config.auth.devLogin, actorAccountId: null, credited: isCredited(row) }) === null ? ["compensate"] : [];
      },
    });
  }

  async preview(actor: AccountRef, purchaseId: string, now = new Date()): Promise<CompensationPreview> {
    await this.roles.require(actor, "payments.compensate");
    const purchase = await this.load(purchaseId);
    const [row, entries] = await Promise.all([this.compensations.byPurchase(purchaseId), this.wallet.recentEntries(purchase.accountId, MANUAL_SCAN_LIMIT)]);
    const multiplier = this.settings.get(SETTINGS.paymentsCompensationMultiplier);
    const maxGems = this.settings.get(SETTINGS.paymentsCompensationMaxGems);
    const equivalent = equivalentGems(purchase);
    return {
      purchaseId,
      blockedReason: compensationBlock(purchase, { devLogin: this.config.auth.devLogin, actorAccountId: actor.accountId, credited: isCredited(row) }),
      chargedStars: purchase.chargedStars,
      equivalentGems: equivalent,
      multiplier,
      suggestedGems: suggestedGems(equivalent, multiplier, maxGems),
      maxGems,
      existing:
        row === null
          ? null
          : { gems: row.amount, suggested: row.suggested, note: row.note, actorName: await this.nameOf(row.actorAccountId), createdAt: row.createdAt, credited: row.creditedAt !== null },
      recentManual: recentManualGrants(entries, now),
    };
  }

  async compensate(actor: AccountRef, purchaseId: string, input: { gems: number; note: string }, now = new Date()): Promise<CompensationResult> {
    await this.roles.require(actor, "payments.compensate");
    checkInput(input);
    const purchase = await this.load(purchaseId);
    const known = await this.compensations.byPurchase(purchaseId);
    const block = compensationBlock(purchase, { devLogin: this.config.auth.devLogin, actorAccountId: actor.accountId, credited: isCredited(known) });
    if (block !== null) throw block === COMPENSATION_TEXTS.own ? new ForbiddenError(block) : new PurchaseActionUnavailableError(block);

    const { row, repaired } = known === null ? await this.claim(actor, purchase, input, now) : { row: known, repaired: true };
    const balance = await this.credit(actor, row, now);
    // Отметку ставит один вызов из двух одновременных: журнал и сообщение — только ему.
    if (await this.mark(row, now)) await this.announce(actor, purchase, row, now);
    return { purchaseId, gems: row.amount, balance, repaired };
  }

  /**
   * Занять покупку строкой. Сумма проверяется по потолку только здесь: при
   * готовой строке берётся её сумма, а запрос игнорируется. `exists` — другой
   * вызов успел раньше: если он уже закончил, отказ, иначе дорабатываем его строку.
   */
  private async claim(actor: AccountRef, purchase: StoredPurchase, input: { gems: number; note: string }, now: Date): Promise<Claim> {
    const maxGems = this.settings.get(SETTINGS.paymentsCompensationMaxGems);
    if (input.gems > maxGems) throw new ValidationError(overCeilingText(maxGems));
    const suggested = suggestedGems(equivalentGems(purchase), this.settings.get(SETTINGS.paymentsCompensationMultiplier), maxGems);
    const fresh: CompensationRow = {
      purchaseId: purchase.purchaseId,
      accountId: purchase.accountId,
      resource: COMPENSATION_RESOURCE,
      amount: input.gems,
      suggested,
      note: input.note,
      actorAccountId: actor.accountId,
      createdAt: now,
      creditedAt: null,
    };
    if ((await this.compensations.insert(fresh)) === "inserted") return { row: fresh, repaired: false };
    const existing = await this.compensations.byPurchase(purchase.purchaseId);
    if (existing === null) {
      this.log("error", "purchase_compensation_row_missing", { purchaseId: purchase.purchaseId });
      throw new CompensationFailedError();
    }
    if (existing.creditedAt !== null) throw new PurchaseActionUnavailableError(COMPENSATION_TEXTS.credited);
    return { row: existing, repaired: true };
  }

  /** Самоцветы в кошелёк под ключом покупки: повтор того же ключа второй раз не начислит. */
  private async credit(actor: AccountRef, row: CompensationRow, now: Date): Promise<number> {
    try {
      const granted = await this.wallet.grant({
        accountId: row.accountId,
        resource: COMPENSATION_RESOURCE,
        amount: row.amount,
        reason: COMPENSATION_REASON,
        source: `admin:${actor.accountId}`,
        idempotencyKey: compensationKey(row.purchaseId),
        at: now,
      });
      return granted.balance;
    } catch (error: unknown) {
      throw this.failed(error, row.purchaseId, "wallet");
    }
  }

  private async mark(row: CompensationRow, now: Date): Promise<boolean> {
    try {
      return await this.compensations.markCredited(row.purchaseId, now);
    } catch (error: unknown) {
      throw this.failed(error, row.purchaseId, "mark");
    }
  }

  /** Отказ предметной области идёт как есть; остальное — в лог, а человеку — «нажмите ещё раз». */
  private failed(error: unknown, purchaseId: string, stage: "wallet" | "mark"): Error {
    if (error instanceof DomainError) return error;
    this.log("error", "purchase_compensation_failed", { purchaseId, stage, reason: error instanceof Error ? error.message : "unknown" });
    return new CompensationFailedError();
  }

  /** Журнал действий, сообщение в поток «Покупки» и лог — после того, как самоцветы легли и отметка стоит. */
  private async announce(actor: AccountRef, purchase: StoredPurchase, row: CompensationRow, now: Date): Promise<void> {
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "payments.compensate",
      target: row.accountId,
      after: { purchaseId: row.purchaseId, gems: row.amount, suggested: row.suggested, note: row.note },
    });
    await this.hooks.emitSupport({ kind: "compensate", purchase, actorName: (await this.nameOf(actor.accountId)) ?? actor.accountId, note: row.note, at: now, gems: row.amount });
    this.log("log", "purchase_compensated", {
      purchaseId: row.purchaseId,
      accountId: row.accountId,
      gems: row.amount,
      suggested: row.suggested,
      actorAccountId: actor.accountId,
    });
  }

  private async load(purchaseId: string): Promise<StoredPurchase> {
    const purchase = await this.purchases.byId(purchaseId);
    if (purchase === null) throw new PurchaseNotFoundError();
    return purchase;
  }

  /**
   * Имя — как в аккаунте; нет аккаунта или он не прочитался — `null`: действие
   * уже выполнено, и строка хронологии или сообщение команде не должны из-за
   * имени превратиться в ошибку запроса.
   */
  private async nameOf(accountId: string): Promise<string | null> {
    try {
      return (await this.accounts.displayNames([accountId])).get(accountId) ?? null;
    } catch (error: unknown) {
      this.log("warn", "purchase_compensation_name_unread", { actorAccountId: accountId, reason: error instanceof Error ? error.message : "unknown" });
      return null;
    }
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

/** Граница сервиса: его зовут и не из HTTP, а колонка примечания — 200 знаков. */
function checkInput(input: { gems: number; note: string }): void {
  if (!Number.isInteger(input.gems) || input.gems < 1) throw new ValidationError("Укажите сумму от 1 самоцвета");
  const length = [...input.note.trim()].length;
  if (length < NOTE_MIN || length > NOTE_MAX) throw new ValidationError(`Укажите причину: от ${String(NOTE_MIN)} до ${String(NOTE_MAX)} символов`);
}

/** Начислено в кошелёк: строка есть и отметка стоит. */
function isCredited(row: CompensationRow | null): boolean {
  return row !== null && row.creditedAt !== null;
}
