import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { AdsService } from "../ads/ads.service.js";
import { ContinueRunUnverifiedError } from "./run-continue-errors.js";
import { RUN_AD_CHESTS_REPOSITORY, type RunAdChestsRepository } from "./run-ad-chests.repository.js";
import { AdChestTakenError, AdChestUnavailableError } from "./run-chest-errors.js";
import { RUNS_REPOSITORY, type RunsRepository, type StoredRun } from "./runs.repository.js";

/**
 * Второй сундук клада за рекламу (docs/35-stage4-plan.md Р162, tasks/T-0327):
 * забег — хозяин места `clad_chest`. Модуль рекламы ручается за показ, здесь
 * решается, можно ли этим показом взять второй сундук, и взятие записывается
 * рядом с забегом — итог сверяется с книгой (`paid`). Один раз за забег:
 * движок держит то же правило, но клиенту не верят.
 *
 * Сервер забеги заново не проигрывает (docs/34-stage3-plan.md Р6), поэтому
 * сундук засчитывается так же, как продолжение и рекламный переброс: клиент
 * перед сундуком забирает досмотренную сессию, а при приёме итога заявленное
 * число сверяется с таблицей. Был ли в забеге клад, сервер не знает — это
 * проверит повтор забега; здесь он ручается только за показ. Оборвалась связь
 * после записи показа и до сундука в движке — сундук пропадает, повтор скажет
 * «уже использован»: защита от повторов важнее.
 *
 * У VIP ролика нет: выдача показа отдаёт пропуск, и он забирается здесь так
 * же, как досмотренная сессия (§3.6). Показ входит в общий дневной кап
 * роликов (Р155): забор сверх капа отказывает, не тратя сессию.
 */

/** Сколько вторых сундуков в забеге: правило, продублированное из движка — он не подключается к серверу. */
const AD_CHESTS_PER_RUN = 1;

const DB_TIMEOUT_MS = 3_000;

export interface AdChestPlayer {
  accountId: string;
  platform: PlatformId;
}

/**
 * Почему второй сундук взять нельзя: `unverified` — сервер не видел старта;
 * `finished` — забег уже записан; `used_up` — второй сундук уже взят;
 * `no_ads` — для площадки нет рекламы и нет VIP, либо награды закрыты;
 * `daily_cap` — общий дневной кап роликов исчерпан.
 */
export type AdChestRefusal = "unverified" | "finished" | "used_up" | "no_ads" | "daily_cap";

export type AdChestView =
  /** `pass` — сундук без ролика (VIP); `null` — нужен показ */
  | { status: "available"; pass: string | null }
  | { status: "unavailable"; reason: AdChestRefusal };

@Injectable()
export class RunAdChestService {
  private readonly logger = new Logger("runs");

  constructor(
    @Inject(RUNS_REPOSITORY) private readonly runs: Pick<RunsRepository, "find">,
    @Inject(RUN_AD_CHESTS_REPOSITORY) private readonly repository: RunAdChestsRepository,
    private readonly ads: AdsService,
  ) {}

  /** Можно ли взять второй сундук за рекламу — для окна сундука: показывать ли кнопку. */
  async view(player: AdChestPlayer, runId: string, at = new Date()): Promise<AdChestView> {
    const run = await this.db(this.runs.find(runId));
    const refusal = runRefusal(run, player.accountId);
    if (refusal !== null) return { status: "unavailable", reason: refusal };
    if ((await this.db(this.repository.count(runId))) >= AD_CHESTS_PER_RUN) return { status: "unavailable", reason: "used_up" };
    const ready = await this.ads.readiness(player, "clad_chest", at);
    if (!ready.available) return { status: "unavailable", reason: ready.capped ? "daily_cap" : "no_ads" };
    return { status: "available", pass: ready.pass };
  }

  /**
   * Взять сундук досмотренной сессией. Порядок — проверка, забор сессии,
   * запись: досмотренная сессия не тратится на забег, где сундук уже взят или
   * которого нет. Повтор той же сессией после обрыва отдаёт тот же ответ, а не
   * отказ.
   */
  async claim(player: AdChestPlayer, runId: string, sessionId: string, at = new Date()): Promise<{ granted: true }> {
    const spent = await this.db(this.repository.bySession(sessionId));
    if (spent !== null) {
      if (spent.runId !== runId) throw new AdChestTakenError();
      // Повтор отвечает только хозяину забега: чужой забег и чужая сессия не различаются от незнакомых.
      if (runRefusal(await this.db(this.runs.find(runId)), player.accountId) === "unverified") throw new ContinueRunUnverifiedError();
      return { granted: true };
    }

    const refusal = runRefusal(await this.db(this.runs.find(runId)), player.accountId);
    if (refusal === "unverified") throw new ContinueRunUnverifiedError();
    if (refusal === "finished") throw new AdChestUnavailableError("Забег уже закончен");
    // Проверка до забора бережёт досмотренную сессию; окончательно «один на забег» держит запись в базе.
    if ((await this.db(this.repository.count(runId))) >= AD_CHESTS_PER_RUN) throw new AdChestUnavailableError("Второй сундук в этом забеге уже взят");

    const { session } = await this.ads.claim(player.accountId, sessionId, "clad_chest", at);
    const outcome = await this.db(this.repository.grant({ runId, accountId: player.accountId, sessionId, networkKey: session.networkKey, grantedAt: at }));
    if (outcome === "taken") {
      // Параллельный забор опередил проверку выше: либо забег уже взял сундук другой сессией, либо эту сессию потратили на другой забег.
      const now = await this.db(this.repository.bySession(sessionId));
      if (now !== null && now.runId !== runId) throw new AdChestTakenError();
      throw new AdChestUnavailableError("Второй сундук в этом забеге уже взят");
    }
    if (outcome === "granted") {
      this.logger.log(JSON.stringify({ module: "runs", event: "run_ad_chest_granted", accountId: player.accountId, runId, network: session.networkKey }));
    }
    return { granted: true };
  }

  /**
   * Сколько вторых сундуков забега подтверждено показом — для сверки итога.
   * Заявленных нет — в базу не ходим: у большинства забегов второго сундука не было.
   */
  async paid(runId: string, claimed: number): Promise<number> {
    if (claimed <= 0) return 0;
    return await this.db(this.repository.count(runId));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "второй сундук клада за рекламу");
  }
}

/**
 * Чужой и незнакомый забег отвечают одинаково: иначе по ответу перебирали бы
 * чужие идентификаторы.
 */
function runRefusal(run: StoredRun | null, accountId: string): "unverified" | "finished" | null {
  if (run === null || run.accountId !== accountId) return "unverified";
  return run.status === "finished" ? "finished" : null;
}
