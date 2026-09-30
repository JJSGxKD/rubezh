import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ProgressService } from "../progress/progress.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { DAYS_IN_WEEK, dailyReward, dayPosition, stepMul } from "./daily-rules.js";
import { DAILY_REPOSITORY, type DailyRepository } from "./daily.repository.js";

/**
 * Награда дня (docs/35-stage4-plan.md Р45, §3.14, WP13). Какой сегодня день
 * и забрано ли — решает сервер по московским суткам: по часам устройства
 * награду получали бы переводом времени.
 *
 * Забор — начисление ключом дня, потом отметка. Ключ — аккаунт и номер дня по
 * порядку, поэтому день даёт награду один раз: два запроса разом начислят её
 * однажды, а начисленную, но не отмеченную после сбоя кошелёк узнает по ключу.
 */

const DB_TIMEOUT_MS = 3_000;

export interface DailyDayView {
  /** номер дня по порядку забора, с первого */
  day: number;
  coins: number;
  shards: number;
  claimed: boolean;
  /** день, который забирают в эти сутки — или уже забрали */
  today: boolean;
}

export interface DailyView {
  /** какая по счёту неделя, с первой */
  week: number;
  days: DailyDayView[];
  canClaim: boolean;
  /** множитель ступени этой недели и следующей; следующая не больше — потолок */
  step: number;
  nextStep: number;
}

export interface DailyClaimResult {
  claimed: boolean;
  coins: number;
  shards: number;
  view: DailyView;
}

@Injectable()
export class DailyService {
  private readonly logger = new Logger("daily");

  constructor(
    @Inject(DAILY_REPOSITORY) private readonly repository: DailyRepository,
    private readonly progress: ProgressService,
    private readonly wallet: WalletService,
  ) {}

  async view(accountId: string, at = new Date()): Promise<DailyView> {
    const [state, level] = await Promise.all([this.state(accountId, at), this.level(accountId)]);
    return viewOf(state.claimedDays, state.claimedToday, level);
  }

  async claim(accountId: string, at = new Date()): Promise<DailyClaimResult> {
    const [state, level] = await Promise.all([this.state(accountId, at), this.level(accountId)]);
    if (state.claimedToday) return { claimed: false, coins: 0, shards: 0, view: viewOf(state.claimedDays, true, level) };

    const day = state.claimedDays + 1;
    const reward = dailyReward(day, level);
    const key = `daily_reward:${accountId}:${String(day)}`;
    const coins = await this.wallet.grant({ accountId, resource: "coins", amount: reward.coins, reason: "daily_reward", source: `daily:${String(day)}`, idempotencyKey: key, at });
    const shards =
      reward.shards > 0
        ? await this.wallet.grant({ accountId, resource: "shard_common", amount: reward.shards, reason: "daily_reward", source: `daily:${String(day)}`, idempotencyKey: `${key}:shards`, at })
        : null;
    const advanced = await withTimeout(this.repository.advance(accountId, state.claimedDays, at), DB_TIMEOUT_MS, "награда дня");
    if (advanced) this.logger.log(JSON.stringify({ module: "daily", event: "daily_claimed", accountId, day, coins: coins.credited, shards: shards?.credited ?? 0 }));
    return { claimed: advanced, coins: coins.credited, shards: shards?.credited ?? 0, view: viewOf(advanced ? day : state.claimedDays, advanced, level) };
  }

  /** Знак меню: 1 — награда этих суток ждёт. */
  async badge(accountId: string, at = new Date()): Promise<number> {
    return (await this.state(accountId, at)).claimedToday ? 0 : 1;
  }

  private async state(accountId: string, at: Date) {
    return await withTimeout(this.repository.state(accountId, at), DB_TIMEOUT_MS, "награда дня");
  }

  private async level(accountId: string): Promise<number> {
    return (await this.progress.view(accountId)).level;
  }
}

/**
 * Неделя, которую видит игрок: забранное, сегодняшнее и то, что впереди.
 * Забрал седьмой день — до следующих суток видна закрытая неделя, а не
 * пустая новая: иначе забор выглядел бы как сброс.
 */
export function viewOf(claimedDays: number, claimedToday: boolean, level: number): DailyView {
  const today = claimedToday ? claimedDays : claimedDays + 1;
  const { dayOfWeek, closedWeeks } = dayPosition(today);
  const first = today - dayOfWeek;
  const days: DailyDayView[] = [];
  for (let index = 0; index < DAYS_IN_WEEK; index++) {
    const day = first + index;
    days.push({ day, ...dailyReward(day, level), claimed: day <= claimedDays, today: day === today });
  }
  return { week: closedWeeks + 1, days, canClaim: !claimedToday, step: stepMul(closedWeeks), nextStep: stepMul(closedWeeks + 1) };
}
