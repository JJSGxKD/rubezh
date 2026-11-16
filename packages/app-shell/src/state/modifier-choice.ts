import { RUN_MODIFIER_IDS, RUN_MODIFIER_REWARD_MUL, type RunModifierId } from "@bh/shared-types";
import { ACCOUNT_UNLOCKS, RUN_MODIFIERS, unlockLevelOf } from "@bh/core-game";
import { t } from "../i18n";

/**
 * Выбор модификатора забега в листе «Перед забегом» (tasks/T-0123, Р105):
 * чистая логика без React, чтобы её проверять без экрана. Уровень открытия
 * берётся из таблицы разблокировок движка, процент награды — из таблицы
 * множителей `shared-types`; своих копий чисел в оболочке нет.
 */

export interface ModifierRow {
  id: RunModifierId;
  nameKey: string;
  descriptionKey: string;
  /** уровень аккаунта, с которого модификатор доступен */
  level: number;
  /** закрыт при текущем уровне аккаунта */
  locked: boolean;
}

function isModifierId(id: string | null | undefined): id is RunModifierId {
  return id !== null && id !== undefined && (RUN_MODIFIER_IDS as readonly string[]).includes(id);
}

/**
 * Пункты блока в порядке контента. Модификатор, которого нет в таблице
 * разблокировок, считается закрытым (уровень `Infinity` в лист не попадает:
 * такое ловит тест контента, а не экран).
 */
export function modifierRows(accountLevel: number): ModifierRow[] {
  return RUN_MODIFIERS.map((modifier) => {
    const level = unlockLevelOf(ACCOUNT_UNLOCKS, "modifier", modifier.id) ?? Number.POSITIVE_INFINITY;
    return { id: modifier.id, nameKey: modifier.nameKey, descriptionKey: modifier.descriptionKey, level, locked: accountLevel < level };
  });
}

/**
 * Доступный выбор из сохранённого: закрытый уровнем, неизвестный id и «ничего»
 * дают `null` («Без») молча.
 */
export function resolveModifierChoice(saved: string | null | undefined, accountLevel: number): RunModifierId | null {
  if (!isModifierId(saved)) return null;
  const row = modifierRows(accountLevel).find((candidate) => candidate.id === saved);
  return row === undefined || row.locked ? null : saved;
}

/** Выбор листа в список для движка и старта; «Без» — без поля. */
export function modifierIdsOf(choice: RunModifierId | null): RunModifierId[] | undefined {
  return choice === null ? undefined : [choice];
}

/** Сколько процентов к награде даёт модификатор — из таблицы множителей. */
export function rewardPercent(id: RunModifierId): number {
  return Math.round((RUN_MODIFIER_REWARD_MUL[id] - 1) * 100);
}

/** Строка под переключателем: «Награда +25%, в рейтинг не идёт». */
export function modifierRewardNote(id: RunModifierId): string {
  return t("modifier.reward", { percent: rewardPercent(id) });
}

/** Поле `modifier` событий забега (словарь T-0122): первый id; забег без модификатора поля не несёт. */
export function modifierEventFields(ids: readonly string[] | undefined): { modifier?: RunModifierId } {
  const first = ids?.[0];
  return isModifierId(first) ? { modifier: first } : {};
}

/** Экран смерти: «Модификатор: Спешка»; нет модификатора — нет и строки. */
export function deathModifierLine(ids: readonly string[] | undefined): string | null {
  const first = ids?.[0];
  return isModifierId(first) ? t("death.modifier", { name: t(`modifier.${first}.name`) }) : null;
}

/**
 * Пометка множителя у награды: только когда награда пришла. Без сети или пока
 * награда считается — без пометки: обещаний нет.
 */
export function rewardMulMark(ids: readonly string[] | undefined, rewardStatus: "pending" | "granted" | "none" | undefined): string | null {
  const first = ids?.[0];
  if (rewardStatus !== "granted" || !isModifierId(first)) return null;
  return `×${RUN_MODIFIER_REWARD_MUL[first].toLocaleString("ru-RU")}`;
}
