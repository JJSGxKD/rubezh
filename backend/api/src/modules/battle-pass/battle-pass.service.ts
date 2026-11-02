import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ITEM_RARITIES, type ItemRarity } from "../items/item-catalog.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { VipService } from "../vip/vip.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { BATTLE_PASS_REPOSITORY, type BattlePassRepository } from "./battle-pass.repository.js";
import { DEFAULT_RIBBON } from "./pass-defaults.js";
import { PassAlreadyClaimedError, PassTierNotReachedError, PassVipRequiredError } from "./pass-errors.js";
import {
  claimBlock,
  monthKeyOf,
  passGrantKey,
  passRibbonSchema,
  passViewOf,
  rewardLines,
  tierOf,
  type PassLane,
  type PassTierDef,
  type PassView,
} from "./pass-rules.js";

/**
 * Батл-пасс (docs/35-stage4-plan.md Р46, §3.15; tasks/T-0311): очки за забранные
 * задания, 30 ступеней в двух лентах, забор награды.
 *
 * **Забор — ровно один раз.** Сначала начисление кошельком по ключу
 * `pass:<месяц>:<ступень>:<лента>:<игрок>:<ресурс>`, потом одна транзакция: журнал
 * `pass_claim` с уникальным ключом и подарок-буст `boost_credit`. Процесс упал
 * между ними — повтор не начислит кошельком второй раз (ключ узнает операцию) и
 * дозапишет журнал и подарок; два запроса разом — выигравший журнал выдаёт подарок,
 * проигравший получает `409` и ничего не пишет. Журнал — после кошелька, а не до:
 * иначе упавший между ними процесс оставил бы награду забранной, но невыданной.
 *
 * **Серверные события** (`pass_tier_reached`, `pass_reward_claimed`) — строки лога,
 * как у сезонов рейтинга: конверт события привязан к устройству, а серверного вида
 * события в конвейере пока нет (docs/22-analytics-and-metrics.md §3.3).
 */

const DB_TIMEOUT_MS = 3_000;
/** Начисление — отдельная транзакция кошелька со своим пределом ожидания. */
const WALLET_TIMEOUT_MS = 8_000;

/** Что легло на счёт игрока при заборе: по ресурсам, после суточного потолка кошелька. */
export interface PassCredited {
  coins?: number;
  gems?: number;
  shards?: Partial<Record<ItemRarity, number>>;
  /** подарок-буст: выдаётся целиком, потолка у него нет */
  boost?: { id: string; count: number };
}

export interface PassClaimResult {
  tier: number;
  lane: PassLane;
  credited: PassCredited;
}

@Injectable()
export class BattlePassService {
  private readonly logger = new Logger("battle-pass");

  constructor(
    @Inject(BATTLE_PASS_REPOSITORY) private readonly repository: BattlePassRepository,
    private readonly wallet: WalletService,
    @Inject(VipService) private readonly vip: Pick<VipService, "activeAt">,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  async view(account: AccountRef, at = new Date()): Promise<PassView> {
    const monthKey = monthKeyOf(at);
    const [points, claimed, ribbon, vip] = await Promise.all([
      this.db(this.repository.points(account.accountId, monthKey)),
      this.db(this.repository.claimed(account.accountId, monthKey)),
      this.ribbon(monthKey),
      this.db(this.vip.activeAt(account.accountId, at)),
    ]);
    return passViewOf({ monthKey, points, pointsPerTier: this.settings.get(SETTINGS.passPointsPerTier), vip, ribbon, claimed });
  }

  async claim(account: AccountRef, tier: number, lane: PassLane, at = new Date()): Promise<PassClaimResult> {
    const { accountId } = account;
    const monthKey = monthKeyOf(at);
    const pointsPerTier = this.settings.get(SETTINGS.passPointsPerTier);
    // VIP спрашиваем только у VIP-ленты и ровно в момент забора: купил посреди месяца — забираешь и пройденное.
    const [points, claimed, ribbon, vipNow] = await Promise.all([
      this.db(this.repository.points(accountId, monthKey)),
      this.db(this.repository.claimed(accountId, monthKey)),
      this.ribbon(monthKey),
      lane === "vip" ? this.db(this.vip.activeAt(accountId, at)) : Promise.resolve(false),
    ]);
    const block = claimBlock({ tier, lane, points, pointsPerTier, vipNow, claimed });
    if (block === "tier_not_reached") throw new PassTierNotReachedError();
    if (block === "already_claimed") throw new PassAlreadyClaimedError();
    if (block === "vip_required") throw new PassVipRequiredError();

    const reward = ribbon[tier - 1]?.[lane];
    if (reward === undefined) throw new PassTierNotReachedError();
    const credited: PassCredited = {};
    for (const line of rewardLines(reward)) {
      const result = await withTimeout(
        this.wallet.grant({
          accountId,
          resource: line.resource,
          amount: line.amount,
          reason: "pass_reward",
          source: `pass:${monthKey}:${String(tier)}:${lane}`,
          idempotencyKey: passGrantKey(monthKey, tier, lane, accountId, line.resource),
          at,
        }),
        WALLET_TIMEOUT_MS,
        "награда пасса",
      );
      const rarity = ITEM_RARITIES.find((candidate) => `shard_${candidate}` === line.resource);
      if (line.resource === "coins") credited.coins = result.credited;
      else if (line.resource === "gems") credited.gems = result.credited;
      else if (rarity !== undefined) credited.shards = { ...credited.shards, [rarity]: result.credited };
    }
    const boost = reward.boost ?? null;
    if (boost !== null) credited.boost = boost;

    const won = await this.db(this.repository.claim({ accountId, monthKey, tier, lane, boost, at }));
    // Проигравший гонку видит ту же награду в кошельке по ключу, но получил её не он.
    if (!won) throw new PassAlreadyClaimedError();
    this.log("pass_reward_claimed", { accountId, month: monthKey, tier, lane, source: "claim", ...flat(credited) });
    return { tier, lane, credited };
  }

  /**
   * Очки пасса за забранное задание (вызывает модуль заданий после отметки «забрано»):
   * прибавка одной командой, ступени — по очкам до и после. Каждая взятая ступень —
   * строка лога `pass_tier_reached`.
   */
  async addTaskPoints(accountId: string, points: number, at = new Date()): Promise<void> {
    if (!Number.isInteger(points) || points <= 0) return;
    const monthKey = monthKeyOf(at);
    const { before, after } = await this.db(this.repository.addPoints(accountId, monthKey, points, at));
    const pointsPerTier = this.settings.get(SETTINGS.passPointsPerTier);
    for (let tier = tierOf(before, pointsPerTier) + 1; tier <= tierOf(after, pointsPerTier); tier++) this.log("pass_tier_reached", { accountId, month: monthKey, tier });
  }

  /**
   * Лента месяца: из базы, если её завели и она проходит схему, иначе по умолчанию. Порченая
   * лента не должна валить пасс: игрок увидит ленту по умолчанию, а команда — ошибку в логе.
   */
  private async ribbon(monthKey: string): Promise<readonly PassTierDef[]> {
    const stored = await this.db(this.repository.season(monthKey));
    if (stored === null) return DEFAULT_RIBBON;
    const parsed = passRibbonSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    this.logger.error(JSON.stringify({ module: "battle-pass", event: "pass_season_invalid", month: monthKey, problem: parsed.error.issues[0]?.message ?? "лента не проходит схему" }));
    return DEFAULT_RIBBON;
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "battle-pass", event, ...fields }));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "батл-пасс");
  }
}

/** Плоские поля для строки лога: без вложенных объектов, чтобы строку читал и `jq`, и глаз. */
function flat(credited: PassCredited): Record<string, number | string | undefined> {
  return {
    coins: credited.coins,
    gems: credited.gems,
    shards: Object.values(credited.shards ?? {}).reduce((sum, amount) => sum + (amount ?? 0), 0) || undefined,
    boost: credited.boost?.id,
  };
}
