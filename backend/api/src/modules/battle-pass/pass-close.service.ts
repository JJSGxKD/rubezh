import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { ITEM_RARITIES } from "../items/item-catalog.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { VIP_REPOSITORY, type VipRepository } from "../vip/vip.repository.js";
import { WalletService } from "../wallet/wallet.service.js";
import { BATTLE_PASS_REPOSITORY, type BattlePassRepository } from "./battle-pass.repository.js";
import type { PassCredited } from "./battle-pass.service.js";
import { DEFAULT_RIBBON } from "./pass-defaults.js";
import { PASS_CLOSE_REPOSITORY, type PassCloseRepository, type PassPlayer } from "./pass-close.repository.js";
import { claimKey, monthBounds, monthKeyOf, passGrantKey, passRibbonSchema, rewardLines, tierOf, PASS_TIERS, type PassLane, type PassReward, type PassTierDef } from "./pass-rules.js";

/**
 * Закрытие месяца пасса (docs/35-stage4-plan.md Р46; tasks/T-0312): в первую
 * минуту нового месяца по Москве игрокам выдаётся всё незабранное — награды не
 * сгорают. Задание ходит раз в минуту (`pass-close.job.ts`) и закрывает прошедшие
 * месяцы окна догона по порядку: сервер лежал через границу месяца — закроет
 * на подъёме.
 *
 * Кому что: бесплатная лента — каждому, у кого есть ступень, по достигнутую;
 * VIP-лента — тем, у кого VIP шёл хоть мгновение этого месяца (за него игрок
 * заплатил), и тоже по достигнутую ступень.
 *
 * **Ровно один раз** держат три слоя, каждый ловит своё:
 * - замок Redis на проход — вторая реплика уходит сразу; токен в значении, чужой
 *   замок не снимается, а потерянный останавливает проход;
 * - выдача — тем же путём, что ручной забор: кошелёк по ключу
 *   `pass:<месяц>:<ступень>:<лента>:<игрок>:<ресурс>`, затем одна транзакция —
 *   журнал `pass_claim` и подарок-буст. Ключ и журнал общие с ручным забором, поэтому
 *   игрок, забиравший в последнюю секунду месяца, награду дважды не получит;
 * - метка `pass_close` пишется **последней**, когда выдано всем: упавший посреди
 *   закрытия проход повторяется с начала, и уже выданное пропускается по журналу.
 *
 * Игроки идут пачками; сбой пачки повторяется только для тех, у кого он случился.
 * Игрок, у которого награды так и не выдались, оставляет месяц незакрытым, остальные
 * при этом оплачены — следующий проход догонит только его.
 *
 * Серверные события (`pass_closed`, `pass_reward_claimed` с `source: "close"`) —
 * строки лога, как у ручного забора: серверного вида события в конвейере нет
 * (docs/22-analytics-and-metrics.md §3.3).
 */

/** Окно догона, пачки и замок; в тестах подменяются. Числа — `docs/30-configuration-map.md`. */
export interface PassCloseLimits {
  /** игроков в одной пачке */
  batch: number;
  /** игроков внутри пачки, которым выдают разом: пул соединений общий с игроками */
  concurrency: number;
  /** сколько раз пачка пробуется за проход, прежде чем остаться до следующего */
  attempts: number;
  /** пауза перед повтором пачки, растёт с номером попытки */
  retryDelayMs: number;
  lockTtlMs: number;
  /** как часто продлевать замок: не чаще, чтобы не ходить в Redis за каждого игрока */
  lockRenewEveryMs: number;
  /** сколько прошедших месяцев проверять: пропущенные дальше окна закрываются руками */
  lookbackMonths: number;
  /**
   * Сколько ждать после границы месяца: запрос игрока, начатый в последнюю секунду, ещё
   * прибавляет очки месяцу, и закрытие, ушедшее вперёд него, оставило бы их без ступени.
   */
  graceMs: number;
}

export const PASS_CLOSE_LIMITS: PassCloseLimits = { batch: 500, concurrency: 4, attempts: 3, retryDelayMs: 2_000, lockTtlMs: 5 * 60_000, lockRenewEveryMs: 60_000, lookbackMonths: 3, graceMs: 10_000 };
export const PASS_CLOSE_OPTIONS = Symbol("PASS_CLOSE_OPTIONS");
export const PASS_CLOSE_LOCK_KEY = "battle-pass:close:lock";

/** Итог закрытия месяца: сколько игроков получили награды и сколько наград выдано этим проходом. */
export interface PassClosed {
  monthKey: string;
  accounts: number;
  rewards: number;
}

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;
const FIRST_ACCOUNT = "00000000-0000-0000-0000-000000000000";
const REDIS_TIMEOUT_MS = 2_000;
const DB_TIMEOUT_MS = 10_000;
const WALLET_TIMEOUT_MS = 8_000;
/** Игрок получает не больше: 30 ступеней двух лент. */
const MAX_REWARDS = PASS_TIERS * 2;

/** Замок потерян: токен в Redis уже чужой или ключа нет. Проход прекращается, выданное остаётся. */
class PassCloseLockLost extends Error {}

interface HeldLock {
  token: string;
  renewedAt: number;
}

@Injectable()
export class PassCloseService {
  private readonly logger = new Logger("battle-pass");

  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    @Inject(PASS_CLOSE_REPOSITORY) private readonly closing: PassCloseRepository,
    @Inject(BATTLE_PASS_REPOSITORY) private readonly pass: BattlePassRepository,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    @Inject(VIP_REPOSITORY) private readonly vip: Pick<VipRepository, "withVipDuring">,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Optional() @Inject(PASS_CLOSE_OPTIONS) private readonly limits: PassCloseLimits = PASS_CLOSE_LIMITS,
  ) {}

  /**
   * Закрыть прошедшие месяцы, которые ещё не закрыты. Возвращает закрытые этим
   * вызовом; пусто — закрывать нечего или месяц остался открытым из-за сбоя
   * (строка `pass_close_incomplete`); `null` — закрытие идёт у другой реплики или
   * замок потерян посреди прохода.
   */
  async closeDue(now = new Date()): Promise<PassClosed[] | null> {
    const candidates = this.candidates(now);
    // Дешёвая проверка без замка: почти каждую минуту закрывать нечего.
    if ((await this.open(candidates)).length === 0) return [];

    const lock = await this.acquire();
    if (lock === null) return null;
    try {
      const closed: PassClosed[] = [];
      // Под замком метки читаются заново: пока ждали, другая реплика могла закрыть месяц.
      for (const month of await this.open(candidates)) {
        const outcome = await this.closeMonth(month, now, lock);
        if (outcome !== null) closed.push(outcome);
      }
      return closed;
    } catch (error: unknown) {
      if (!(error instanceof PassCloseLockLost)) throw error;
      this.warn("pass_close_lock_lost", {});
      return null;
    } finally {
      await this.release(lock);
    }
  }

  /** Месяцы окна догона до текущего, старые первыми; только те, чья граница уже позади с запасом. */
  private candidates(now: Date): string[] {
    const [year = 0, month = 1] = monthKeyOf(now).split("-").map(Number);
    return Array.from({ length: this.limits.lookbackMonths }, (_, index) => monthKeyOf(new Date(Date.UTC(year, month - 1 - (this.limits.lookbackMonths - index), 15)))).filter(
      (key) => monthBounds(key).endsAt.getTime() + this.limits.graceMs <= now.getTime(),
    );
  }

  private async open(candidates: readonly string[]): Promise<string[]> {
    const closed = await this.timed(this.closing.closedMonths(candidates));
    return candidates.filter((month) => !closed.has(month));
  }

  /** `null` — месяц остался открытым (сбой игрока) или метку поставила другая реплика. */
  private async closeMonth(month: string, now: Date, lock: HeldLock): Promise<PassClosed | null> {
    const { startsAt, endsAt } = monthBounds(month);
    const pointsPerTier = this.settings.get(SETTINGS.passPointsPerTier);
    const ribbon = await this.ribbon(month);
    const total = { accounts: 0, rewards: 0, failed: 0 };
    let after = FIRST_ACCOUNT;
    for (;;) {
      const page = await this.timed(this.closing.players(month, pointsPerTier, after, this.limits.batch));
      if (page.length === 0) break;
      after = page[page.length - 1]?.accountId ?? after;
      const batch = await this.closeBatch({ month, page, startsAt, endsAt, pointsPerTier, ribbon, now }, lock);
      total.accounts += batch.accounts;
      total.rewards += batch.rewards;
      total.failed += batch.failed;
      if (page.length < this.limits.batch) break;
    }
    if (total.failed > 0) {
      this.warn("pass_close_incomplete", { month, failed: total.failed });
      return null;
    }
    if (!(await this.timed(this.closing.markClosed(month, now)))) return null;
    this.log("pass_closed", { month, accounts: total.accounts, rewards: total.rewards });
    return { monthKey: month, accounts: total.accounts, rewards: total.rewards };
  }

  /** Пачка: выдача с повторами для упавших, затем уведомления тем, кому выдано всё. */
  private async closeBatch(input: BatchInput, lock: HeldLock): Promise<{ accounts: number; rewards: number; failed: number }> {
    const winners = new Set<string>();
    let rewards = 0;
    let pending = input.page;
    for (let attempt = 1; attempt <= this.limits.attempts && pending.length > 0; attempt++) {
      if (attempt > 1 && this.limits.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.limits.retryDelayMs * (attempt - 1)));
      const result = await this.payPlayers(pending, input, lock);
      for (const [accountId, wins] of result.wins) {
        winners.add(accountId);
        rewards += wins;
      }
      pending = result.failed;
    }
    const failed = new Set(pending.map((player) => player.accountId));
    await this.notify(input.month, input.endsAt, input.page.filter((player) => !failed.has(player.accountId)), input.now);
    return { accounts: winners.size, rewards, failed: failed.size };
  }

  /** Один заход по игрокам пачки: выданное в журнале пропускается, упавшие возвращаются для повтора. */
  private async payPlayers(players: readonly PassPlayer[], input: BatchInput, lock: HeldLock): Promise<{ wins: Map<string, number>; failed: PassPlayer[] }> {
    const ids = players.map((player) => player.accountId);
    // Журнал и VIP читаются заново на каждый заход: предыдущий мог выдать часть.
    const [claimed, withVip] = await Promise.all([this.timed(this.closing.claimed(input.month, ids)), this.timed(this.vipHolders(ids, input.startsAt, input.endsAt))]);
    const wins = new Map<string, number>();
    const failed: PassPlayer[] = [];
    for (let from = 0; from < players.length; from += this.limits.concurrency) {
      await this.keepLock(lock);
      await Promise.all(
        players.slice(from, from + this.limits.concurrency).map(async (player) => {
          const tally = { wins: 0 };
          try {
            const lanes: PassLane[] = withVip.has(player.accountId) ? ["free", "vip"] : ["free"];
            await this.pay(player, lanes, claimed.get(player.accountId) ?? new Set<string>(), input, tally);
          } catch (error: unknown) {
            failed.push(player);
            this.warn("pass_close_account_failed", { month: input.month, accountId: player.accountId, reason: error instanceof Error ? error.message : "unknown" });
          }
          // Выданное до сбоя тоже в счёт: игрок мог получить часть наград, прежде чем упал.
          if (tally.wins > 0) wins.set(player.accountId, tally.wins);
        }),
      );
    }
    return { wins, failed };
  }

  /**
   * Все ещё не забранные награды игрока по лентам; первый сбой прерывает игрока, остаток
   * довыдаст повтор. Сколько наград выдали мы, считается в `tally` — он остаётся и при сбое.
   */
  private async pay(player: PassPlayer, lanes: readonly PassLane[], claimed: ReadonlySet<string>, input: BatchInput, tally: { wins: number }): Promise<void> {
    const reached = tierOf(player.points, input.pointsPerTier);
    for (const lane of lanes) {
      for (let tier = 1; tier <= reached; tier++) {
        const reward = input.ribbon[tier - 1]?.[lane];
        if (reward === undefined || claimed.has(claimKey(tier, lane))) continue;
        if (await this.grant(player.accountId, input.month, tier, lane, reward, input.now)) tally.wins++;
      }
    }
  }

  /**
   * Один путь с ручным забором (`battle-pass.service.ts`): кошелёк по ключу, затем журнал
   * и подарок-буст одной транзакцией. `false` — журнал успел занять другой (ручной забор в
   * последнюю секунду месяца или соседняя реплика): награда выдана им, не нами.
   */
  private async grant(accountId: string, month: string, tier: number, lane: PassLane, reward: PassReward, at: Date): Promise<boolean> {
    const credited: PassCredited = {};
    for (const line of rewardLines(reward)) {
      const result = await withTimeout(
        this.wallet.grant({ accountId, resource: line.resource, amount: line.amount, reason: "pass_reward", source: `pass:${month}:${String(tier)}:${lane}`, idempotencyKey: passGrantKey(month, tier, lane, accountId, line.resource), at }),
        WALLET_TIMEOUT_MS,
        "награда пасса при закрытии",
      );
      const rarity = ITEM_RARITIES.find((candidate) => `shard_${candidate}` === line.resource);
      if (line.resource === "coins") credited.coins = result.credited;
      else if (line.resource === "gems") credited.gems = result.credited;
      else if (rarity !== undefined) credited.shards = { ...credited.shards, [rarity]: result.credited };
    }
    const boost = reward.boost ?? null;
    if (boost !== null) credited.boost = boost;
    if (!(await this.timed(this.pass.claim({ accountId, monthKey: month, tier, lane, boost, at })))) return false;
    this.log("pass_reward_claimed", { accountId, month, tier, lane, source: "close", ...flat(credited) });
    return true;
  }

  /**
   * Уведомление «Пасс закрыт» — одно на игрока и месяц (ключ события), число — сколько наград
   * зачислило закрытие. Число берётся из журнала, а не из счётчика этого прохода, поэтому повтор
   * после падения шлёт то же самое. Сбой ленты не мешает выдаче: после попыток он только в логе.
   */
  private async notify(month: string, endsAt: Date, players: readonly PassPlayer[], at: Date): Promise<void> {
    const counts = await this.timed(this.closing.closeRewards(month, players.map((player) => player.accountId), endsAt));
    for (const [accountId, count] of counts) {
      if (count <= 0) continue;
      for (let attempt = 1; attempt <= this.limits.attempts; attempt++) {
        try {
          await this.notifications.deliver({ accountId, kind: "pass_closed", payload: { month, rewards: Math.min(count, MAX_REWARDS) }, dedupeKey: `pass_closed:${month}`, at });
          break;
        } catch (error: unknown) {
          if (attempt === this.limits.attempts) this.warn("pass_close_notify_failed", { month, accountId, reason: error instanceof Error ? error.message : "unknown" });
          else if (this.limits.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.limits.retryDelayMs * attempt));
        }
      }
    }
  }

  private async vipHolders(accountIds: readonly string[], from: Date, to: Date): Promise<Set<string>> {
    if (this.vip.withVipDuring === undefined) throw new Error("хранилище VIP не умеет искать VIP за месяц");
    return await this.vip.withVipDuring(accountIds, from, to);
  }

  /** Лента месяца — как у ручного забора: из базы, если проходит схему, иначе по умолчанию. */
  private async ribbon(month: string): Promise<readonly PassTierDef[]> {
    const stored = await this.timed(this.pass.season(month));
    if (stored === null) return DEFAULT_RIBBON;
    const parsed = passRibbonSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    this.logger.error(JSON.stringify({ module: "battle-pass", event: "pass_season_invalid", month, problem: parsed.error.issues[0]?.message ?? "лента не проходит схему" }));
    return DEFAULT_RIBBON;
  }

  private async acquire(): Promise<HeldLock | null> {
    const token = randomUUID();
    const taken = await withTimeout(this.redis.set(PASS_CLOSE_LOCK_KEY, token, "PX", this.limits.lockTtlMs, "NX"), REDIS_TIMEOUT_MS, "батл-пасс: замок закрытия");
    return taken === null ? null : { token, renewedAt: Date.now() };
  }

  /** Продлить замок, если пора. Redis недоступен — идём дальше: двойной проход безопасен, а остановка стоила бы месяца. */
  private async keepLock(lock: HeldLock): Promise<void> {
    if (Date.now() - lock.renewedAt < this.limits.lockRenewEveryMs) return;
    let kept: unknown;
    try {
      kept = await withTimeout(this.redis.eval(RENEW_SCRIPT, 1, PASS_CLOSE_LOCK_KEY, lock.token, String(this.limits.lockTtlMs)) as Promise<unknown>, REDIS_TIMEOUT_MS, "батл-пасс: продление замка");
    } catch (error: unknown) {
      this.warn("pass_close_lock_renew_failed", { reason: error instanceof Error ? error.message : "unknown" });
      return;
    }
    if (Number(kept) !== 1) throw new PassCloseLockLost();
    lock.renewedAt = Date.now();
  }

  private async release(lock: HeldLock): Promise<void> {
    try {
      await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, PASS_CLOSE_LOCK_KEY, lock.token) as Promise<unknown>, REDIS_TIMEOUT_MS, "батл-пасс: снятие замка");
    } catch (error: unknown) {
      // Замок живёт не дольше TTL: следующий проход увидит его свободным.
      this.warn("pass_close_lock_not_released", { reason: error instanceof Error ? error.message : "unknown" });
    }
  }

  private async timed<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "батл-пасс: закрытие месяца");
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "battle-pass", event, ...fields }));
  }

  private warn(event: string, fields: Record<string, unknown>): void {
    this.logger.warn(JSON.stringify({ module: "battle-pass", event, ...fields }));
  }
}

interface BatchInput {
  month: string;
  page: readonly PassPlayer[];
  startsAt: Date;
  endsAt: Date;
  pointsPerTier: number;
  ribbon: readonly PassTierDef[];
  now: Date;
}

/** Плоские поля для строки лога: без вложенных объектов, как у ручного забора. */
function flat(credited: PassCredited): Record<string, number | string | undefined> {
  return {
    coins: credited.coins,
    gems: credited.gems,
    shards: Object.values(credited.shards ?? {}).reduce((sum, amount) => sum + (amount ?? 0), 0) || undefined,
    boost: credited.boost?.id,
  };
}
