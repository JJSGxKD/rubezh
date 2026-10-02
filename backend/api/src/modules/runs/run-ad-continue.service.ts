import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { AdsService } from "../ads/ads.service.js";
import { AdContinueDailyCapError, AdContinueUnavailableError, ContinueRunUnverifiedError, ContinueTakenError } from "./run-continue-errors.js";
import { RunContinues, type ContinueCheck, type ContinueLedger } from "./run-continues.js";
import { CONTINUES_PER_RUN } from "./run-rules.js";
import { RUN_AD_CONTINUES_REPOSITORY, type RunAdContinuesRepository } from "./run-ad-continues.repository.js";
import { RUNS_REPOSITORY, type RunsRepository, type StoredRun } from "./runs.repository.js";

/**
 * Второй шанс за рекламу (docs/35-stage4-plan.md WP11, Р4): забег — хозяин
 * места `second_chance`. Модуль рекламы ручается за показ, здесь решается,
 * можно ли этим показом продолжить забег, и продолжение записывается рядом
 * с покупками — итог забега сверяется с обеими книгами (`run-continues.ts`).
 *
 * У VIP ролика нет: выдача показа отдаёт пропуск, и он забирается здесь так
 * же, как досмотренная сессия (§3.6).
 */

/**
 * **Рабочее число (Р4, Р31):** продолжений за рекламу в игровые сутки.
 * Дальше — только звёзды: иначе продолжение за ролик обесценило бы
 * продолжение за звёзды для тех, кто играет весь день.
 */
export const AD_CONTINUES_PER_DAY = 5;

/** Какие по счёту продолжения забега берутся за рекламу (Р4): только первое, дальше — звёзды. */
export const AD_CONTINUE_NUMBERS: readonly number[] = [1];

const DB_TIMEOUT_MS = 3_000;

export interface ContinuePlayer {
  accountId: string;
  platform: PlatformId;
}

/**
 * Почему за рекламу продолжить нельзя: `unverified` — сервер не видел
 * старта; `finished` — забег уже записан; `used_up` — продолжения забега
 * кончились; `stars_only` — это продолжение — только за звёзды; `daily_cap`
 * — рекламные на сегодня кончились; `no_ads` — для площадки нет рекламы и
 * нет VIP.
 */
export type AdContinueRefusal = "unverified" | "finished" | "used_up" | "stars_only" | "daily_cap" | "no_ads";

export type AdContinueView =
  /** `pass` — продолжение без ролика (VIP); `null` — нужен показ */
  | { status: "available"; continueNo: number; pass: string | null }
  | { status: "unavailable"; reason: AdContinueRefusal };

@Injectable()
export class RunAdContinueService implements ContinueLedger, OnModuleInit {
  private readonly logger = new Logger("runs");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RUNS_REPOSITORY) private readonly runs: Pick<RunsRepository, "find">,
    @Inject(RUN_AD_CONTINUES_REPOSITORY) private readonly repository: RunAdContinuesRepository,
    private readonly ads: AdsService,
    private readonly continues: RunContinues,
  ) {}

  onModuleInit(): void {
    // Без авторизации нет ни базы, ни приёма забегов — сверять нечего.
    if (this.config.auth.enabled) this.continues.provide(this);
  }

  /** Можно ли продолжить забег за рекламу — для экрана смерти: держать ли забег в ожидании решения. */
  async view(player: ContinuePlayer, runId: string, at = new Date()): Promise<AdContinueView> {
    const run = await this.db(this.runs.find(runId));
    const refusal = runRefusal(run, player.accountId);
    if (refusal !== null) return { status: "unavailable", reason: refusal };
    const continueNo = (await this.continues.taken(runId)).size + 1;
    const numberRefusal = numberRefusalOf(continueNo);
    if (numberRefusal !== null) return { status: "unavailable", reason: numberRefusal };
    const [today, ready] = await Promise.all([this.db(this.repository.todayCount(player.accountId, at)), this.ads.readiness(player, "second_chance", at)]);
    if (today >= AD_CONTINUES_PER_DAY) return { status: "unavailable", reason: "daily_cap" };
    if (!ready.available) return { status: "unavailable", reason: "no_ads" };
    return { status: "available", continueNo, pass: ready.pass };
  }

  /**
   * Продолжить забег досмотренной сессией. Порядок — проверка, забор
   * сессии, запись: досмотренная сессия не тратится на забег, который
   * продолжить нельзя. Повтор той же сессией после обрыва отдаёт то же
   * продолжение, а не отказ «продолжения кончились».
   */
  async claim(player: ContinuePlayer, runId: string, sessionId: string, at = new Date()): Promise<{ continueNo: number }> {
    const spent = await this.db(this.repository.bySession(sessionId));
    if (spent !== null) {
      if (spent.runId === runId) return { continueNo: spent.continueNo };
      throw new ContinueTakenError();
    }

    const run = await this.db(this.runs.find(runId));
    const refusal = runRefusal(run, player.accountId);
    if (refusal === "unverified") throw new ContinueRunUnverifiedError();
    if (refusal === "finished") throw new AdContinueUnavailableError("Забег уже закончен");
    const continueNo = (await this.continues.taken(runId)).size + 1;
    if (numberRefusalOf(continueNo) !== null) throw new AdContinueUnavailableError("Это продолжение — не за рекламу");
    // Потолок не атомарен: два параллельных продолжения могут пройти оба. Цена — одно лишнее за сутки.
    if ((await this.db(this.repository.todayCount(player.accountId, at))) >= AD_CONTINUES_PER_DAY) throw new AdContinueDailyCapError();

    const { session } = await this.ads.claim(player.accountId, sessionId, "second_chance", at);
    const outcome = await this.db(this.repository.grant({ runId, continueNo, accountId: player.accountId, sessionId, networkKey: session.networkKey, grantedAt: at }));
    if (outcome === "taken") throw new ContinueTakenError();
    if (outcome === "granted") {
      this.logger.log(JSON.stringify({ module: "runs", event: "run_ad_continued", accountId: player.accountId, runId, continueNo, network: session.networkKey }));
    }
    return { continueNo };
  }

  /** Книга рекламных продолжений для сверки итога: каждое выдано по забранной сессии показа. */
  async check(runId: string): Promise<ContinueCheck> {
    return { paid: (await this.granted(runId)).length, underpaid: false };
  }

  async granted(runId: string): Promise<number[]> {
    return await this.db(this.repository.numbers(runId));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "второй шанс за рекламу");
  }
}

/**
 * Чужой и незнакомый забег отвечают одинаково: иначе по ответу перебирали бы
 * чужие идентификаторы. Время старта по часам сервера, в отличие от
 * покупки, не нужно: цена рекламы от минут забега не зависит.
 */
function runRefusal(run: StoredRun | null, accountId: string): "unverified" | "finished" | null {
  if (run === null || run.accountId !== accountId) return "unverified";
  return run.status === "finished" ? "finished" : null;
}

function numberRefusalOf(continueNo: number): "used_up" | "stars_only" | null {
  if (continueNo > CONTINUES_PER_RUN) return "used_up";
  return AD_CONTINUE_NUMBERS.includes(continueNo) ? null : "stars_only";
}
