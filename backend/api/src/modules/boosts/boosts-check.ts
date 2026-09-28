import { Injectable, type OnModuleInit } from "@nestjs/common";
import { RunLoadouts, type BoostCheck } from "../runs/run-loadouts.js";
import { BoostsService } from "./boosts.service.js";

/**
 * Сверка бустов для вердикта забега (Р39): подключается к модулю забегов
 * сама, как проверка снимка снаряжения у модуля предметов.
 */
@Injectable()
export class BoostsCheck implements BoostCheck, OnModuleInit {
  constructor(
    private readonly boosts: BoostsService,
    private readonly runLoadouts: RunLoadouts,
  ) {}

  onModuleInit(): void {
    this.runLoadouts.provideBoosts(this);
  }

  async check(accountId: string, runId: string, claimed: readonly string[]): Promise<"paid" | "unpaid"> {
    return await this.boosts.checkClaimed(accountId, runId, claimed);
  }
}
