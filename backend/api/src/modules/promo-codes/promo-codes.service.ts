import { randomInt, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ForbiddenError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import {
  PromoCampaignInvalidError,
  PromoCampaignNotFoundError,
  PromoCampaignUsedError,
  PromoCodeNotFoundError,
  PromoCodeRefusedError,
  PromoCodeTakenError,
} from "./promo-code-errors.js";
import {
  PROMO_CODE_LIMITS,
  PROMO_REWARD_RESOURCES,
  batchCode,
  campaignState,
  codeDisplay,
  codeKey,
  codeProblem,
  periodProblem,
  prefixProblem,
  redeemRefusal,
  remaining,
  rewardLines,
  updateProblem,
  type PromoCampaignInput,
  type PromoCampaignRow,
  type PromoCampaignState,
  type PromoCampaignUpdate,
  type PromoReward,
} from "./promo-code-rules.js";
import { PROMO_CODES_REPOSITORY, type PromoCodeDraft, type PromoCodesRepository } from "./promo-codes.repository.js";

/**
 * Промокоды (docs/35-stage4-plan.md WP41, Р74).
 *
 * **Игрок** вводит код — сервер находит кампанию, проверяет срок, лимит и
 * кому она, записывает погашение и кладёт награду в кошелёк причиной
 * `promo_reward` с ключом по кампании и игроку. Погашение пишется раньше
 * награды: упади кошелёк между ними, повторный ввод того же кода доначислит
 * награду теми же ключами, а не скажет «уже получили».
 *
 * **Команда** заводит кампании в панели под `promo.edit`; каждое действие — в
 * аудит. Награда и начало меняются, пока код никто не активировал (правила —
 * `promo-code-rules.ts`).
 */

/** Случайное целое от 0 до n−1: в проде — криптостойкое, в тестах — подменяется. */
export const PROMO_RANDOM = Symbol("PROMO_RANDOM");
export type PromoRandom = (size: number) => number;
export const cryptoPick: PromoRandom = (size) => randomInt(size);

export interface RedeemResult {
  /** сколько легло на самом деле: суточный потолок кошелька мог срезать часть */
  credited: PromoReward;
  /** часть награды не легла — суточный потолок `promo_reward` */
  capped: boolean;
  /** текст кампании игроку; `null` — общий текст клиента */
  message: string | null;
  /** для события `promo_code_applied` */
  campaignId: string;
  kind: PromoCampaignRow["kind"];
}

export interface PromoCampaignView extends PromoCampaignRow {
  state: PromoCampaignState;
  remaining: number | null;
}

export interface PromoCatalogView {
  campaigns: PromoCampaignView[];
  limits: typeof PROMO_CODE_LIMITS;
  platforms: readonly PlatformId[];
}

export interface PromoCampaignDetail {
  campaign: PromoCampaignView;
  /** коды пачки с отметкой погашения; у общего кода — он один */
  codes: { display: string; redeemedAt: Date | null }[];
  /** активации по игровым суткам за последние `DAILY_DAYS` */
  daily: { day: string; count: number }[];
}

export interface CodeCheck {
  /** как код запишется */
  display: string;
  /** по чему игрок его найдёт — для подсказки «регистр и пробелы не важны» */
  key: string;
  problem: string | null;
  /** код уже занят другой кампанией */
  taken: { display: string; title: string } | null;
}

const DB_TIMEOUT_MS = 3_000;
/** заведение пачки — до тысячи строк в одной транзакции */
const CREATE_TIMEOUT_MS = 15_000;
const LIST_LIMIT = 500;
const DAILY_DAYS = 30;
const DAY_MS = 86_400_000;

@Injectable()
export class PromoCodesService {
  private readonly logger = new Logger("promo-codes");

  constructor(
    @Inject(PROMO_CODES_REPOSITORY) private readonly repository: PromoCodesRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(PROMO_RANDOM) private readonly pick: PromoRandom,
    private readonly wallet: WalletService,
    private readonly roles: RolesService,
  ) {}

  async redeem(account: AccountRef, raw: string, at = new Date()): Promise<RedeemResult> {
    const key = codeKey(raw);
    if (key.length < PROMO_CODE_LIMITS.codeMinLength || key.length > PROMO_CODE_LIMITS.codeMaxLength) {
      this.log("promo_code_refused", { accountId: account.accountId, reason: "not_found" });
      throw new PromoCodeNotFoundError();
    }
    const found = await this.db(this.repository.lookup(key));
    if (found === null) {
      // Код в логе — чтобы увидеть опечатку в посте: десятки игроков вводят одно и то же «почти».
      this.log("promo_code_refused", { accountId: account.accountId, reason: "not_found", code: key });
      throw new PromoCodeNotFoundError();
    }
    const { campaign } = found;

    const previous = await this.db(this.repository.redemption(campaign.campaignId, account.accountId));
    if (previous !== null) {
      // Погашение записано, а награда не легла: доначисляем теми же ключами.
      if (previous.rewardedAt === null) return await this.reward(account.accountId, campaign, at);
      throw this.refuse(account, campaign, "already");
    }

    const player = await this.db(this.accounts.byId(account.accountId));
    if (player === null) throw new PromoCodeNotFoundError();
    if (player.bannedAt !== null) throw new ForbiddenError("Аккаунт заблокирован");
    const refusal = redeemRefusal(campaign, found, { platform: account.platform, createdAt: player.createdAt }, at);
    if (refusal !== null) throw this.refuse(account, campaign, refusal);

    const outcome = await this.db(this.repository.redeem({ campaignId: campaign.campaignId, accountId: account.accountId, code: found.code, batch: campaign.kind === "batch", at }));
    if (outcome !== "redeemed") throw this.refuse(account, campaign, outcome);
    return await this.reward(account.accountId, campaign, at);
  }

  async catalog(actor: AccountRef, at = new Date()): Promise<PromoCatalogView> {
    await this.roles.require(actor, "promo.edit");
    const rows = await this.db(this.repository.list(LIST_LIMIT));
    return { campaigns: rows.map((row) => view(row, at)), limits: PROMO_CODE_LIMITS, platforms: PLATFORM_IDS };
  }

  async detail(actor: AccountRef, campaignId: string, at = new Date()): Promise<PromoCampaignDetail> {
    await this.roles.require(actor, "promo.edit");
    const row = await this.db(this.repository.byId(campaignId));
    if (row === null) throw new PromoCampaignNotFoundError();
    const [codes, daily] = await Promise.all([
      this.db(this.repository.codes(campaignId, PROMO_CODE_LIMITS.batchMax)),
      this.db(this.repository.daily(campaignId, new Date(at.getTime() - DAILY_DAYS * DAY_MS))),
    ]);
    return { campaign: view(row, at), codes, daily };
  }

  /** Проверка кода в мастере панели, пока его набирают: занят ли и как его найдёт игрок. */
  async check(actor: AccountRef, raw: string): Promise<CodeCheck> {
    await this.roles.require(actor, "promo.edit");
    const display = codeDisplay(raw);
    const key = codeKey(raw);
    const problem = codeProblem(raw);
    const taken = problem === null ? await this.db(this.repository.codeOwner(key)) : null;
    return { display, key, problem, taken };
  }

  async create(actor: AccountRef, input: PromoCampaignInput, at = new Date()): Promise<PromoCampaignView> {
    await this.roles.require(actor, "promo.edit");
    const period = periodProblem(input, at, { startChanged: true, endChanged: true });
    if (period !== null) throw new PromoCampaignInvalidError(period);

    const { issue } = input;
    let codes: PromoCodeDraft[];
    let refill: ((count: number) => PromoCodeDraft[]) | null = null;
    if (issue.kind === "shared") {
      const problem = codeProblem(issue.code);
      if (problem !== null) throw new PromoCampaignInvalidError(problem);
      codes = [{ code: codeKey(issue.code), display: codeDisplay(issue.code) }];
    } else {
      const problem = prefixProblem(issue.prefix);
      if (problem !== null) throw new PromoCampaignInvalidError(problem);
      refill = (count) => this.batch(issue.prefix, count);
      codes = refill(issue.count);
    }

    const campaign = {
      campaignId: randomUUID(),
      title: input.title,
      kind: issue.kind,
      reward: input.reward,
      message: input.message,
      maxRedemptions: issue.kind === "shared" ? issue.maxRedemptions : issue.count,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      newPlayersDays: input.newPlayersDays,
      platforms: input.platforms,
      note: input.note,
      createdBy: actor.accountId,
      createdAt: at,
    };
    const outcome = await withTimeout(this.repository.create(campaign, codes, refill), CREATE_TIMEOUT_MS, "промокоды");
    if (outcome.status === "taken") throw new PromoCodeTakenError(outcome.display, outcome.title);

    await this.roles.audit({ actorAccountId: actor.accountId, action: "promo.create", target: campaign.campaignId, after: { ...outcome.row, codes: codes.length } });
    this.log("promo_campaign_created", { campaignId: campaign.campaignId, kind: campaign.kind, codes: codes.length, reward: rewardLines(campaign.reward), actor: actor.accountId });
    return view(outcome.row, at);
  }

  async update(actor: AccountRef, campaignId: string, update: PromoCampaignUpdate, at = new Date()): Promise<PromoCampaignView> {
    await this.roles.require(actor, "promo.edit");
    const outcome = await this.db(this.repository.update(campaignId, update, at, (current) => updateProblem(current, update, at)));
    if (outcome.status === "missing") throw new PromoCampaignNotFoundError();
    if (outcome.status === "invalid") throw new PromoCampaignInvalidError(outcome.message);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "promo.update", target: campaignId, before: outcome.before, after: outcome.after });
    return view(outcome.after, at);
  }

  async pause(actor: AccountRef, campaignId: string, paused: boolean, at = new Date()): Promise<PromoCampaignView> {
    await this.roles.require(actor, "promo.edit");
    const row = await this.db(this.repository.setPaused(campaignId, paused ? at : null, at));
    if (row === null) throw new PromoCampaignNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: paused ? "promo.pause" : "promo.resume", target: campaignId, after: { pausedAt: row.pausedAt } });
    this.log(paused ? "promo_campaign_paused" : "promo_campaign_resumed", { campaignId, actor: actor.accountId });
    return view(row, at);
  }

  async remove(actor: AccountRef, campaignId: string): Promise<void> {
    await this.roles.require(actor, "promo.edit");
    const outcome = await this.db(this.repository.remove(campaignId));
    if (outcome.status === "missing") throw new PromoCampaignNotFoundError();
    if (outcome.status === "used") throw new PromoCampaignUsedError(outcome.redeemed);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "promo.remove", target: campaignId, before: outcome.row });
  }

  private async reward(accountId: string, campaign: PromoCampaignRow, at: Date): Promise<RedeemResult> {
    const credited: PromoReward = { coins: 0, gems: 0, shard_common: 0, shard_uncommon: 0 };
    for (const { resource, amount } of rewardLines(campaign.reward)) {
      const granted = await this.wallet.grant({
        accountId,
        resource,
        amount,
        reason: "promo_reward",
        source: `promo:${campaign.campaignId}`,
        idempotencyKey: `promo:${campaign.campaignId}:${accountId}:${resource}`,
        at,
      });
      credited[resource] = granted.credited;
    }
    await this.db(this.repository.markRewarded(campaign.campaignId, accountId, credited, at));
    const capped = PROMO_REWARD_RESOURCES.some((resource) => credited[resource] < campaign.reward[resource]);
    this.log("promo_code_redeemed", { accountId, campaignId: campaign.campaignId, kind: campaign.kind, capped });
    return { credited, capped, message: campaign.message, campaignId: campaign.campaignId, kind: campaign.kind };
  }

  private refuse(account: AccountRef, campaign: PromoCampaignRow, reason: PromoCodeRefusedError["reason"]): PromoCodeRefusedError {
    this.log("promo_code_refused", { accountId: account.accountId, campaignId: campaign.campaignId, reason });
    return new PromoCodeRefusedError(reason);
  }

  private batch(prefix: string, count: number): PromoCodeDraft[] {
    const drafts = new Map<string, PromoCodeDraft>();
    // Совпадения внутри одной пачки отсеиваются сразу, с уже занятыми — в базе.
    while (drafts.size < count) {
      const draft = batchCode(prefix, this.pick);
      drafts.set(draft.code, draft);
    }
    return [...drafts.values()];
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "промокоды");
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "promo-codes", event, ...fields }));
  }
}

function view(row: PromoCampaignRow, at: Date): PromoCampaignView {
  return { ...row, state: campaignState(row, at), remaining: remaining(row) };
}
