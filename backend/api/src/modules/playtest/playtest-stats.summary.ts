import { DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";
import { DURATION_BUCKETS_MIN, dayKey, type DifficultyAggregate, type StatsSnapshot } from "./playtest-stats.store.js";

/**
 * Сводка для чата администраторов: из сырых счётчиков — доли, средние и
 * «типичная длина забега». Чистая функция без Redis и Telegram: картинку и
 * подпись к ней строят из одной и той же сводки, и проверяется она без сети.
 */

export interface Share {
  key: string;
  count: number;
  /** доля от суммы разреза, 0…1 */
  share: number;
}

export interface DifficultySummary {
  id: Difficulty;
  runs: number;
  avgSurvivalSec: number;
  avgLevel: number;
  /** корзина, в которую попадает медиана: «3–5 мин»; `null` — забегов нет */
  medianRange: string | null;
  abandonShare: number;
  bestSurvivalSec: number | null;
}

export interface StatsSummary {
  /** сутки в поясе команды, «2026-09-14» */
  day: string;
  /** время формирования в поясе команды, «21:00» */
  time: string;
  players: { seen: number; played: number; seenToday: number; playedToday: number };
  installs: number;
  runsToday: number;
  runsTotal: number;
  byOs: Share[];
  byFormFactor: Share[];
  byClient: Share[];
  difficulties: DifficultySummary[];
  topWeapons: Share[];
  topDeaths: Share[];
  stress: { reports: number; byOs: { os: string; reports: number; avgPeak: number; outcomes: Share[] }[] };
  recordings: { reports: number; problematic: number; byProblem: Share[] };
}

const TOP_LIMIT = 5;

export function buildStatsSummary(
  snapshot: StatsSnapshot,
  bests: Record<Difficulty, number | null>,
  nowMs: number,
  offsetMin: number,
): StatsSummary {
  const local = new Date(nowMs + offsetMin * 60_000).toISOString();
  const difficulties = DIFFICULTIES.map((id) => summarizeDifficulty(id, snapshot.difficulties[id], bests[id]));
  return {
    day: dayKey(nowMs, offsetMin),
    time: local.slice(11, 16),
    players: {
      seen: snapshot.playersSeen,
      played: snapshot.playersPlayed,
      seenToday: snapshot.playersSeenToday,
      playedToday: snapshot.playersPlayedToday,
    },
    installs: snapshot.installs,
    runsToday: snapshot.runsToday,
    runsTotal: difficulties.reduce((sum, entry) => sum + entry.runs, 0),
    byOs: shares(snapshot.byOs),
    byFormFactor: shares(snapshot.byFormFactor),
    byClient: shares(snapshot.byClient),
    difficulties,
    topWeapons: shares(snapshot.startingWeapons).slice(0, TOP_LIMIT),
    topDeaths: shares(snapshot.deathCauses).slice(0, TOP_LIMIT),
    stress: {
      reports: snapshot.stress.reports,
      byOs: Object.entries(snapshot.stress.byOs)
        .map(([os, entry]) => ({
          os,
          reports: entry.reports,
          avgPeak: entry.reports === 0 ? 0 : Math.round(entry.totalPeak / entry.reports),
          outcomes: shares(entry.outcomes),
        }))
        .sort((left, right) => right.reports - left.reports || left.os.localeCompare(right.os)),
    },
    recordings: {
      reports: snapshot.recordings.reports,
      problematic: snapshot.recordings.problematic,
      byProblem: shares(snapshot.recordings.byProblem),
    },
  };
}

/** Разрез по убыванию, при равенстве — по ключу: картинка не прыгает между отчётами. */
export function shares(counts: Record<string, number>): Share[] {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count, share: total === 0 ? 0 : count / total }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function summarizeDifficulty(id: Difficulty, aggregate: DifficultyAggregate, best: number | null): DifficultySummary {
  const { runs } = aggregate;
  return {
    id,
    runs,
    avgSurvivalSec: runs === 0 ? 0 : aggregate.totalSurvivalSec / runs,
    avgLevel: runs === 0 ? 0 : aggregate.totalLevel / runs,
    medianRange: medianRange(aggregate.buckets, runs),
    abandonShare: runs === 0 ? 0 : aggregate.abandoned / runs,
    bestSurvivalSec: best,
  };
}

function medianRange(buckets: number[], runs: number): string | null {
  if (runs === 0) return null;
  let passed = 0;
  for (const [index, count] of buckets.entries()) {
    passed += count;
    if (passed * 2 >= runs) return bucketLabel(index);
  }
  return bucketLabel(buckets.length - 1);
}

export function bucketLabel(index: number): string {
  const upper = DURATION_BUCKETS_MIN[index];
  const lower = index === 0 ? 0 : DURATION_BUCKETS_MIN[index - 1];
  if (upper === undefined) return `${lower ?? 0}+ мин`;
  return `${lower}–${upper} мин`;
}
