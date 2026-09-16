import type { Difficulty, StoredRun } from "./playtest.store.js";

/**
 * Агрегаты статистики плейтеста: кто открывал игру, на чём, как проходят
 * забеги. Считаются на записи, а не пересчётом всех забегов на каждый
 * запрос сводки: сводка — это чтение десятка счётчиков.
 *
 * Только числа и распределения. Имён и Telegram ID в агрегатах нет: сводку
 * отправляют в групповой чат (docs/28-diagnostics.md §8).
 */

export const DEVICE_OS = ["android", "ios", "windows", "macos", "linux", "other"] as const;
export const FORM_FACTORS = ["phone", "tablet", "desktop"] as const;

export interface StoredDevice {
  clientPlatform: string | null;
  clientVersion: string | null;
  os: (typeof DEVICE_OS)[number];
  formFactor: (typeof FORM_FACTORS)[number];
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  cores: number | null;
  memoryGb: number | null;
}

export interface SessionRecord {
  installId: string;
  build: string;
  contentHash: string;
  device: StoredDevice;
}

/**
 * Корзины длительности забега, минуты — верхние границы. Медиана считается
 * по корзинам: точная медиана потребовала бы хранить каждый забег, а для
 * сводки плейтеста «от трёх до пяти минут» достаточно.
 */
export const DURATION_BUCKETS_MIN = [1, 3, 5, 10, 15, 20] as const;

export function durationBucket(survivalSec: number): number {
  const minutes = survivalSec / 60;
  const index = DURATION_BUCKETS_MIN.findIndex((limit) => minutes < limit);
  return index < 0 ? DURATION_BUCKETS_MIN.length : index;
}

export interface DifficultyAggregate {
  runs: number;
  totalSurvivalSec: number;
  totalLevel: number;
  abandoned: number;
  /** забегов в каждой корзине длительности; длина — корзины + «дольше последней» */
  buckets: number[];
}

export interface StatsSnapshot {
  playersSeen: number;
  playersPlayed: number;
  playersSeenToday: number;
  playersPlayedToday: number;
  installs: number;
  runsToday: number;
  byOs: Record<string, number>;
  byFormFactor: Record<string, number>;
  byClient: Record<string, number>;
  difficulties: Record<Difficulty, DifficultyAggregate>;
  startingWeapons: Record<string, number>;
  deathCauses: Record<string, number>;
  stress: StressAggregate;
}

export interface StressAggregate {
  reports: number;
  /** по семейству ОС: сколько прогонов, сумма пиков и чем они закончились */
  byOs: Record<string, { reports: number; totalPeak: number; outcomes: Record<string, number> }>;
}

/**
 * Итог стресс-теста без таймлайна кадров: для сводки и разбора по
 * устройствам хватает пика и того, чем прогон закончился. Telegram ID здесь
 * нет — прогоны лежат списком, который читает команда.
 */
export interface StressSummary {
  reportId: string;
  build: string;
  mode: string;
  loadout: string;
  /** почему прогон остановился: `degradation` — предел найден, `duration` — нет */
  outcome: string;
  device: StoredDevice;
  peakObjects: number;
  peakEnemies: number;
  peakProjectiles: number;
  avgFps: number;
  p95FrameMs: number;
  displayHz: number | null;
  durationSec: number;
  interruptions: number;
  /** нагрузка, на которой устройство перестало держать порог; `null` — не перестало */
  breakingLoad: number | null;
}

export interface PlaytestStatsStore {
  recordSession(playerId: string, session: SessionRecord, nowMs: number): Promise<void>;
  recordRun(playerId: string, run: StoredRun, nowMs: number): Promise<void>;
  recordStress(playerId: string, summary: StressSummary, nowMs: number): Promise<boolean>;
  snapshot(nowMs: number): Promise<StatsSnapshot>;
}

export const PLAYTEST_STATS_STORE = Symbol("PLAYTEST_STATS_STORE");

/**
 * Сутки для «за сегодня». Время на сервере — UTC, но сутки считаются в поясе
 * команды (`PLAYTEST_STATS_UTC_OFFSET_MIN`): отчёт в девять вечера по Москве
 * должен говорить о прошедшем московском дне, а не о дне с трёх часов ночи.
 */
export function dayKey(nowMs: number, offsetMin: number): string {
  return new Date(nowMs + offsetMin * 60_000).toISOString().slice(0, 10);
}
