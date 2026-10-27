import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PLACE_FORMAT, deliveryOf, profileOf, type AdFormat } from "./ad-networks.js";
import { ADS_CATALOG_REPOSITORY, type AdBlockDef, type AdNetworkRow, type AdsCatalogRepository } from "./ads-catalog.repository.js";

/**
 * Проверка рекламы командой (docs/35-stage4-plan.md, Р165; tasks/T-0333): каталог
 * SDK-сетей и блоков для экрана «Проверка рекламы» и приём исхода проверки.
 * Сервис намеренно не знает ни сервиса выдачи показов, ни таблицы сессий: ничего не
 * начисляется и не создаётся, ни кулдауны, ни кап, ни воронка не двигаются. Исход
 * идёт в аудит и в JSON-лог; событие аналитики `ad_tested` присылает клиент.
 */

const DB_TIMEOUT_MS = 3_000;

/** Форматы, которые команда проверяет: у задач сетей нет ни показа, ни исхода. */
export type ToolsAdFormat = Exclude<AdFormat, "task">;

/** Причины отказа показа. Держать равным `AdFailureReason` из `packages/shared-types`: бэкенд пакеты клиента не импортирует. */
const FAILURE_REASONS = ["no_fill", "sdk_error", "load_failed", "timeout", "busy", "unsupported", "misconfigured", "late"] as const;

export const toolsAdsResultSchema = z
  .object({
    network: z.string().min(1).max(32),
    format: z.enum(["rewarded", "interstitial"]),
    blockId: z.string().uuid().nullable(),
    live: z.boolean(),
    outcome: z.enum(["completed", "closed", "failed"]),
    reason: z.enum(FAILURE_REASONS).optional(),
    ms: z.number().int().min(0).max(600_000),
  })
  .strict()
  .refine((value) => (value.outcome === "failed") === (value.reason !== undefined), { message: "причина нужна только при отказе показа", path: ["reason"] });

export type ToolsAdsResult = z.infer<typeof toolsAdsResultSchema>;

export interface ToolsAdsNetwork {
  network: string;
  name: string;
  active: boolean;
  /** только ключи, объявленные в профиле сети */
  keys: Record<string, string>;
  formats: ToolsAdFormat[];
}

export interface ToolsAdsBlock {
  blockId: string;
  network: string;
  place: string;
  format: ToolsAdFormat;
  externalId: string | null;
  active: boolean;
  platforms: string[];
}

export interface ToolsAdsCatalog {
  networks: ToolsAdsNetwork[];
  blocks: ToolsAdsBlock[];
}

/** SDK-форматы профиля сети, которые команда проверяет; пусто — сети в каталоге проверки нет. */
function sdkFormats(networkKey: string): ToolsAdFormat[] {
  const profile = profileOf(networkKey);
  if (profile === undefined) return [];
  return profile.formats.filter((support) => support.format !== "task" && deliveryOf(support) === "sdk").map((support) => support.format as ToolsAdFormat);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

@Injectable()
export class AdsToolsService {
  private readonly logger = new Logger("ads");

  constructor(
    @Inject(ADS_CATALOG_REPOSITORY) private readonly repository: AdsCatalogRepository,
    private readonly roles: RolesService,
  ) {}

  /** Сети и блоки, которые умеют показывать SDK; выключенные тоже — проверка нужна и им. */
  async catalog(): Promise<ToolsAdsCatalog> {
    const [networks, blocks] = await this.read();
    return buildCatalog(networks, blocks);
  }

  async recordResult(actor: AccountRef, input: ToolsAdsResult): Promise<void> {
    const [networks, blocks] = await this.read();
    const catalog = buildCatalog(networks, blocks);

    const network = catalog.networks.find((candidate) => candidate.network === input.network);
    if (network === undefined || !network.formats.includes(input.format)) throw new ValidationError("Неизвестная сеть или формат");
    if (input.blockId !== null) {
      const block = catalog.blocks.find((candidate) => candidate.blockId === input.blockId);
      if (block === undefined || block.network !== input.network || block.format !== input.format) throw new ValidationError("Блок не подходит");
    }

    await this.roles.audit({ actorAccountId: actor.accountId, action: "ads.test", target: `${input.network}:${input.format}`, after: input });
    this.logger.log(JSON.stringify({ module: "ads", event: "ad_tested", actor: actor.accountId, network: input.network, format: input.format, live: input.live, outcome: input.outcome, reason: input.reason ?? null, ms: input.ms }));
  }

  private async read(): Promise<[AdNetworkRow[], AdBlockDef[]]> {
    return await withTimeout(Promise.all([this.repository.networks(), this.repository.blocks()]), DB_TIMEOUT_MS, "реклама");
  }
}

function buildCatalog(networkRows: AdNetworkRow[], blockRows: AdBlockDef[]): ToolsAdsCatalog {
  const networks: ToolsAdsNetwork[] = [];
  for (const row of [...networkRows].sort((a, b) => a.priority - b.priority || byText(a.networkKey, b.networkKey))) {
    const profile = profileOf(row.networkKey);
    const formats = sdkFormats(row.networkKey);
    if (profile === undefined || formats.length === 0) continue;
    const keys: Record<string, string> = {};
    for (const field of profile.keys) {
      const value = row.keys[field.key];
      if (value !== undefined) keys[field.key] = value;
    }
    networks.push({ network: row.networkKey, name: row.name, active: row.active, keys, formats });
  }

  const blocks: ToolsAdsBlock[] = [];
  for (const row of blockRows) {
    const network = networks.find((candidate) => candidate.network === row.networkKey);
    const format = PLACE_FORMAT[row.place];
    if (network === undefined || format === "task" || !network.formats.includes(format)) continue;
    blocks.push({ blockId: row.blockId, network: row.networkKey, place: row.place, format, externalId: row.externalId, active: row.active, platforms: [...row.platforms] });
  }
  blocks.sort((a, b) => byText(a.network, b.network) || byText(a.place, b.place) || byText(a.blockId, b.blockId));
  return { networks, blocks };
}
