import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import {
  AD_NETWORK_PROFILES,
  PLACE_FORMAT,
  blockShapeProblem,
  formatFor,
  keysProblem,
  missingKeys,
  profileOf,
  type AdFormat,
  type AdNetworkProfile,
} from "./ad-networks.js";
import {
  AdBlockInvalidError,
  AdBlockLimitError,
  AdBlockShapeLockedError,
  AdCatalogNotFoundError,
  AdNetworkIncompleteError,
  AdNetworkKeysError,
} from "./ads-errors.js";
import { AD_DEVICES, AD_PLACES, AD_SUCCESS, type AdPlace, type AdSuccess } from "./ads-rules.js";
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

/** `keys` не пришли — ключи не меняются; пустое значение — ключа нет. */
export const networkEditSchema = z
  .object({
    networkKey: z.string().min(1).max(32),
    active: z.boolean(),
    priority: z.number().int().min(0).max(10_000),
    keys: z.record(z.string().min(1).max(32), z.string().trim().max(128)).optional(),
  })
  .strict();
export type NetworkEdit = z.infer<typeof networkEditSchema>;

const unique = (values: readonly string[]) => new Set(values).size === values.length;

/**
 * `blockId: null` — новый блок. Пустые площадки и устройства — «везде».
 * `externalId` пустой или `null` — у формата нет блока в кабинете; условие
 * успеха не задано — первое из допустимых форматом. Остальное проверяет
 * профиль сети (`ad-networks.ts`).
 */
export const blockEditSchema = z
  .object({
    blockId: z.string().uuid().nullable(),
    networkKey: z.string().min(1).max(32),
    place: z.enum(AD_PLACES),
    externalId: z
      .string()
      .trim()
      .max(128)
      .nullable()
      .transform((value) => (value === null || value === "" ? null : value)),
    success: z.enum(AD_SUCCESS).optional(),
    active: z.boolean(),
    platforms: z.array(z.enum(PLATFORM_IDS)).refine(unique),
    devices: z.array(z.enum(AD_DEVICES)).refine(unique),
  })
  .strict();
export type AdBlockEdit = z.infer<typeof blockEditSchema>;

export interface AdNetworkView extends AdNetworkRow {
  /** обязательных ключей не хватает — сеть не включить; пусто — хватает */
  missing: string[];
  /** ключ не по виду — запись до профилей или правка в базе руками */
  problem: string | null;
}

export interface AdBlockView extends AdBlockDef {
  /** блок не по профилю сети — выдача его пропускает; `null` — по правилам */
  problem: string | null;
}

export interface AdsCatalogView {
  networks: AdNetworkView[];
  blocks: AdBlockView[];
  funnel: AdFunnelRow[];
  days: FunnelDays;
  places: readonly AdPlace[];
  /** что каждая сеть умеет и что ей нужно — по ним панель строит формы */
  profiles: readonly AdNetworkProfile[];
  /** какой формат ждёт место */
  formats: Record<AdPlace, AdFormat>;
  /** включены тестовые показы: сети крутят пробные ролики и не платят — панель предупреждает */
  testMode: boolean;
}

@Injectable()
export class AdsCatalogService {
  private readonly logger = new Logger("ads");

  constructor(
    @Inject(ADS_CATALOG_REPOSITORY) private readonly repository: AdsCatalogRepository,
    private readonly roles: RolesService,
    private readonly ads: AdsService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  async view(actor: AccountRef, days: FunnelDays, at = new Date()): Promise<AdsCatalogView> {
    await this.roles.require(actor, "ads.view");
    const [networks, blocks, funnel] = await Promise.all([
      this.db(this.repository.networks()),
      this.db(this.repository.blocks()),
      this.db(this.repository.funnel(new Date(at.getTime() - days * DAY_MS), at)),
    ]);
    return {
      networks: networks.map((network) => networkView(network)),
      blocks: blocks.map((block) => ({ ...block, problem: blockShapeProblem(block) })),
      funnel,
      days,
      places: AD_PLACES,
      profiles: AD_NETWORK_PROFILES,
      formats: PLACE_FORMAT,
      testMode: this.settings.get(SETTINGS.adsTestMode),
    };
  }

  /**
   * Сеть из панели: место в круге, ключи и включённость. Ключи — по виду из
   * профиля; включить сеть без обязательных ключей нельзя — SDK без них
   * ничего не покажет, и место молча осталось бы пустым.
   */
  async saveNetwork(actor: AccountRef, input: NetworkEdit, at = new Date()): Promise<AdNetworkView> {
    await this.roles.require(actor, "ads.edit");
    const before = (await this.db(this.repository.networks())).find((network) => network.networkKey === input.networkKey);
    if (before === undefined) throw new AdCatalogNotFoundError("network");
    const profile = profileOf(input.networkKey);
    const keys = input.keys === undefined ? before.keys : filledKeys(input.keys);
    if (profile === undefined) {
      if (input.active) throw new AdNetworkIncompleteError(`Сети ${before.name} нет в коде — её SDK не подключён, включать нечего`);
    } else {
      const problem = keysProblem(profile, keys);
      if (problem !== null) throw new AdNetworkKeysError(problem);
      const missing = missingKeys(profile, keys);
      if (input.active && missing.length > 0) throw new AdNetworkIncompleteError(`Чтобы включить ${profile.title}, задайте: ${missing.join(", ")}`);
    }
    const edit: AdNetworkEdit = { networkKey: input.networkKey, active: input.active, priority: input.priority, keys };
    if (!(await this.db(this.repository.updateNetwork(edit, at)))) throw new AdCatalogNotFoundError("network");
    const after: AdNetworkRow = { ...before, active: edit.active, priority: edit.priority, keys };
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ads.network.update", target: edit.networkKey, before, after });
    this.changed({ event: "ad_network_updated", networkKey: edit.networkKey, actor: actor.accountId });
    return networkView(after);
  }

  /**
   * Блок из панели: без идентификатора — новый, с ним — правка блока в
   * кабинете сети, условия успеха, площадок, устройств и включённости.
   */
  async saveBlock(actor: AccountRef, input: AdBlockEdit, at = new Date()): Promise<AdBlockDef> {
    await this.roles.require(actor, "ads.edit");
    const before = input.blockId === null ? null : ((await this.db(this.repository.blocks())).find((candidate) => candidate.blockId === input.blockId) ?? null);
    if (input.blockId !== null) {
      if (before === null) throw new AdCatalogNotFoundError("block");
      if (before.networkKey !== input.networkKey || before.place !== input.place) throw new AdBlockShapeLockedError();
    }
    const edit = await this.checkedBlock(input);
    if (edit.blockId === null || before === null) {
      const created = await this.db(this.repository.insertBlock({ ...edit }, actor.accountId, at));
      if (created === null) throw new AdCatalogNotFoundError("network");
      await this.roles.audit({ actorAccountId: actor.accountId, action: "ads.block.create", target: created.blockId, after: created });
      this.changed({ event: "ad_block_created", blockId: created.blockId, actor: actor.accountId });
      return created;
    }
    const block: AdBlockDef = { ...edit, blockId: edit.blockId };
    if (!(await this.db(this.repository.updateBlock(block, actor.accountId, at)))) throw new AdCatalogNotFoundError("block");
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ads.block.update", target: block.blockId, before, after: block });
    this.changed({ event: "ad_block_updated", blockId: block.blockId, actor: actor.accountId });
    return block;
  }

  /**
   * Блок по профилю сети: место её формата, идентификатор того вида, условие
   * успеха из допустимых, и не больше включённых блоков формата, чем держит
   * кабинет сети. Проверка до записи — неправильный блок не попадает в базу.
   */
  private async checkedBlock(input: AdBlockEdit): Promise<AdBlockEdit & { success: AdSuccess }> {
    const profile = profileOf(input.networkKey);
    // Сеть без профиля для панели — не сеть: её SDK не подключён, показать блок нечем.
    if (profile === undefined) throw new AdCatalogNotFoundError("network");
    const support = formatFor(profile, input.place);
    const success = input.success ?? support?.success[0] ?? "view";
    const edit = { ...input, success };
    const problem = blockShapeProblem(edit);
    if (problem !== null || support === undefined) throw new AdBlockInvalidError(problem ?? "Блок не по правилам сети");
    if (edit.active && support.maxActive !== undefined) {
      const format = PLACE_FORMAT[edit.place];
      const others = (await this.db(this.repository.blocks())).filter(
        (block) => block.active && block.networkKey === edit.networkKey && PLACE_FORMAT[block.place] === format && block.blockId !== edit.blockId,
      );
      if (others.length >= support.maxActive) {
        throw new AdBlockLimitError(`${profile.title}: включённых блоков формата «${support.title}» не больше ${String(support.maxActive)} — выключите прежний`);
      }
    }
    return edit;
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

/** Ключи как их хранит база: только заданные, без пустых строк. */
function filledKeys(keys: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(keys).filter(([, value]) => value !== ""));
}

function networkView(network: AdNetworkRow): AdNetworkView {
  const profile = profileOf(network.networkKey);
  if (profile === undefined) return { ...network, missing: [], problem: "Сети нет в коде — её SDK не подключён" };
  return { ...network, missing: missingKeys(profile, network.keys), problem: keysProblem(profile, network.keys) };
}
