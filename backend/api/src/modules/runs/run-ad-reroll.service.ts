import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { AdsService } from "../ads/ads.service.js";
import { ContinueRunUnverifiedError } from "./run-continue-errors.js";
import { RUN_AD_REROLLS_REPOSITORY, type RunAdRerollsRepository } from "./run-ad-rerolls.repository.js";
import { AdRerollTakenError, AdRerollUnavailableError } from "./run-reroll-errors.js";
import { RUNS_REPOSITORY, type RunsRepository, type StoredRun } from "./runs.repository.js";

/**
 * Переброс карточек за рекламу (docs/35-stage4-plan.md Р133, tasks/T-0199):
 * забег — хозяин места `card_reroll`. Модуль рекламы ручается за показ, здесь
 * решается, можно ли этим показом перебросить, и переброс записывается рядом с
 * забегом — итог сверяется с книгой (`paid`). Один раз за забег: движок держит
 * то же правило, но клиенту не верят.
 *
 * Сервер забеги заново не проигрывает (docs/34-stage3-plan.md Р6), поэтому
 * переброс засчитывается так же, как продолжение: клиент перед перебросом
 * забирает досмотренную сессию, а при приёме итога заявленное число сверяется
 * с таблицей. Оборвалась связь после записи показа и до переброса в движке —
 * переброс пропадает, повтор скажет «уже использован»: награда копеечная,
 * защита от повторов важнее.
 *
 * У VIP ролика нет: выдача показа отдаёт пропуск, и он забирается здесь так
 * же, как досмотренная сессия (§3.6).
 */

/** Сколько рекламных перебросов в забеге: правило движка (`MAX_AD_REROLLS`), продублированное — движок не подключается к серверу. */
const AD_REROLLS_PER_RUN = 1;

const DB_TIMEOUT_MS = 3_000;

export interface AdRerollPlayer {
  accountId: string;
  platform: PlatformId;
}

/**
 * Почему перебросить за рекламу нельзя: `unverified` — сервер не видел
 * старта; `finished` — забег уже записан; `used_up` — рекламный переброс уже
 * взят; `no_ads` — для площадки нет рекламы и нет VIP, либо награды закрыты.
 */
export type AdRerollRefusal = "unverified" | "finished" | "used_up" | "no_ads";

export type AdRerollView =
  /** `pass` — переброс без ролика (VIP); `null` — нужен показ */
  | { status: "available"; pass: string | null }
  | { status: "unavailable"; reason: AdRerollRefusal };

@Injectable()
export class RunAdRerollService {
  private readonly logger = new Logger("runs");

  constructor(
    @Inject(RUNS_REPOSITORY) private readonly runs: Pick<RunsRepository, "find">,
    @Inject(RUN_AD_REROLLS_REPOSITORY) private readonly repository: RunAdRerollsRepository,
    private readonly ads: AdsService,
  ) {}

  /** Можно ли перебросить за рекламу — для окна выбора улучшения: показывать ли кнопку. */
  async view(player: AdRerollPlayer, runId: string, at = new Date()): Promise<AdRerollView> {
    const run = await this.db(this.runs.find(runId));
    const refusal = runRefusal(run, player.accountId);
    if (refusal !== null) return { status: "unavailable", reason: refusal };
    if ((await this.db(this.repository.count(runId))) >= AD_REROLLS_PER_RUN) return { status: "unavailable", reason: "used_up" };
    const ready = await this.ads.readiness(player, "card_reroll", at);
    if (!ready.available) return { status: "unavailable", reason: "no_ads" };
    return { status: "available", pass: ready.pass };
  }

  /**
   * Перебросить досмотренной сессией. Порядок — проверка, забор сессии, запись:
   * досмотренная сессия не тратится на забег, где переброс уже взят или которого
   * нет. Повтор той же сессией после обрыва отдаёт тот же ответ, а не отказ.
   */
  async claim(player: AdRerollPlayer, runId: string, sessionId: string, at = new Date()): Promise<{ granted: true }> {
    const spent = await this.db(this.repository.bySession(sessionId));
    if (spent !== null) {
      if (spent.runId !== runId) throw new AdRerollTakenError();
      // Повтор отвечает только хозяину забега: чужой забег и чужая сессия не различаются от незнакомых.
      if (runRefusal(await this.db(this.runs.find(runId)), player.accountId) === "unverified") throw new ContinueRunUnverifiedError();
      return { granted: true };
    }

    const refusal = runRefusal(await this.db(this.runs.find(runId)), player.accountId);
    if (refusal === "unverified") throw new ContinueRunUnverifiedError();
    if (refusal === "finished") throw new AdRerollUnavailableError("Забег уже закончен");
    // Проверка до забора бережёт досмотренную сессию; окончательно «один на забег» держит запись в базе.
    if ((await this.db(this.repository.count(runId))) >= AD_REROLLS_PER_RUN) throw new AdRerollUnavailableError("Переброс за рекламу в этом забеге уже использован");

    const { session } = await this.ads.claim(player.accountId, sessionId, "card_reroll", at);
    const outcome = await this.db(this.repository.grant({ runId, accountId: player.accountId, sessionId, networkKey: session.networkKey, grantedAt: at }));
    if (outcome === "taken") {
      // Параллельный забор опередил проверку выше: либо забег уже перебросил другой сессией, либо эту сессию потратили на другой забег.
      const now = await this.db(this.repository.bySession(sessionId));
      if (now !== null && now.runId !== runId) throw new AdRerollTakenError();
      throw new AdRerollUnavailableError("Переброс за рекламу в этом забеге уже использован");
    }
    if (outcome === "granted") {
      this.logger.log(JSON.stringify({ module: "runs", event: "run_ad_rerolled", accountId: player.accountId, runId, network: session.networkKey }));
    }
    return { granted: true };
  }

  /**
   * Сколько рекламных перебросов забега подтверждено показом — для сверки итога.
   * Заявленных нет — в базу не ходим: у большинства забегов переброса за рекламу не было.
   */
  async paid(runId: string, claimed: number): Promise<number> {
    if (claimed <= 0) return 0;
    return await this.db(this.repository.count(runId));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "переброс карточек за рекламу");
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
