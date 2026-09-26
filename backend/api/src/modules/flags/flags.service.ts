import { Inject, Injectable } from "@nestjs/common";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { isOn, type FlagRule } from "./flag-rollout.js";
import { FLAGS_REPOSITORY, type FlagRecord, type FlagsRepository } from "./flags.repository.js";

/**
 * Фича-флаги (WP17, docs/09-ci-cd.md §11): рискованное — за флагом, который
 * выключается мгновенно, без релиза и без модерации клиента.
 *
 * Флаги читаются с каждого входа игрока и из кода других модулей, поэтому
 * держатся в памяти процесса `CACHE_MS`: выключенный флаг гаснет у всех
 * реплик самое позднее через это время, а база не получает запрос на каждое
 * «можно ли». Изменение из панели сбрасывает кеш своей реплики сразу.
 */

const CACHE_MS = 30_000;

export interface FlagInput {
  key: string;
  enabled: boolean;
  platforms: PlatformId[];
  percent: number;
  note: string | null;
}

@Injectable()
export class FlagsService {
  private cache: { at: number; flags: FlagRecord[] } | null = null;

  constructor(
    @Inject(FLAGS_REPOSITORY) private readonly flags: FlagsRepository,
    private readonly roles: RolesService,
  ) {}

  /** Флаги игрока: все известные ключи с вычисленным значением. */
  async forAccount(account: { accountId: string; platform: PlatformId }, nowMs = Date.now()): Promise<Record<string, boolean>> {
    const rules = await this.rules(nowMs);
    return Object.fromEntries(rules.map((rule) => [rule.key, isOn(rule, account)]));
  }

  /** Включён ли флаг для игрока — для кода других модулей. Неизвестный флаг выключен. */
  async isOn(key: string, account: { accountId: string; platform: PlatformId }, nowMs = Date.now()): Promise<boolean> {
    const rule = (await this.rules(nowMs)).find((flag) => flag.key === key);
    return rule !== undefined && isOn(rule, account);
  }

  async list(actor: AccountRef): Promise<FlagRecord[]> {
    await this.roles.require(actor, "flags.edit");
    return await this.flags.all();
  }

  async save(actor: AccountRef, input: FlagInput): Promise<FlagRecord> {
    await this.roles.require(actor, "flags.edit");
    const before = await this.flags.byKey(input.key);
    const saved = await this.flags.save({ ...input, updatedBy: actor.accountId });
    this.cache = null;
    await this.roles.audit({ actorAccountId: actor.accountId, action: "flags.save", target: input.key, before: before === null ? null : snapshot(before), after: snapshot(saved) });
    return saved;
  }

  async remove(actor: AccountRef, key: string): Promise<{ removed: boolean }> {
    await this.roles.require(actor, "flags.edit");
    const before = await this.flags.byKey(key);
    const removed = await this.flags.remove(key);
    this.cache = null;
    if (removed && before !== null) await this.roles.audit({ actorAccountId: actor.accountId, action: "flags.remove", target: key, before: snapshot(before), after: null });
    return { removed };
  }

  private async rules(nowMs: number): Promise<FlagRule[]> {
    if (this.cache === null || nowMs - this.cache.at > CACHE_MS) this.cache = { at: nowMs, flags: await this.flags.all() };
    return this.cache.flags;
  }
}

function snapshot(flag: FlagRule & { note: string | null }): Record<string, unknown> {
  return { enabled: flag.enabled, platforms: flag.platforms, percent: flag.percent, note: flag.note };
}
