import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { RunContinues, type ContinueCheck, type ContinueLedger } from "../runs/run-continues.js";
import { continuePrice } from "./continue-price.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Сверка итога забега с покупками (docs/34-stage3-plan.md, Р5.2): сколько
 * вторых шансов оплачено и не заплачено ли за меньшее время, чем прошло.
 *
 * Заявить при покупке меньше секунд, чем прошло, можно: сервер знает только
 * верхнюю границу — свои часы. Но итог приезжает с секундой каждого
 * продолжения, и здесь она сравнивается с той, по которой считали цену.
 * Сравниваются цены, а не секунды: разница внутри одной минуты или выше
 * потолка цены не стоила игроку ни звезды.
 */
@Injectable()
export class PaymentsContinueLedger implements ContinueLedger, OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
    private readonly runContinues: RunContinues,
  ) {}

  onModuleInit(): void {
    // Без авторизации базы нет, как нет и приёма забегов.
    if (this.config.auth.enabled) this.runContinues.provide(this);
  }

  async check(runId: string, continues: readonly number[]): Promise<ContinueCheck> {
    const granted = await this.purchases.grantedForRun(runId);
    const paidAt = new Map(granted.map((purchase) => [purchase.continueNo, purchase.elapsedSec]));
    const underpaid = continues.some((sec, index) => {
      const claimed = paidAt.get(index + 1);
      return claimed !== undefined && continuePrice(sec, this.config.payments) > continuePrice(claimed, this.config.payments);
    });
    return { paid: granted.length, underpaid };
  }
}
