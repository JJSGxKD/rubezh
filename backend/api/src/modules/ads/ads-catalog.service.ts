import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { AdBlockShapeLockedError, AdCatalogNotFoundError } from "./ads-errors.js";
import { AD_DEVICES, AD_PLACES, AD_SUCCESS, type AdPlace } from "./ads-rules.js";
import { AdsService } from "./ads.service.js";
import {
  ADS_CATALOG_REPOSITORY,
  type AdBlockDef,
  type AdFunnelRow,
  type AdNetworkEdit,
  type AdNetworkRow,
  type AdsCatalogRepository,
} from "./ads-catalog.repository.js";

/**
 * Реклама в панели (docs/29-admin-panel.md, раздел «Реклама»; WP12): какие
 * сети включены и в каком порядке, блоки мест и воронка показов. Читать —
 * `ads.view`, менять — `ads.edit`; каждое изменение — в аудит. Удаления нет:
 * на блок ссылаются сессии показов, его выключают.
 */

const DB_TIMEOUT_MS = 3_000;
const DAY_MS = 86_400_000;

/** Окна воронки в панели: сутки — видно вчерашний сбой сети, месяц — сравнить сети. */
export const FUNNEL_DAYS = [1, 7, 30] as const;
export type FunnelDays = (typeof FUNNEL_DAYS)[number];

export const networkEditSchema = z
  .object({ networkKey: z.string().min(1).max(32), active: z.boolean(), priority: z.number().int().min(0).max(10_000) })
  .strict();

const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** `blockId: null` — новый блок. Пустые площадки и устройства — «везде». */
export const blockEditSchema = z
  .object({
    blockId: z.string().uuid().nullable(),
    networkKey: z.string().min(1).max(32),
    place: z.enum(AD_PLACES),
    externalId: z.string().trim().min(1).max(128).regex(/^\S+$/),
    success: z.enum(AD_SUCCESS),
    active: z.boolean(),
    platforms: z.array(z.enum(PLATFORM_IDS)).refine(unique),
    devices: z.array(z.enum(AD_DEVICES)).refine(unique),
  })
  .strict();
export type AdBlockEdit = z.infer<typeof blockEditSchema>;

export interface AdsCatalogView {
  networks: AdNetworkRow[];
  blocks: AdBlockDef[];
  funnel: AdFunnelRow[];
  days: FunnelDays;
  places: readonly AdPlace[];
}

@Injectable()
export class AdsCatalogService {
  private readonly logger = new Logger("ads");

  constructor(
    @Inject(ADS_CATALOG_REPOSITORY) private readonly repository: AdsCatalogRepository,
    private readonly roles: RolesService,
    private readonly ads: AdsService,
  ) {}

  async view(actor: AccountRef, days: FunnelDays, at = new Date()): Promise<AdsCatalogView> {
    await this.roles.require(actor, "ads.view");
    const [networks, blocks, funnel] = await Promise.all([
      this.db(this.repository.networks()),
      this.db(this.repository.blocks()),
      this.db(this.repository.funnel(new Date(at.getTime() - days * DAY_MS), at)),
    ]);
    return { networks, blocks, funnel, days, places: AD_PLACES };
  }

  async saveNetwork(actor: AccountRef, edit: AdNetworkEdit, at = new Date()): Promise<AdNetworkRow> {
    await this.roles.require(actor, "ads.edit");
    const before = (await this.db(this.repository.networks())).find((network) => network.networkKey === edit.networkKey);
    if (before === undefined || !(await this.db(this.repository.updateNetwork(edit, at)))) throw new AdCatalogNotFoundError("network");
    const after = { ...before, active: edit.active, priority: edit.priority };
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ads.network.update", target: edit.networkKey, before, after });
    this.changed({ event: "ad_network_updated", networkKey: edit.networkKey, actor: actor.accountId });
    return after;
  }

  /**
   * Блок из панели: без идентификатора — новый, с ним — правка блока в
   * кабинете сети, условия успеха, площадок, устройств и включённости.
   */
  async saveBlock(actor: AccountRef, edit: AdBlockEdit, at = new Date()): Promise<AdBlockDef> {
    await this.roles.require(actor, "ads.edit");
    if (edit.blockId === null) {
      const created = await this.db(this.repository.insertBlock({ ...edit }, actor.accountId, at));
      if (created === null) throw new AdCatalogNotFoundError("network");
      await this.roles.audit({ actorAccountId: actor.accountId, action: "ads.block.create", target: created.blockId, after: created });
      this.changed({ event: "ad_block_created", blockId: created.blockId, actor: actor.accountId });
      return created;
    }
    const block: AdBlockDef = { ...edit, blockId: edit.blockId };
    const before = (await this.db(this.repository.blocks())).find((candidate) => candidate.blockId === block.blockId);
    if (before === undefined) throw new AdCatalogNotFoundError("block");
    if (before.networkKey !== block.networkKey || before.place !== block.place) throw new AdBlockShapeLockedError();
    if (!(await this.db(this.repository.updateBlock(block, actor.accountId, at)))) throw new AdCatalogNotFoundError("block");
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ads.block.update", target: block.blockId, before, after: block });
    this.changed({ event: "ad_block_updated", blockId: block.blockId, actor: actor.accountId });
    return block;
  }

  /** Правка видна выдаче сразу на этой реплике, на остальных — в пределах полуминуты. */
  private changed(fields: Record<string, unknown>): void {
    this.ads.forgetBlocks();
    this.logger.log(JSON.stringify({ module: "ads", ...fields }));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "реклама");
  }
}
