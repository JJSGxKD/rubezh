import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { NetworkTaskDef } from "./network-task-rules.js";

/**
 * Строки заданий рекламных сетей в базе (`network_task`, WP13 часть 6).
 * Строка на сеть заводится миграцией вместе с поддержкой её заданий в коде:
 * панель их правит, но не заводит и не удаляет.
 */

export interface NetworkTaskRow extends NetworkTaskDef {
  updatedAt: Date;
  /** `null` — строка из миграции, человек её не правил */
  updatedBy: string | null;
}

export const NETWORK_TASKS_REPOSITORY = Symbol("NETWORK_TASKS_REPOSITORY");

export interface NetworkTasksRepository {
  all(): Promise<NetworkTaskRow[]>;
  /** поправить строку сети; `false` — строки нет */
  update(def: NetworkTaskDef, actorAccountId: string, at: Date): Promise<boolean>;
}

const rowSchema = z.object({
  network_key: z.string(),
  active: z.boolean(),
  daily_cap: z.number().int(),
  pause_min: z.number().int(),
  coins: z.number().int(),
  gems: z.number().int(),
  shards: z.number().int(),
  updated_at: z.date(),
  updated_by: z.string().nullable(),
});

@Injectable()
export class PrismaNetworkTasksRepository implements NetworkTasksRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async all(): Promise<NetworkTaskRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT network_key, active, daily_cap::int AS daily_cap, pause_min, coins, gems, shards, updated_at, updated_by::text
      FROM network_task ORDER BY network_key`;
    return rows.map((raw) => {
      const row = rowSchema.parse(raw);
      return {
        networkKey: row.network_key,
        active: row.active,
        dailyCap: row.daily_cap,
        pauseMin: row.pause_min,
        coins: row.coins,
        gems: row.gems,
        shards: row.shards,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    });
  }

  async update(def: NetworkTaskDef, actorAccountId: string, at: Date): Promise<boolean> {
    return (
      (await this.prisma.$executeRaw`
        UPDATE network_task SET active = ${def.active}, daily_cap = ${def.dailyCap}, pause_min = ${def.pauseMin},
          coins = ${def.coins}, gems = ${def.gems}, shards = ${def.shards}, updated_at = ${at}, updated_by = ${actorAccountId}::uuid
        WHERE network_key = ${def.networkKey}`) > 0
    );
  }
}
