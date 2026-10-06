import { Injectable, type OnModuleInit } from "@nestjs/common";
import { RunExtras, type RunBoostsSource } from "../runs/run-details.js";
import { BoostsService } from "./boosts.service.js";

/** Бусты забега в листе забега (Р39): только купленные на него и не возвращённые. */
@Injectable()
export class BoostsRunExtras implements RunBoostsSource, OnModuleInit {
  constructor(
    private readonly service: BoostsService,
    private readonly extras: RunExtras,
  ) {}

  onModuleInit(): void {
    this.extras.provideBoosts(this);
  }

  async boosts(accountId: string, runId: string): Promise<string[]> {
    return await this.service.ofRun(accountId, runId);
  }
}
