import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";
import { REDIS } from "../../infra/redis.js";
import {
  DURATION_BUCKETS_MIN,
  dayKey,
  durationBucket,
  type DifficultyAggregate,
  type PlaytestStatsStore,
  type SessionRecord,
  type StatsRun,
  type StatsSnapshot,
  type StressSummary,
} from "./playtest-stats.store.js";

/**
 * Агрегаты статистики плейтеста в Redis.
 *
 * Ключи:
 * - `pt:st:seen`, `pt:st:played` — множества игроков: открывали и играли;
 * - `pt:st:day:{дата}:seen|played` — то же за сутки; `…:runs` — счётчик забегов;
 * - `pt:st:install:{installId}` — последнее устройство установки (JSON);
 *   `pt:st:installs` — множество установок;
 * - `pt:st:diff:{сложность}` — хэш: забеги, суммы времени и уровня, сдачи,
 *   корзины длительности `b0…bN`;
 * - `pt:st:weapon`, `pt:st:death` — хэши: стартовое оружие, причина смерти;
 * - `pt:st:stress:{reportId}` — отметка против повтора отчёта,
 *   `pt:st:stress` — хэш сводки стресс-тестов по семейству ОС,
 *   `pt:st:stress:recent` — последние итоги прогонов списком (JSON);
 * - `pt:st:rec:{reportId}` — отметка против повтора записи забега,
 *   `pt:st:rec` — хэш: записей, проблемных и `problem:{причина}`.
 *
 * Всё живёт `dataTtlSec` с последней записи — как остальные данные плейтеста.
 */
const DAY_TTL_SEC = 3 * 24 * 60 * 60;
/** Последние прогоны стресс-теста — для разбора по устройствам, без таймлайна кадров. */
const STRESS_RECENT_KEPT = 200;

@Injectable()
export class RedisPlaytestStatsStore implements PlaytestStatsStore {
  private readonly ttlSec: number;
  private readonly offsetMin: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ttlSec = config.playtest.dataTtlSec;
    this.offsetMin = config.playtest.statsUtcOffsetMin;
  }

  async recordSession(accountId: string, session: SessionRecord, nowMs: number): Promise<void> {
    const day = dayKey(nowMs, this.offsetMin);
    const installKey = `pt:st:install:${session.installId}`;
    await this.redis
      .multi()
      .sadd("pt:st:seen", accountId)
      .expire("pt:st:seen", this.ttlSec)
      .sadd(`pt:st:day:${day}:seen`, accountId)
      .expire(`pt:st:day:${day}:seen`, DAY_TTL_SEC)
      .sadd("pt:st:installs", session.installId)
      .expire("pt:st:installs", this.ttlSec)
      .set(installKey, JSON.stringify(session.device), "EX", this.ttlSec)
      .exec();
  }

  async recordRun(accountId: string, run: StatsRun, nowMs: number): Promise<void> {
    const day = dayKey(nowMs, this.offsetMin);
    const diffKey = `pt:st:diff:${run.difficultyId}`;
    const tx = this.redis
      .multi()
      .sadd("pt:st:played", accountId)
      .expire("pt:st:played", this.ttlSec)
      .sadd(`pt:st:day:${day}:played`, accountId)
      .expire(`pt:st:day:${day}:played`, DAY_TTL_SEC)
      .incr(`pt:st:day:${day}:runs`)
      .expire(`pt:st:day:${day}:runs`, DAY_TTL_SEC)
      .hincrby(diffKey, "runs", 1)
      .hincrbyfloat(diffKey, "survival", run.survivalSec)
      .hincrby(diffKey, "level", run.level)
      .hincrby(diffKey, `b${durationBucket(run.survivalSec)}`, 1)
      .expire(diffKey, this.ttlSec)
      .hincrby("pt:st:weapon", run.startingWeaponId, 1)
      .expire("pt:st:weapon", this.ttlSec);
    if (run.outcome === "abandoned") tx.hincrby(diffKey, "abandoned", 1);
    if (run.deathCause !== null) {
      tx.hincrby("pt:st:death", run.deathCause, 1).expire("pt:st:death", this.ttlSec);
    }
    await tx.exec();
  }

  async recordStress(summary: StressSummary, nowMs: number): Promise<boolean> {
    const fresh = await this.redis.set(`pt:st:stress:${summary.reportId}`, "1", "EX", this.ttlSec, "NX");
    if (fresh === null) return false;
    const os = summary.device.os;
    await this.redis
      .multi()
      .hincrby("pt:st:stress", "reports", 1)
      .hincrby("pt:st:stress", `${os}:reports`, 1)
      .hincrby("pt:st:stress", `${os}:peak`, Math.round(summary.peakObjects))
      .hincrby("pt:st:stress", `${os}:outcome:${summary.outcome}`, 1)
      .expire("pt:st:stress", this.ttlSec)
      .lpush("pt:st:stress:recent", JSON.stringify({ ...summary, at: nowMs }))
      .ltrim("pt:st:stress:recent", 0, STRESS_RECENT_KEPT - 1)
      .expire("pt:st:stress:recent", this.ttlSec)
      .exec();
    return true;
  }

  async recordRecording(reportId: string, problems: readonly string[]): Promise<boolean> {
    const fresh = await this.redis.set(`pt:st:rec:${reportId}`, "1", "EX", this.ttlSec, "NX");
    if (fresh === null) return false;
    const tx = this.redis.multi().hincrby("pt:st:rec", "reports", 1);
    if (problems.length > 0) tx.hincrby("pt:st:rec", "problematic", 1);
    for (const problem of problems) tx.hincrby("pt:st:rec", `problem:${problem}`, 1);
    await tx.expire("pt:st:rec", this.ttlSec).exec();
    return true;
  }

  async snapshot(nowMs: number): Promise<StatsSnapshot> {
    const day = dayKey(nowMs, this.offsetMin);
    const pipeline = this.redis
      .pipeline()
      .scard("pt:st:seen")
      .scard("pt:st:played")
      .scard(`pt:st:day:${day}:seen`)
      .scard(`pt:st:day:${day}:played`)
      .get(`pt:st:day:${day}:runs`)
      .smembers("pt:st:installs")
      .hgetall("pt:st:weapon")
      .hgetall("pt:st:death")
      .hgetall("pt:st:stress")
      .hgetall("pt:st:rec");
    for (const difficulty of DIFFICULTIES) pipeline.hgetall(`pt:st:diff:${difficulty}`);
    const replies = (await pipeline.exec()) ?? [];
    const value = <T>(index: number, fallback: T): T => (replies[index]?.[1] as T | undefined) ?? fallback;

    const installIds = value<string[]>(5, []);
    const devices = installIds.length === 0 ? [] : await this.redis.mget(...installIds.map((id) => `pt:st:install:${id}`));

    const byOs: Record<string, number> = {};
    const byFormFactor: Record<string, number> = {};
    const byClient: Record<string, number> = {};
    let installs = 0;
    for (const raw of devices) {
      const device = parseDevice(raw);
      if (device === null) continue;
      installs++;
      byOs[device.os] = (byOs[device.os] ?? 0) + 1;
      byFormFactor[device.formFactor] = (byFormFactor[device.formFactor] ?? 0) + 1;
      const client = device.clientPlatform ?? "unknown";
      byClient[client] = (byClient[client] ?? 0) + 1;
    }

    const difficulties = {} as Record<Difficulty, DifficultyAggregate>;
    DIFFICULTIES.forEach((difficulty, index) => {
      difficulties[difficulty] = parseDifficulty(value<Record<string, string>>(10 + index, {}));
    });

    return {
      playersSeen: value(0, 0),
      playersPlayed: value(1, 0),
      playersSeenToday: value(2, 0),
      playersPlayedToday: value(3, 0),
      runsToday: Number(value<string | null>(4, null) ?? 0),
      installs,
      byOs,
      byFormFactor,
      byClient,
      difficulties,
      startingWeapons: numbers(value(6, {})),
      deathCauses: numbers(value(7, {})),
      stress: parseStress(value(8, {})),
      recordings: parseRecordings(value(9, {})),
    };
  }
}

function numbers(raw: Record<string, string>): Record<string, number> {
  return Object.fromEntries(Object.entries(raw).map(([key, count]) => [key, Number(count)]));
}

function parseDifficulty(raw: Record<string, string>): DifficultyAggregate {
  return {
    runs: Number(raw.runs ?? 0),
    totalSurvivalSec: Number(raw.survival ?? 0),
    totalLevel: Number(raw.level ?? 0),
    abandoned: Number(raw.abandoned ?? 0),
    buckets: Array.from({ length: DURATION_BUCKETS_MIN.length + 1 }, (_, index) => Number(raw[`b${index}`] ?? 0)),
  };
}

function parseRecordings(raw: Record<string, string>): StatsSnapshot["recordings"] {
  const byProblem: Record<string, number> = {};
  for (const [field, count] of Object.entries(raw)) {
    if (field.startsWith("problem:")) byProblem[field.slice("problem:".length)] = Number(count);
  }
  return { reports: Number(raw.reports ?? 0), problematic: Number(raw.problematic ?? 0), byProblem };
}

function parseStress(raw: Record<string, string>): StatsSnapshot["stress"] {
  const byOs: StatsSnapshot["stress"]["byOs"] = {};
  for (const [field, count] of Object.entries(raw)) {
    const [os, kind, outcome] = field.split(":");
    if (os === undefined || kind === undefined || os === "reports") continue;
    const entry = (byOs[os] ??= { reports: 0, totalPeak: 0, outcomes: {} });
    if (kind === "reports") entry.reports = Number(count);
    else if (kind === "peak") entry.totalPeak = Number(count);
    else if (kind === "outcome" && outcome !== undefined) entry.outcomes[outcome] = Number(count);
  }
  return { reports: Number(raw.reports ?? 0), byOs };
}

const deviceSchema = z.object({
  os: z.string(),
  formFactor: z.string(),
  clientPlatform: z.string().nullable(),
});

/** Строки пишет этот же сервис, но Redis — граница: битая строка пропускается. */
function parseDevice(raw: string | null): z.infer<typeof deviceSchema> | null {
  if (raw === null) return null;
  try {
    const parsed = deviceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Не JSON вовсе — устройство не считается, сводка строится без него.
    return null;
  }
}
