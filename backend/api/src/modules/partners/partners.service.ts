import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { DisabledError, ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { NO_POSTBACK_ADDRESS, checkedPostbackEvents, checkedPostbackUrl, nextPostback, postbackLogForm, sameEvents } from "../ad-conversions/postback-settings.js";
import { partnerFunnelView, type PartnerFunnelView } from "../funnel/funnel-report.js";
import { PARTNER_FUNNEL, type PartnerFunnelSource } from "../funnel/funnel.repository.js";
import { campaignState, type PromoCampaignState } from "../promo-codes/promo-code-rules.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PARTNER_ACCOUNTS, PartnerAccountTakenError, type CabinetState, type PartnerAccounts } from "./partner-cabinet.js";
import { PartnerNotFoundError, PartnerTelegramTakenError } from "./partner-errors.js";
import { PARTNER_LINKS, type PartnerLinks, type PartnerLinksSource, type PartnerLinkStats } from "./partner-links.repository.js";
import { PARTNER_RULES, PARTNER_STATUSES, withTerms, type PartnerFull, type PartnerInput, type PartnerPatch, type PartnerStats, type PartnerStatus, type PartnerUpdateInput } from "./partner-rules.js";
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
 *
 * Кабинет партнёра (Р136, T-0217): «Открыть кабинет» находит аккаунт по Telegram ID карточки, выдаёт ему
 * роль `partner` и записывает связь, «Закрыть» снимает роль и оставляет связь — она защищает от привязки
 * партнёра к самому себе. Роль и связь пишутся только отсюда.
 *
 * Общий адрес постбэка (T-0070) — ещё одно условие партнёра: регистрация приведённого им игрока уходит на
 * него, если у ссылки партнёра нет своего адреса. Полный адрес видят те, кто правит партнёров
 * (`partners.edit`): запрос адреса может нести секрет приёмника, остальным показывается без запроса.
 */

export type PartnerView = PartnerFull & { stats: PartnerStats };

/** Поля, чья правка попадает в аудит «было → стало»; статус — отдельным действием `partner.status`. */
const AUDITED_FIELDS = ["name", "contact", "note", "telegramId", "country", "payoutCurrency", "payoutMethod", "sharePercent", "postbackUrl", "postbackEvents"] as const;

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
  /** кабинет партнёра: связанный аккаунт и открыт ли он сейчас */
  cabinet: CabinetState;
  rules: typeof PARTNER_RULES;
}

/** Воронка партнёра за период: как у остальных отчётов панели, не длиннее года. */
const FUNNEL_MAX_DAYS = 366;
const DAY_MS = 86_400_000;

export interface PartnerFunnel extends PartnerFunnelView {
  from: string;
  to: string;
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
   * ссылок, карточка тогда показывает пустой блок. `funnel` — источник воронки игроков партнёра (T-0068),
   * так же необязателен: без него воронка пустая. `accounts` — связь карточки с аккаунтом для кабинета
   * (T-0217): без неё карточка показывает «кабинета нет», а открыть его нельзя.
   */
  constructor(
    @Inject(PARTNERS_REPOSITORY) private readonly repository: PartnersRepository,
    private readonly roles: RolesService,
    @Optional() @Inject(PARTNER_LINKS) private readonly partnerLinks: PartnerLinksSource | null = null,
    @Optional() @Inject(PARTNER_FUNNEL) private readonly funnelSource: PartnerFunnelSource | null = null,
    @Optional() @Inject(PARTNER_ACCOUNTS) private readonly accounts: PartnerAccounts | null = null,
  ) {}

  async catalog(actor: AccountRef, at = new Date()): Promise<{ partners: PartnerView[]; rules: typeof PARTNER_RULES }> {
    await this.roles.require(actor, "partners.view");
    const canEdit = await this.roles.can(actor, "partners.edit");
    return { partners: (await this.db(this.repository.list(LIST_LIMIT, at))).map((row) => seenBy(withTerms(row), canEdit)), rules: PARTNER_RULES };
  }

  async detail(actor: AccountRef, partnerId: string, at = new Date()): Promise<PartnerDetail> {
    await this.roles.require(actor, "partners.view");
    const canEdit = await this.roles.can(actor, "partners.edit");
    const partner = await this.db(this.repository.byId(partnerId, at));
    if (partner === null) throw new PartnerNotFoundError();
    const [daily, codes, linked, cabinet] = await Promise.all([
      this.db(this.repository.daily(partnerId, new Date(at.getTime() - DAILY_DAYS * 86_400_000))),
      this.db(this.repository.campaigns(partnerId)),
      this.partnerLinks === null ? NO_LINKS : this.db(this.partnerLinks.forPartner(partnerId)),
      this.cabinetState(partnerId),
    ]);
    return {
      partner: seenBy(withTerms(partner), canEdit),
      daily,
      codes: codes.map((code) => ({ ...code, state: campaignState(code, at) })),
      links: linked.links,
      linkBound: linked.bound,
      cabinet,
      rules: PARTNER_RULES,
    };
  }

  /**
   * Воронка игроков партнёра (Р96, T-0068): привязанные к нему в окне `[from, to)` по дате привязки — все вместе,
   * по ссылке или коду и по площадке. Партнёра нет — 404 до обращения к воронке.
   */
  async funnel(actor: AccountRef, partnerId: string, from: Date, to: Date, at = new Date()): Promise<PartnerFunnel> {
    await this.roles.require(actor, "partners.view");
    if (!(from < to)) throw new ValidationError("Начало периода должно быть раньше конца");
    if (to.getTime() - from.getTime() > FUNNEL_MAX_DAYS * DAY_MS) throw new ValidationError("Период не длиннее года");
    if ((await this.db(this.repository.byId(partnerId, at))) === null) throw new PartnerNotFoundError();
    const rows = this.funnelSource === null ? [] : await this.db(this.funnelSource.partnerReport(partnerId, from, to));
    return { from: from.toISOString(), to: to.toISOString(), ...partnerFunnelView(rows) };
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

  /**
   * Правка названия, связи и условий: названное меняется, не названное остаётся. В аудит — только изменённые поля,
   * адрес постбэка — без запроса. Адрес проверяется правилами шаблона до записи; первое задание ставит
   * `postback_since`, смена на другой адрес момент не трогает, снятие обнуляет и возвращает события к одной
   * регистрации (`nextPostback`). События общего адреса (T-0071) выбираются, только когда адрес задан — уже или в этом же
   * запросе; снять адрес и выбрать события одним запросом нельзя.
   */
  async update(actor: AccountRef, partnerId: string, input: PartnerUpdateInput, at = new Date()): Promise<PartnerView> {
    await this.roles.require(actor, "partners.edit");
    if (typeof input.telegramId === "string") await this.assertTelegramFree(input.telegramId, partnerId);
    const { postbackUrl: rawUrl, postbackEvents: rawEvents, ...fields } = input;
    const patch: PartnerPatch = fields;
    const events = rawEvents === undefined ? undefined : checkedPostbackEvents(rawEvents);
    const url = rawUrl === undefined ? undefined : checkedPostbackUrl(rawUrl);
    if (url !== undefined || events !== undefined) {
      const current = await this.db(this.repository.byId(partnerId, at));
      if (current === null) throw new PartnerNotFoundError();
      const terms = withTerms(current);
      if (events !== undefined && (url === undefined ? terms.postbackUrl : url) === null) throw new ValidationError(NO_POSTBACK_ADDRESS);
      if (url !== undefined && terms.postbackUrl !== url) {
        const next = nextPostback({ url: terms.postbackUrl, since: terms.postbackSince }, url, at);
        patch.postbackUrl = next.url;
        patch.postbackSince = next.since;
        if (next.events !== undefined) patch.postbackEvents = next.events;
      }
      if (events !== undefined && !sameEvents(terms.postbackEvents, events)) patch.postbackEvents = events;
    }
    const changed = await this.db(this.repository.update(partnerId, patch, at));
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

  /**
   * Открыть кабинет: аккаунт — по Telegram ID карточки, роль `partner` — через `RolesService.grant` (права,
   * уровни, запрет выдать роль себе и запись в журнал — там), связь с аккаунтом — после выдачи, чтобы отказ
   * выдачи не оставил связи без роли. Выдавать вправе тот, у кого есть и `partners.edit`, и `roles.assign`
   * (владелец и администратор): отказ — до поиска аккаунтов. Повторное открытие безвредно.
   */
  async openCabinet(actor: AccountRef, partnerId: string, at = new Date()): Promise<CabinetState> {
    const accounts = this.cabinetAccounts();
    await this.roles.require(actor, "partners.edit");
    await this.roles.require(actor, "roles.assign");
    const partner = await this.db(this.repository.byId(partnerId, at));
    if (partner === null) throw new PartnerNotFoundError();
    const { telegramId } = withTerms(partner);
    if (telegramId === null) throw new ValidationError("Сначала укажите Telegram ID партнёра");
    const account = await this.db(accounts.byTelegramId(telegramId));
    if (account === null) throw new ValidationError("Партнёр ещё не заходил в игру — пусть откроет её один раз");
    const holder = await this.db(accounts.partnerOf(account.accountId));
    if (holder !== null && holder.partnerId !== partnerId) throw new PartnerAccountTakenError(holder.name);
    // Telegram ID карточки сменили: связь переносится на новый аккаунт только после того, как прежний закрыт —
    // иначе у прежнего осталась бы роль без карточки.
    const previous = await this.db(accounts.linkedTo(partnerId));
    const moved = previous !== null && previous.accountId !== account.accountId;
    if (moved && (await this.roles.rolesFor(previous)).includes("partner")) throw new ValidationError("Кабинет уже открыт на другой аккаунт — сначала закройте его");

    const granted = await this.roles.grant(actor, account.accountId, "partner");
    await this.db(accounts.link(partnerId, account.accountId, at));
    if (granted || previous === null || moved) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "partner.cabinet", target: partnerId, before: { open: false }, after: { open: true, accountId: account.accountId } });
      this.logger.log(JSON.stringify({ module: "partners", event: "partner_cabinet_opened", partnerId, accountId: account.accountId, actor: actor.accountId }));
    }
    return { accountId: account.accountId, open: true };
  }

  /**
   * Закрыть кабинет: роль снимается у связанного аккаунта (а не у найденного по нынешнему Telegram ID),
   * связь остаётся. Закрытого или не открывавшегося кабинета закрывать нечего — ответ тот же, записей нет.
   */
  async closeCabinet(actor: AccountRef, partnerId: string, at = new Date()): Promise<CabinetState> {
    const accounts = this.cabinetAccounts();
    await this.roles.require(actor, "partners.edit");
    await this.roles.require(actor, "roles.assign");
    if ((await this.db(this.repository.byId(partnerId, at))) === null) throw new PartnerNotFoundError();
    const linked = await this.db(accounts.linkedTo(partnerId));
    if (linked === null) return { accountId: null, open: false };
    const revoked = await this.roles.revoke(actor, linked.accountId, "partner");
    if (revoked) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "partner.cabinet", target: partnerId, before: { open: true }, after: { open: false, accountId: linked.accountId } });
      this.logger.log(JSON.stringify({ module: "partners", event: "partner_cabinet_closed", partnerId, accountId: linked.accountId, actor: actor.accountId }));
    }
    return { accountId: linked.accountId, open: false };
  }

  private async cabinetState(partnerId: string): Promise<CabinetState> {
    const linked = this.accounts === null ? null : await this.db(this.accounts.linkedTo(partnerId));
    if (linked === null) return { accountId: null, open: false };
    return { accountId: linked.accountId, open: (await this.roles.rolesFor(linked)).includes("partner") };
  }

  private cabinetAccounts(): PartnerAccounts {
    if (this.accounts === null) throw new DisabledError("Кабинет партнёров не подключён");
    return this.accounts;
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
    if (field === "postbackEvents" ? sameEvents(before.postbackEvents, after.postbackEvents) : before[field] === after[field]) continue;
    // Адрес постбэка идёт в аудит без запроса: в нём бывает секрет приёмника.
    was[field] = field === "postbackUrl" ? postbackLogForm(before.postbackUrl) : before[field];
    now[field] = field === "postbackUrl" ? postbackLogForm(after.postbackUrl) : after[field];
  }
  return Object.keys(now).length === 0 ? null : { before: was, after: now };
}

/** Партнёр глазами читателя: тому, у кого нет права на правку, адрес постбэка показывается без запроса. */
function seenBy<T extends PartnerFull>(partner: T, canEdit: boolean): T {
  return canEdit || partner.postbackUrl === null ? partner : { ...partner, postbackUrl: postbackLogForm(partner.postbackUrl) };
}
