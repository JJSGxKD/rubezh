import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { AD_DEVICES, AD_PLACES, AD_SUCCESS, type AdDevice, type AdPlace, type AdSuccess } from "./ads-rules.js";

/**
 * Сети и блоки рекламы для панели (docs/35-stage4-plan.md §3.7, WP12;
 * docs/29-admin-panel.md): всё, и выключенное, — и воронка показов по сетям
 * и местам. Выбор сети читает только включённое, из `ads.repository.ts`.
 */

export interface AdNetworkRow {
  networkKey: string;
  name: string;
  active: boolean;
  priority: number;
}

/** Правка сети: сети приходят кодом (у каждой свой SDK), панель их включает и ставит в круг. */
export interface AdNetworkEdit {
  networkKey: string;
  active: boolean;
  priority: number;
}

export interface AdBlockDef {
  blockId: string;
  networkKey: string;
  place: AdPlace;
  externalId: string;
  success: AdSuccess;
  active: boolean;
  platforms: PlatformId[];
  devices: AdDevice[];
}

/** Воронка сети в месте за период: сколько выдано и сколько дошло до каждого шага. */
export interface AdFunnelRow {
  networkKey: string;
  place: AdPlace;
  offered: number;
  shown: number;
  clicked: number;
  completed: number;
  claimed: number;
  failed: number;
}

export const ADS_CATALOG_REPOSITORY = Symbol("ADS_CATALOG_REPOSITORY");

export interface AdsCatalogRepository {
  networks(): Promise<AdNetworkRow[]>;
  blocks(): Promise<AdBlockDef[]>;
  /** `false` — такой сети нет */
  updateNetwork(edit: AdNetworkEdit, at: Date): Promise<boolean>;
  /** новый блок — идентификатор выдаёт база; `null` — сети нет */
  insertBlock(block: Omit<AdBlockDef, "blockId">, actorAccountId: string, at: Date): Promise<AdBlockDef | null>;
  /** сеть и место у блока не меняются; `false` — блока нет */
  updateBlock(block: AdBlockDef, actorAccountId: string, at: Date): Promise<boolean>;
  funnel(from: Date, to: Date): Promise<AdFunnelRow[]>;
}

const networkSchema = z.object({ network_key: z.string(), name: z.string(), active: z.boolean(), priority: z.number().int() });

const blockSchema = z.object({
  block_id: z.string(),
  network_key: z.string(),
  place: z.enum(AD_PLACES),
  external_id: z.string(),
  success: z.enum(AD_SUCCESS),
  active: z.boolean(),
  platforms: z.array(z.enum(PLATFORM_IDS)),
  devices: z.array(z.enum(AD_DEVICES)),
});

const count = z.union([z.bigint(), z.number()]).transform(Number);
const funnelSchema = z.object({
  network_key: z.string(),
  place: z.enum(AD_PLACES),
  offered: count,
  shown: count,
  clicked: count,
  completed: count,
  claimed: count,
  failed: count,
});

@Injectable()
export class PrismaAdsCatalogRepository implements AdsCatalogRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async networks(): Promise<AdNetworkRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT network_key, name, active, priority FROM ad_network ORDER BY priority, network_key`;
    return rows.map((raw) => {
      const row = networkSchema.parse(raw);
      return { networkKey: row.network_key, name: row.name, active: row.active, priority: row.priority };
    });
  }

  async blocks(): Promise<AdBlockDef[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT block_id::text, network_key, place::text, external_id, success::text, active, platforms::text[] AS platforms, devices::text[] AS devices
      FROM ad_block ORDER BY place, network_key, created_at`;
    return rows.map((raw) => {
      const row = blockSchema.parse(raw);
      return {
        blockId: row.block_id,
        networkKey: row.network_key,
        place: row.place,
        externalId: row.external_id,
        success: row.success,
        active: row.active,
        platforms: row.platforms,
        devices: row.devices,
      };
    });
  }

  async updateNetwork(edit: AdNetworkEdit, at: Date): Promise<boolean> {
    return (
      (await this.prisma.$executeRaw`
        UPDATE ad_network SET active = ${edit.active}, priority = ${edit.priority}, updated_at = ${at} WHERE network_key = ${edit.networkKey}`) > 0
    );
  }

  async insertBlock(block: Omit<AdBlockDef, "blockId">, actorAccountId: string, at: Date): Promise<AdBlockDef | null> {
    const blockId = randomUUID();
    try {
      await this.prisma.adBlock.create({
        data: {
          blockId,
          networkKey: block.networkKey,
          place: block.place,
          externalId: block.externalId,
          success: block.success,
          active: block.active,
          platforms: [...block.platforms],
          devices: [...block.devices],
          createdAt: at,
          updatedAt: at,
          updatedBy: actorAccountId,
        },
      });
    } catch (error: unknown) {
      // Сеть проверяет внешний ключ: блок несуществующей сети не заведётся.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") return null;
      throw error;
    }
    return { ...block, blockId };
  }

  async updateBlock(block: AdBlockDef, actorAccountId: string, at: Date): Promise<boolean> {
    // Сеть и место не меняются: по ним считана воронка прошлых показов.
    const { count } = await this.prisma.adBlock.updateMany({
      where: { blockId: block.blockId },
      data: {
        externalId: block.externalId,
        success: block.success,
        active: block.active,
        platforms: [...block.platforms],
        devices: [...block.devices],
        updatedAt: at,
        updatedBy: actorAccountId,
      },
    });
    return count > 0;
  }

  async funnel(from: Date, to: Date): Promise<AdFunnelRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT network_key, place::text, count(*) AS offered, count(shown_at) AS shown, count(clicked_at) AS clicked,
             count(completed_at) AS completed, count(claimed_at) AS claimed, count(failed_at) AS failed
      FROM ad_session WHERE created_at >= ${from} AND created_at < ${to}
      GROUP BY network_key, place ORDER BY place, network_key`;
    return rows.map((raw) => {
      const row = funnelSchema.parse(raw);
      return { networkKey: row.network_key, place: row.place, offered: row.offered, shown: row.shown, clicked: row.clicked, completed: row.completed, claimed: row.claimed, failed: row.failed };
    });
  }
}
