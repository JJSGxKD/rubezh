import type { TelegramPlayer } from "./telegram-init-data";

/**
 * Хранилище плейтеста. Интерфейс отдельно от Redis: сервис проверяется тестом
 * без Redis, а сама реализация на Redis — отдельным тестом на живом Redis
 * (docs/17-testing-strategy.md §4.2).
 */

export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface StoredRun {
  runId: string;
  difficultyId: Difficulty;
  outcome: "died" | "abandoned";
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  startingWeaponId: string;
  weapons: { id: string; level: number }[];
  contentHash: string;
  /** кто убил; `null` — сдача, нет поля — забег от прошлой версии клиента */
  deathCause?: string | null;
  /** когда получен сервером, мс UTC */
  at: number;
}

export interface LeaderboardRow {
  playerId: string;
  name: string;
  photoUrl: string | null;
  survivalSec: number;
  level: number;
  startingWeaponId: string;
  enemiesKilled: number;
}

export interface PlayerStats {
  runs: number;
  totalKills: number;
  totalSurvivalSec: number;
}

export interface RecordRunResult {
  /** забег с этим `runId` уже был записан — статистика не тронута */
  duplicate: boolean;
  isNewBest: boolean;
  bestSurvivalSec: number;
}

export interface PlaytestStore {
  savePlayer(player: TelegramPlayer): Promise<void>;
  recordRun(playerId: string, run: StoredRun): Promise<RecordRunResult>;
  /** место игрока на сложности с единицы; `null` — забегов на ней нет */
  rank(difficulty: Difficulty, playerId: string): Promise<number | null>;
  best(difficulty: Difficulty, playerId: string): Promise<number | null>;
  leaderboard(difficulty: Difficulty, limit: number): Promise<LeaderboardRow[]>;
  playerCount(difficulty: Difficulty): Promise<number>;
  stats(playerId: string): Promise<PlayerStats>;
  recentRuns(playerId: string, limit: number): Promise<StoredRun[]>;
}

export const PLAYTEST_STORE = Symbol("PLAYTEST_STORE");
