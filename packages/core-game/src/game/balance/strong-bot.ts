import type { UpgradeOption } from "@bh/shared-types";
import { WEAPONS } from "../../content/weapons";
import type { SimInput } from "../sim/step";
import { chestSizeOf } from "../sim/chests";
import { PICKUP_KIND } from "../sim/pickups";
import type { World } from "../sim/world";
import { createDodgingBot, type Bot } from "./bot";

/**
 * Сильный бот калибровки — модель опытного игрока (Р194, T-0389).
 *
 * Пассивный и уклоняющийся боты проверяют ранний бой: уклоняющийся умирает на
 * 2–4-й минуте и собирает набор к 17-й, а живые игроки живут 13–20 минут и
 * собирают набор к 10-й (отчёты с прода v0.12.2). Баланс, подогнанный под
 * слабого бота, остаётся лёгким для человека. Сильный бот делает то, что
 * делает опытный игрок, и коридоры по нему следят за лесенкой Р183 и за тем,
 * чтобы стоять на месте со связкой было нельзя:
 *
 * - **собирает опыт и подборы**, когда рядом нет угрозы, — иначе набор у него
 *   собирался бы к 17-й минуте, как у уклоняющегося;
 * - **выбирает карточки по плану**: «Очаг» и «Оберег», потом «Заживление»,
 *   «Живучесть» и «Магнит» (таблицы ниже);
 * - **бегает** (`kite`) или **стоит** (`stand`) с 180-й секунды — так играет
 *   игрок, который после 3-й минуты перестал двигаться (отчёт владельца).
 *
 * Бот детерминирован: ни генератора, ни тригонометрии (`sim-purity.test.ts`).
 */

export type StrongStance = "kite" | "stand";

export interface StrongBotOptions {
  stance: StrongStance;
}

/**
 * С какой секунды «стоит» перестаёт двигаться. Три минуты — как у отчёта
 * владельца: связка к этому времени уже собрана, и дальше он стоял.
 */
export const STAND_FROM_SEC = 180;

/**
 * Числа сильного бота. Единицы контента: умножаются на `world.config.unitScale`.
 * Выбраны по смыслу, а не по лучшей строке таблицы замера: бот — модель человека,
 * а не прибор, подгоняемый под коридор.
 */
export const STRONG_BOT = {
  /**
   * Радиус, в котором враг считается угрозой: с ним бот ведёт себя как
   * уклоняющийся. Чуть больше экрана вокруг героя по вертикали на телефоне —
   * дальше игрок врага «не замечает», пока тот не подошёл, и спокойно собирает.
   */
  safeRadiusUnits: 220,
  /**
   * Радиус, в котором бот идёт к кристаллу или подбору. Человек видит весь экран
   * и тянется к добыче, но не бежит через пол-карты: столько же, сколько радиус
   * видимости сундука у уклоняющегося, без запаса.
   */
  collectRadiusUnits: 340,
  /** Дальность, на которой он замечает сундук: тот не притягивается, и за ним идут нарочно. */
  chestRadiusUnits: 520,
  /**
   * Раз во сколько тиков бот пересчитывает курс: 12 тиков — 0,2 с. Опытный игрок
   * реагирует быстрее новичка (у уклоняющегося 0,3 с), но не мгновенно.
   */
  reactionTicks: 12,
  /** Сколько ближайших врагов он держит в уме при отходе: опытный видит толпу лучше новичка (у того четыре). */
  attentionCount: 6,
  /** Аптечку берёт, когда здоровья меньше этой доли: с полным она лежит и ждёт. */
  medkitBelowRatio: 0.9,
} as const;

/**
 * Приоритеты карточек. Источник — отчёты живых игроков (полный арсенал 1242 с и
 * игрок с 4-м уровнем аккаунта 813 с, v0.12.2) и решение Р194: оба выбирали связку
 * «Очаг» (урон вокруг себя) + «Оберег» (обереги кружат), потом «Заживление» и
 * «Живучесть», «Магнит» собирает опыт со всего поля. Это же рецепты эволюций
 * «Очага» и «Оберега» (`weapons.ts`), поэтому связка ведёт к ним.
 */
const CORE_WEAPONS: readonly string[] = ["hearth", "wardstone"];
const SURVIVAL_PASSIVES: readonly string[] = ["mending", "vitality", "lodestone"];
const DAMAGE_PASSIVES: readonly string[] = ["might", "haste"];
/** Записи «Предела» того же смысла: нечего прокачать — берётся прибавка к выживанию, потом к урону. */
const SURVIVAL_LIMITS: readonly string[] = ["regen", "maxHp"];
const DAMAGE_LIMITS: readonly string[] = ["damage", "cooldown"];

/** Рецепт эволюции каждого базового оружия: какой навык делает его «ведущим к эволюции». */
const RECIPE_PASSIVE = new Map<string, string>(
  WEAPONS.flatMap((weapon) => (weapon.evolvedFrom === undefined || weapon.recipe === undefined ? [] : [[weapon.evolvedFrom, weapon.recipe.passive] as const])),
);

/** Ступени предпочтения, меньше — лучше; внутри ступени порядок таблицы выше. */
const RANK = { evolve: 0, leading: 1, core: 2, survival: 3, damage: 4, weaponLevel: 5, rest: 6 } as const;

function indexIn(table: readonly string[], id: string): number {
  const index = table.indexOf(id);
  return index < 0 ? table.length : index;
}

/** Навыки в наборе: из мира, а без него — те, что бот брал сам. */
function ownedPassives(world: World | undefined, taken: ReadonlySet<string>): ReadonlySet<string> {
  if (world === undefined) return taken;
  const owned = new Set<string>(taken);
  for (const slot of world.loadout.passives) {
    const type = world.passiveTypes[slot.typeIndex];
    if (type !== undefined) owned.add(type.id);
  }
  return owned;
}

/**
 * Оружие «ведёт к эволюции»: оно из связки или навык его рецепта уже взят. Тогда
 * развитие идёт раньше новых навыков — сундук выдаст эволюцию, когда оба готовы.
 */
function isLeading(weaponId: string, owned: ReadonlySet<string>): boolean {
  if (CORE_WEAPONS.includes(weaponId)) return true;
  const recipe = RECIPE_PASSIVE.get(weaponId);
  return recipe !== undefined && owned.has(recipe);
}

function scoreOf(offer: UpgradeOption, owned: ReadonlySet<string>): number {
  switch (offer.kind) {
    case "weapon_evolve":
      return RANK.evolve * 100;
    case "weapon_level":
      if (isLeading(offer.refId, owned)) return RANK.leading * 100 + indexIn(CORE_WEAPONS, offer.refId);
      return RANK.weaponLevel * 100;
    case "weapon_new":
      return CORE_WEAPONS.includes(offer.refId) ? RANK.core * 100 + indexIn(CORE_WEAPONS, offer.refId) : RANK.rest * 100;
    case "passive_new":
    case "passive_level":
      if (SURVIVAL_PASSIVES.includes(offer.refId)) return RANK.survival * 100 + indexIn(SURVIVAL_PASSIVES, offer.refId);
      if (DAMAGE_PASSIVES.includes(offer.refId)) return RANK.damage * 100 + indexIn(DAMAGE_PASSIVES, offer.refId);
      return RANK.rest * 100;
    case "limit":
      if (SURVIVAL_LIMITS.includes(offer.refId)) return RANK.survival * 100 + 50 + indexIn(SURVIVAL_LIMITS, offer.refId);
      if (DAMAGE_LIMITS.includes(offer.refId)) return RANK.damage * 100 + 50 + indexIn(DAMAGE_LIMITS, offer.refId);
      return RANK.rest * 100;
    default:
      return RANK.rest * 100;
  }
}

/**
 * Выбор карточки по плану опытного игрока: развить оружие, ведущее к эволюции;
 * взять «Очаг» или «Оберег»; «Заживление», «Живучесть», «Магнит»; урон и
 * перезарядку; иначе первую карточку. Равные по ступени — первая из предложенных.
 */
export function pickCard(offers: readonly UpgradeOption[], owned: ReadonlySet<string>): UpgradeOption {
  let best = offers[0];
  let bestScore = scoreOf(best, owned);
  for (let i = 1; i < offers.length; i++) {
    const score = scoreOf(offers[i], owned);
    if (score < bestScore) {
      best = offers[i];
      bestScore = score;
    }
  }
  return best;
}

const target = { x: 0, y: 0 };

/**
 * Куда идти за добычей: сундук в пределах `chestRadiusUnits`, иначе ближайший
 * кристалл или подбор в пределах `collectRadiusUnits`. `false` — идти не за чем.
 * Сундук дороже кристалла: это пять улучшений сразу, и он не притягивается сам.
 */
function seekLoot(world: World, out: { x: number; y: number }): boolean {
  const player = world.player;
  const scale = world.config.unitScale;
  const collectReach = STRONG_BOT.collectRadiusUnits * scale;
  const chestReach = STRONG_BOT.chestRadiusUnits * scale;
  const hurt = player.hp < world.playerStats.maxHp * STRONG_BOT.medkitBelowRatio;

  let nearestChest = chestReach;
  let nearestLoot = collectReach;
  let chestX = 0;
  let chestY = 0;
  let lootX = 0;
  let lootY = 0;

  const pool = world.pickups;
  for (let i = 0; i < pool.count; i++) {
    if (pool.alive[i] === 0) continue;
    const kind = pool.kind[i];
    const isChest = chestSizeOf(kind) !== null;
    if (kind === PICKUP_KIND.medkit && !hurt) continue;
    const dx = pool.x[i] - player.x;
    const dy = pool.y[i] - player.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 1e-3) continue;
    if (isChest) {
      if (distance >= nearestChest) continue;
      nearestChest = distance;
      chestX = dx / distance;
      chestY = dy / distance;
    } else {
      if (distance >= nearestLoot) continue;
      nearestLoot = distance;
      lootX = dx / distance;
      lootY = dy / distance;
    }
  }
  if (nearestChest < chestReach) {
    out.x = chestX;
    out.y = chestY;
    return true;
  }

  const gems = world.gems;
  for (let i = 0; i < gems.count; i++) {
    if (gems.alive[i] === 0) continue;
    const dx = gems.x[i] - player.x;
    const dy = gems.y[i] - player.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 1e-3 || distance >= nearestLoot) continue;
    nearestLoot = distance;
    lootX = dx / distance;
    lootY = dy / distance;
  }
  if (nearestLoot < collectReach) {
    out.x = lootX;
    out.y = lootY;
    return true;
  }
  return false;
}

/** Есть ли живой враг в безопасном радиусе. Сетка перестроена на прошлом шаге: тик задержки боту не мешает. */
function hasThreat(world: World): boolean {
  const player = world.player;
  const reach = STRONG_BOT.safeRadiusUnits * world.config.unitScale;
  const found = world.enemyGrid.queryInto(player.x, player.y, reach, world.queryBuffer);
  for (let k = 0; k < found; k++) {
    const i = world.queryBuffer[k];
    if (world.enemies.alive[i] === 0) continue;
    const dx = world.enemies.x[i] - player.x;
    const dy = world.enemies.y[i] - player.y;
    if (dx * dx + dy * dy <= reach * reach) return true;
  }
  return false;
}

export function createStrongBot(options: StrongBotOptions): Bot {
  const { stance } = options;
  // Отход от толпы тот же, что у уклоняющегося, но с реакцией и вниманием опытного
  // игрока: сильный бот отличается тем, чем занят, когда угрозы нет, и выбором карточек.
  const evader = createDodgingBot({ reactionTicks: STRONG_BOT.reactionTicks, attentionCount: STRONG_BOT.attentionCount });
  const taken = new Set<string>();
  let calls = 0;
  let lastX = 1;
  let lastY = 0;

  return {
    input(world): SimInput {
      if (stance === "stand" && world.stats.elapsedSec >= STAND_FROM_SEC) return { moveX: 0, moveY: 0 };
      // Уклоняющийся зовётся каждый тик, чтобы его счётчик шёл в ногу с нашим:
      // курс отхода нужен, как только угроза перебивает добычу.
      const evade = evader.input(world);

      const recalculate = calls % STRONG_BOT.reactionTicks === 0;
      calls++;
      if (!recalculate) return { moveX: lastX, moveY: lastY };

      if (!hasThreat(world) && seekLoot(world, target)) {
        lastX = target.x;
        lastY = target.y;
      } else {
        lastX = evade.moveX;
        lastY = evade.moveY;
      }
      return { moveX: lastX, moveY: lastY };
    },

    choose(offers, world) {
      const chosen = pickCard(offers, ownedPassives(world, taken));
      if (chosen.kind === "passive_new" || chosen.kind === "passive_level") taken.add(chosen.refId);
      return chosen.id;
    },
  };
}
