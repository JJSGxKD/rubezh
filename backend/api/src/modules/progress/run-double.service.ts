import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { AdsService } from "../ads/ads.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { RunAlreadyDoubledError, RunDoubleUnavailableError } from "./run-double-errors.js";
import { RUN_DOUBLE_REPOSITORY, type DoubleCandidate, type RunDoubleRepository } from "./run-double.repository.js";

/**
 * Удвоение награды за забег за рекламу (docs/35-stage4-plan.md WP4, WP12):
 * забег — хозяин места `run_double`. Удваиваются монеты, которые легли в
 * кошелёк, — не опыт: темп уровней не должен зависеть от роликов. Удвоить
 * можно один раз и в течение часа после забега — это кнопка экрана итогов,
 * а не запас на потом; кулдаун между удвоениями держит модуль рекламы.
 *
 * Порядок — проверка, забор сессии, привязка сессии к забегу, начисление
 * ключом забега, отметка. Проверка до забора: досмотренная сессия не
 * тратится на забег, который удвоить нельзя. Повтор той же сессией после
 * обрыва дожимает начисление тем же ключом.
 */

const DB_TIMEOUT_MS = 3_000;
const MINUTE_MS = 60_000;

/** Сколько после забега держится кнопка «удвоить за рекламу». */
export const RUN_DOUBLE_WINDOW_MIN = 60;

export interface RunDoublePlayer {
  accountId: string;
  platform: PlatformId;
}

export type RunDoubleView =
  | {
      status: "available";
      /** сколько монет добавит удвоение */
      coins: number;
      /** до какого времени держится кнопка */
      until: string;
      /** есть ли реклама для площадки, когда пройдёт кулдаун места и нужен ли ролик (`pass` — VIP без него) */
      ad: { available: boolean; readyAt: string | null; pass: string | null };
    }
  | { status: "doubled"; coins: number }
  | { status: "unavailable"; reason: RunDoubleUnavailableError["reason"] };

export interface RunDoubleResult {
  /** сколько легло: меньше удвоения, если упёрлось в суточный потолок рекламы */
  credited: number;
  coins: number;
}

@Injectable()
export class RunDoubleService {
  private readonly logger = new Logger("progress");

  constructor(
    @Inject(RUN_DOUBLE_REPOSITORY) private readonly repository: RunDoubleRepository,
    private readonly ads: AdsService,
    private readonly wallet: WalletService,
  ) {}

  async view(player: RunDoublePlayer, runId: string, at = new Date()): Promise<RunDoubleView> {
    const candidate = await this.db(this.repository.candidate(runId, player.accountId));
    if (candidate !== null && candidate.doubledAt !== null) return { status: "doubled", coins: candidate.coinsCredited ?? 0 };
    const problem = unavailable(candidate, null, at);
    if (problem !== null || candidate === null) return { status: "unavailable", reason: problem ?? "pending" };
    const ready = await this.ads.readiness(player, "run_double", at);
    return {
      status: "available",
      coins: candidate.coinsCredited ?? 0,
      until: new Date(candidate.createdAt.getTime() + RUN_DOUBLE_WINDOW_MIN * MINUTE_MS).toISOString(),
      ad: { available: ready.available, readyAt: ready.readyAt?.toISOString() ?? null, pass: ready.pass },
    };
  }

  async double(player: RunDoublePlayer, runId: string, sessionId: string, at = new Date()): Promise<RunDoubleResult> {
    const { accountId } = player;
    const candidate = await this.db(this.repository.candidate(runId, accountId));
    // Удвоенный другой сессией — «уже удвоено», а не «окно прошло»: так честнее.
    if (candidate !== null && candidate.doubleSessionId !== null && candidate.doubleSessionId !== sessionId) throw new RunAlreadyDoubledError();
    const problem = unavailable(candidate, sessionId, at);
    if (problem !== null || candidate === null) throw new RunDoubleUnavailableError(problem ?? "pending");

    await this.ads.claim(accountId, sessionId, "run_double", at);
    if (!(await this.db(this.repository.attach(runId, accountId, sessionId)))) throw new RunAlreadyDoubledError();

    const coins = candidate.coinsCredited ?? 0;
    const granted = await this.wallet.grant({
      accountId,
      resource: "coins",
      amount: coins,
      reason: "ad_reward",
      source: `run:${runId}`,
      idempotencyKey: `run_double:${runId}`,
      at,
    });
    await this.db(this.repository.markDoubled(runId, at));
    this.logger.log(JSON.stringify({ module: "progress", event: "run_doubled", accountId, runId, coins, credited: granted.credited }));
    return { credited: granted.credited, coins };
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "удвоение");
  }
}

/**
 * Почему удвоить нельзя; `null` — можно. Окно не мешает дожать удвоение той
 * же сессией, которая уже привязана к забегу: реклама досмотрена вовремя,
 * оборвалось начисление.
 */
export function unavailable(candidate: DoubleCandidate | null, sessionId: string | null, at: Date): RunDoubleUnavailableError["reason"] | null {
  if (candidate === null) return "pending";
  if (candidate.skipped !== null) return "no_reward";
  if (candidate.coinsCredited === null) return "pending";
  if (candidate.coinsCredited <= 0) return "nothing";
  const resuming = sessionId !== null && candidate.doubleSessionId === sessionId;
  if (!resuming && at.getTime() - candidate.createdAt.getTime() > RUN_DOUBLE_WINDOW_MIN * MINUTE_MS) return "expired";
  return null;
}
