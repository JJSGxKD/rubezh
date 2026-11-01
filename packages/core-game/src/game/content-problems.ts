import { DIFFICULTY_IDS, PASSIVE_CATEGORIES } from "@bh/shared-types";
import { DEFAULT_DIFFICULTY_ID } from "../content/difficulty";
import type { ContentSnapshot } from "../content/snapshot";
import { findPassiveContentProblems } from "./progression/passives";
import { findBoostProblems } from "./progression/boosts";
import { findEvolutionProblems } from "./progression/evolutions";
import { xpForLevel } from "./progression/levels";
import { findCardToolProblems, findUnlockProblems } from "./progression/unlocks";
import { findEnemyContentProblems } from "./patterns";
import { findChestsProblems } from "./sim/chests";
import { findSecretsProblems } from "./sim/secrets";
import { findContinueProblems } from "./sim/continue";
import { findDifficultyContentProblems } from "./sim/difficulty";
import { findDropsContentProblems } from "./sim/gems";
import { findMapContentProblems } from "./sim/map-types";
import { MAX_PICKUPS } from "./sim/pickups";
import { findStageProblems } from "./sim/stages";
import { findTimelineProblems } from "./sim/timeline-content";
import { findWeaponContentProblems } from "./weapons";

/**
 * Проблема контента: раздел снимка и сообщение для геймдизайнера. Раздел —
 * имя поля `ContentSnapshot`, по нему панель подсвечивает нужный редактор;
 * сообщение называет запись и поле, а не «invalid content».
 */
export interface ContentProblem {
  path: string;
  message: string;
}

/** Первый уровень дороже этого — первая минута без решений, самый дешёвый способ потерять игрока. */
const MAX_FIRST_LEVEL_XP = 8;

/** Сколько уровней кривой опыта проверяется на строгий рост: дальше игрок за забег не доходит. */
const CHECKED_LEVELS = 20;

/**
 * Все проверки контента одной функцией: ссылки на врагов и оружие, паттерны,
 * бюджет угрозы, элиты только событием, ступени, открытия и слоты, коридоры
 * эволюций. Её зовут тест контента (на `CONTENT_SNAPSHOT` ждёт пустой список),
 * а позже и песочница редактора баланса — на черновике.
 *
 * Проверки разбирают данные, которые пришли и из JSON, поэтому функция не
 * бросает исключений на неполном снимке: плохой раздел становится проблемой,
 * остальные проверяются дальше.
 *
 * Лежит в `game/`, а не в `content/`: проверки знают код движка (реализованные
 * паттерны, пределы пула), а контент о нём знать не должен.
 */
export function findContentProblems(content: ContentSnapshot): ContentProblem[] {
  const problems: ContentProblem[] = [];
  const add = (path: keyof ContentSnapshot, messages: readonly string[]): void => {
    for (const message of messages) problems.push({ path, message });
  };

  const passiveIds = content.passives.map((passive) => passive.id);
  const passiveCategories = new Map(content.passives.map((passive) => [passive.id, passive.category]));
  const baseWeapons = content.weapons.filter((weapon) => weapon.evolvedFrom === undefined);

  add("enemies", findEnemyContentProblems(content.enemies));
  add("stages", findStageProblems(content.stages));
  add("weapons", findWeaponContentProblems(content.weapons));
  add("weapons", findEvolutionProblems(content.weapons, passiveIds));
  add("passives", findPassiveContentProblems(content.passives));
  add("levelCurve", findLevelCurveProblems(content));
  add("loadoutLimits", findLoadoutProblems(content));
  add("accountUnlocks", findUnlockProblems(content.accountUnlocks, { weapons: baseWeapons.map((weapon) => weapon.id), passives: passiveCategories }, content.loadoutLimits));
  add("timeline", findTimelineProblems(content.timeline, content.endlessCurve, content.enemies));
  add("timeline", findFirstChestProblems(content));
  add("maps", findMapContentProblems(content.maps));
  add("drops", findDropsContentProblems(content.drops));
  add("chests", findChestsProblems(content.chests));
  add("chests", findPickupPoolProblems(content));
  add("secrets", findSecretsProblems(content.secrets));
  add("difficulties", findDifficultyContentProblems(content.difficulties));
  add("difficulties", findDifficultySetProblems(content));
  add("continueRules", findContinueProblems(content.continueRules));
  add("boosts", findBoostProblems(content.boosts));
  add("maxBoostsPerRun", findBoostLimitProblems(content));
  add("cardToolUnlocks", findCardToolProblems(content.cardToolUnlocks));
  return problems;
}

/**
 * Набор уровней целиком: уровень по умолчанию есть (иначе забег стартует без
 * сложности молча) и порядок совпадает с `DIFFICULTY_IDS` — по нему строятся
 * переключатель и рейтинг.
 */
function findDifficultySetProblems(content: ContentSnapshot): string[] {
  const problems: string[] = [];
  const ids = content.difficulties.map((level) => level.id);
  if (!ids.includes(DEFAULT_DIFFICULTY_ID)) {
    problems.push(`difficulties: нет уровня по умолчанию «${DEFAULT_DIFFICULTY_ID}» — забег пошёл бы без сложности`);
  }
  if (ids.join() !== DIFFICULTY_IDS.join()) {
    problems.push(`difficulties: порядок уровней ${ids.join(", ")} не равен ${DIFFICULTY_IDS.join(", ")}`);
  }
  return problems;
}

function findLevelCurveProblems(content: ContentSnapshot): string[] {
  const curve = content.levelCurve;
  if (!(curve.baseXp > 0 && curve.growth > 0)) return ["levelCurve: baseXp и growth должны быть больше нуля"];

  const problems: string[] = [];
  if (xpForLevel(curve, 1) > MAX_FIRST_LEVEL_XP) {
    problems.push(`levelCurve: первый уровень стоит ${xpForLevel(curve, 1)} опыта, а должен быть не дороже ${MAX_FIRST_LEVEL_XP} — первая минута без решений`);
  }
  for (let level = 1; level < CHECKED_LEVELS; level++) {
    if (!(xpForLevel(curve, level + 1) > xpForLevel(curve, level))) {
      problems.push(`levelCurve: уровень ${level + 1} не дороже уровня ${level} — кривая опыта должна расти`);
      break;
    }
  }
  return problems;
}

/** Слотов меньше, чем кандидатов: иначе игроку нечего выбирать. */
function findLoadoutProblems(content: ContentSnapshot): string[] {
  const problems: string[] = [];
  const limits = content.loadoutLimits;
  const baseWeapons = content.weapons.filter((weapon) => weapon.evolvedFrom === undefined).length;
  if (baseWeapons <= limits.weapons) {
    problems.push(`loadoutLimits: оружия ${baseWeapons}, слотов под него ${limits.weapons} — выбирать нечего`);
  }
  for (const category of PASSIVE_CATEGORIES) {
    const count = content.passives.filter((passive) => passive.category === category).length;
    if (count <= limits.passives[category]) {
      problems.push(`loadoutLimits: навыков «${category}» ${count}, слотов под них ${limits.passives[category]} — выбирать нечего`);
    }
  }
  return problems;
}

/** Первое событие элиты или босса — с него падает первый сундук; секунда обязана лечь в коридор. */
function findFirstChestProblems(content: ContentSnapshot): string[] {
  const ranked = new Set(content.enemies.filter((enemy) => enemy.rank !== undefined).map((enemy) => enemy.id));
  const seconds = content.timeline
    .filter((segment) => (segment.events ?? []).some((event) => ranked.has(event.enemy)))
    .map((segment) => segment.fromSec);
  if (seconds.length === 0) return ["в таймлайне нет события элиты или босса: первый сундук не выпадет никогда"];

  const first = Math.min(...seconds);
  const corridor = content.balanceTargets.firstChestEventSec;
  if (first < corridor.min || first > corridor.max) {
    return [`первый сундук (событие элиты или босса) на ${first}-й секунде, а коридор — от ${corridor.min} до ${corridor.max}`];
  }
  return [];
}

/** Сумма потолков подборов не больше пула: иначе часть подборов нечем показать. */
function findPickupPoolProblems(content: ContentSnapshot): string[] {
  const { medkits, magnets, dynamite, freeze } = content.drops;
  const total = medkits.maxOnField + magnets.maxOnField + dynamite.maxOnField + freeze.maxOnField + content.chests.maxOnField;
  return total > MAX_PICKUPS ? [`потолки подборов и сундуков в сумме ${total}, а пул вмещает ${MAX_PICKUPS}`] : [];
}

function findBoostLimitProblems(content: ContentSnapshot): string[] {
  const limit = content.maxBoostsPerRun;
  return Number.isInteger(limit) && limit >= 1 ? [] : [`maxBoostsPerRun — целое от 1, сейчас ${limit}`];
}
