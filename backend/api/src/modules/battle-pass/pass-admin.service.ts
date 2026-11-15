import { Inject, Injectable, Logger } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { BOOST_IDS } from "../boosts/boost-catalog.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { DEFAULT_RIBBON } from "./pass-defaults.js";
import { PassSeasonBrokenError, PassSeasonChangedError, PassSeasonExistsError, PassSeasonNotFoundError, PassSeasonReadonlyError, PassTierPassedError } from "./pass-errors.js";
import { PASS_TIERS, monthBounds, monthKeyOf, passRewardCaps, passRibbonSchema, tierOf, type PassTierDef, type PassTierEdit } from "./pass-rules.js";
import { PASS_SEASON_REPOSITORY, type PassSeasonRecord, type PassSeasonRepository } from "./pass-season.repository.js";

/**
 * Ленты батл-пасса в панели (docs/35-stage4-plan.md Р46, §3.15; tasks/T-0313):
 * месяцы, 30 ступеней двух лент, копия прошлого месяца, публикация. Всё — под
 * `pass.edit`, каждое изменение — в аудит.
 *
 * Правила, которые держит сервер, а не форма:
 * - **награда — по схеме T-0311** (`passRibbonSchema`): ни шанса, ни «случайного
 *   осколка» (Р11), сумма лент не выше суточного потолка кошелька;
 * - **прошлый месяц — только чтение**, будущий правится свободно;
 * - **у текущего не правятся ступени, до которых кто-то уже дошёл**: награду
 *   игрок забирает по ленте на момент забора, и задним числом её менять нельзя.
 *   Ту же границу держит публикация: лента, меняющая пройденные ступени
 *   относительно ленты по умолчанию (её видели игроки, пока своей не было), не
 *   публикуется;
 * - **неопубликованный месяц игрок не видит** — для него действует лента по
 *   умолчанию (`BattlePassRepository.season`).
 *
 * Граница «пройдено» берётся из очков игроков в момент запроса; ступень, которую
 * игрок взял в миллисекундах между проверкой и записью, всё равно останется
 * наградой, которую он увидит перед забором, — гонка безвредна.
 */

const DB_TIMEOUT_MS = 3_000;

export type PassPhase = "past" | "current" | "future";

export interface PassSeasonRow {
  monthKey: string;
  phase: PassPhase;
  /** есть ли у месяца своя лента; нет — игрокам идёт лента по умолчанию */
  saved: boolean;
  published: boolean;
}

export interface PassSeasonsView {
  currentMonth: string;
  nextMonth: string;
  months: PassSeasonRow[];
}

export interface PassSeasonView extends PassSeasonRow {
  publishedAt: string | null;
  pointsPerTier: number;
  /** сколько первых ступеней править нельзя: все — в прошлом месяце, пройденные игроками — в текущем */
  lockedTiers: number;
  tiers: PassTierDef[];
  /** предел количества по ресурсам: форма проверяет им то, что видно без базы */
  caps: Record<string, number>;
  /** бусты, которые можно подарить */
  boosts: string[];
}

export interface PassSeasonCreateInput {
  month: string;
  /** месяц-источник копии; нет — лента по умолчанию */
  from?: string | undefined;
}

@Injectable()
export class PassAdminService {
  private readonly logger = new Logger("pass-admin");

  constructor(
    @Inject(PASS_SEASON_REPOSITORY) private readonly repository: PassSeasonRepository,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly roles: RolesService,
  ) {}

  /** Текущий, следующий и все заведённые месяцы: свежие первыми. */
  async seasons(actor: AccountRef, now = new Date()): Promise<PassSeasonsView> {
    await this.require(actor);
    const currentMonth = monthKeyOf(now);
    const nextMonth = monthKeyOf(monthBounds(currentMonth).endsAt);
    const listed = await this.db(this.repository.list());
    const rows = new Map<string, PassSeasonRow>();
    for (const month of [nextMonth, currentMonth]) rows.set(month, { monthKey: month, phase: phaseOf(month, currentMonth), saved: false, published: false });
    for (const item of listed) rows.set(item.monthKey, { monthKey: item.monthKey, phase: phaseOf(item.monthKey, currentMonth), saved: true, published: item.published });
    return { currentMonth, nextMonth, months: [...rows.values()].sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1)) };
  }

  async season(actor: AccountRef, month: string, now = new Date()): Promise<PassSeasonView> {
    await this.require(actor);
    return await this.viewOf(month, await this.db(this.repository.find(month)), now);
  }

  /** Завести ленту месяца черновиком: по умолчанию или копией другого месяца. */
  async create(actor: AccountRef, input: PassSeasonCreateInput, now = new Date()): Promise<PassSeasonView> {
    await this.require(actor);
    const currentMonth = monthKeyOf(now);
    if (phaseOf(input.month, currentMonth) === "past") throw new PassSeasonReadonlyError();
    const source = input.from === undefined ? null : await this.db(this.repository.find(input.from));
    // Копия месяца без своей ленты — это копия ленты по умолчанию: именно её видели игроки.
    const tiers = source === null ? DEFAULT_RIBBON : this.parse(source.tiers);
    if (!(await this.db(this.repository.insertDraft(input.month, tiers)))) throw new PassSeasonExistsError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "pass.season.create", target: input.month, after: { from: input.from ?? null } });
    this.logger.log(JSON.stringify({ module: "pass-admin", event: "pass_season_created", month: input.month, from: input.from ?? null, actor: actor.accountId }));
    return await this.viewOf(input.month, await this.db(this.repository.find(input.month)), now);
  }

  /** Правка одной ступени: обе ленты разом. */
  async editTier(actor: AccountRef, month: string, tier: number, edit: PassTierEdit, now = new Date()): Promise<PassSeasonView> {
    await this.require(actor);
    if (!Number.isInteger(tier) || tier < 1 || tier > PASS_TIERS) throw new ValidationError(`Ступень — от 1 до ${String(PASS_TIERS)}`);
    const currentMonth = monthKeyOf(now);
    const phase = phaseOf(month, currentMonth);
    if (phase === "past") throw new PassSeasonReadonlyError();
    const record = await this.db(this.repository.find(month));
    if (record === null) throw new PassSeasonNotFoundError();
    const tiers = this.parse(record.tiers);
    if (tier <= (await this.lockedTiers(month, phase))) throw new PassTierPassedError();

    const next = tiers.map((candidate) => (candidate.tier === tier ? { tier, free: edit.free, vip: edit.vip } : candidate));
    const checked = passRibbonSchema.safeParse(next);
    if (!checked.success) throw new ValidationError(checked.error.issues[0]?.message ?? "Лента не проходит проверку");
    if (!(await this.db(this.repository.replaceTiers(month, record.tiers, checked.data)))) throw new PassSeasonChangedError();

    await this.roles.audit({ actorAccountId: actor.accountId, action: "pass.tier.update", target: `${month}:${String(tier)}`, before: tiers[tier - 1], after: checked.data[tier - 1] });
    this.logger.log(JSON.stringify({ module: "pass-admin", event: "pass_tier_updated", month, tier, actor: actor.accountId }));
    return await this.viewOf(month, { ...record, tiers: checked.data }, now);
  }

  /** Опубликовать месяц: с этого момента игроки видят его ленту. Повтор ничего не пишет. */
  async publish(actor: AccountRef, month: string, now = new Date()): Promise<PassSeasonView> {
    await this.require(actor);
    const currentMonth = monthKeyOf(now);
    const phase = phaseOf(month, currentMonth);
    if (phase === "past") throw new PassSeasonReadonlyError();
    const record = await this.db(this.repository.find(month));
    if (record === null) throw new PassSeasonNotFoundError();
    if (record.published) return await this.viewOf(month, record, now);

    const tiers = this.parse(record.tiers);
    const locked = await this.lockedTiers(month, phase);
    // Пока своей ленты не было, игроки шли по ленте по умолчанию: пройденные ступени обязаны остаться её ступенями.
    const changed = tiers.slice(0, locked).some((tier, index) => !sameTier(tier, DEFAULT_RIBBON[index]));
    if (changed) throw new PassTierPassedError(`Лента меняет ступени, которые уже прошли игроки (до ${String(locked)}-й): опубликовать её нельзя`);

    if (await this.db(this.repository.publish(month, now))) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "pass.season.publish", target: month, after: { publishedAt: now.toISOString() } });
      this.logger.log(JSON.stringify({ module: "pass-admin", event: "pass_season_published", month, actor: actor.accountId }));
    }
    return await this.viewOf(month, await this.db(this.repository.find(month)), now);
  }

  private async viewOf(month: string, record: PassSeasonRecord | null, now: Date): Promise<PassSeasonView> {
    const phase = phaseOf(month, monthKeyOf(now));
    return {
      monthKey: month,
      phase,
      saved: record !== null,
      published: record?.published ?? false,
      publishedAt: record?.publishedAt?.toISOString() ?? null,
      pointsPerTier: this.settings.get(SETTINGS.passPointsPerTier),
      lockedTiers: await this.lockedTiers(month, phase),
      tiers: record === null ? [...DEFAULT_RIBBON] : this.parse(record.tiers),
      caps: passRewardCaps(),
      boosts: [...BOOST_IDS],
    };
  }

  /** Сколько первых ступеней месяца закрыто для правки. */
  private async lockedTiers(month: string, phase: PassPhase): Promise<number> {
    if (phase === "past") return PASS_TIERS;
    if (phase === "future") return 0;
    return tierOf(await this.db(this.repository.maxPoints(month)), this.settings.get(SETTINGS.passPointsPerTier));
  }

  /** Лента из базы — граница системы: правили руками, и схема её не пропустит, когда там мусор. */
  private parse(stored: unknown): PassTierDef[] {
    const parsed = passRibbonSchema.safeParse(stored);
    if (!parsed.success) throw new PassSeasonBrokenError(parsed.error.issues[0]?.message ?? "не проходит схему");
    return parsed.data;
  }

  private async require(actor: AccountRef): Promise<void> {
    await this.roles.require(actor, "pass.edit");
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "ленты пасса");
  }
}

/** Месяц по отношению к текущему: ключи `ГГГГ-ММ` сравниваются как строки. */
function phaseOf(month: string, currentMonth: string): PassPhase {
  if (month < currentMonth) return "past";
  return month === currentMonth ? "current" : "future";
}

/** Ступени равны по наградам; порядок ключей и отсутствующие поля не важны. */
function sameTier(a: PassTierDef, b: PassTierDef | undefined): boolean {
  if (b === undefined) return false;
  const plain = (tier: PassTierDef): unknown => JSON.parse(JSON.stringify({ free: tier.free, vip: tier.vip }));
  return isDeepStrictEqual(plain(a), plain(b));
}
