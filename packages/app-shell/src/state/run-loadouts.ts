import { LOADOUT_STATS, type LoadoutStat, type SignedLoadout } from "@bh/shared-types";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { useProgress } from "./progress";
import { reportError, useShell } from "./shell";

/**
 * Снимок надетого на устройстве (docs/35-stage4-plan.md §3.4, WP7): какой
 * взять в следующий забег и с каким начался каждый забег.
 *
 * Забег без сети начинается с тем, что надето, поэтому снимок хранится, а не
 * спрашивается на старте. Итог забега несёт тот же снимок, что был на старте:
 * сервер сверяет его подпись, а надетое к концу забега могло смениться.
 * Забег переживает перезапуск приложения — продолженный и упавший на экране
 * смерти, — поэтому связка «забег → снимок» тоже на устройстве. Записей —
 * столько же, сколько забегов в очереди на отправку: итог старше уже
 * отправлен или выброшен.
 *
 * Модуль грузится отдельным чанком — на старте забега вместе с движком и при
 * отправке итога: первой загрузке схема снимка ни к чему.
 */

const SNAPSHOT_KEY = "bh.loadout.v1";
const RUNS_KEY = "bh.run-loadouts.v1";
const RUNS_LIMIT = 20;

/** Снимок с сервера или с устройства — граница системы: разбирается схемой. */
export const signedLoadoutSchema = z.object({
  accountId: z.string(),
  modifiers: z.record(z.string(), z.number()),
  // Нет поля — снимок прошлой сборки: подпись у него своя, без уровня.
  accountLevel: z.optional(z.number()),
  issuedAtMs: z.number(),
  signature: z.string(),
});

const runsSchema = z.array(z.object({ runId: z.string(), loadout: signedLoadoutSchema }));

/** Снимок для следующего забега; `null` — сервер его не выдавал. */
export function equippedLoadout(): SignedLoadout | null {
  return persisted(SNAPSHOT_KEY, z.nullable(signedLoadoutSchema), null).read();
}

export function saveEquippedLoadout(loadout: SignedLoadout | null): void {
  persisted(SNAPSHOT_KEY, z.nullable(signedLoadoutSchema), null).write(loadout);
  useProgress.setState({ runLevel: runLevelOf(loadout) });
}

/**
 * Уровень, который получит движок (WP25). Нет снимка — игра без входа или
 * вход ещё не удался — первый уровень; снимок прошлой сборки уровня не несёт —
 * тоже первый, до первого обновления снимка.
 */
export function runLevelOf(loadout: SignedLoadout | null): number {
  return loadout?.accountLevel ?? 1;
}

/**
 * Параметры, которых движок не знает, — от сервера новее клиента: подпись
 * считается по всем, поэтому снимок хранится целиком, а движку уходят
 * известные.
 */
export function knownModifiers(loadout: SignedLoadout): Partial<Record<LoadoutStat, number>> {
  const known: Partial<Record<LoadoutStat, number>> = {};
  for (const stat of LOADOUT_STATS) {
    const value = loadout.modifiers[stat];
    if (value !== undefined) known[stat] = value;
  }
  return known;
}

export function rememberRunLoadout(runId: string, loadout: SignedLoadout): void {
  const store = persisted(RUNS_KEY, runsSchema, []);
  const entries = store.read().filter((entry) => entry.runId !== runId);
  store.write([...entries, { runId, loadout }].slice(-RUNS_LIMIT));
}

export function runLoadoutOf(runId: string): SignedLoadout | undefined {
  return persisted(RUNS_KEY, runsSchema, []).read().find((entry) => entry.runId === runId)?.loadout;
}

function persisted<T>(key: string, schema: z.ZodMiniType<T>, fallback: T): ReturnType<typeof createPersistedValue<T>> {
  return createPersistedValue<T>({
    storage: useShell.getState().storage,
    key,
    schema,
    fallback,
    onBroken: (brokenKey, reason) => reportError("items", `${brokenKey}: ${reason}`),
  });
}
