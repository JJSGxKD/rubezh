import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import { DomainError, ForbiddenError, ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { newLinkCode } from "../links/link-code.js";
import { LINKS_REPOSITORY, type LinksRepository } from "../links/links.repository.js";
import { PromoCampaignNotFoundError } from "../promo-codes/promo-code-errors.js";
import {
  PROMO_KINDS,
  campaignState,
  codeDisplay,
  codeKey,
  codeProblem,
  promoRewardSchema,
  type PromoCampaignRow,
  type PromoCampaignState,
  type PromoKind,
  type PromoReward,
} from "../promo-codes/promo-code-rules.js";
import { PROMO_CODES_REPOSITORY, type PromoCodesRepository } from "../promo-codes/promo-codes.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SETTINGS, type SettingDefinition } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { CABINET_FUNNEL, buildCabinetFunnel, checkFunnelPeriod, type CabinetFunnel, type CabinetFunnelSource } from "./partner-cabinet-funnel.js";
import { PartnerNotFoundError } from "./partner-errors.js";
import { withTerms, type PartnerStatus } from "./partner-rules.js";
import { PARTNERS_REPOSITORY, type PartnersRepository } from "./partners.repository.js";

/**
 * Кабинет партнёра (docs/35-stage4-plan.md Р136, tasks/T-0217): внешний человек
 * входит в панель с ролью `partner` и видит только своё. Три части:
 *
 * - связь карточки партнёра с игровым аккаунтом (`PartnerAccounts`): пишется только из карточки,
 *   остаётся после закрытия кабинета и защищает от привязки партнёра к самому себе;
 * - `PartnerCabinet.partnerOf` — **единственное** место, где решается, чей кабинет открыт; разделы
 *   кабинета берут партнёра только через неё, а не из запроса;
 * - точка входа `overview` — карточка без контактов и заметок команды;
 * - ссылки и промокоды кабинета (T-0218): партнёр заводит свои ссылки и копии своих общих кодов с новым
 *   словом, в пределах лимитов из настроек, без прав `links.manage` и `promo.edit`: право кабинета проверено
 *   в `partnerOf`, а владелец записи — всегда партнёр кабинета. Награду копии партнёр не выбирает — она
 *   берётся у исходной кампании; игроков, их имён и ID в ответах нет (docs/23 §4.4);
 * - воронка (T-0219): вехи игроков партнёра по ссылкам, кодам и дням — в `partner-cabinet-funnel.ts`, где и порог группы.
 */

/** Состояние кабинета в карточке партнёра: с каким аккаунтом связан и есть ли у аккаунта роль. */
export interface CabinetState {
  /** связанный аккаунт; `null` — кабинет ещё ни разу не открывали */
  accountId: string | null;
  /** роль `partner` на аккаунте сейчас: закрытый кабинет оставляет связь, но не роль */
  open: boolean;
}

/** Аккаунт, как его принимает `RolesService`: роли спрашиваются по этой паре. */
export interface PartnerAccountRef {
  accountId: string;
  platform: PlatformId;
  platformUserId: string;
}

export const PARTNER_ACCOUNTS = Symbol("PARTNER_ACCOUNTS");

export interface PartnerAccounts {
  /** аккаунт Telegram с этим ID; `null` — партнёр ещё не открывал игру */
  byTelegramId(telegramId: string): Promise<PartnerAccountRef | null>;
  /** аккаунт, связанный с карточкой; `null` — связи нет */
  linkedTo(partnerId: string): Promise<PartnerAccountRef | null>;
  /** карточка, с которой связан аккаунт; `null` — аккаунт не партнёрский */
  partnerOf(accountId: string): Promise<{ partnerId: string; name: string } | null>;
  /**
   * Записать связь. Аккаунт уже у другого партнёра — `PartnerAccountTakenError`: проверка в сервисе
   * понятная, а гарантия, в том числе под гонкой, — уникальный индекс. Повтор той же пары безвреден;
   * связь другого аккаунта у карточки заменяется. Карточки нет — `PartnerNotFoundError`.
   */
  link(partnerId: string, accountId: string, at: Date): Promise<void>;
}

/** Аккаунт уже связан с другим партнёром: один человек — одна карточка. */
export class PartnerAccountTakenError extends DomainError {
  constructor(holderName: string) {
    super("partner_account_taken", `Этот аккаунт уже привязан к партнёру «${holderName}»`, 409);
  }
}

const DB_TIMEOUT_MS = 3_000;
/** отчёт воронки считает вехи по всем привязкам окна: дольше обычного чтения, но не бесконечно */
const FUNNEL_TIMEOUT_MS = 15_000;

@Injectable()
export class PrismaPartnerAccounts implements PartnerAccounts {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async byTelegramId(telegramId: string): Promise<PartnerAccountRef | null> {
    const found = await this.prisma.account.findUnique({
      where: { platform_platformUserId: { platform: "telegram", platformUserId: telegramId } },
      select: { accountId: true, platform: true, platformUserId: true },
    });
    return found;
  }

  async linkedTo(partnerId: string): Promise<PartnerAccountRef | null> {
    const found = await this.prisma.partner.findUnique({
      where: { partnerId },
      select: { account: { select: { accountId: true, platform: true, platformUserId: true } } },
    });
    return found?.account ?? null;
  }

  async partnerOf(accountId: string): Promise<{ partnerId: string; name: string } | null> {
    return await this.prisma.partner.findUnique({ where: { accountId }, select: { partnerId: true, name: true } });
  }

  async link(partnerId: string, accountId: string, at: Date): Promise<void> {
    try {
      await this.prisma.partner.update({ where: { partnerId }, data: { accountId, updatedAt: at } });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") throw new PartnerNotFoundError();
      // Уникальный индекс `partner.account_id`: аккаунт занят другой карточкой.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const holder = await this.partnerOf(accountId);
        if (holder !== null && holder.partnerId !== partnerId) throw new PartnerAccountTakenError(holder.name);
      }
      throw error;
    }
  }
}

/** Кто и чей кабинет открывает: `partnerId` в запросе — только у тех, кто смотрит чужой кабинет для поддержки. */
export interface CabinetQuery {
  partnerId?: string | undefined;
}

/** Чей кабинет открыт и можно ли в нём что-то менять: глазами партнёра (`?partnerId=`) — только читать. */
export interface CabinetScope {
  partnerId: string;
  viewOnly: boolean;
}

/** Карточка партнёра глазами партнёра: без контактов, заметок команды, Telegram ID и адресов постбэка. */
export interface CabinetPartner {
  partnerId: string;
  name: string;
  status: PartnerStatus;
  sharePercent: string | null;
  payoutCurrency: string | null;
}

export interface CabinetOverview {
  partner: CabinetPartner;
}

/** Что за ссылка: подпись в списке и срез в аналитике (`source` ссылки — латиница, поэтому слова по-английски). */
export const CABINET_LINK_SOURCES = ["channel", "post", "stream", "chat", "other"] as const;
export type CabinetLinkSource = (typeof CABINET_LINK_SOURCES)[number];

export const CABINET_LIMITS = { campaignMin: 2, campaignMax: 64, noteMax: 120, codeMax: 48 } as const;

/** Что партнёр задаёт у новой ссылки: остальное (цель, сеть, постбэк) — не его выбор. */
export interface CabinetLinkInput {
  /** название словами партнёра: в кампанию ссылки оно идёт латиницей (`campaignSlug`) */
  campaign: string;
  source: CabinetLinkSource;
  note: string | null;
}

/** Ссылка партнёра: адрес, подписи, переходы и запуски — без игроков. */
export interface CabinetLink {
  code: string;
  /** адрес переходника; `null` — домен приложения не задан */
  url: string | null;
  campaign: string;
  source: string | null;
  note: string | null;
  createdAt: Date;
  clicks: number;
  /** запуски игры по кликам и по прямой ссылке вместе */
  launches: number;
}

export interface CabinetLinks {
  links: CabinetLink[];
  /** сколько ссылок у партнёра и потолок кабинета */
  limit: { used: number; max: number };
  viewOnly: boolean;
}

/** Промокод партнёра: слово, награда, погашено из лимита, срок — без названия для команды и без игроков. */
export interface CabinetPromo {
  campaignId: string;
  kind: PromoKind;
  /** общий код; у пачки — один из кодов, панель его не показывает */
  code: string;
  reward: PromoReward;
  redeemed: number;
  maxRedemptions: number | null;
  startsAt: Date;
  endsAt: Date | null;
  state: PromoCampaignState;
  /** заведён самим партнёром копией */
  copy: boolean;
}

export interface CabinetPromos {
  promos: CabinetPromo[];
  /** сколько копий партнёр уже сделал и потолок кабинета */
  copies: { used: number; max: number };
  viewOnly: boolean;
}

/** Слово копии занято — без названия кампании, которая его держит: оно внутреннее. */
export class CabinetCodeTakenError extends DomainError {
  constructor(display: string) {
    super("promo_code_taken", `Код ${display} уже занят: нужно другое слово`, 409);
  }
}

const TRANSLIT: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Название ссылки словами партнёра — в кампанию ссылки: латиница в нижнем регистре, цифры, дефис и
 * подчёркивание, как у ссылок команды (они уходят в разрезы аналитики). Кириллица пишется латиницей, любой
 * другой знак — дефисом. `null` — в названии нет ни буквы, ни цифры.
 */
export function campaignSlug(name: string): string | null {
  const latin = [...name.normalize("NFC").toLowerCase()].map((char) => TRANSLIT[char] ?? char).join("");
  const slug = latin
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, CABINET_LIMITS.campaignMax)
    .replace(/-+$/, "");
  return /^[a-z0-9]/.test(slug) ? slug : null;
}

const DB_LIST_LIMIT = 200;
/** заведение копии пишет кампанию с кодом одной транзакцией */
const CREATE_TIMEOUT_MS = 15_000;

export const PARTNER_PROMOS = Symbol("PARTNER_PROMOS");

/** Кампании партнёра для его кабинета: читает кабинет, а заводит копию репозиторий промокодов. */
export interface PartnerPromos {
  /** кампании, у которых владелец — партнёр, новые первыми */
  ofPartner(partnerId: string): Promise<PromoCampaignRow[]>;
}

@Injectable()
export class PrismaPartnerPromos implements PartnerPromos {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async ofPartner(partnerId: string): Promise<PromoCampaignRow[]> {
    const rows = await this.prisma.promoCampaign.findMany({
      where: { partnerId },
      orderBy: { createdAt: "desc" },
      take: DB_LIST_LIMIT,
      include: { codes: { orderBy: { code: "asc" }, take: 1, select: { display: true } }, partner: { select: { name: true } } },
    });
    return rows.map((row) => ({
      campaignId: row.campaignId,
      title: row.title,
      kind: z.enum(PROMO_KINDS).parse(row.kind),
      reward: promoRewardSchema.parse(row.reward),
      message: row.message,
      maxRedemptions: row.maxRedemptions,
      redeemed: row.redeemed,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      newPlayersDays: row.newPlayersDays,
      platforms: z.array(z.enum(PLATFORM_IDS)).parse(row.platforms),
      pausedAt: row.pausedAt,
      note: row.note,
      partnerId: row.partnerId,
      partnerName: row.partner?.name ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      codeSample: row.codes[0]?.display ?? "",
    }));
  }
}

@Injectable()
export class PartnerCabinet {
  constructor(
    private readonly roles: RolesService,
    @Inject(PARTNER_ACCOUNTS) private readonly accounts: PartnerAccounts,
    @Inject(PARTNERS_REPOSITORY) private readonly partners: PartnersRepository,
    // Нужны только ссылкам и промокодам кабинета: тесты точки входа (T-0217) собирают кабинет без них.
    @Optional() @Inject(APP_CONFIG) private readonly config: AppConfig | null = null,
    @Optional() @Inject(LINKS_REPOSITORY) private readonly linkStore: LinksRepository | null = null,
    @Optional() @Inject(PROMO_CODES_REPOSITORY) private readonly promoStore: PromoCodesRepository | null = null,
    @Optional() @Inject(PARTNER_PROMOS) private readonly partnerPromos: PartnerPromos | null = null,
    @Optional() @Inject(SETTINGS_READER) private readonly settings: SettingsReader | null = null,
    @Optional() @Inject(CABINET_FUNNEL) private readonly funnelSource: CabinetFunnelSource | null = null,
  ) {}

  /**
   * Чей кабинет открыт. Своего партнёра находят по аккаунту и праву `partner.cabinet`; чужого — по
   * `partnerId` и праву `partners.view` (владелец, администратор и те, кто ведёт партнёров): в этом
   * режиме кабинет только для чтения. Партнёр чужой `partnerId` не откроет — у него нет `partners.view`.
   *
   * Права проверяются здесь, а не на маршруте: одно право на маршруте не выразило бы «или своё, или
   * чужое для поддержки». Сам партнёр существует или нет, этот метод не проверяет — это дело раздела.
   */
  async partnerOf(actor: AccountRef, query: CabinetQuery): Promise<CabinetScope> {
    if (query.partnerId !== undefined) {
      await this.roles.require(actor, "partners.view");
      return { partnerId: query.partnerId, viewOnly: true };
    }
    await this.roles.require(actor, "partner.cabinet");
    const own = await this.db(this.accounts.partnerOf(actor.accountId));
    if (own === null) throw new ForbiddenError("Аккаунт не привязан к партнёру");
    return { partnerId: own.partnerId, viewOnly: false };
  }

  async overview(actor: AccountRef, query: CabinetQuery, at = new Date()): Promise<CabinetOverview> {
    const scope = await this.partnerOf(actor, query);
    const row = await this.db(this.partners.byId(scope.partnerId, at));
    if (row === null) throw new PartnerNotFoundError();
    const { partnerId, name, status, sharePercent, payoutCurrency } = withTerms(row);
    return { partner: { partnerId, name, status, sharePercent, payoutCurrency } };
  }

  /**
   * Воронка игроков партнёра за период по дате привязки, порог группы — из настроек. Партнёр — только из
   * `partnerOf`: запрос не называет его сам. Партнёра нет — 404 до обращения к отчёту.
   */
  async funnel(actor: AccountRef, query: CabinetQuery, period: { from: Date; to: Date }, at = new Date()): Promise<CabinetFunnel> {
    const scope = await this.partnerOf(actor, query);
    checkFunnelPeriod(period);
    if ((await this.db(this.partners.byId(scope.partnerId, at))) === null) throw new PartnerNotFoundError();
    const raw = await withTimeout(this.need(this.funnelSource, "воронка").report(scope.partnerId, period.from, period.to), FUNNEL_TIMEOUT_MS, "воронка кабинета партнёра");
    return buildCabinetFunnel(raw, period, this.setting(SETTINGS.partnersCabinetMinGroup));
  }

  /** Ссылки партнёра с переходами и запусками — те же числа, что в разделе «Ссылки» команды. */
  async links(actor: AccountRef, query: CabinetQuery): Promise<CabinetLinks> {
    const scope = await this.partnerOf(actor, query);
    const rows = await this.db(this.need(this.linkStore, "ссылки").list(DB_LIST_LIMIT, { partnerId: scope.partnerId }));
    return {
      links: rows.map((row) => this.linkView(row, row.clicks, row.launches + row.directLaunches)),
      limit: { used: rows.length, max: this.setting(SETTINGS.partnersCabinetMaxLinks) },
      viewOnly: scope.viewOnly,
    };
  }

  /**
   * Завести ссылку партнёра. Владелец — партнёр кабинета, цель — Mini App, сети нет; название, источник и
   * заметку задаёт партнёр. В режиме «глазами партнёра» — отказ до всякой записи.
   */
  async createLink(actor: AccountRef, query: CabinetQuery, input: CabinetLinkInput): Promise<CabinetLink> {
    const scope = await this.writableScope(actor, query);
    const campaign = campaignSlug(input.campaign);
    if (campaign === null || input.campaign.trim().length < CABINET_LIMITS.campaignMin) throw new ValidationError("Название ссылки — буквы и цифры, не короче двух знаков");
    if (!CABINET_LINK_SOURCES.includes(input.source)) throw new ValidationError("Источник — канал, пост, стрим, чат или другое");
    const note = input.note?.trim() ?? "";
    if (note.length > CABINET_LIMITS.noteMax) throw new ValidationError(`Заметка — не длиннее ${String(CABINET_LIMITS.noteMax)} знаков`);

    const store = this.need(this.linkStore, "ссылки");
    const max = this.setting(SETTINGS.partnersCabinetMaxLinks);
    // Считаются все ссылки партнёра, и заведённые командой: кабинет показывает их одним списком.
    if ((await this.db(store.list(DB_LIST_LIMIT, { partnerId: scope.partnerId }))).length >= max) throw new ValidationError(`Ссылок уже ${String(max)} — это потолок кабинета`);

    const link = await this.db(
      store.create({
        code: newLinkCode(),
        platform: "telegram",
        campaign,
        source: input.source,
        medium: null,
        note: note === "" ? null : note,
        createdBy: actor.accountId,
        network: null,
        registrationOn: "first_run",
        target: "app",
        partnerId: scope.partnerId,
      }),
    );
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "links.create",
      target: link.code,
      after: { campaign: link.campaign, source: link.source, platform: link.platform, target: link.target, network: null, registrationOn: null, partnerId: scope.partnerId },
    });
    return this.linkView(link, 0, 0);
  }

  /** Промокоды партнёра: его кампании и сколько копий он уже сделал. */
  async promos(actor: AccountRef, query: CabinetQuery, at = new Date()): Promise<CabinetPromos> {
    const scope = await this.partnerOf(actor, query);
    const [rows, account] = await Promise.all([this.db(this.need(this.partnerPromos, "промокоды").ofPartner(scope.partnerId)), this.db(this.accounts.linkedTo(scope.partnerId))]);
    const promos = rows.map((row) => promoView(row, account?.accountId ?? null, at));
    return { promos, copies: { used: promos.filter((promo) => promo.copy).length, max: this.setting(SETTINGS.partnersCabinetMaxPromoCopies) }, viewOnly: scope.viewOnly };
  }

  /**
   * Копия своей общей кампании с новым кодовым словом. Награда, лимит погашений, срок, площадки и окно новичков —
   * как у исходной: меняет их только команда, и входа для них здесь нет. Чужая и несуществующая кампания
   * отвечают одинаково; пачку одноразовых кодов не копируют.
   */
  async copyPromo(actor: AccountRef, query: CabinetQuery, campaignId: string, rawCode: string, at = new Date()): Promise<CabinetPromo> {
    const scope = await this.writableScope(actor, query);
    const store = this.need(this.promoStore, "промокоды");
    const source = await this.db(store.byId(campaignId));
    if (source === null || source.partnerId !== scope.partnerId) throw new PromoCampaignNotFoundError();
    if (source.kind === "batch") throw new ValidationError("Пачку одноразовых кодов копировать нельзя");
    if (source.endsAt !== null && source.endsAt <= at) throw new ValidationError("Срок промокода уже закончился — копию не сделать");
    if (rawCode.length > CABINET_LIMITS.codeMax) throw new ValidationError(`Код — не длиннее ${String(CABINET_LIMITS.codeMax)} знаков`);
    const problem = codeProblem(rawCode);
    if (problem !== null) throw new ValidationError(problem);

    const { copies } = await this.promos(actor, query, at);
    if (copies.used >= copies.max) throw new ValidationError(`Копий уже ${String(copies.max)} — это потолок кабинета`);

    const display = codeDisplay(rawCode);
    const campaign = {
      campaignId: randomUUID(),
      title: `${source.title} · копия`.slice(0, 80),
      kind: "shared" as const,
      reward: source.reward,
      message: source.message,
      maxRedemptions: source.maxRedemptions,
      startsAt: source.startsAt,
      endsAt: source.endsAt,
      newPlayersDays: source.newPlayersDays,
      platforms: source.platforms,
      note: `Копия кода ${source.codeSample} из кабинета партнёра`.slice(0, 200),
      partnerId: scope.partnerId,
      createdBy: actor.accountId,
      createdAt: at,
    };
    const outcome = await withTimeout(store.create(campaign, [{ code: codeKey(rawCode), display }], null), CREATE_TIMEOUT_MS, "промокоды кабинета");
    if (outcome.status === "taken") throw new CabinetCodeTakenError(display);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "promo.create", target: campaign.campaignId, after: { ...outcome.row, codes: 1, copiedFrom: source.campaignId } });
    return promoView(outcome.row, actor.accountId, at);
  }

  /** Кабинет для записи: «глазами партнёра» только читает. */
  private async writableScope(actor: AccountRef, query: CabinetQuery): Promise<CabinetScope> {
    const scope = await this.partnerOf(actor, query);
    if (scope.viewOnly) throw new ForbiddenError("Кабинет открыт для просмотра");
    return scope;
  }

  private linkView(link: { code: string; campaign: string; source: string | null; note: string | null; createdAt: Date }, clicks: number, launches: number): CabinetLink {
    const { code, campaign, source, note, createdAt } = link;
    return { code, url: this.publicUrl(code), campaign, source, note, createdAt, clicks, launches };
  }

  /** Адрес ссылки на домене клиента — как у ссылок команды (`links.service.ts`): `/r/<код>`. */
  private publicUrl(code: string): string | null {
    const base = this.config?.telegram.webAppUrl ?? "";
    if (base === "") return null;
    try {
      return new URL(`/r/${code}`, base).toString();
    } catch {
      return null;
    }
  }

  private setting(definition: SettingDefinition<number>): number {
    return this.settings?.get(definition) ?? definition.fallback;
  }

  private need<T>(dependency: T | null, what: string): T {
    if (dependency === null) throw new Error(`Кабинет партнёра собран без раздела «${what}»`);
    return dependency;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "кабинет партнёра");
  }
}

function promoView(row: PromoCampaignRow, partnerAccountId: string | null, at: Date): CabinetPromo {
  return {
    campaignId: row.campaignId,
    kind: row.kind,
    code: row.codeSample,
    reward: row.reward,
    redeemed: row.redeemed,
    maxRedemptions: row.maxRedemptions,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    state: campaignState(row, at),
    copy: partnerAccountId !== null && row.createdBy === partnerAccountId,
  };
}
