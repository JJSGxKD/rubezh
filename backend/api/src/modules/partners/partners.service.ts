import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { DomainError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { campaignState, type PromoCampaignState } from "../promo-codes/promo-code-rules.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PARTNER_RULES, type PartnerInput, type PartnerRow, type PartnerStats } from "./partner-rules.js";
import { PARTNERS_REPOSITORY, type PartnerBindingView, type PartnerCampaignRow, type PartnersRepository } from "./partners.repository.js";

/**
 * Партнёры в панели (docs/35-stage4-plan.md WP41, часть 2): кто приводит
 * игроков своими кодами и чего эти игроки стоят. Смотрят — под
 * `partners.view` (владелец, администратор, маркетолог, бухгалтерия),
 * заводят и правят — под `partners.edit`; каждое изменение — в аудит.
 * Удаления нет: по партнёру считаются приведённые им игроки.
 */

export class PartnerNotFoundError extends DomainError {
  constructor() {
    super("partner_not_found", "Партнёра нет", 404);
  }
}

export interface PartnerView extends PartnerRow {
  stats: PartnerStats;
}

export interface PartnerDetail {
  partner: PartnerView;
  /** привязки по игровым суткам за последние `DAILY_DAYS` */
  daily: { day: string; count: number }[];
  codes: (PartnerCampaignRow & { state: PromoCampaignState })[];
  rules: typeof PARTNER_RULES;
}

const DB_TIMEOUT_MS = 3_000;
const LIST_LIMIT = 500;
const DAILY_DAYS = 30;

@Injectable()
export class PartnersService {
  private readonly logger = new Logger("partners");

  constructor(
    @Inject(PARTNERS_REPOSITORY) private readonly repository: PartnersRepository,
    private readonly roles: RolesService,
  ) {}

  async catalog(actor: AccountRef, at = new Date()): Promise<{ partners: PartnerView[]; rules: typeof PARTNER_RULES }> {
    await this.roles.require(actor, "partners.view");
    return { partners: await this.db(this.repository.list(LIST_LIMIT, at)), rules: PARTNER_RULES };
  }

  async detail(actor: AccountRef, partnerId: string, at = new Date()): Promise<PartnerDetail> {
    await this.roles.require(actor, "partners.view");
    const partner = await this.db(this.repository.byId(partnerId, at));
    if (partner === null) throw new PartnerNotFoundError();
    const [daily, codes] = await Promise.all([
      this.db(this.repository.daily(partnerId, new Date(at.getTime() - DAILY_DAYS * 86_400_000))),
      this.db(this.repository.campaigns(partnerId)),
    ]);
    return { partner, daily, codes: codes.map((code) => ({ ...code, state: campaignState(code, at) })), rules: PARTNER_RULES };
  }

  async create(actor: AccountRef, input: PartnerInput, at = new Date()): Promise<PartnerView> {
    await this.roles.require(actor, "partners.edit");
    const row: PartnerRow = { ...input, partnerId: randomUUID(), createdBy: actor.accountId, createdAt: at, updatedAt: at };
    await this.db(this.repository.create(row));
    await this.roles.audit({ actorAccountId: actor.accountId, action: "partner.create", target: row.partnerId, after: row });
    this.logger.log(JSON.stringify({ module: "partners", event: "partner_created", partnerId: row.partnerId, actor: actor.accountId }));
    return { ...row, stats: { codes: 0, activeCodes: 0, redeemed: 0, bound: 0, played: 0, payers: 0, stars: 0 } };
  }

  async update(actor: AccountRef, partnerId: string, input: PartnerInput, at = new Date()): Promise<PartnerView> {
    await this.roles.require(actor, "partners.edit");
    const changed = await this.db(this.repository.update(partnerId, input, at));
    if (changed === null) throw new PartnerNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "partner.update", target: partnerId, before: changed.before, after: changed.after });
    const view = await this.db(this.repository.byId(partnerId, at));
    if (view === null) throw new PartnerNotFoundError();
    return view;
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
