import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { WalletService } from "../wallet/wallet.service.js";
import { claimResultSchema, type ClaimResult } from "./dto/seasons.dto.js";
import { SeasonRewardNotFoundError } from "./seasons-errors.js";
import { SEASONS_REPOSITORY, type SeasonsRepository } from "./seasons.repository.js";

/**
 * «Забрать» награду сезона (tasks/T-0110). Награда не ложится сама: возврат
 * игрока к закрытию сезона — метрика `docs/39-retention-mechanics.md` §4.6.
 *
 * **Порядок: сначала кошелёк, потом отметка.** Монеты начисляются по ключу
 * `season:<сезон>:<аккаунт>` — один раз при любом числе вызовов, — и только
 * затем награда переходит `pending → claimed` одним условным обновлением. Если
 * процесс упал между ними, награда осталась `pending`, и повторный «Забрать»
 * найдёт монеты по ключу и лишь отметит её. В обратном порядке тот же сбой
 * оставил бы награду забранной, а монеты — не начисленными.
 */

const DB_TIMEOUT_MS = 3_000;
const WALLET_TIMEOUT_MS = 5_000;

const NOT_CLAIMED: ClaimResult = { claimed: false, credited: { coins: 0, prestige: 0 } };

@Injectable()
export class SeasonsClaimService {
  private readonly logger = new Logger("seasons");

  constructor(
    @Inject(SEASONS_REPOSITORY) private readonly repository: SeasonsRepository,
    private readonly wallet: WalletService,
  ) {}

  async claim(accountId: string, seasonKey: string, at = new Date()): Promise<ClaimResult> {
    const reward = await withTimeout(this.repository.rewardOf(seasonKey, accountId), DB_TIMEOUT_MS, "seasons: награда");
    if (reward === null) throw new SeasonRewardNotFoundError();
    if (reward.status !== "pending") return NOT_CLAIMED;

    const granted = await withTimeout(
      this.wallet.grant({ accountId, resource: "coins", amount: reward.coins, reason: "season_reward", source: `season:${seasonKey}`, idempotencyKey: `season:${seasonKey}:${accountId}`, at }),
      WALLET_TIMEOUT_MS,
      "seasons: начисление",
    );
    const won = await withTimeout(this.repository.markClaimed(seasonKey, accountId, at), DB_TIMEOUT_MS, "seasons: отметка награды");
    // Параллельный «Забрать» отметил раньше: монеты по ключу легли один раз, ответ этому вызову — «уже забрано».
    if (!won) return NOT_CLAIMED;

    // Событие `season_reward_claimed` (docs/22-analytics-and-metrics.md §3.3) — один раз, у выигравшего отметку.
    this.logger.log(
      JSON.stringify({
        module: "seasons",
        event: "season_reward_claimed",
        season: seasonKey,
        kind: reward.kind,
        difficulty: reward.difficulty,
        place: reward.place,
        coins: granted.credited,
        prestige: reward.prestige,
      }),
    );
    return claimResultSchema.parse({ claimed: true, credited: { coins: granted.credited, prestige: reward.prestige } });
  }
}
