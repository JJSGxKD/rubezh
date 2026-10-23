import { ACCOUNT_UNLOCKS, PASSIVES, unlocksAt, unlocksOfLevel, WEAPONS } from "@bh/core-game";
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

/**
 * Ближайшее открытие выше `level`: уровни без открытий (на лестнице их до двух
 * подряд) пропускаются. После последней строки таблицы — `null`.
 */
export function nextUnlockAfter(level: number): { level: number; unlocks: LevelUnlock[] } | null {
  const last = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));
  for (let candidate = level + 1; candidate <= last; candidate++) {
    const unlocks = unlocksGainedAt(candidate);
    if (unlocks.length > 0) return { level: candidate, unlocks };
  }
  return null;
}

export interface CollectionItem {
  id: string;
  /** уровень аккаунта, на котором предмет открывается */
  level: number;
}

/**
 * Всё оружие и все навыки с уровнем открытия, по порядку открытия — для
 * коллекции на экране уровня: открытое видно целиком, закрытое — целью
 * «откроется на N-м». Чего нет в таблице разблокировок, в коллекцию не идёт:
 * это проверяет тест контента, а не экран.
 */
export function collectionByLevel(): { weapons: CollectionItem[]; passives: CollectionItem[] } {
  const weapons: CollectionItem[] = [];
  const passives: CollectionItem[] = [];
  const rows = [...ACCOUNT_UNLOCKS].sort((a, b) => a.level - b.level);
  for (const row of rows) {
    for (const id of row.weapons ?? []) weapons.push({ id, level: row.level });
    for (const id of row.passives ?? []) passives.push({ id, level: row.level });
  }
  const known = (ids: readonly { id: string }[]) => new Set(ids.map((item) => item.id));
  const weaponIds = known(WEAPONS);
  const passiveIds = known(PASSIVES);
  return { weapons: weapons.filter((item) => weaponIds.has(item.id)), passives: passives.filter((item) => passiveIds.has(item.id)) };
}

export function nextUnlockLabel(next: { level: number; unlocks: LevelUnlock[] }): string {
  return t("level.open.next", { level: next.level, list: next.unlocks.map(unlockLabel).join(", ") });
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
