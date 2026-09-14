import { DIFFICULTIES, type Difficulty, type StoredRun } from "../../src/modules/playtest/playtest.store";
import {
  DURATION_BUCKETS_MIN,
  dayKey,
  durationBucket,
  type DifficultyAggregate,
  type PlaytestStatsStore,
  type SessionRecord,
  type StatsSnapshot,
  type StoredDevice,
  type StressSummary,
} from "../../src/modules/playtest/playtest-stats.store";

/**
 * Статистика плейтеста в памяти — для тестов сервиса и сводки. Повторяет
 * смысл реализации на Redis: игроки считаются множествами, сутки — в поясе
 * команды, у установки остаётся последнее устройство, повтор отчёта
 * стресс-теста не считается.
 */
export class MemoryPlaytestStatsStore implements PlaytestStatsStore {
  failing = false;
  private readonly seen = new Set<string>();
  private readonly played = new Set<string>();
  private readonly daySeen = new Map<string, Set<string>>();
  private readonly dayPlayed = new Map<string, Set<string>>();
  private readonly dayRuns = new Map<string, number>();
  private readonly devices = new Map<string, StoredDevice>();
  private readonly difficulties = new Map<Difficulty, DifficultyAggregate>();
  private readonly weapons: Record<string, number> = {};
  private readonly deaths: Record<string, number> = {};
  private readonly stressIds = new Set<string>();
  private readonly stress: StatsSnapshot["stress"] = { reports: 0, byOs: {} };
  readonly stressRecent: StressSummary[] = [];

  constructor(private readonly offsetMin = 180) {}

  async recordSession(playerId: string, session: SessionRecord, nowMs: number): Promise<void> {
    this.check();
    const day = dayKey(nowMs, this.offsetMin);
    this.seen.add(playerId);
    setOf(this.daySeen, day).add(playerId);
    this.devices.set(session.installId, session.device);
  }

  async recordRun(playerId: string, run: StoredRun, nowMs: number): Promise<void> {
    this.check();
    const day = dayKey(nowMs, this.offsetMin);
    this.played.add(playerId);
    setOf(this.dayPlayed, day).add(playerId);
    this.dayRuns.set(day, (this.dayRuns.get(day) ?? 0) + 1);

    const aggregate = this.difficulties.get(run.difficultyId) ?? emptyAggregate();
    aggregate.runs++;
    aggregate.totalSurvivalSec += run.survivalSec;
    aggregate.totalLevel += run.level;
    if (run.outcome === "abandoned") aggregate.abandoned++;
    const bucket = durationBucket(run.survivalSec);
    aggregate.buckets[bucket] = (aggregate.buckets[bucket] ?? 0) + 1;
    this.difficulties.set(run.difficultyId, aggregate);

    this.weapons[run.startingWeaponId] = (this.weapons[run.startingWeaponId] ?? 0) + 1;
    if (run.deathCause !== undefined && run.deathCause !== null) {
      this.deaths[run.deathCause] = (this.deaths[run.deathCause] ?? 0) + 1;
    }
  }

  async recordStress(_playerId: string, summary: StressSummary, _nowMs: number): Promise<boolean> {
    this.check();
    if (this.stressIds.has(summary.reportId)) return false;
    this.stressIds.add(summary.reportId);
    this.stress.reports++;
    const entry = (this.stress.byOs[summary.device.os] ??= { reports: 0, totalPeak: 0, outcomes: {} });
    entry.reports++;
    entry.totalPeak += Math.round(summary.peakObjects);
    entry.outcomes[summary.outcome] = (entry.outcomes[summary.outcome] ?? 0) + 1;
    this.stressRecent.unshift(summary);
    return true;
  }

  async snapshot(nowMs: number): Promise<StatsSnapshot> {
    this.check();
    const day = dayKey(nowMs, this.offsetMin);
    const byOs: Record<string, number> = {};
    const byFormFactor: Record<string, number> = {};
    const byClient: Record<string, number> = {};
    for (const device of this.devices.values()) {
      byOs[device.os] = (byOs[device.os] ?? 0) + 1;
      byFormFactor[device.formFactor] = (byFormFactor[device.formFactor] ?? 0) + 1;
      const client = device.clientPlatform ?? "unknown";
      byClient[client] = (byClient[client] ?? 0) + 1;
    }
    const difficulties = Object.fromEntries(
      DIFFICULTIES.map((difficulty) => [difficulty, structuredClone(this.difficulties.get(difficulty) ?? emptyAggregate())]),
    ) as Record<Difficulty, DifficultyAggregate>;

    return {
      playersSeen: this.seen.size,
      playersPlayed: this.played.size,
      playersSeenToday: this.daySeen.get(day)?.size ?? 0,
      playersPlayedToday: this.dayPlayed.get(day)?.size ?? 0,
      installs: this.devices.size,
      runsToday: this.dayRuns.get(day) ?? 0,
      byOs,
      byFormFactor,
      byClient,
      difficulties,
      startingWeapons: { ...this.weapons },
      deathCauses: { ...this.deaths },
      stress: structuredClone(this.stress),
    };
  }

  private check(): void {
    if (this.failing) throw new Error("хранилище недоступно");
  }
}

function emptyAggregate(): DifficultyAggregate {
  return { runs: 0, totalSurvivalSec: 0, totalLevel: 0, abandoned: 0, buckets: Array.from({ length: DURATION_BUCKETS_MIN.length + 1 }, () => 0) };
}

function setOf(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}
