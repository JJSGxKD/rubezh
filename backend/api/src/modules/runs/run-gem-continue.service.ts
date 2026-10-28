import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { continueGems } from "../payments/continue-price.js";
import { InsufficientFundsError } from "../wallet/wallet-errors.js";
import { InsufficientBalance } from "../wallet/wallet-ledger.js";
import { WalletService } from "../wallet/wallet.service.js";
import { ContinueElapsedExceedsClockError, ContinueRunUnverifiedError, ContinueTakenError, ContinueUnavailableError } from "./run-continue-errors.js";
import { RunContinues, type ContinueCheck, type ContinueLedger } from "./run-continues.js";
import { RUN_GEM_CONTINUES_REPOSITORY, type GemContinueRow, type RunGemContinuesRepository } from "./run-gem-continues.repository.js";
import { CONTINUES_PER_RUN } from "./run-rules.js";
import { RUNS_REPOSITORY, type RunsRepository } from "./runs.repository.js";

/**
 * Второй шанс за самоцветы (docs/35-stage4-plan.md Р162, tasks/T-0324):
 * цена — цена в звёздах от начатых минут забега по курсу товара
 * (`payments/continue-price.ts`), видна игроку до нажатия. Самоцветы есть на
 * любой площадке, поэтому продолжение доступно везде, в отличие от звёзд.
 *
 * Покупка проверяет то же, что покупка за звёзды (`payments.service.ts`):
 * забег свой, незаконченный, старт виден серверу, заявленная секунда не
 * больше часов сервера с допуском. Списание и запись продолжения — одна
 * транзакция в репозитории; повтор запроса с тем же номером отдаёт прежний
 * ответ и ничего не списывает. Книга продолжений регистрируется в
 * `RunContinues`, как рекламная и звёздная: итог забега сверяется со всеми.
 */

const DB_TIMEOUT_MS = 3_000;
/** Покупка — транзакция с блокировкой аккаунта и списанием; потолок ожидания чуть ниже потолка самой транзакции. */
const BUY_TIMEOUT_MS = 10_000;

/** Почему за самоцветы продолжить нельзя: `unverified` — сервер не видел старта; `finished` — забег записан; `used_up` — продолжения кончились. */
export type GemContinueRefusal = "unverified" | "finished" | "used_up";

export type GemContinueView =
  /** `priceGems` — цена при заявленной секунде; `balance` — самоцветов у игрока: не хватает — решает кнопка */
  | { status: "available"; continueNo: number; priceGems: number; balance: number }
  | { status: "unavailable"; reason: GemContinueRefusal };

export interface GemContinueRequest {
  continueNo: number;
  elapsedSec: number;
}

export interface GemContinueReceipt {
  continueNo: number;
  priceGems: number;
  /** самоцветов осталось */
  balance: number;
}

@Injectable()
export class RunGemContinueService implements ContinueLedger, OnModuleInit {
  private readonly logger = new Logger("runs");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RUNS_REPOSITORY) private readonly runs: Pick<RunsRepository, "find">,
    @Inject(RUN_GEM_CONTINUES_REPOSITORY) private readonly repository: RunGemContinuesRepository,
    @Inject(WalletService) private readonly wallet: Pick<WalletService, "balances">,
    private readonly continues: RunContinues,
  ) {}

  onModuleInit(): void {
    // Без авторизации нет ни базы, ни приёма забегов — сверять нечего.
    if (this.config.auth.enabled) this.continues.provide(this);
  }

  /**
   * Можно ли продолжить забег за самоцветы и сколько это стоит — для экрана
   * смерти. Не хватает самоцветов — всё равно «доступно»: кнопка покажет цену и
   * нехватку, решать игроку. Секунда заявлена клиентом и здесь только считает
   * цену на экране: покупка сверяет её с часами сервера.
   */
  async view(accountId: string, runId: string, elapsedSec: number): Promise<GemContinueView> {
    const refusal = await this.runRefusal(accountId, runId);
    if (refusal !== null) return { status: "unavailable", reason: refusal };
    const continueNo = (await this.db(this.continues.taken(runId))).size + 1;
    if (continueNo > CONTINUES_PER_RUN) return { status: "unavailable", reason: "used_up" };
    return { status: "available", continueNo, priceGems: continueGems(elapsedSec, this.config.payments), balance: await this.gems(accountId) };
  }

  /**
   * Купить продолжение. Повтор того же номера — раньше любых проверок: ответ
   * потерялся, забег успел закончиться, а игрок заплатил и должен получить
   * прежний ответ, а не отказ «забег закончен».
   */
  async buy(accountId: string, runId: string, request: GemContinueRequest, at = new Date()): Promise<GemContinueReceipt> {
    const { continueNo, elapsedSec } = request;
    const bought = await this.db(this.repository.find(runId, continueNo));
    if (bought !== null && bought.accountId === accountId) return await this.receipt(bought);

    if (continueNo > CONTINUES_PER_RUN) throw new ContinueUnavailableError("Продолжения этого забега закончились");
    const run = await this.db(this.runs.find(runId));
    // Чужой и незнакомый забег отвечают одинаково: иначе по ответу перебирали бы чужие идентификаторы.
    if (run === null || run.accountId !== accountId || run.startedAt === null) throw new ContinueRunUnverifiedError();
    if (run.status === "finished") throw new ContinueUnavailableError("Забег уже закончен");

    const wallClockSec = (at.getTime() - run.startedAt.getTime()) / 1000;
    if (elapsedSec > wallClockSec + this.config.runs.wallClockToleranceSec) {
      this.logger.warn(JSON.stringify({ module: "runs", event: "gem_continue_elapsed_exceeds_clock", accountId, runId, elapsedSec, wallClockSec }));
      throw new ContinueElapsedExceedsClockError();
    }

    const taken = await this.db(this.continues.taken(runId));
    if (taken.has(continueNo)) throw new ContinueTakenError();
    // Второе продолжение — только после взятого первого: иначе номер ничего не значил бы.
    if (continueNo > 1 && taken.size < continueNo - 1) throw new ValidationError("Некорректное продолжение");

    const priceGems = continueGems(elapsedSec, this.config.payments);
    let outcome;
    try {
      outcome = await withTimeout(this.repository.buy({ runId, continueNo, accountId, elapsedSec, priceGems, at }), BUY_TIMEOUT_MS, "второй шанс за самоцветы");
    } catch (error: unknown) {
      if (!(error instanceof InsufficientBalance)) throw error;
      throw new InsufficientFundsError(error.resource, error.needed, await this.gems(accountId));
    }
    if (outcome.status === "taken") throw new ContinueTakenError();
    if (outcome.status === "bought") {
      this.logger.log(JSON.stringify({ module: "runs", event: "run_gem_continued", accountId, runId, continueNo, priceGems: outcome.row.priceGems }));
    }
    return await this.receipt(outcome.row);
  }

  /**
   * Книга продолжений за самоцветы для сверки итога: оплачено столько, сколько
   * строк; недоплата — когда секунда продолжения в итоге даёт цену выше той, по
   * которой посчитана уплаченная (Р5.2, как у звёзд). Сравниваются цены, а не
   * секунды: разница внутри одной минуты или выше потолка цены не стоила
   * игроку ни самоцвета.
   */
  async check(runId: string, continues: readonly number[]): Promise<ContinueCheck> {
    const bought = await this.db(this.repository.forRun(runId));
    const paidAt = new Map(bought.map((row) => [row.continueNo, row.elapsedSec]));
    const underpaid = continues.some((sec, index) => {
      const claimed = paidAt.get(index + 1);
      return claimed !== undefined && continueGems(sec, this.config.payments) > continueGems(claimed, this.config.payments);
    });
    return { paid: bought.length, underpaid };
  }

  async granted(runId: string): Promise<number[]> {
    return (await this.db(this.repository.forRun(runId))).map((row) => row.continueNo);
  }

  /** Чужой и незнакомый забег, и забег без времени старта по часам сервера, — одинаково `unverified`. */
  private async runRefusal(accountId: string, runId: string): Promise<GemContinueRefusal | null> {
    const run = await this.db(this.runs.find(runId));
    if (run === null || run.accountId !== accountId || run.startedAt === null) return "unverified";
    return run.status === "finished" ? "finished" : null;
  }

  private async receipt(row: GemContinueRow): Promise<GemContinueReceipt> {
    return { continueNo: row.continueNo, priceGems: row.priceGems, balance: await this.gems(row.accountId) };
  }

  private async gems(accountId: string): Promise<number> {
    return (await this.db(this.wallet.balances(accountId))).gems;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "второй шанс за самоцветы");
  }
}
