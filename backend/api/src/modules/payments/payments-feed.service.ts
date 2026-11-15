import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import type { Permission } from "../roles/permissions.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PaymentFeedSources } from "./payment-feed-sources.js";
import { ACTION_ORDER, ACTION_PERMISSION, mergeTimeline, purchaseTimeline, teamTimeline, type FeedMark, type TimelineEntry } from "./payment-timeline.js";
import { PurchaseNotFoundError } from "./payments-errors.js";
import { PAYMENTS_FEED_REPOSITORY, type FeedQuery, type PaymentsFeedRepository } from "./payments-feed.repository.js";
import { PurchaseFulfillment } from "./purchase-fulfillment.js";
import { PurchaseSupport } from "./purchase-support.js";
import { SUBSCRIPTION_PRODUCTS, type PurchaseAction, type StoredPurchase } from "./purchase-types.js";

/**
 * Лента платежей и карточка платежа для панели (Р209, WP53, tasks/T-0429):
 * все покупки всех игроков с фильтрами и поиском и один платёж целиком — игрок,
 * продления, хронология и то, что с платежом можно сделать сейчас. Только
 * чтение: «Вернуть звёзды» и «Выдать» остаются в `PurchaseSupport`, остальные
 * действия приносят соседние задачи, а лента лишь показывает их по праву
 * актёра.
 *
 * Право проверяется здесь (`payments.view`), а не только охранником маршрута:
 * сервис зовут и не из HTTP. **Что видно в карточке, решает сервер**: панель
 * только прячет кнопки, а идентификатор игрока на площадке и юзернейм отдаются
 * с `players.pii.view` и с записью в журнал — как карточка игрока. В ленте
 * персональных данных нет вовсе.
 */

/** Сколько записей журнала действий читает карточка: чужие покупки того же игрока отсекаются после. */
const TEAM_JOURNAL_LIMIT = 100;

const CURSOR_PROBLEM = "Ссылка на страницу устарела — откройте ленту заново";
const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Фильтры ленты — запрос без размера страницы, курсора и списка товаров с выдачей: их знает сервис. */
export type FeedFilters = Omit<FeedQuery, "fulfillable" | "cursor" | "limit">;

export interface FeedRow {
  purchase: StoredPurchase;
  account: { accountId: string; displayName: string; platform: PlatformId };
  marks: FeedMark[];
}

export interface FeedPage {
  rows: FeedRow[];
  /** курсор следующей страницы; `null` — это последняя */
  next: string | null;
}

export interface PaymentCard {
  purchase: StoredPurchase;
  account: { accountId: string; displayName: string; platform: PlatformId; pii: { platformUserId: string; username: string | null } | null };
  /** первая покупка подписки — если эта покупка — продление */
  renewalOf: StoredPurchase | null;
  /** продления — если эта покупка — первая покупка подписки */
  renewals: StoredPurchase[];
  timeline: TimelineEntry[];
  actions: PurchaseAction[];
  marks: FeedMark[];
}

@Injectable()
export class PaymentsFeed {
  constructor(
    @Inject(PAYMENTS_FEED_REPOSITORY) private readonly repository: PaymentsFeedRepository,
    private readonly sources: PaymentFeedSources,
    private readonly support: PurchaseSupport,
    private readonly fulfillment: PurchaseFulfillment,
    private readonly roles: RolesService,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
  ) {}

  async page(actor: AccountRef, filters: FeedFilters, cursor: string | null, limit: number): Promise<FeedPage> {
    await this.roles.require(actor, "payments.view");
    const after = cursor === null ? null : decodeCursor(cursor);
    const records = await this.repository.page({ ...filters, fulfillable: this.fulfillment.products(), cursor: after, limit });
    // Лишняя строка репозитория — только признак «дальше»: показывается ровно страница.
    const shown = records.slice(0, limit);
    const marks = shown.length === 0 ? new Map<string, FeedMark[]>() : await this.sources.marks(shown.map((record) => record.purchase.purchaseId));
    const last = shown.at(-1);
    return {
      rows: shown.map(({ purchase, account }) => ({
        purchase,
        account: { accountId: purchase.accountId, displayName: account.displayName, platform: account.platform },
        marks: marks.get(purchase.purchaseId) ?? [],
      })),
      next: records.length > limit && last !== undefined ? encodeCursor(last.purchase) : null,
    };
  }

  async card(actor: AccountRef, purchaseId: string): Promise<PaymentCard> {
    await this.roles.require(actor, "payments.view");
    const record = await this.repository.byId(purchaseId);
    if (record === null) throw new PurchaseNotFoundError();
    const { purchase, account } = record;

    const [withPii, canSupport, canCompensate, canAudit] = await Promise.all([
      this.roles.can(actor, "players.pii.view"),
      this.roles.can(actor, "payments.support"),
      this.roles.can(actor, "payments.compensate"),
      this.roles.can(actor, "audit.view"),
    ]);
    const [first, renewals, team, fromSources, sourceActions, marks] = await Promise.all([
      purchase.renewalOf === null ? null : this.repository.byId(purchase.renewalOf),
      // Продления бывают только у первой покупки подписки; у разового товара запрос был бы пустым проходом по таблице.
      purchase.renewalOf === null && SUBSCRIPTION_PRODUCTS.includes(purchase.product) ? this.repository.renewals(purchase.purchaseId) : [],
      // Нет права на журнал — хронология без строк команды, а не ошибка.
      canAudit ? this.teamLines(actor, purchase) : [],
      this.sources.timeline(purchase),
      this.sources.actions(purchase),
      this.sources.marks([purchase.purchaseId]),
    ]);

    if (withPii) await this.roles.audit({ actorAccountId: actor.accountId, action: "players.pii.view", target: purchase.accountId });

    const granted = new Set<Permission>();
    if (canSupport) granted.add("payments.support");
    if (canCompensate) granted.add("payments.compensate");
    const offered = [...this.support.actionsFor(purchase), ...sourceActions];

    return {
      purchase,
      account: {
        accountId: purchase.accountId,
        displayName: account.displayName,
        platform: account.platform,
        pii: withPii ? { platformUserId: account.platformUserId, username: account.username } : null,
      },
      renewalOf: first?.purchase ?? null,
      renewals,
      timeline: mergeTimeline([purchaseTimeline(purchase, renewals), team, fromSources]),
      // Порядок — сначала то, что не стоит денег; одно и то же действие от поддержки и от источника показывается один раз.
      actions: ACTION_ORDER.filter((action) => offered.includes(action) && granted.has(ACTION_PERMISSION[action])),
      marks: marks.get(purchase.purchaseId) ?? [],
    };
  }

  /** Действия команды над аккаунтом игрока из журнала, отобранные по этой покупке; имена актёров — одним запросом. */
  private async teamLines(actor: AccountRef, purchase: StoredPurchase): Promise<TimelineEntry[]> {
    const records = await this.roles.auditPage(actor, { limit: TEAM_JOURNAL_LIMIT, before: null, actions: ["payments."], actorAccountId: null, target: purchase.accountId });
    const actorIds = [...new Set(records.flatMap((record) => (record.actorAccountId === null ? [] : [record.actorAccountId])))];
    const names = actorIds.length === 0 ? new Map<string, string>() : await this.accounts.displayNames(actorIds);
    return teamTimeline(purchase.purchaseId, records, names);
  }
}

/** Курсор — `base64url` строки `<время счёта ISO>|<id покупки>`: по ним репозиторий продолжает с того же места. */
function encodeCursor(purchase: StoredPurchase): string {
  return Buffer.from(`${purchase.invoicedAt.toISOString()}|${purchase.purchaseId}`, "utf8").toString("base64url");
}

function decodeCursor(value: string): { invoicedAt: Date; purchaseId: string } {
  const match = CURSOR_PATTERN.exec(Buffer.from(value, "base64url").toString("utf8"));
  const invoicedAt = new Date(match?.[1] ?? Number.NaN);
  const purchaseId = match?.[2];
  // Дата проходит шаблон, но не существует (30 февраля): курсор такой ссылки тоже битый.
  if (purchaseId === undefined || Number.isNaN(invoicedAt.getTime()) || invoicedAt.toISOString() !== match?.[1]) throw new ValidationError(CURSOR_PROBLEM);
  return { invoicedAt, purchaseId };
}
