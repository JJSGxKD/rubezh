import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ProgressService } from "../progress/progress.service.js";
import { PrologueService } from "../runs/prologue.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { DAYS_IN_WEEK, dailyLadderOf, dailyReward, dayPosition, stepMul, type DailyLadder } from "./daily-rules.js";
import { nextStreak, streakView, type StreakView } from "./daily-streak.js";
import { DAILY_REPOSITORY, type DailyRepository, type DailyState } from "./daily.repository.js";

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
  /**
   * Награда следующего дня по порядку — та, что ждёт после сегодняшнего
   * забора: «Завтра: 120 монет» на главной. За седьмым днём — первый день
   * следующей недели со своей ступенью.
   */
  next: { coins: number; shards: number };
  /** серия дней (Р154, T-0262): каждый день подряд +5 % к награде дня, до +50 % */
  streak: StreakView;
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
    // Нет сервиса пролога (старый состав модуля) — награда открыта.
    @Optional() private readonly prologue?: PrologueService,
    // Нет настроек — неделя награды прежняя; число читается на каждом запросе, правка из панели действует сразу.
    @Optional() @Inject(SETTINGS_READER) private readonly settings?: SettingsReader,
  ) {}

  async view(accountId: string, at = new Date()): Promise<DailyView> {
    const [state, level] = await Promise.all([this.state(accountId, at), this.level(accountId)]);
    return viewOf(state.claimedDays, state.claimedToday, level, this.ladder(), streakOf(state));
  }

  async claim(accountId: string, at = new Date()): Promise<DailyClaimResult> {
    // Закрыто до победы в прологе (Р151): новичка не встречает кнопка до первого забега.
    await this.prologue?.requireOpen(accountId);
    const [state, level] = await Promise.all([this.state(accountId, at), this.level(accountId)]);
    if (state.claimedToday) return { claimed: false, coins: 0, shards: 0, view: viewOf(state.claimedDays, true, level, this.ladder(), streakOf(state)) };

    const day = state.claimedDays + 1;
    // Ступень серии считает сервер по игровым суткам; тот же забор, повторённый после сбоя, даёт ту же ступень и тот же ключ.
    const streak = nextStreak(state.streak, state.lastClaimDay, state.today);
    const reward = dailyReward(day, level, this.ladder(), streak);
    const key = `daily_reward:${accountId}:${String(day)}`;
    const coins = await this.wallet.grant({ accountId, resource: "coins", amount: reward.coins, reason: "daily_reward", source: `daily:${String(day)}`, idempotencyKey: key, at });
    const shards =
      reward.shards > 0
        ? await this.wallet.grant({ accountId, resource: "shard_common", amount: reward.shards, reason: "daily_reward", source: `daily:${String(day)}`, idempotencyKey: `${key}:shards`, at })
        : null;
    const advanced = await withTimeout(this.repository.advance(accountId, state.claimedDays, at, streak), DB_TIMEOUT_MS, "награда дня");
    if (advanced) this.logger.log(JSON.stringify({ module: "daily", event: "daily_claimed", accountId, day, streak, coins: coins.credited, shards: shards?.credited ?? 0 }));
    const after = advanced ? { ...state, claimedDays: day, claimedToday: true, streak, lastClaimDay: state.today } : state;
    return { claimed: advanced, coins: coins.credited, shards: shards?.credited ?? 0, view: viewOf(after.claimedDays, advanced, level, this.ladder(), streakOf(after)) };
  }

  /** Знак меню: 1 — награда этих суток ждёт. */
  async badge(accountId: string, at = new Date()): Promise<number> {
    // Закрытая награда знака не даёт: он позвал бы туда, куда нельзя.
    if (this.prologue !== undefined && !(await this.prologue.isDone(accountId))) return 0;
    return (await this.state(accountId, at)).claimedToday ? 0 : 1;
  }

  private ladder(): DailyLadder | undefined {
    return this.settings === undefined ? undefined : dailyLadderOf(this.settings.get(SETTINGS.rewardsDailyLadder));
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
export function viewOf(claimedDays: number, claimedToday: boolean, level: number, ladder?: DailyLadder, streak: StreakView = { days: 0, bonusPercent: 0, next: 1 }): DailyView {
  const today = claimedToday ? claimedDays : claimedDays + 1;
  const { dayOfWeek, closedWeeks } = dayPosition(today);
  const first = today - dayOfWeek;
  const days: DailyDayView[] = [];
  for (let index = 0; index < DAYS_IN_WEEK; index++) {
    const day = first + index;
    days.push({ day, ...dailyReward(day, level, ladder), claimed: day <= claimedDays, today: day === today });
  }
  return { week: closedWeeks + 1, days, canClaim: !claimedToday, step: stepMul(closedWeeks), nextStep: stepMul(closedWeeks + 1), next: dailyReward(today + 1, level, ladder), streak };
}

/** Серия для ответа по состоянию строки награды дня. */
function streakOf(state: DailyState): StreakView {
  return streakView(state.streak, state.lastClaimDay, state.today, state.claimedToday);
}
