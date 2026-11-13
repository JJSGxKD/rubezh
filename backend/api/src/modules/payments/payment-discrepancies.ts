import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ForbiddenError } from "../../common/domain-error.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { PaymentProviders } from "../../platforms/ports/payment-provider.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PaymentFeedSources } from "./payment-feed-sources.js";
import { actorNameOf } from "./payment-jobs.js";
import { DISCREPANCY_KINDS, DISCREPANCY_RESOLUTIONS, type DiscrepancyKind, type DiscrepancyResolution } from "./payment-reconcile.js";
import { PAYMENT_RECONCILE_REPOSITORY, type DiscrepancyRow, type PaymentDiscrepancyStore } from "./payment-reconcile.repository.js";
import type { DiscrepancyView } from "./payment-reconciler.js";
import type { FeedMark, TimelineEntry } from "./payment-timeline.js";
import { DiscrepancyNotFoundError, PurchaseActionUnavailableError } from "./payments-errors.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PaymentsQueue } from "./payments-queue.js";
import type { PurchaseAction, StoredPurchase } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Действия по расхождениям сверки с выпиской площадки (Р209, WP53, tasks/T-0434): «Повторить учёт»,
 * «Вернуть звёзды», «Разобрано» и источник карточки платежа — строки хронологии расхождения, пометка
 * ленты и действие «Повторить учёт».
 *
 * | вид | «Повторить учёт» | «Вернуть звёзды» | «Разобрано» |
 * |---|---|---|---|
 * | `charged_unrecorded` | задание подтверждения по выписке | возврат оплаты без покупки | да |
 * | `refund_unrecorded` | задание внешнего возврата по выписке | нет | да |
 * | `recorded_missing` | нет — 409 | нет | да |
 *
 * **Запись по выписке — тем же заданием очереди оплаты, что подтверждение от бота** (`PaymentsQueue.replay`):
 * запись идемпотентна по идентификатору оплаты, выдача — по ключу покупки, а неизвестный счёт вернёт звёзды
 * сам (`unmatched`). Время оплаты — время операции площадки, а не время повтора: по нему считаются холд и
 * срок VIP.
 *
 * **Гонки.** Действие сначала занимает расхождение условным обновлением (`claim`): занял не он — 409
 * «Расхождение уже разобрано», и задание не ставится. Двойное нажатие даёт одно задание и одну запись в
 * журнал. Задание ставится после занятия и наружу ошибкой не пробивается (`PaymentsQueue.run` пишет её в
 * лог со всеми полями оплаты), поэтому занятое расхождение не остаётся без попытки действия.
 *
 * Право — `payments.support`, причина обязательна (проверяет контроллер). Свою оплату не разбирают — только
 * вход разработчика, чтобы проверить на себе.
 */

export const ALREADY_RESOLVED = "Расхождение уже разобрано";
const NOT_RETRYABLE = "Повторять нечего: оплаты нет в выписке площадки. Не появится — нажмите «Разобрано» с причиной";
const NOT_REFUNDABLE = "Вернуть звёзды можно только у оплаты, которую мы не записали; у записанной — кнопкой в карточке платежа";
const NO_PAYER = "В выписке нет игрока — вернуть или записать оплату нельзя";
const NO_PROVIDER = "Площадка не принимает оплату — записать или вернуть её нельзя";
const OWN_PAYMENT = "Разбирать свою оплату нельзя";
const UNKNOWN_VALUE = "Расхождение записано более новой версией сервера — разберите его там";
/** Метка задания повтора по выписке в его идентификаторе: `confirm-<отпечаток>-reconcile`. */
const REPLAY_TAG = "reconcile";

/** Подписи видов для команды — те же, что в таблице «Решений» T-0433 и в сообщении о новых расхождениях. */
export const DISCREPANCY_LABELS: Readonly<Record<DiscrepancyKind, string>> = {
  charged_unrecorded: "Списано, но не записано",
  recorded_missing: "Записано, но нет в выписке",
  refund_unrecorded: "Возврат в Telegram, но не у нас",
};

const RESOLUTION_LABELS: Readonly<Record<DiscrepancyResolution, string>> = {
  matched: "сошлось само",
  retried: "учёт повторён",
  refunded: "звёзды возвращены",
  dismissed: "разобрано",
};

type Action = "retry" | "refund" | "dismiss";

const RESOLUTION_OF: Readonly<Record<Action, DiscrepancyResolution>> = { retry: "retried", refund: "refunded", dismiss: "dismissed" };
const AUDIT_OF: Readonly<Record<Action, string>> = { retry: "payments.discrepancy.retry", refund: "payments.discrepancy.refund", dismiss: "payments.discrepancy.dismiss" };

/** Что видит команда в сообщении поддержки по покупке расхождения: «Разобрано» сообщения не шлёт. */
const SUPPORT_EVENT: Readonly<Record<"retry" | "refund", { kind: PurchaseAction; detail: string }>> = {
  retry: { kind: "retry", detail: "запись по выписке площадки" },
  refund: { kind: "refund", detail: "оплата не была записана — возврат по выписке" },
};

const kindSchema = z.enum(DISCREPANCY_KINDS);
const resolutionSchema = z.enum(DISCREPANCY_RESOLUTIONS);
const platformSchema = z.enum(PLATFORM_IDS);

/** Виды, у которых «Повторить учёт» есть: у «записано, но нет в выписке» повторять нечего. */
const RETRYABLE: readonly DiscrepancyKind[] = ["charged_unrecorded", "refund_unrecorded"];

/** Строка расхождения, у которой вид, решение и площадка разобраны схемой: незнакомое значение — запись более новой версии. */
interface ParsedRow {
  row: DiscrepancyRow;
  platform: PlatformId;
  kind: DiscrepancyKind;
  resolution: DiscrepancyResolution | null;
}

@Injectable()
export class PaymentDiscrepancies implements OnModuleInit {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    // Тот же класс Postgres, что у сверки: чтение и захват для действий — отдельный интерфейс (`PaymentDiscrepancyStore`).
    @Inject(PAYMENT_RECONCILE_REPOSITORY) private readonly store: PaymentDiscrepancyStore,
    private readonly queue: PaymentsQueue,
    private readonly providers: PaymentProviders,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: Pick<PurchasesRepository, "byId">,
    private readonly roles: RolesService,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly hooks: PaymentsHooks,
    private readonly sources: PaymentFeedSources,
  ) {}

  onModuleInit(): void {
    this.sources.register("reconcile", {
      timeline: (purchase) => this.timeline(purchase),
      marks: (purchaseIds) => this.marks(purchaseIds),
      actions: (purchase) => this.actions(purchase),
    });
  }

  /** «Повторить учёт»: оплата или возврат записываются по выписке площадки тем же заданием, что обновление от бота. */
  async retry(actor: AccountRef, discrepancyId: string, note: string, now = new Date()): Promise<DiscrepancyView> {
    const found = await this.openFor(actor, discrepancyId);
    if (!RETRYABLE.includes(found.kind)) throw new PurchaseActionUnavailableError(NOT_RETRYABLE);
    const { row } = found;
    if (found.kind === "charged_unrecorded") {
      // Валюта — у площадки, а не из выписки: выписка звёзд бота её не называет.
      const currency = this.providers.for(found.platform)?.currency;
      if (currency === undefined) throw new PurchaseActionUnavailableError(NO_PROVIDER);
      if (row.payerId === null) throw new PurchaseActionUnavailableError(NO_PAYER);
      await this.claim(found, "retry", actor, note, now);
      const payment = { platform: found.platform, chargeId: row.chargeId, payload: row.payload ?? "", payerId: row.payerId, currency, totalAmount: row.amount };
      await this.queue.replay({ kind: "confirm", payment, at: row.occurredAt.getTime() }, REPLAY_TAG);
    } else {
      await this.claim(found, "retry", actor, note, now);
      await this.queue.replay({ kind: "refunded", chargeId: row.chargeId, at: row.occurredAt.getTime() }, REPLAY_TAG);
    }
    return await this.finish(found, "retry", actor, note, now);
  }

  /**
   * «Вернуть звёзды»: возврат оплаты, которую мы так и не записали. Заказ — без покупки (`purchaseId: null`,
   * причина `manual`), как возврат лишней оплаты: покупка остаётся неоплаченной, остатка забирать нечего.
   */
  async refund(actor: AccountRef, discrepancyId: string, note: string, now = new Date()): Promise<DiscrepancyView> {
    const found = await this.openFor(actor, discrepancyId);
    if (found.kind !== "charged_unrecorded") throw new PurchaseActionUnavailableError(NOT_REFUNDABLE);
    const { row } = found;
    if (this.providers.for(found.platform) === null) throw new PurchaseActionUnavailableError(NO_PROVIDER);
    if (row.payerId === null) throw new PurchaseActionUnavailableError(NO_PAYER);
    await this.claim(found, "refund", actor, note, now);
    await this.queue.dispatchRefunds(Promise.resolve([{ purchaseId: null, platform: found.platform, chargeId: row.chargeId, payerId: row.payerId, reason: "manual" as const }]));
    return await this.finish(found, "refund", actor, note, now);
  }

  /** «Разобрано»: закрыть расхождение причиной, ничего не записывая и не возвращая. Доступно у каждого вида. */
  async dismiss(actor: AccountRef, discrepancyId: string, note: string, now = new Date()): Promise<DiscrepancyView> {
    const found = await this.openFor(actor, discrepancyId);
    await this.claim(found, "dismiss", actor, note, now);
    return await this.finish(found, "dismiss", actor, note, now);
  }

  /**
   * Что повторит «Повторить учёт» в карточке платежа, когда брошенных заданий нет: самое раннее открытое
   * расхождение покупки вида «списано, но не записано» или «возврат не у нас». Нет — `null`.
   */
  async retryableFor(purchaseId: string): Promise<string | null> {
    const rows = await this.store.byPurchase(purchaseId);
    for (const { row, kind, resolution } of this.parse(rows)) {
      if (row.resolvedAt === null && resolution === null && RETRYABLE.includes(kind)) return row.discrepancyId;
    }
    return null;
  }

  /**
   * Общий порядок действий: право, расхождение, закрыто ли оно, своё ли. Закрытое проверяется раньше «своего»:
   * закрытому расхождению ответ «уже разобрано» полезнее отказа, которого человек уже не обойдёт.
   */
  private async openFor(actor: AccountRef, discrepancyId: string): Promise<ParsedRow> {
    await this.roles.require(actor, "payments.support");
    const row = await this.store.byId(discrepancyId);
    if (row === null) throw new DiscrepancyNotFoundError();
    if (row.resolvedAt !== null) throw new PurchaseActionUnavailableError(ALREADY_RESOLVED);
    if (row.accountId !== null && row.accountId === actor.accountId && !this.config.auth.devLogin) throw new ForbiddenError(OWN_PAYMENT);
    const [parsed] = this.parse([row]);
    if (parsed === undefined) throw new PurchaseActionUnavailableError(UNKNOWN_VALUE);
    return parsed;
  }

  /** Занять расхождение под решение: занял не этот вызов — 409, и ничего дальше не делается. */
  private async claim(found: ParsedRow, action: Action, actor: AccountRef, note: string, now: Date): Promise<void> {
    if (!(await this.store.claim(found.row.discrepancyId, RESOLUTION_OF[action], actor.accountId, note, now))) throw new PurchaseActionUnavailableError(ALREADY_RESOLVED);
  }

  /** После действия: журнал, сообщение команде по покупке, строка лога и ответ — расхождение таким, каким оно стало. */
  private async finish(found: ParsedRow, action: Action, actor: AccountRef, note: string, now: Date): Promise<DiscrepancyView> {
    const { row } = found;
    const resolution = RESOLUTION_OF[action];
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: AUDIT_OF[action],
      target: row.accountId,
      after: { discrepancyId: row.discrepancyId, kind: found.kind, chargeId: row.chargeId, purchaseId: row.purchaseId, note },
    });
    if (action !== "dismiss") await this.tellTeam(row, action, actor, note, now);
    this.log("log", "discrepancy_resolved", { discrepancyId: row.discrepancyId, kind: found.kind, resolution, actorAccountId: actor.accountId });
    return await this.view({ ...found, row: { ...row, resolution, resolvedAt: now, resolvedBy: actor.accountId, note }, resolution }, actor);
  }

  /** Сообщение команде — только при найденной покупке; сбой чтения покупки не отменяет уже сделанное. */
  private async tellTeam(row: DiscrepancyRow, action: "retry" | "refund", actor: AccountRef, note: string, now: Date): Promise<void> {
    if (row.purchaseId === null) return;
    let purchase: StoredPurchase | null;
    try {
      purchase = await this.purchases.byId(row.purchaseId);
    } catch (error: unknown) {
      this.log("warn", "discrepancy_purchase_unread", { discrepancyId: row.discrepancyId, reason: error instanceof Error ? error.message : "unknown" });
      return;
    }
    if (purchase === null) return;
    const actorName = await actorNameOf(this.accounts, actor, (reason) => this.log("warn", "discrepancy_name_unread", { actorAccountId: actor.accountId, reason }));
    await this.hooks.emitSupport({ purchase, actorName, note, at: now, ...SUPPORT_EVENT[action] });
  }

  /** Идентификатор плательщика на площадке — персональные данные: без `players.pii.view` он стёрт, как в обзоре сверки. */
  private async view(found: ParsedRow, actor: AccountRef): Promise<DiscrepancyView> {
    const { row } = found;
    const withPayer = await this.roles.can(actor, "players.pii.view");
    const names = await this.namesOf([row.accountId, row.resolvedBy]);
    return {
      discrepancyId: row.discrepancyId,
      platform: found.platform,
      kind: found.kind,
      chargeId: row.chargeId,
      purchaseId: row.purchaseId,
      accountId: row.accountId,
      displayName: row.accountId === null ? null : (names.get(row.accountId) ?? null),
      payerId: withPayer ? row.payerId : null,
      amount: row.amount,
      payload: row.payload,
      occurredAt: row.occurredAt,
      detectedAt: row.detectedAt,
      resolution: found.resolution,
      resolvedAt: row.resolvedAt,
      resolvedByName: row.resolvedBy === null ? null : (names.get(row.resolvedBy) ?? null),
      note: row.note,
    };
  }

  /** Имена аккаунтов одним запросом; без аккаунтов запроса нет. */
  private async namesOf(accountIds: readonly (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(accountIds.filter((id): id is string => id !== null))];
    return ids.length === 0 ? new Map<string, string>() : await this.accounts.displayNames(ids);
  }

  /** Строки хронологии: обнаружение и, если закрыто, закрытие — с именем того, кто закрыл. */
  private async timeline(purchase: StoredPurchase): Promise<TimelineEntry[]> {
    const parsed = this.parse(await this.store.byPurchase(purchase.purchaseId));
    const names = await this.namesOf(parsed.map(({ row }) => row.resolvedBy));
    const lines: TimelineEntry[] = [];
    for (const { row, kind, resolution } of parsed) {
      lines.push({ at: row.detectedAt, kind: "discrepancy", text: `Сверка: ${DISCREPANCY_LABELS[kind]}`, actorName: null });
      if (row.resolvedAt === null || resolution === null) continue;
      const actorName = row.resolvedBy === null ? null : (names.get(row.resolvedBy) ?? null);
      lines.push({ at: row.resolvedAt, kind: "discrepancy", text: `Расхождение закрыто: ${RESOLUTION_LABELS[resolution]}`, actorName });
    }
    return lines;
  }

  /** Пометка `discrepancy` — у покупок с открытым расхождением любого вида, одним запросом на страницу ленты. */
  private async marks(purchaseIds: readonly string[]): Promise<Map<string, readonly FeedMark[]>> {
    const marked = new Map<string, readonly FeedMark[]>();
    if (purchaseIds.length === 0) return marked;
    for (const row of await this.store.openByPurchases(purchaseIds)) {
      if (row.purchaseId !== null) marked.set(row.purchaseId, ["discrepancy"]);
    }
    return marked;
  }

  private async actions(purchase: StoredPurchase): Promise<PurchaseAction[]> {
    return (await this.retryableFor(purchase.purchaseId)) === null ? [] : ["retry"];
  }

  /**
   * Вид, решение и площадка строки — типы. Незнакомое значение (запись более новой версии) пропускается с
   * предупреждением, а не роняет карточку платежа.
   */
  private parse(rows: readonly DiscrepancyRow[]): ParsedRow[] {
    const parsed: ParsedRow[] = [];
    for (const row of rows) {
      const platform = platformSchema.safeParse(row.platform);
      const kind = kindSchema.safeParse(row.kind);
      const resolution = row.resolution === null ? null : resolutionSchema.safeParse(row.resolution);
      if (!platform.success || !kind.success || (resolution !== null && !resolution.success)) {
        this.log("warn", "discrepancy_row_skipped", { discrepancyId: row.discrepancyId, chargeId: row.chargeId, platform: row.platform, kind: row.kind, resolution: row.resolution });
        continue;
      }
      parsed.push({ row, platform: platform.data, kind: kind.data, resolution: resolution === null ? null : resolution.data });
    }
    return parsed;
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}
