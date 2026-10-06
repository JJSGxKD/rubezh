import { DIFFICULTY_IDS, ELEMENTS, type RunResult } from "@bh/shared-types";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { reportError, useShell } from "./shell";

/**
 * Итог забега, который ждёт решения на экране смерти — второй шанс
 * (docs/07-monetization-and-ads.md §8). Пока игрок решает, забег не закрыт:
 * иначе продолженный забег записался бы дважды. Но приложение чаще всего
 * закрывают именно на экране смерти — и забег пропал бы из рекорда и из
 * рейтинга.
 *
 * Поэтому итог «как при отказе» лежит на устройстве, пока решение не принято,
 * и при следующем запуске уходит обычной смертью. Продолжил игрок — запись
 * снимается, и засчитан будет только итог продолженного забега.
 */
const KEY = "bh.run.v1.downed";

const resultSchema = z.object({
  runId: z.string(),
  seed: z.number(),
  outcome: z.enum(["died", "abandoned"]),
  startingWeaponId: z.string(),
  mapId: z.string(),
  difficultyId: z.enum(DIFFICULTY_IDS),
  contentHash: z.string(),
  waveReached: z.number(),
  survivalSec: z.number(),
  level: z.number(),
  xpCollected: z.number(),
  enemiesKilled: z.number(),
  killsByEnemy: z.record(z.string(), z.number()),
  damageDealt: z.number(),
  damageTaken: z.number(),
  // Забег, брошенный на экране смерти до сборки со стихиями, урона по ним не
  // несёт — и не должен из-за этого пропасть.
  damageByElement: z._default(z.partialRecord(z.enum(ELEMENTS), z.number()), {}),
  weapons: z.array(z.object({ id: z.string(), level: z.number(), damage: z.number() })),
  passives: z.array(z.object({ id: z.string(), level: z.number() })),
  deathCause: z.nullable(z.string()),
  distance: z.number(),
  peakEnemies: z.number(),
  cheats: z.boolean(),
  continues: z.array(z.number()),
});

const downedSchema = z.nullable(z.object({ result: resultSchema, countInRating: z.boolean() }));

export interface DownedRun {
  result: RunResult;
  /** просьба администратора учесть забег с читами — как в момент смерти */
  countInRating: boolean;
}

export function saveDownedRun(downed: DownedRun): void {
  value().write(downed);
}

export function clearDownedRun(): void {
  value().write(null);
}

/** Забег, брошенный на экране смерти в прошлый запуск, — и снять его с устройства. */
export function takeDownedRun(): DownedRun | null {
  const stored = value().read();
  if (stored !== null) clearDownedRun();
  return stored;
}

function value(): ReturnType<typeof createPersistedValue<DownedRun | null>> {
  return createPersistedValue<DownedRun | null>({
    storage: useShell.getState().storage,
    key: KEY,
    schema: downedSchema,
    fallback: null,
    onBroken: (key, reason) => reportError("run", `${key}: ${reason}`),
  });
}
