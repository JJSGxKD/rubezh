import { Injectable, type OnModuleInit } from "@nestjs/common";
import { RunExtras, type RunLootPart, type RunLootSource } from "../runs/run-details.js";
import { ItemsService } from "./items.service.js";

/** Добыча забега в листе забега (§3.3): подключается к модулю забегов сама. */
@Injectable()
export class ItemsRunExtras implements RunLootSource, OnModuleInit {
  constructor(
    private readonly items: ItemsService,
    private readonly extras: RunExtras,
  ) {}

  onModuleInit(): void {
    this.extras.provideLoot(this);
  }

  async loot(accountId: string, runId: string): Promise<RunLootPart[]> {
    return await this.items.lootOf(accountId, runId);
  }
}
