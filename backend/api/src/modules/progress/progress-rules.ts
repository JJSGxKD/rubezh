import type { Difficulty } from "../runs/run-rules.js";

/**
 * Награда за забег и уровень аккаунта (docs/35-stage4-plan.md, WP4).
 *
 * **Числа утверждены участником 1 как отправная точка** (Р36): меняются
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

export const MAX_LEVEL = 100;

export interface RewardableRun {
  difficulty: Difficulty;
  survivalSec: number;
  enemiesKilled: number;
  /** уровень, до которого игрок дорос в забеге */
  level: number;
  cheats: boolean;
  verdict: "ok" | "suspicious" | "rejected";
}

export type RunRewardDecision = { coins: number; xp: number; skipped: null } | { coins: 0; xp: 0; skipped: "too_short" | "cheats" | "rejected" };

/**
 * Подозрительный забег награду получает: вердикт — повод посмотреть, а не
 * приговор, и честный игрок с необычным забегом не должен терять монеты.
 * Злоупотребление ловят потолки кошелька и разбор. Отклонённый — нет.
 */
export function runReward(run: RewardableRun): RunRewardDecision {
  if (run.cheats) return { coins: 0, xp: 0, skipped: "cheats" };
  if (run.verdict === "rejected") return { coins: 0, xp: 0, skipped: "rejected" };
  if (run.survivalSec < MIN_REWARDED_SEC) return { coins: 0, xp: 0, skipped: "too_short" };

  const minutes = run.survivalSec / 60;
  const mul = DIFFICULTY_REWARD_MUL[run.difficulty];
  const coins = Math.round((COINS_PER_MINUTE * minutes + (COINS_PER_100_KILLS * run.enemiesKilled) / 100) * mul);
  const xp = Math.round((XP_PER_MINUTE * minutes + XP_PER_RUN_LEVEL * Math.max(0, run.level - 1)) * mul);
  return { coins: Math.min(coins, MAX_COINS_PER_RUN), xp: Math.min(xp, MAX_XP_PER_RUN), skipped: null };
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

export interface LevelReward {
  coins: number;
  gems: number;
}

/**
 * Награда за уровень: монеты растут с уровнем, самоцветы — раз в пять
 * уровней. Самоцветы бесплатно — немного (Р2): основной их источник —
 * покупка.
 */
export function levelReward(level: number): LevelReward {
  return { coins: 50 * level, gems: level % 5 === 0 ? 10 : 0 };
}
