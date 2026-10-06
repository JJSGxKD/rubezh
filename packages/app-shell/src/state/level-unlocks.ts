import { ACCOUNT_UNLOCKS, unlocksAt, unlocksOfLevel } from "@bh/core-game";
import { PASSIVE_CATEGORIES, type PassiveCategory } from "@bh/shared-types";
import { t } from "../i18n";

/**
 * Что открывает уровень аккаунта (docs/35-stage4-plan.md Р42): оружие, навыки
 * и слоты — из таблицы разблокировок движка, той же, что решает, что есть в
 * забеге. Экран уровня и плашка после забега говорят ровно то, что откроет
 * следующий забег.
 */
export type LevelUnlock =
  | { kind: "weapon"; id: string }
  | { kind: "passive"; id: string }
  | { kind: "weaponSlots"; count: number }
  | { kind: "passiveSlots"; category: PassiveCategory; count: number };

/** Что даёт сам уровень; первый — стартовый набор, он ничего не «открывает». */
export function unlocksGainedAt(level: number): LevelUnlock[] {
  const row = unlocksOfLevel(ACCOUNT_UNLOCKS, level);
  if (row === null || level <= 1) return [];
  const before = unlocksAt(ACCOUNT_UNLOCKS, level - 1).limits;
  const after = unlocksAt(ACCOUNT_UNLOCKS, level).limits;
  const gained: LevelUnlock[] = [
    ...(row.weapons ?? []).map((id): LevelUnlock => ({ kind: "weapon", id })),
    ...(row.passives ?? []).map((id): LevelUnlock => ({ kind: "passive", id })),
  ];
  if (after.weapons > before.weapons) gained.push({ kind: "weaponSlots", count: after.weapons });
  for (const category of PASSIVE_CATEGORIES) {
    if (after.passives[category] > before.passives[category]) gained.push({ kind: "passiveSlots", category, count: after.passives[category] });
  }
  return gained;
}

/** Открытое уровнями после `fromLevel` и до `toLevel` включительно — за забег их может быть несколько. */
export function unlocksGainedBetween(fromLevel: number, toLevel: number): LevelUnlock[] {
  const gained: LevelUnlock[] = [];
  for (let level = fromLevel + 1; level <= toLevel; level++) gained.push(...unlocksGainedAt(level));
  return gained;
}

export function unlockLabel(unlock: LevelUnlock): string {
  switch (unlock.kind) {
    case "weapon":
      return t("level.unlock.weapon", { name: t(`weapon.${unlock.id}.name`) });
    case "passive":
      return t("level.unlock.passive", { name: t(`passive.${unlock.id}.name`) });
    case "weaponSlots":
      return t("level.unlock.weaponSlots", { count: unlock.count });
    case "passiveSlots":
      return t("level.unlock.passiveSlots", { count: unlock.count, category: t(`passive.category.${unlock.category}`) });
  }
}
