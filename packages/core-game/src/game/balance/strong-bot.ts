import type { UpgradeOption } from "@bh/shared-types";
import { WEAPONS } from "../../content/weapons";
import type { SimInput } from "../sim/step";
import { chestSizeOf } from "../sim/chests";
import { PICKUP_KIND } from "../sim/pickups";
import type { World } from "../sim/world";
import { BANISH_PREFIX, canReroll, itemKeyOf, REROLL_COMMAND } from "../progression/card-tools";
import { ORBITER_RADIUS } from "../weapons";
import { createDirection, ringDirection } from "../sim/directions";
import type { Bot } from "./bot";

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
 * - **собирает опыт и подборы** — когда угрозы рядом нет, идёт прямо к добыче, в бою
 *   тянется за ней в просвет; иначе набор у него собирался бы к 17-й минуте, как у
 *   уклоняющегося;
 * - **выбирает просвет** в кольце врагов из шестнадцати направлений, а не «подальше от
 *   ближайшего»;
 * - **выбирает карточки по плану**: «Очаг» и «Оберег», потом «Заживление»,
 *   «Живучесть» и «Магнит» (таблицы ниже); пока их нет в наборе, перебрасывает карточки,
 *   а мешающие связке изгоняет — заряды дают уровень аккаунта и бусты;
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
 * Шаг стоящего бота (Р196): после `STAND_FROM_SEC` владелец не замирал совсем. В записи
 * (`test/fixtures/veteran-run-v0122.json`) он двигался 50% тиков до 3-й минуты, 44% с 3-й по
 * 10-ю и 4% после: короткие шаги по 24 тика (0,4 с, медиана серии), между ними пауза 84 тика
 * (1,4 с, медиана покоя) и дольше. Правило одно: пока стоит, шагает от врага, подошедшего ближе
 * `radiusUnits`, на `ticks` тиков, потом не шагает `cooldownTicks`. Радиус подобран так, чтобы
 * доля движения бота после 3-й минуты на контенте до T-0388 совпала с записью (19%).
 */
export const STAND_STEP = { radiusUnits: 80, ticks: 24, cooldownTicks: 84 } as const;

/**
 * Числа сильного бота. Единицы контента: умножаются на `world.config.unitScale`.
 * Выбраны по смыслу, а не по лучшей строке таблицы замера: бот — модель человека,
 * а не прибор, подгоняемый под коридор.
 */
export const STRONG_BOT = {
  /**
   * Радиус, в котором враг считается угрозой: пока он есть, бот выбирает просвет, а не
   * идёт прямо к добыче. Дальше игрок врага «не замечает», пока тот не подошёл, и спокойно
   * собирает; радиус немного больше дистанции дальнего оружия (`rangedHoldUnits`).
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
  /** Аптечку берёт, когда здоровья меньше этой доли: с полным она лежит и ждёт. */
  medkitBelowRatio: 0.9,
  /**
   * Дистанция, на которой бот держит врагов, если бьёт издали: как у уклоняющегося.
   * Оружию вблизи (оберег, очаг, нож) нужно ближе — его дистанция считается от оружия.
   */
  rangedHoldUnits: 200,
  /** Нож и прочее оружие «по ходу движения» бьёт, только когда бегут на врага: подпускать почти вплотную. */
  facingHoldUnits: 90,
  /** Запас поверх радиуса оружия ближнего боя: враги у самой кромки кольца или ауры, а не внутри. */
  contactMarginUnits: 20,
  /** Дальность, на которой бот замечает врага, когда спокойно подходит к нему, — как у уклоняющегося. */
  approachRadiusUnits: 460,
  /**
   * На сколько секунд вперёд бот прикидывает, куда шагнуть: полсекунды — столько
   * человеку нужно, чтобы заметить смыкающийся круг и выбрать просвет.
   */
  lookaheadSec: 0.5,
  /** Сколько ближайших врагов учитывается при выборе просвета: дальше человек толпу не взвешивает. */
  scanLimit: 96,
  /** Вес притяжения к ближайшему врагу, когда тот дальше удобной дистанции, в долях опасности одного врага вплотную. */
  approachWeight: 0.35,
  /**
   * Вес притяжения к добыче, пока рядом враги, в тех же долях. Опытный игрок не ждёт тишины:
   * в поздней игре её не бывает, и тянется за кристаллом, если путь не через толпу. Меньше
   * опасности одного врага вплотную — через строй за кристаллом бот не идёт.
   */
  lootWeight: 0.2,
  /** Вес прежнего курса: без него бот дёргается между двумя равными просветами. */
  stickinessWeight: 0.15,
} as const;

/** Сколько направлений бот пробует при выборе просвета. */
const CANDIDATES = 16;

/**
 * План карточек — по записи забега владельца на v0.12.2 (Р196, фикстура
 * `test/fixtures/veteran-run-v0122.json`, 1242 с, уровень 64). Он брал новое в таком порядке:
 * «Живучесть», «Спешка», «Искра», «Обережный камень» (после «Очага», с которого начал),
 * «Заживление», «Мощь», «Магнит»; дальше развивал оружие («Искра» до 8-го уровня, «Очаг»,
 * «Обережный камень»), потом навыки и, когда прокачивать стало нечего, малые прибавки
 * «Предела» (перезарядка, урон, площадь, притяжение). «Быстроту» не брал ни разу. Это же
 * связка из отчётов Р194: «Очаг» + «Оберег» + «Заживление», рецепты их эволюций.
 *
 * Ключ — `weapon:<id>` или `passive:<id>`; порядок в списке — порядок взятия нового.
 */
const PLAN: readonly string[] = [
  "passive:vitality",
  "passive:haste",
  "weapon:spark",
  "weapon:hearth",
  "weapon:wardstone",
  "passive:mending",
  "passive:might",
  "passive:lodestone",
];
const PLAN_WEAPONS: readonly string[] = PLAN.filter((key) => key.startsWith("weapon:")).map((key) => key.slice("weapon:".length));
const PLAN_PASSIVES: readonly string[] = PLAN.filter((key) => key.startsWith("passive:")).map((key) => key.slice("passive:".length));
/**
 * Навыки, которые бот не берёт, пока есть выбор: они занимают слот категории, которого
 * ждёт навык из плана. «Быструю» ногу владелец не брал: единственный слот подвижности ждал
 * «Магнит» (и рецепт эволюции «Оберега»); взятая раньше, она закрывает его до конца забега.
 */
const SLOT_BLOCKERS: readonly string[] = ["swiftness"];
/** Малые прибавки «Предела» в порядке, в котором их брал владелец чаще всего (перезарядка 14, урон 12, площадь 7, притяжение 4). */
const LIMIT_ORDER: readonly string[] = ["cooldown", "damage", "area", "pull", "regen", "maxHp"];

/** Рецепт эволюции каждого базового оружия: какой навык делает его «ведущим к эволюции». */
const RECIPE_PASSIVE = new Map<string, string>(
  WEAPONS.flatMap((weapon) => (weapon.evolvedFrom === undefined || weapon.recipe === undefined ? [] : [[weapon.evolvedFrom, weapon.recipe.passive] as const])),
);

/** До какого уровня единственное оружие качается раньше нового из плана. */
const LONE_WEAPON_LEVELS = 3;

/** Оценка карточки, меньше — лучше: ступень × 100 плюс место в таблице. */
const RANK = { evolve: 0, planNew: 1, weaponLevel: 2, passiveLevel: 3, limit: 4, otherLevel: 5, rest: 6, blocker: 9 } as const;

/** Что бот знает о своём наборе в момент выбора. */
export interface PickContext {
  /** навыки в наборе */
  passives: ReadonlySet<string>;
  /** оружие в наборе (без эволюций: у них своего слота-цели нет) */
  weapons: ReadonlySet<string>;
  /** свободных слотов оружия; `null` — мира нет, и сказать нечего */
  freeWeaponSlots: number | null;
  /** есть ли в плане то, чего в наборе ещё нет и что можно взять (слот свободен) */
  planIncomplete: boolean;
}

/** Набор из мира, а без мира — то, что бот брал сам: слотов он тогда не знает. */
function contextOf(world: World | undefined, taken: { passives: ReadonlySet<string>; weapons: ReadonlySet<string> }): PickContext {
  if (world === undefined) return { passives: taken.passives, weapons: taken.weapons, freeWeaponSlots: null, planIncomplete: false };
  const passives = new Set<string>(taken.passives);
  for (const slot of world.loadout.passives) {
    const type = world.passiveTypes[slot.typeIndex];
    if (type !== undefined) passives.add(type.id);
  }
  const weapons = new Set<string>();
  for (const slot of world.loadout.weapons) {
    const type = world.weaponTypes[slot.typeIndex];
    if (type !== undefined) weapons.add(type.id);
  }
  const freeWeaponSlots = world.loadoutLimits.weapons - world.loadout.weapons.length;
  return { passives, weapons, freeWeaponSlots, planIncomplete: isPlanIncomplete(world, passives, weapons, freeWeaponSlots) };
}

/**
 * Осталось ли в плане то, чего в наборе нет: оружие плана при свободном слоте оружия или
 * навык плана при свободном слоте его категории. Пока осталось, опытный игрок перебрасывает
 * карточки, на которых плана нет.
 */
function isPlanIncomplete(world: World, passives: ReadonlySet<string>, weapons: ReadonlySet<string>, freeWeaponSlots: number): boolean {
  if (freeWeaponSlots > 0 && PLAN_WEAPONS.some((id) => !weapons.has(id) && world.weaponTypes.some((type) => type.id === id))) return true;
  return PLAN_PASSIVES.some((id) => {
    if (passives.has(id)) return false;
    const type = world.passiveTypes.find((candidate) => candidate.id === id);
    if (type === undefined) return false;
    let inCategory = 0;
    for (const slot of world.loadout.passives) if (world.passiveTypes[slot.typeIndex]?.category === type.category) inCategory++;
    return inCategory < world.loadoutLimits.passives[type.category];
  });
}

/**
 * Оружие «ведёт к эволюции»: оно из плана или навык его рецепта уже взят. Развитие такого
 * оружия идёт раньше прочих уровней — сундук выдаст эволюцию, когда оба готовы.
 */
function isLeading(weaponId: string, context: PickContext): boolean {
  if (PLAN_WEAPONS.includes(weaponId)) return true;
  const recipe = RECIPE_PASSIVE.get(weaponId);
  return recipe !== undefined && context.passives.has(recipe);
}

/**
 * Не отдать слоты плана чужому оружию: новое оружие вне плана берётся, только если после
 * него слотов хватит на ещё не взятое оружие плана. Без мира слотов не видно, и правило молчит.
 */
function squeezesPlan(context: PickContext): boolean {
  if (context.freeWeaponSlots === null) return false;
  const missing = PLAN_WEAPONS.filter((id) => !context.weapons.has(id)).length;
  return context.freeWeaponSlots <= missing;
}

function scoreOf(offer: UpgradeOption, context: PickContext): number {
  switch (offer.kind) {
    case "weapon_evolve":
      return RANK.evolve * 100;
    case "weapon_new": {
      const place = PLAN.indexOf(`weapon:${offer.refId}`);
      if (place >= 0) return RANK.planNew * 100 + place;
      return (squeezesPlan(context) ? RANK.blocker : RANK.rest) * 100;
    }
    case "passive_new": {
      const place = PLAN.indexOf(`passive:${offer.refId}`);
      if (place >= 0) return RANK.planNew * 100 + place;
      return (SLOT_BLOCKERS.includes(offer.refId) ? RANK.blocker : RANK.rest) * 100;
    }
    case "weapon_level":
      // Единственное оружие качают первым, пока оно слабо: «Искра» первого уровня первые минуты никого
      // не останавливает, а у владельца роль единственного играл «Очаг», и до его уровней дело не доходило.
      if (context.weapons.size <= 1 && offer.level <= LONE_WEAPON_LEVELS && isLeading(offer.refId, context)) return RANK.evolve * 100 + 50;
      if (isLeading(offer.refId, context)) return RANK.weaponLevel * 100 + Math.max(0, PLAN.indexOf(`weapon:${offer.refId}`));
      return RANK.otherLevel * 100;
    case "passive_level": {
      const place = PLAN.indexOf(`passive:${offer.refId}`);
      return (place >= 0 ? RANK.passiveLevel : RANK.otherLevel) * 100 + Math.max(0, place);
    }
    case "limit": {
      const place = LIMIT_ORDER.indexOf(offer.refId);
      return (place >= 0 ? RANK.limit : RANK.rest) * 100 + Math.max(0, place);
    }
    default:
      return RANK.rest * 100;
  }
}

/**
 * Выбор карточки по плану опытного игрока: развить оружие, ведущее к эволюции;
 * взять «Очаг» или «Оберег»; «Заживление», «Живучесть», «Магнит»; урон и
 * перезарядку; иначе первую карточку. Равные по ступени — первая из предложенных.
 */
export function pickCard(offers: readonly UpgradeOption[], context: PickContext): UpgradeOption {
  return rankCards(offers, context).best;
}

/** Лучшая карточка и её оценка (меньше — лучше). */
function rankCards(offers: readonly UpgradeOption[], context: PickContext): { best: UpgradeOption; score: number } {
  let best = offers[0];
  let bestScore = scoreOf(best, context);
  for (let i = 1; i < offers.length; i++) {
    const score = scoreOf(offers[i], context);
    if (score < bestScore) {
      best = offers[i];
      bestScore = score;
    }
  }
  return { best, score: bestScore };
}

/**
 * Карточка или действие с карточками (переброс, изгнание). Опытный игрок не берёт то, что
 * мешает плану, пока есть заряды: нет ничего из плана — перебрасывает; лучшее из показанного
 * закрывает слот нужной связке — изгоняет. Заряды даёт уровень аккаунта и буст, у новичка
 * их нет, и он берёт что дали.
 */
export function chooseCardOrTool(offers: readonly UpgradeOption[], context: PickContext, world: World | undefined): string {
  const { best, score } = rankCards(offers, context);
  if (world === undefined) return best.id;
  if (score >= RANK.passiveLevel * 100 && context.planIncomplete && canReroll(world)) return REROLL_COMMAND;
  if (score >= RANK.blocker * 100 && world.progression.tools.banish > 0) {
    const key = itemKeyOf(best);
    if (key !== null) return `${BANISH_PREFIX}${best.id}`;
  }
  return best.id;
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

/** Есть ли живой враг ближе `radiusUnits`. Сетка перестроена на прошлом шаге: тик задержки боту не мешает. */
function hasEnemyWithin(world: World, radiusUnits: number): boolean {
  const player = world.player;
  const reach = radiusUnits * world.config.unitScale;
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

/** Есть ли враг в безопасном радиусе: пока есть, бот выбирает просвет, а не идёт прямо к добыче. */
const hasThreat = (world: World): boolean => hasEnemyWithin(world, STRONG_BOT.safeRadiusUnits);

/**
 * Дистанция, на которой бот держит врагов. Берётся ближайшая из потребностей
 * оружия: с «Очагом» или «Оберегом» в наборе враги нужны у самой кромки, даже
 * если рядом лежит «Искра», — ей всё равно, где враг, а кольцу не всё равно.
 */
function holdDistance(world: World): number {
  const scale = world.config.unitScale;
  let hold = Infinity;
  for (const slot of world.loadout.weapons) {
    const type = world.weaponTypes[slot.typeIndex];
    if (type === undefined) continue;
    const level = type.levels[Math.min(slot.level, type.levels.length) - 1];
    if (level === undefined) continue;

    const reach =
      type.behavior === "orbit"
        ? level.areaRadius + (ORBITER_RADIUS + STRONG_BOT.contactMarginUnits) * scale
        : type.behavior === "aura"
          ? level.areaRadius + STRONG_BOT.contactMarginUnits * scale
          : type.behavior === "projectile_facing"
            ? STRONG_BOT.facingHoldUnits * scale
            : STRONG_BOT.rangedHoldUnits * scale;
    if (reach < hold) hold = reach;
  }
  return hold === Infinity ? STRONG_BOT.rangedHoldUnits * scale : hold;
}

// Буферы просвета: один раз, чтобы пересчёт не плодил мусор.
const scanX = new Float64Array(STRONG_BOT.scanLimit);
const scanY = new Float64Array(STRONG_BOT.scanLimit);
const direction = createDirection();

/**
 * Куда шагнуть, когда рядом враги: из шестнадцати направлений берётся то, куда
 * через `lookaheadSec` врагов (с их ходом) подойдёт меньше всего. Это выбор
 * просвета, а не «подальше от ближайшего»: кольцо врагов уклоняющийся бот
 * обходит хуже человека, который видит, где в нём дыра. К опасности добавляется
 * притяжение к ближайшему врагу, когда тот дальше удобной дистанции, и вес
 * прежнего курса против дрожания. Результат пишется в `out`.
 */
function chooseGap(
  world: World,
  hold: number,
  previousX: number,
  previousY: number,
  loot: { x: number; y: number } | null,
  out: { x: number; y: number },
): void {
  const player = world.player;
  const scale = world.config.unitScale;
  const lookahead = STRONG_BOT.lookaheadSec;
  const reach = hold + 120 * scale;
  const found = world.enemyGrid.queryInto(player.x, player.y, Math.max(reach, STRONG_BOT.approachRadiusUnits * scale), world.queryBuffer);

  let counted = 0;
  let nearest = Infinity;
  let nearestX = 0;
  let nearestY = 0;
  for (let k = 0; k < found; k++) {
    const i = world.queryBuffer[k];
    if (world.enemies.alive[i] === 0) continue;
    const dx = world.enemies.x[i] - player.x;
    const dy = world.enemies.y[i] - player.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < nearest && distance > 1e-3) {
      nearest = distance;
      nearestX = dx / distance;
      nearestY = dy / distance;
    }
    if (distance > reach || counted >= STRONG_BOT.scanLimit) continue;
    // Положение врага через `lookahead` секунд относительно игрока на старте шага.
    scanX[counted] = dx + world.enemies.vx[i] * lookahead;
    scanY[counted] = dy + world.enemies.vy[i] * lookahead;
    counted++;
  }

  const step = world.config.player.speedPxSec * world.playerStats.moveSpeedMul * lookahead;
  const comfort = Math.max(hold, 40 * scale);
  const approach = nearest > hold && nearest < Infinity;
  let bestScore = Infinity;
  out.x = previousX;
  out.y = previousY;

  for (let c = 0; c < CANDIDATES; c++) {
    ringDirection(0, c, CANDIDATES, direction);
    const qx = direction.x * step;
    const qy = direction.y * step;

    let danger = 0;
    for (let e = 0; e < counted; e++) {
      const rx = scanX[e] - qx;
      const ry = scanY[e] - qy;
      const distance = Math.sqrt(rx * rx + ry * ry);
      if (distance >= comfort) continue;
      const closeness = 1 - distance / comfort;
      danger += closeness * closeness;
    }

    let score = danger - STRONG_BOT.stickinessWeight * (direction.x * previousX + direction.y * previousY);
    if (approach) score -= STRONG_BOT.approachWeight * (direction.x * nearestX + direction.y * nearestY);
    if (loot !== null) score -= STRONG_BOT.lootWeight * (direction.x * loot.x + direction.y * loot.y);
    if (score < bestScore) {
      bestScore = score;
      out.x = direction.x;
      out.y = direction.y;
    }
  }
}

const gap = { x: 1, y: 0 };

export function createStrongBot(options: StrongBotOptions): Bot {
  const { stance } = options;
  const takenPassives = new Set<string>();
  const takenWeapons = new Set<string>();
  let calls = 0;
  let lastX = 1;
  let lastY = 0;
  // Шаг стоящего: сколько тиков ещё идёт и сколько тиков после него не шагает.
  let stepLeft = 0;
  let pauseLeft = 0;

  return {
    input(world): SimInput {
      if (stance === "stand" && world.stats.elapsedSec >= STAND_FROM_SEC) return standInput(world);

      const recalculate = calls % STRONG_BOT.reactionTicks === 0;
      calls++;
      if (!recalculate) return { moveX: lastX, moveY: lastY };

      const hasLoot = seekLoot(world, target);
      if (hasLoot && !hasThreat(world)) {
        lastX = target.x;
        lastY = target.y;
      } else {
        chooseGap(world, holdDistance(world), lastX, lastY, hasLoot ? target : null, gap);
        lastX = gap.x;
        lastY = gap.y;
      }
      return { moveX: lastX, moveY: lastY };
    },

    choose(offers, world) {
      const context = contextOf(world, { passives: takenPassives, weapons: takenWeapons });
      const id = chooseCardOrTool(offers, context, world);
      const chosen = offers.find((offer) => offer.id === id);
      if (chosen !== undefined) {
        if (chosen.kind === "passive_new" || chosen.kind === "passive_level") takenPassives.add(chosen.refId);
        if (chosen.kind === "weapon_new" || chosen.kind === "weapon_level") takenWeapons.add(chosen.refId);
      }
      return id;
    },
  };

  /** Ввод стоящего: покой, а при враге ближе радиуса шага — шаг от него. */
  function standInput(world: World): SimInput {
    if (stepLeft > 0) {
      stepLeft--;
      if (stepLeft === 0) pauseLeft = STAND_STEP.cooldownTicks;
      return { moveX: lastX, moveY: lastY };
    }
    if (pauseLeft > 0) {
      pauseLeft--;
      return { moveX: 0, moveY: 0 };
    }
    if (!hasEnemyWithin(world, STAND_STEP.radiusUnits)) {
      // Врага рядом нет — шаг за добычей, если она в пределах досягаемости.
      if (!seekLoot(world, target)) return { moveX: 0, moveY: 0 };
      lastX = target.x;
      lastY = target.y;
      stepLeft = STAND_STEP.ticks - 1;
      if (stepLeft === 0) pauseLeft = STAND_STEP.cooldownTicks;
      return { moveX: lastX, moveY: lastY };
    }

    // Прежнего курса у стоящего нет: вес курса перевесил бы опасность и повёл шаг на врага.
    // Запас вдвое больше радиуса шага: иначе все направления за пределами радиуса одинаково безопасны,
    // и бот шагнул бы вбок.
    chooseGap(world, 2 * STAND_STEP.radiusUnits * world.config.unitScale, 0, 0, null, gap);
    lastX = gap.x;
    lastY = gap.y;
    stepLeft = STAND_STEP.ticks - 1;
    if (stepLeft === 0) pauseLeft = STAND_STEP.cooldownTicks;
    return { moveX: lastX, moveY: lastY };
  }
}
