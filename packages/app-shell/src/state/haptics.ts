import type { HapticType } from "@bh/shared-types";
import type { RunCues } from "@bh/core-game";
import { useSettings } from "./settings";
import { useShell } from "./shell";

/**
 * Вибрация на действия и события (docs/27-design-system-and-app-shell.md §4.5):
 * одна точка, один переключатель в настройках и ограничение частоты.
 *
 * Вибрация — не звук: её нельзя сделать тише, можно только реже. Поэтому у
 * каждого события свой минимальный интервал, а из пачки сигналов забега
 * выбирается одно самое важное — толпа врагов не должна превращать телефон
 * в электробритву.
 */

export type HapticEvent =
  /** обычная кнопка, пункт меню */
  | "tap"
  /** переключатель, вкладка, выбор из вариантов */
  | "select"
  /** крупная кнопка главного действия */
  | "primary"
  | "hit"
  | "lowHp"
  | "levelUp"
  | "upgrade"
  | "pickup"
  | "dynamite"
  | "blast"
  | "eliteSpawn"
  | "eliteKill"
  | "death"
  | "record";

interface HapticRule {
  type: HapticType;
  /** не чаще раза в столько миллисекунд */
  minIntervalMs: number;
}

export const HAPTIC_RULES: Record<HapticEvent, HapticRule> = {
  tap: { type: "light", minIntervalMs: 40 },
  select: { type: "selection", minIntervalMs: 40 },
  primary: { type: "medium", minIntervalMs: 60 },
  hit: { type: "light", minIntervalMs: 280 },
  lowHp: { type: "warning", minIntervalMs: 4000 },
  levelUp: { type: "success", minIntervalMs: 400 },
  upgrade: { type: "medium", minIntervalMs: 120 },
  pickup: { type: "soft", minIntervalMs: 200 },
  dynamite: { type: "heavy", minIntervalMs: 300 },
  blast: { type: "rigid", minIntervalMs: 350 },
  eliteSpawn: { type: "warning", minIntervalMs: 1500 },
  eliteKill: { type: "medium", minIntervalMs: 300 },
  death: { type: "error", minIntervalMs: 1000 },
  record: { type: "success", minIntervalMs: 1000 },
};

/** Между любыми двумя вибрациями: два удара ближе этого сливаются в один невнятный. */
const GLOBAL_MIN_INTERVAL_MS = 35;

const lastAt = new Map<HapticEvent, number>();
let lastAnyAt = Number.NEGATIVE_INFINITY;

export function haptic(event: HapticEvent, nowMs: number = performance.now()): boolean {
  if (!useSettings.getState().haptics) return false;
  const rule = HAPTIC_RULES[event];
  if (nowMs - (lastAt.get(event) ?? Number.NEGATIVE_INFINITY) < rule.minIntervalMs) return false;
  if (nowMs - lastAnyAt < GLOBAL_MIN_INTERVAL_MS) return false;
  lastAt.set(event, nowMs);
  lastAnyAt = nowMs;
  useShell.getState().adapter.haptic(rule.type);
  return true;
}

/**
 * Из пачки сигналов — одна вибрация, самая важная. Порядок — что игроку
 * важнее почувствовать: взрыв динамита и взрыв рядом сильнее попадания,
 * появление элиты — предупреждение, подбор — мягкое подтверждение.
 */
export function hapticForCues(cues: RunCues, nowMs: number = performance.now()): HapticEvent | null {
  const event: HapticEvent | null =
    cues.dynamite > 0
      ? "dynamite"
      : cues.explosionsNear > 0
        ? "blast"
        : cues.eliteSpawns > 0
          ? "eliteSpawn"
          : cues.playerHit > 0
            ? "hit"
            : cues.eliteKills > 0
              ? "eliteKill"
              : cues.heal > 0 || cues.magnet > 0
                ? "pickup"
                : null;
  if (event === null) return null;
  return haptic(event, nowMs) ? event : null;
}

/** Для тестов: забыть, когда что вибрировало. */
export function resetHaptics(): void {
  lastAt.clear();
  lastAnyAt = Number.NEGATIVE_INFINITY;
}
