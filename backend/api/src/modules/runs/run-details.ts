import { Injectable } from "@nestjs/common";
import { z } from "zod";

/**
 * Подробности забега для листа в профиле (docs/35-stage4-plan.md, WP4,
 * «Как сделано — подробности забега»): чем игрок воевал, что набрал и что
 * получил за забег.
 *
 * Хранятся колонкой `details` строки забега и колонкой `weapons` — JSON из
 * базы, поэтому читаются схемой, а не приведением типа: строка прошлой сборки
 * или правленная руками не должна ронять профиль.
 */

const id = z.string().min(1).max(64);
const count = z.number().int().min(0);

export const storedWeaponsSchema = z.array(z.object({ id, level: count, damage: z.number().min(0).optional() }));

export const storedDetailsSchema = z.object({
  passives: z.array(z.object({ id, level: count })),
  damageTaken: z.number().min(0).nullable(),
  xpCollected: count.nullable(),
  waveReached: count.nullable(),
  topKills: z.array(z.object({ enemy: id, count })),
});

export type StoredDetails = z.infer<typeof storedDetailsSchema>;

/** Сколько врагов показывать в «кого больше всего убил»: дальше список ничего не говорит. */
export const TOP_KILLS_SHOWN = 5;

/** Что пришло в итоге сверх рейтинга — подробности; без них колонка пустая. */
export interface FinishDetailsInput {
  passives: { id: string; level: number }[];
  stats?: { damageTaken: number; xpCollected: number; waveReached: number; topKills: { enemy: string; count: number }[] } | undefined;
}

export function detailsOf(input: FinishDetailsInput): StoredDetails | null {
  if (input.passives.length === 0 && input.stats === undefined) return null;
  return {
    passives: input.passives,
    damageTaken: input.stats?.damageTaken ?? null,
    xpCollected: input.stats?.xpCollected ?? null,
    waveReached: input.stats?.waveReached ?? null,
    // Клиент шлёт свою пятёрку, но порядок и потолок держит сервер: лист не
    // должен зависеть от того, как сборка отсортировала.
    topKills: [...(input.stats?.topKills ?? [])].sort((a, b) => b.count - a.count).slice(0, TOP_KILLS_SHOWN),
  };
}

/** Что игрок получил за забег — из модуля прогресса. */
export interface RunRewardPart {
  /** `pending` — очередь наград ещё не дошла; `none` — награды нет, с причиной */
  status: "pending" | "none" | "granted";
  reason: string | null;
  coins: number;
  xp: number;
  levelBefore: number;
  levelAfter: number;
}

/** Предмет, выпавший в забеге, — из модуля предметов. */
export interface RunLootPart {
  slot: string;
  rarity: string;
  level: number;
}

export interface RunRewardSource {
  reward(accountId: string, runId: string): Promise<RunRewardPart>;
}

export interface RunBoostsSource {
  /** бусты, купленные на забег и не возвращённые */
  boosts(accountId: string, runId: string): Promise<string[]>;
}

export interface RunLootSource {
  loot(accountId: string, runId: string): Promise<RunLootPart[]>;
}

/**
 * Подробности, которые лежат у других модулей: награда, бусты, добыча.
 * Модуль забегов о них не знает — модули подключаются сами, как к сверке
 * набора (`run-loadouts.ts`): иначе забегу понадобились бы прогресс, бусты и
 * предметы, а им — забег.
 *
 * Источник не подключён — части нет, а лист забега всё равно открывается.
 */
@Injectable()
export class RunExtras {
  private rewardSource: RunRewardSource | null = null;
  private boostsSource: RunBoostsSource | null = null;
  private lootSource: RunLootSource | null = null;

  provideReward(source: RunRewardSource): void {
    this.rewardSource = source;
  }

  provideBoosts(source: RunBoostsSource): void {
    this.boostsSource = source;
  }

  provideLoot(source: RunLootSource): void {
    this.lootSource = source;
  }

  async of(accountId: string, runId: string): Promise<{ reward: RunRewardPart | null; boosts: string[]; loot: RunLootPart[] }> {
    const [reward, boosts, loot] = await Promise.all([
      this.rewardSource?.reward(accountId, runId) ?? null,
      this.boostsSource?.boosts(accountId, runId) ?? [],
      this.lootSource?.loot(accountId, runId) ?? [],
    ]);
    return { reward, boosts, loot };
  }
}
