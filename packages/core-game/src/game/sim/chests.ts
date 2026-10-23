import type { ChestReward, ChestSize, ChestSource, ChestsDef, EnemyRank } from "@bh/shared-types";
import { readyEvolutionOption } from "../progression/evolutions";
import { addXp, applyUpgrade, collectCandidates, drawWeighted, healOption } from "../progression/levels";
import { createDirection, randomDirection } from "./directions";
import { countOnField, MAX_PICKUPS_OF_KIND, PICKUP_KIND, SCATTER_MAX_UNITS, SCATTER_MIN_UNITS, spawnPickup, type PickupKind } from "./pickups";
import { clampToBounds, type ChestFound, type ChestOpening, type World } from "./world";

/**
 * Сундук забега (docs/39-retention-mechanics.md Б1, Р102): падает с элиты и
 * босса, при касании выдаёт 1, 3 или 5 улучшений сразу, без выбора.
 *
 * Случайность — собственный поток `world.chests.rng`, а не `world.rng`: иначе
 * любой бросок сундука сдвинул бы все golden-прогоны и все предложения
 * уровней. Ни одного обращения к `world.rng` в этом файле быть не должно.
 */

/**
 * Размер сундука → вид подбора на поле. Функциями, а не таблицами на уровне
 * модуля: `pickups.ts` и этот файл импортируют друг друга, и `PICKUP_KIND` при
 * загрузке модуля может оказаться ещё не заполненным.
 */
function kindOfSize(size: ChestSize): PickupKind {
  return size === 1 ? PICKUP_KIND.chestOne : size === 3 ? PICKUP_KIND.chestThree : PICKUP_KIND.chestFive;
}

/** Размер сундука по виду подбора; `null` — подбор не сундук. */
export function chestSizeOf(kind: number): ChestSize | null {
  if (kind === PICKUP_KIND.chestOne) return 1;
  if (kind === PICKUP_KIND.chestThree) return 3;
  if (kind === PICKUP_KIND.chestFive) return 5;
  return null;
}

const ALLOWED_CHEST_SIZES: readonly ChestSize[] = [1, 3, 5];
const ALLOWED_SIZES: readonly number[] = ALLOWED_CHEST_SIZES;

const scratch = createDirection();

// --- Контент ------------------------------------------------------------------

export function findChestsProblems(def: ChestsDef): string[] {
  const problems: string[] = [];

  def.opening.forEach((size, i) => {
    if (!ALLOWED_SIZES.includes(size)) problems.push(`chests.opening[${i}] — размер 1, 3 или 5, сейчас ${size}`);
  });

  if (def.sizes.length === 0) problems.push("chests.sizes — нужен хотя бы один размер");
  def.sizes.forEach((entry, i) => {
    if (!ALLOWED_SIZES.includes(entry.size)) {
      problems.push(`chests.sizes[${i}].size — размер 1, 3 или 5, сейчас ${entry.size}`);
    }
    if (!(entry.weight > 0)) problems.push(`chests.sizes[${i}].weight — больше 0, сейчас ${entry.weight}`);
  });

  if (!def.sizes.some((entry) => entry.size === def.bossMinSize)) {
    // Иначе босс не находил бы себе размера в таблице весов.
    problems.push(`chests.bossMinSize — размер из sizes, сейчас ${def.bossMinSize}`);
  }
  if (!(def.ownedWeightMul >= 1)) {
    problems.push(`chests.ownedWeightMul — не меньше 1, сейчас ${def.ownedWeightMul}`);
  }
  for (const key of ["lowHpRatio", "xpRatio"] as const) {
    if (!(def[key] > 0 && def[key] <= 1)) problems.push(`chests.${key} — больше 0 и не больше 1, сейчас ${def[key]}`);
  }
  if (!Number.isInteger(def.maxOnField) || def.maxOnField < 0 || def.maxOnField > MAX_PICKUPS_OF_KIND) {
    problems.push(`chests.maxOnField — целое от 0 до ${MAX_PICKUPS_OF_KIND}, сейчас ${def.maxOnField}`);
  }
  return problems;
}

// --- Выпадение ----------------------------------------------------------------

/**
 * Уронить сундук на месте убитого врага. Рядовые не роняют; на поле не больше
 * `maxOnField` сундуков. Вызывается после выпадения подборов.
 */
export function dropChest(world: World, x: number, y: number, rank: EnemyRank | "normal"): void {
  if (rank === "normal") return;
  if (!world.config.lootEnabled || !world.config.progressionEnabled) return;

  const rules = world.chestRules;
  if (chestsOnField(world) >= rules.maxOnField) return;

  const chests = world.chests;
  const source: ChestSource = rank;
  let size = rollSize(world);
  if (source === "boss" && size < rules.bossMinSize) size = rules.bossMinSize;

  // Разброс как у подборов, но направление и расстояние — из потока сундуков.
  randomDirection(chests.rng, scratch);
  const distance = chests.rng.nextRange(SCATTER_MIN_UNITS, SCATTER_MAX_UNITS) * world.config.unitScale;
  const bounds = world.config.bounds;
  const placed = spawnPickup(
    world,
    kindOfSize(size),
    clampToBounds(x + scratch.x * distance, bounds.halfWidth),
    clampToBounds(y + scratch.y * distance, bounds.halfHeight),
    x,
    y,
  );
  // Пул подборов полон: сундука нет, и номер для схемы «1, 3, 1, 5» не занят.
  if (!placed) return;

  chests.founds.push({ index: chests.dropped, size, source, elapsedSec: world.stats.elapsedSec });
  chests.dropped++;
  world.stats.chestsFound++;
}

/** Размер очередного сундука: сначала схема, потом бросок по весам. */
function rollSize(world: World): ChestSize {
  const rules = world.chestRules;
  const scripted = rules.opening[world.chests.dropped];
  if (scripted !== undefined) return scripted;

  const index = drawWeighted(world.chests.rng, rules.sizes);
  return rules.sizes[index].size;
}

export function chestsOnField(world: World): number {
  let count = 0;
  for (const size of ALLOWED_CHEST_SIZES) count += countOnField(world, kindOfSize(size));
  return count;
}

// --- Открытие -----------------------------------------------------------------

/**
 * Выдать `size` улучшений. Кандидаты те же, что у карточек уровня, поэтому
 * сундук не выдаёт то, что нельзя взять. Предложения и очередь уровней не
 * трогаются: открытие не заменяет и не откладывает выбор на уровне.
 */
export function openChest(world: World, size: ChestSize): void {
  const chests = world.chests;
  const rewards: ChestReward[] = [];
  let fallbacks = 0;

  // Готовая эволюция — первой наградой и без броска: сундук из одной награды
  // отдаёт только её. Готовность смотрится один раз, в начале: награды этого же
  // сундука эволюцию не создают, она придёт со следующим.
  const evolution = readyEvolutionOption(world);
  if (evolution !== null) {
    applyUpgrade(world, evolution);
    rewards.push(evolution);
  }

  for (let k = rewards.length; k < size; k++) {
    const candidates = collectCandidates(world);
    if (candidates.length === 0) {
      rewards.push(fallbackReward(world));
      fallbacks++;
      continue;
    }

    // Развитие уже взятого весит больше нового: сундук должен усиливать билд,
    // а не раскидывать его по новым предметам.
    const weighted = candidates.map((candidate) => ({
      option: candidate.option,
      weight: candidate.option.kind.endsWith("_level") ? candidate.weight * world.chestRules.ownedWeightMul : candidate.weight,
    }));
    const option = weighted[drawWeighted(chests.rng, weighted)].option;
    applyUpgrade(world, option);
    rewards.push(option);
  }

  chests.openings.push({ index: chests.opened, size, rewards, fallbacks, elapsedSec: world.stats.elapsedSec });
  chests.opened++;
  world.stats.chestsOpened++;
}

/**
 * Награда, когда улучшать нечего: аптечка, пока здоровье ниже порога, иначе
 * часть опыта. Опыт в «собрано» не идёт — это счётчик кристаллов.
 */
function fallbackReward(world: World): ChestReward {
  if (world.player.hp < world.playerStats.maxHp * world.chestRules.lowHpRatio) {
    const heal = healOption();
    applyUpgrade(world, heal);
    return heal;
  }

  const amount = Math.ceil(world.progression.xpToNext * world.chestRules.xpRatio);
  addXp(world, amount, false);
  return {
    id: "xp",
    kind: "xp",
    refId: "",
    level: 0,
    nameKey: "upgrade.xp.name",
    descriptionKey: "upgrade.xp.description",
    changes: [{ labelKey: "upgrade.xp.label", from: null, to: amount, format: "plus", lowerIsBetter: false }],
  };
}

// --- События для сцены ----------------------------------------------------------

/** Сколько записей сцена уже забрала. */
export interface ChestCursor {
  found: number;
  opened: number;
}

export interface ChestEvents {
  found: ChestFound[];
  opened: ChestOpening[];
  cursor: ChestCursor;
}

/** Новые записи после курсора и сдвинутый курсор. Мир не меняется. */
export function takeChestEvents(world: World, cursor: ChestCursor): ChestEvents {
  const { founds, openings } = world.chests;
  return {
    found: founds.slice(cursor.found),
    opened: openings.slice(cursor.opened),
    cursor: { found: founds.length, opened: openings.length },
  };
}
