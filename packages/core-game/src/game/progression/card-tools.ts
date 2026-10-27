import type { CardTools } from "@bh/shared-types";
import type { World } from "../sim/world";
import { addXp, collectCandidates, drawWeighted, healOption, isAwaitingChoice, OFFERS_PER_LEVEL, pickWeighted, type Candidate } from "./levels";

/**
 * Переброс, пропуск и изгнание карточек (docs/39-retention-mechanics.md Б3,
 * docs/35-stage4-plan.md Р102): единственное, чем игрок исправляет «выпало не
 * то». Заряды дают уровень аккаунта и буст «Контроль», между забегами они не
 * переносятся.
 *
 * Новые карточки берутся из отдельного потока (`world.cardRng`), а не из
 * `world.rng`: первое предложение уровня бросает `world.rng`, как раньше, и
 * забег без зарядов не меняется ни на бит.
 *
 * Действия приходят снаружи — из интерфейса и из лога ввода при повторе
 * забега, — поэтому каждое проверяется: невозможная команда возвращает
 * `null` и ничего не меняет, заряд цел.
 */

/** Условные id в логе выбора: обычный id варианта с `~` не начинается. */
export const REROLL_COMMAND = "~reroll";
export const SKIP_COMMAND = "~skip";
export const BANISH_PREFIX = "~banish:";

/** Страховка: сумма зарядов каждого вида (уровень аккаунта + бусты) не выше. */
export const MAX_CARD_TOOLS = 9;

export type CardToolKind = keyof CardTools;

export interface CardToolOutcome {
  kind: CardToolKind;
  /** зарядов этого вида осталось */
  left: number;
  /** изгнанный предмет (`weapon:<id>` / `passive:<id>`); у остальных — `null` */
  item: string | null;
}

export function isCardToolCommand(optionId: string): boolean {
  return optionId.startsWith("~");
}

/** Ключ предмета для списка изгнанных; у лечения и опыта предмета нет. */
export function itemKeyOf(option: { kind: string; refId: string }): string | null {
  if (option.kind === "weapon_new" || option.kind === "weapon_level") return `weapon:${option.refId}`;
  if (option.kind === "passive_new" || option.kind === "passive_level") return `passive:${option.refId}`;
  return null;
}

/** Новые кандидаты — те, что не показаны на карточках прямо сейчас. */
function candidatesOutside(world: World, shown: ReadonlySet<string>): Candidate[] {
  return collectCandidates(world).filter((candidate) => !shown.has(candidate.option.id));
}

function shownIds(world: World): Set<string> {
  return new Set(world.progression.offers.map((offer) => offer.id));
}

function hasItemCards(world: World): boolean {
  return world.progression.offers.some((offer) => itemKeyOf(offer) !== null);
}

/** Сработает ли переброс: заряд есть, на карточках не одно лечение и есть что показать нового. */
export function canReroll(world: World): boolean {
  return (
    isAwaitingChoice(world) &&
    world.progression.tools.reroll > 0 &&
    hasItemCards(world) &&
    candidatesOutside(world, shownIds(world)).length > 0
  );
}

/**
 * Применить команду из лога выбора. `null` — мир не ждёт выбора, заряда нет,
 * команда незнакома, вариант не найден или это лечение.
 */
export function applyCardTool(world: World, command: string): CardToolOutcome | null {
  if (!isAwaitingChoice(world)) return null;
  if (command === REROLL_COMMAND) return reroll(world);
  if (command === SKIP_COMMAND) return skip(world);
  if (command.startsWith(BANISH_PREFIX)) return banish(world, command.slice(BANISH_PREFIX.length));
  return null;
}

function reroll(world: World): CardToolOutcome | null {
  if (!canReroll(world)) return null;
  const progression = world.progression;
  const shown = shownIds(world);
  const fresh = candidatesOutside(world, shown);

  // Число карточек то же, что при наборе уровня; если новых не хватает,
  // добираем из прежних: игрок не должен видеть меньше, чем видел.
  const wanted = OFFERS_PER_LEVEL + world.boosts.extraOffers;
  const next = pickWeighted(world.cardRng, fresh, wanted);
  if (next.length < wanted) {
    const previous = collectCandidates(world).filter((candidate) => shown.has(candidate.option.id));
    next.push(...pickWeighted(world.cardRng, previous, wanted - next.length));
  }

  progression.offers = next;
  progression.tools.reroll--;
  return { kind: "reroll", left: progression.tools.reroll, item: null };
}

function skip(world: World): CardToolOutcome | null {
  const progression = world.progression;
  if (progression.tools.skip <= 0) return null;

  // Награда считается от порога до накопления: уровень, который наберёт
  // сама награда, откроется штатно следующим выбором.
  const reward = Math.ceil(progression.xpToNext * world.cardRules.skipXpRatio);
  progression.tools.skip--;
  progression.offers = [];
  progression.pendingLevelUps = Math.max(0, progression.pendingLevelUps - 1);
  // Опыт пропуска в «собрано» не идёт: счётчик показывает подобранные кристаллы.
  addXp(world, reward, false);
  return { kind: "skip", left: progression.tools.skip, item: null };
}

function banish(world: World, optionId: string): CardToolOutcome | null {
  const progression = world.progression;
  if (progression.tools.banish <= 0) return null;
  const index = progression.offers.findIndex((offer) => offer.id === optionId);
  if (index < 0) return null;
  const key = itemKeyOf(progression.offers[index]);
  if (key === null) return null;

  if (!progression.banished.includes(key)) progression.banished.push(key);
  progression.tools.banish--;

  // Изгнанный предмет уже не кандидат, поэтому замена берётся из тех, что
  // не показаны: две одинаковые карточки на экране не нужны.
  const pool = candidatesOutside(world, shownIds(world));
  if (pool.length > 0) {
    progression.offers[index] = pool[drawWeighted(world.cardRng, pool)].option;
  } else {
    progression.offers.splice(index, 1);
    // Выбирать больше не из чего — остаётся запасной вариант, мир не зависает.
    if (progression.offers.length === 0) progression.offers = [healOption()];
  }
  return { kind: "banish", left: progression.tools.banish, item: key };
}
