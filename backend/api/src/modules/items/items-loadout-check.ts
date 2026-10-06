import { Injectable, type OnModuleInit } from "@nestjs/common";
import { RunLoadouts, type LoadoutCheck, type LoadoutStatus, type SignedLoadout } from "../runs/run-loadouts.js";
import { ItemsService } from "./items.service.js";

/**
 * Проверка снимка снаряжения для вердикта забега (WP7, Р17): подключается к
 * модулю забегов сама, как сверка продолжений у оплаты.
 */
@Injectable()
export class ItemsLoadoutCheck implements LoadoutCheck, OnModuleInit {
  constructor(
    private readonly items: ItemsService,
    private readonly runLoadouts: RunLoadouts,
  ) {}

  onModuleInit(): void {
    this.runLoadouts.provide(this);
  }

  async check(accountId: string, snapshot: SignedLoadout): Promise<Exclude<LoadoutStatus, "none">> {
    return await this.items.checkLoadout(accountId, snapshot);
  }
}
