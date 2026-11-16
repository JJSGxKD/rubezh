import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { AdsService } from "../ads/ads.service.js";
import { ProgressService } from "../progress/progress.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { dailyLadderOf, dailyReward, type DailyLadder } from "./daily-rules.js";
import { DailyAlreadyDoubledError, DailyNotClaimedError } from "./daily-double-errors.js";
import { DAILY_DOUBLE_REPOSITORY, DAILY_REPOSITORY, type DailyDoubleRepository, type DailyDoubleRow, type DailyRepository } from "./daily.repository.js";
import type { DailyView } from "./daily.service.js";

/**
 * Награда дня ×2 за ролик (docs/35-stage4-plan.md Р155, tasks/T-0242): модуль
 * награды дня — хозяин места рекламы `daily_double`. Забрав награду дня, игрок
 * удваивает её досмотренной сессией — те же монеты и осколки ещё раз, раз в
 * игровые сутки. Удвоить можно только сегодняшнюю забранную награду: не
 * забрал — нечего удваивать, сутки прошли — удвоение того дня сгорело.
 *
 * Порядок — как у второго шанса: проверка, забор сессии, запись, начисление.
 * Проверка идёт до забора, поэтому досмотренная сессия не тратится на день,
 * который удвоить нельзя. Запись неделима (`ON CONFLICT DO NOTHING`): два
 * параллельных запроса дают одно удвоение. Повтор той же сессией после обрыва
 * отдаёт тот же ответ и дожимает начисление тем же ключом, а не отказывает.
 *
 * Дневной кап роликов (T-0241) считает модуль рекламы: место наградное и не
 * задание. У VIP ролика нет — выдача показа отдаёт пропуск.
 */

const DB_TIMEOUT_MS = 3_000;

export interface DailyDoublePlayer {
  accountId: string;
  platform: PlatformId;
}

export type DailyDoubleView =
  | {
      status: "available";
      /** сколько монет и осколков добавит удвоение — столько же, сколько дал забор дня */
      coins: number;
      shards: number;
      /** есть ли реклама для площадки, когда пройдёт кулдаун (у места его нет) и нужен ли ролик (`pass` — VIP без него) */
      ad: { available: boolean; readyAt: string | null; pass: string | null; capped: boolean };
    }
  | { status: "doubled"; coins: number; shards: number }
  /** сегодня награда дня не забрана — удваивать нечего */
  | { status: "unavailable" };

/** Неделя награды дня и то, что можно сделать с сегодняшней наградой. */
export type DailyViewWithDouble = DailyView & { double: DailyDoubleView };

export interface DailyDoubleResult {
  /** сколько легло на кошелёк; при повторе той же сессией — то же, что в первый раз */
  credited: { coins: number; shards: number };
  view: DailyDoubleView;
}

@Injectable()
export class DailyDoubleService {
  private readonly logger = new Logger("daily");

  constructor(
    @Inject(DAILY_REPOSITORY) private readonly daily: Pick<DailyRepository, "state">,
    @Inject(DAILY_DOUBLE_REPOSITORY) private readonly doubles: DailyDoubleRepository,
    private readonly progress: ProgressService,
    private readonly wallet: WalletService,
    private readonly ads: AdsService,
    // Нет настроек — неделя награды прежняя; число читается на каждом запросе, правка из панели действует сразу.
    @Optional() @Inject(SETTINGS_READER) private readonly settings?: SettingsReader,
  ) {}

  async view(player: DailyDoublePlayer, at = new Date()): Promise<DailyDoubleView> {
    const { accountId } = player;
    const state = await this.db(this.daily.state(accountId, at));
    if (!state.claimedToday) return { status: "unavailable" };
    const done = await this.db(this.doubles.today(accountId, at));
    if (done !== null) return { status: "doubled", coins: done.coins, shards: done.shards };
    const reward = dailyReward(state.claimedDays, await this.level(accountId), this.ladder());
    const ready = await this.ads.readiness(player, "daily_double", at);
    return {
      status: "available",
      coins: reward.coins,
      shards: reward.shards,
      ad: { available: ready.available, readyAt: ready.readyAt?.toISOString() ?? null, pass: ready.pass, capped: ready.capped },
    };
  }

  async double(player: DailyDoublePlayer, sessionId: string, at = new Date()): Promise<DailyDoubleResult> {
    const { accountId } = player;

    // Сессия уже потрачена на удвоение — обрыв после записи: дожимаем начисление, а не отказываем.
    const spent = await this.db(this.doubles.bySession(accountId, sessionId));
    if (spent !== null) return await this.settle(player, spent, at);

    const state = await this.db(this.daily.state(accountId, at));
    if (!state.claimedToday) throw new DailyNotClaimedError();
    if ((await this.db(this.doubles.today(accountId, at))) !== null) throw new DailyAlreadyDoubledError();
    const reward = dailyReward(state.claimedDays, await this.level(accountId), this.ladder());

    // Чужая, незавершённая и чужого места сессия, кап роликов, ограничение — отказы модуля рекламы.
    await this.ads.claim(accountId, sessionId, "daily_double", at);
    const outcome = await this.db(this.doubles.record({ accountId, sessionId, dayNumber: state.claimedDays, coins: reward.coins, shards: reward.shards }, at));
    if (outcome === "taken") throw new DailyAlreadyDoubledError();

    // Записанное — истина: параллельный повтор той же сессией берёт числа первой записи, а не свои.
    const row = await this.db(this.doubles.bySession(accountId, sessionId));
    if (row === null) throw new DailyAlreadyDoubledError();
    return await this.settle(player, row, at);
  }

  /** Начислить удвоение ключом дня и отдать ответ; повтор не начисляет второй раз. */
  private async settle(player: DailyDoublePlayer, row: DailyDoubleRow, at: Date): Promise<DailyDoubleResult> {
    const { accountId } = player;
    const day = String(row.dayNumber);
    const key = `daily:${accountId}:${day}:double`;
    const coins = await this.wallet.grant({ accountId, resource: "coins", amount: row.coins, reason: "daily_reward", source: `daily:${day}:double`, idempotencyKey: key, at });
    const shards = row.shards > 0 ? await this.wallet.grant({ accountId, resource: "shard_common", amount: row.shards, reason: "daily_reward", source: `daily:${day}:double`, idempotencyKey: `${key}:shards`, at }) : null;
    const repeat = coins.duplicate && (shards === null || shards.duplicate);
    if (!repeat) this.logger.log(JSON.stringify({ module: "daily", event: "daily_doubled", accountId, day: row.dayNumber, coins: coins.credited, shards: shards?.credited ?? 0 }));
    return {
      // Повтор отдаёт то же, что первый ответ: кошелёк на дубле говорит «ничего не легло».
      credited: { coins: coins.duplicate ? row.coins : coins.credited, shards: shards === null ? 0 : shards.duplicate ? row.shards : shards.credited },
      view: await this.view(player, at),
    };
  }

  private ladder(): DailyLadder | undefined {
    return this.settings === undefined ? undefined : dailyLadderOf(this.settings.get(SETTINGS.rewardsDailyLadder));
  }

  private async level(accountId: string): Promise<number> {
    return (await this.progress.view(accountId)).level;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "удвоение награды дня");
  }
}
