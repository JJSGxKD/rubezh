import type { Difficulty } from "../runs/run-rules.js";
import { isRunModifierId, type RunModifierId } from "../runs/run-verdict.js";

/**
 * Награда за забег и уровень аккаунта (docs/35-stage4-plan.md, WP4).
 *
 * **Числа утверждены владельцем как отправная точка** (Р36): меняются
 * здесь, в карте конфигурации — docs/30-configuration-map.md. Ориентир — медиана живого забега 6–10 минут
 * (docs/32-balance.md) и полтора десятка забегов в день у активного игрока:
 * это около 1 300 монет и 2 500 опыта в сутки, десятый уровень на второй
 * день, двадцатый — к концу недели. Суточный потолок кошелька (20 000 монет
 * из забегов) выше этого на порядок: он ловит ошибку в числах и накрутку, а
 * не честного игрока.
 *
 * Награду считает сервер из записанного забега — время сверено с его же
 * стартом (runs.service.ts), — а не из того, что прислал клиент как «награду».
 */

/**
 * Числа забега, лестницы уровней и награды дня — ключи каталога настроек
 * `rewards.*` с пометкой «деньги» (tasks/T-0310): правятся в панели заявкой со
 * вторым участником. Постоянные ниже — умолчания ключей и то, что считается,
 * пока настроек нет (тесты, процесс без базы).
 */

/** Короче — не забег, а «нажал и вышел»: награды нет, иначе её фармили бы. */
export const MIN_REWARDED_SEC = 30;

const COINS_PER_MINUTE = 10;
const COINS_PER_100_KILLS = 3;
const XP_PER_MINUTE = 10;
const XP_PER_RUN_LEVEL = 5;

/** Потолок одного забега: сорокаминутный забег на сложной не должен давать недельную норму. */
export const MAX_COINS_PER_RUN = 600;
export const MAX_XP_PER_RUN = 1_500;

/** Сложнее — щедрее: иначе незачем уходить с лёгкой. */
export const DIFFICULTY_REWARD_MUL: Record<Difficulty, number> = { easy: 1, normal: 1.3, hard: 1.7 };

/**
 * Победа над стражем рубежа удваивает монеты и опыт забега (T-0121, Р102).
 * Сервер `shared-types` не импортирует, поэтому число здесь, а равенство с
 * `RUBEZH_REWARD_MUL` держит тест `rubezh-win.test.ts`. Число стартовое.
 */
export const RUBEZH_REWARD_MUL = 2;

/**
 * Модификатор забега платит больше (T-0122, Р105): множитель ложится поверх
 * сложности, а не заменяет её. Сервер `shared-types` не импортирует, поэтому
 * числа здесь, а равенство с `RUN_MODIFIER_REWARD_MUL` и полноту по всем
 * модификаторам держит `progress.test.ts`. Числа стартовые, калибрует
 * геймдизайнер.
 */
export const RUN_MODIFIER_REWARD_MUL: Readonly<Record<RunModifierId, number>> = { hurry: 1.25, inverse: 1.25 };

/** Порог и потолки награды за забег: читаются из настроек на каждом начислении. */
export interface RunRewardLimits {
  minSec: number;
  maxCoins: number;
  maxXp: number;
}

export const DEFAULT_RUN_REWARD_LIMITS: RunRewardLimits = { minSec: MIN_REWARDED_SEC, maxCoins: MAX_COINS_PER_RUN, maxXp: MAX_XP_PER_RUN };

export const MAX_LEVEL = 100;

export interface RewardableRun {
  difficulty: Difficulty;
  survivalSec: number;
  enemiesKilled: number;
  /** уровень, до которого игрок дорос в забеге */
  level: number;
  cheats: boolean;
  verdict: "ok" | "suspicious" | "rejected";
  /** победа над стражем заявлена и правдоподобна (`RecordedRun.rubezhCleared`); поля нет — победы нет */
  rubezhCleared?: boolean;
  /** модификатор записи забега (T-0122); поля или `null` нет — забег без него. Не число клиента: сервер знает его из вердикта */
  modifierId?: string | null | undefined;
}

/**
 * Множитель модификатора: платится только за забег с известным модификатором,
 * честным вердиктом `ok` и без читов. Подозрение (в том числе расхождение
 * старта и итога) и отказ множителя не получают; читы и отказ не получают и
 * саму награду (`runReward`).
 */
export function modifierRewardMul(run: Pick<RewardableRun, "modifierId" | "verdict" | "cheats">): number {
  if (run.verdict !== "ok" || run.cheats || !isRunModifierId(run.modifierId)) return 1;
  return RUN_MODIFIER_REWARD_MUL[run.modifierId];
}

/**
 * Победа оплачена ×2: засчитана, вердикт честный, читов нет и награда не
 * пропущена. Подозрительный забег награду получает, но без множителя — иначе
 * сомнительная победа платила бы вдвое.
 */
export function rubezhPaid(run: { cleared: boolean; verdict: RewardableRun["verdict"]; cheats: boolean; skipped: string | null }): boolean {
  return run.cleared && run.verdict === "ok" && !run.cheats && run.skipped === null;
}

export type RunRewardDecision = { coins: number; xp: number; skipped: null } | { coins: 0; xp: 0; skipped: "too_short" | "cheats" | "rejected" };

/**
 * Подозрительный забег награду получает: вердикт — повод посмотреть, а не
 * приговор, и честный игрок с необычным забегом не должен терять монеты.
 * Злоупотребление ловят потолки кошелька и разбор. Отклонённый — нет.
 */
export function runReward(run: RewardableRun, limits: RunRewardLimits = DEFAULT_RUN_REWARD_LIMITS): RunRewardDecision {
  if (run.cheats) return { coins: 0, xp: 0, skipped: "cheats" };
  if (run.verdict === "rejected") return { coins: 0, xp: 0, skipped: "rejected" };
  if (run.survivalSec < limits.minSec) return { coins: 0, xp: 0, skipped: "too_short" };

  const minutes = run.survivalSec / 60;
  // Множители складываются до округления, потолки — после них.
  const mul =
    DIFFICULTY_REWARD_MUL[run.difficulty] *
    (rubezhPaid({ cleared: run.rubezhCleared === true, verdict: run.verdict, cheats: run.cheats, skipped: null }) ? RUBEZH_REWARD_MUL : 1) *
    modifierRewardMul(run);
  const coins = Math.round((COINS_PER_MINUTE * minutes + (COINS_PER_100_KILLS * run.enemiesKilled) / 100) * mul);
  const xp = Math.round((XP_PER_MINUTE * minutes + XP_PER_RUN_LEVEL * Math.max(0, run.level - 1)) * mul);
  return { coins: Math.min(coins, limits.maxCoins), xp: Math.min(xp, limits.maxXp), skipped: null };
}

/**
 * Сколько всего опыта нужно для уровня: `150·(n−1)^1.6`. Первые уровни —
 * за один-два забега, дальше растягиваются: уровень открывает постепенно
 * (docs/10-progression-and-ladder.md §1), и к двадцатому игрок идёт неделю.
 * Возведение в степень — не симуляция, детерминизм между движками здесь не
 * нужен: уровень считает только сервер.
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(150 * (level - 1) ** 1.6);
}

export function levelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  return level;
}

/**
 * Лестница наград за уровень — список ступеней «с уровня:монет за уровень:
 * самоцветов:раз в сколько уровней», например `1:50:10:5; 20:80:20:10`.
 * Ступень действует со своего уровня до следующей: монеты — `монет за
 * уровень × номер уровня`, самоцветы — на каждом уровне, кратном «раз в».
 * Умолчание — прежняя формула: 50 монет за уровень и 10 самоцветов раз в
 * пять уровней. Самоцветы бесплатно — немного (Р2): основной их источник —
 * покупка.
 */
export interface LevelLadderStep {
  fromLevel: number;
  coinsPerLevel: number;
  gems: number;
  gemsEvery: number;
}

export type LevelLadder = readonly LevelLadderStep[];

export const DEFAULT_LEVEL_LADDER_TEXT = "1:50:10:5";

export const LEVEL_LADDER_MAX_STEPS = 8;
export const LEVEL_LADDER_COINS_MAX = 1_000;
export const LEVEL_LADDER_GEMS_MAX = 100;

export const LEVEL_LADDER_FORMAT = "с уровня:монет за уровень:самоцветов:раз в сколько уровней, ступени через «;», например 1:50:10:5; 20:80:20:10";

/** Разбор лестницы: `text` — канонический вид (пробелы и порядок знаков приведены), по нему «было» сравнивается строкой. */
export type LadderParse<T> = { ok: true; ladder: T; text: string } | { ok: false; problem: string };

const WHOLE = /^\d{1,9}$/;

function whole(text: string): number | null {
  return WHOLE.test(text.trim()) ? Number(text.trim()) : null;
}

export function formatLevelLadder(ladder: LevelLadder): string {
  return ladder.map((step) => `${String(step.fromLevel)}:${String(step.coinsPerLevel)}:${String(step.gems)}:${String(step.gemsEvery)}`).join("; ");
}

/** Первая ступень с первого уровня, уровни по возрастанию, числа в пределах. */
export function parseLevelLadder(text: string): LadderParse<LevelLadder> {
  const parts = text.split(";").map((part) => part.trim());
  if (parts[0] === undefined || parts[0] === "") return { ok: false, problem: `Лестница пуста. Формат: ${LEVEL_LADDER_FORMAT}` };
  if (parts.length > LEVEL_LADDER_MAX_STEPS) return { ok: false, problem: `Ступеней не больше ${String(LEVEL_LADDER_MAX_STEPS)}` };
  const ladder: LevelLadderStep[] = [];
  for (const part of parts) {
    const fields = part.split(":").map(whole);
    const [fromLevel, coinsPerLevel, gems, gemsEvery] = fields;
    if (fields.length !== 4 || fromLevel == null || coinsPerLevel == null || gems == null || gemsEvery == null) {
      return { ok: false, problem: `Ступень «${part}» не разобрана: четыре целых неотрицательных числа через «:». Формат: ${LEVEL_LADDER_FORMAT}` };
    }
    if (fromLevel < 1 || fromLevel > MAX_LEVEL) return { ok: false, problem: `Ступень «${part}»: уровень от 1 до ${String(MAX_LEVEL)}` };
    if (coinsPerLevel > LEVEL_LADDER_COINS_MAX) return { ok: false, problem: `Ступень «${part}»: монет за уровень не больше ${String(LEVEL_LADDER_COINS_MAX)}` };
    if (gems > LEVEL_LADDER_GEMS_MAX) return { ok: false, problem: `Ступень «${part}»: самоцветов не больше ${String(LEVEL_LADDER_GEMS_MAX)}` };
    if (gemsEvery < 1 || gemsEvery > MAX_LEVEL) return { ok: false, problem: `Ступень «${part}»: «раз в сколько уровней» от 1 до ${String(MAX_LEVEL)}` };
    ladder.push({ fromLevel, coinsPerLevel, gems, gemsEvery });
  }
  if (ladder[0]?.fromLevel !== 1) return { ok: false, problem: "Первая ступень начинается с первого уровня" };
  for (let index = 1; index < ladder.length; index++) {
    if ((ladder[index]?.fromLevel ?? 0) <= (ladder[index - 1]?.fromLevel ?? 0)) return { ok: false, problem: "Уровни ступеней идут по возрастанию, без повторов" };
  }
  return { ok: true, ladder, text: formatLevelLadder(ladder) };
}

const DEFAULT_LEVEL_LADDER: LevelLadder = [{ fromLevel: 1, coinsPerLevel: 50, gems: 10, gemsEvery: 5 }];

/** Лестница из настройки. Битое значение не роняет начисление: действует прежняя лестница. */
export function levelLadderOf(text: string): LevelLadder {
  const parsed = parseLevelLadder(text);
  return parsed.ok ? parsed.ladder : DEFAULT_LEVEL_LADDER;
}

export interface LevelReward {
  coins: number;
  gems: number;
}

/** Награда за достижение уровня по лестнице; без аргумента — умолчание. */
export function levelReward(level: number, ladder: LevelLadder = DEFAULT_LEVEL_LADDER): LevelReward {
  let step: LevelLadderStep | undefined;
  for (const candidate of ladder) {
    if (candidate.fromLevel <= level) step = candidate;
  }
  if (step === undefined) return { coins: 0, gems: 0 };
  return { coins: step.coinsPerLevel * level, gems: level % step.gemsEvery === 0 ? step.gems : 0 };
}

/** Самая большая награда за один уровень: предупреждение о потолке кошелька сравнивает её. */
export function maxLevelReward(ladder: LevelLadder): LevelReward {
  let coins = 0;
  let gems = 0;
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const reward = levelReward(level, ladder);
    coins = Math.max(coins, reward.coins);
    gems = Math.max(gems, reward.gems);
  }
  return { coins, gems };
}
