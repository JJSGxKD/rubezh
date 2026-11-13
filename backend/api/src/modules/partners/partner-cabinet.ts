import { Inject, Injectable } from "@nestjs/common";
import { DomainError, ForbiddenError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
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
 * - точка входа `overview` — карточка без контактов и заметок команды.
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

@Injectable()
export class PartnerCabinet {
  constructor(
    private readonly roles: RolesService,
    @Inject(PARTNER_ACCOUNTS) private readonly accounts: PartnerAccounts,
    @Inject(PARTNERS_REPOSITORY) private readonly partners: PartnersRepository,
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

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "кабинет партнёра");
  }
}
