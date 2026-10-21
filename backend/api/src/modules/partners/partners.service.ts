import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { campaignState, type PromoCampaignState } from "../promo-codes/promo-code-rules.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PartnerNotFoundError, PartnerTelegramTakenError } from "./partner-errors.js";
import { PARTNER_LINKS, type PartnerLinks, type PartnerLinksSource, type PartnerLinkStats } from "./partner-links.repository.js";
import { PARTNER_RULES, PARTNER_STATUSES, withTerms, type PartnerFull, type PartnerInput, type PartnerStats, type PartnerStatus } from "./partner-rules.js";
import { PARTNERS_REPOSITORY, type PartnerBindingView, type PartnerCampaignRow, type PartnersRepository } from "./partners.repository.js";

/**
 * Партнёры в панели (docs/35-stage4-plan.md WP41, часть 2): кто приводит
 * игроков своими кодами и чего эти игроки стоят. Смотрят — под
 * `partners.view` (владелец, администратор, маркетолог, бухгалтерия),
 * заводят и правят — под `partners.edit`; каждое изменение — в аудит.
 * Удаления нет: по партнёру считаются приведённые им игроки.
 *
 * Условия партнёра (docs/35-stage4-plan.md Р96) — TG id, страна, валюта,
 * способ выплаты и процент — только записываются: что и когда начисляется,
 * решит модель учёта (О44). Статус меняется отдельно, с причиной: он
 * решает, привязывает ли партнёр новых игроков.
 */

export type PartnerView = PartnerFull & { stats: PartnerStats };

/** Поля, чья правка попадает в аудит «было → стало»; статус — отдельным действием `partner.status`. */
const AUDITED_FIELDS = ["name", "contact", "note", "telegramId", "country", "payoutCurrency", "payoutMethod", "sharePercent"] as const;

/** Причина смены статуса: от трёх до двухсот знаков без пробелов по краям. */
const REASON_MIN = 3;
const REASON_MAX = 200;

export interface PartnerDetail {
  partner: PartnerView;
  /** привязки по игровым суткам за последние `DAILY_DAYS` */
  daily: { day: string; count: number }[];
  codes: (PartnerCampaignRow & { state: PromoCampaignState })[];
  /** ссылки партнёра с кликами и запусками (T-0067) */
  links: PartnerLinkStats[];
  /** игроков, привязанных по ссылкам; привязанные кодами сюда не входят */
  linkBound: number;
  rules: typeof PARTNER_RULES;
}

const DB_TIMEOUT_MS = 3_000;
const LIST_LIMIT = 500;
const DAILY_DAYS = 30;
const NO_LINKS: PartnerLinks = { links: [], bound: 0 };

@Injectable()
export class PartnersService {
  private readonly logger = new Logger("partners");

  /**
   * `partnerLinks` — источник ссылок для карточки. Необязателен: сервис партнёров живёт и без модуля
   * ссылок, карточка тогда показывает пустой блок.
   */
  constructor(
    @Inject(PARTNERS_REPOSITORY) private readonly repository: PartnersRepository,
    private readonly roles: RolesService,
    @Optional() @Inject(PARTNER_LINKS) private readonly partnerLinks: PartnerLinksSource | null = null,
  ) {}

  async catalog(actor: AccountRef, at = new Date()): Promise<{ partners: PartnerView[]; rules: typeof PARTNER_RULES }> {
    await this.roles.require(actor, "partners.view");
    return { partners: (await this.db(this.repository.list(LIST_LIMIT, at))).map(withTerms), rules: PARTNER_RULES };
  }

  async detail(actor: AccountRef, partnerId: string, at = new Date()): Promise<PartnerDetail> {
    await this.roles.require(actor, "partners.view");
    const partner = await this.db(this.repository.byId(partnerId, at));
    if (partner === null) throw new PartnerNotFoundError();
    const [daily, codes, linked] = await Promise.all([
      this.db(this.repository.daily(partnerId, new Date(at.getTime() - DAILY_DAYS * 86_400_000))),
      this.db(this.repository.campaigns(partnerId)),
      this.partnerLinks === null ? NO_LINKS : this.db(this.partnerLinks.forPartner(partnerId)),
    ]);
    return {
      partner: withTerms(partner),
      daily,
      codes: codes.map((code) => ({ ...code, state: campaignState(code, at) })),
      links: linked.links,
      linkBound: linked.bound,
      rules: PARTNER_RULES,
    };
  }

  /** Новый партнёр — активный: заявки заводит команда, статус меняется после, с причиной. */
  async create(actor: AccountRef, input: PartnerInput, at = new Date()): Promise<PartnerView> {
    await this.roles.require(actor, "partners.edit");
    // Условия в теле необязательны: не названное — пусто, а не «как у соседа».
    const row: PartnerFull = withTerms({ ...input, status: "active", partnerId: randomUUID(), createdBy: actor.accountId, createdAt: at, updatedAt: at });
    await this.assertTelegramFree(row.telegramId, row.partnerId);
    await this.db(this.repository.create(row));
    await this.roles.audit({ actorAccountId: actor.accountId, action: "partner.create", target: row.partnerId, after: row });
    this.logger.log(JSON.stringify({ module: "partners", event: "partner_created", partnerId: row.partnerId, actor: actor.accountId }));
    return { ...row, stats: { codes: 0, activeCodes: 0, redeemed: 0, bound: 0, played: 0, payers: 0, stars: 0 } };
  }

  /** Правка названия, связи и условий: названное меняется, не названное остаётся. В аудит — только изменённые поля. */
  async update(actor: AccountRef, partnerId: string, input: PartnerInput, at = new Date()): Promise<PartnerView> {
    await this.roles.require(actor, "partners.edit");
    if (typeof input.telegramId === "string") await this.assertTelegramFree(input.telegramId, partnerId);
    const changed = await this.db(this.repository.update(partnerId, input, at));
    if (changed === null) throw new PartnerNotFoundError();
    const diff = changedFields(withTerms(changed.before), withTerms(changed.after));
    if (diff !== null) await this.roles.audit({ actorAccountId: actor.accountId, action: "partner.update", target: partnerId, ...diff });
    return await this.view(partnerId, at);
  }

  /**
   * Сменить статус: причина обязательна, в аудит «было → стало» с ней. Привязанных ранее игроков смена не
   * трогает — статус решает только, привязывает ли партнёр новых.
   */
  async setStatus(actor: AccountRef, partnerId: string, status: PartnerStatus, reason: string, at = new Date()): Promise<PartnerView> {
    await this.roles.require(actor, "partners.edit");
    const why = reason.trim();
    if (why.length < REASON_MIN || why.length > REASON_MAX) throw new ValidationError(`Причина — от ${String(REASON_MIN)} до ${String(REASON_MAX)} знаков`);
    if (!PARTNER_STATUSES.includes(status)) throw new ValidationError("Неизвестный статус партнёра");
    const changed = await this.db(this.repository.update(partnerId, { status }, at));
    if (changed === null) throw new PartnerNotFoundError();
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "partner.status",
      target: partnerId,
      before: { status: withTerms(changed.before).status },
      after: { status, reason: why },
    });
    this.logger.log(JSON.stringify({ module: "partners", event: "partner_status", partnerId, status, actor: actor.accountId }));
    return await this.view(partnerId, at);
  }

  private async view(partnerId: string, at: Date): Promise<PartnerView> {
    const view = await this.db(this.repository.byId(partnerId, at));
    if (view === null) throw new PartnerNotFoundError();
    return withTerms(view);
  }

  /**
   * TG id уникален среди партнёров. Здесь — понятный отказ с именем держателя; настоящую гарантию, в том
   * числе под гонкой, даёт уникальный индекс, а хранилище переводит его отказ в ту же ошибку. Партнёров
   * единицы, поэтому держателя ищем по списку, а не отдельным запросом.
   */
  private async assertTelegramFree(telegramId: string | null, exceptPartnerId: string): Promise<void> {
    if (telegramId === null) return;
    const holder = (await this.db(this.repository.list(LIST_LIMIT, new Date()))).find((row) => row.telegramId === telegramId && row.partnerId !== exceptPartnerId);
    if (holder !== undefined) throw new PartnerTelegramTakenError(holder.name);
  }

  /** Партнёры для выбора в мастере промокода — право проверяет тот, кто спрашивает. */
  async names(): Promise<{ partnerId: string; name: string }[]> {
    return await this.db(this.repository.names());
  }

  /** К какому партнёру привязан игрок — для карточки игрока в панели. */
  async bindingOf(accountId: string): Promise<PartnerBindingView | null> {
    return await this.db(this.repository.bindingOf(accountId));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "партнёры");
  }
}

/**
 * Что изменилось между строками: только изменённые поля из `AUDITED_FIELDS`, «было» и «стало». `null` — ничего
 * не изменилось: пустую запись в аудит не пишем.
 */
function changedFields(before: PartnerFull, after: PartnerFull): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS) {
    if (before[field] === after[field]) continue;
    was[field] = before[field];
    now[field] = after[field];
  }
  return Object.keys(now).length === 0 ? null : { before: was, after: now };
}
