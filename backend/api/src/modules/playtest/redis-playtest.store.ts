import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import type {
  Difficulty,
  LeaderboardRow,
  PlayerStats,
  PlaytestStore,
  RecordRunResult,
  StoredRun,
} from "./playtest.store";
import { PLAYTEST_REDIS } from "./playtest-redis";
import type { TelegramPlayer } from "./telegram-init-data";

/**
 * Данные плейтеста в Redis (docs/26-stage2-plan.md, Р19 и WP13).
 *
 * Redis, а не Postgres, сознательно: данные плейтеста временные и после него
 * стираются, а лидерборд — это ровно сортированное множество. Каждый ключ
 * живёт `dataTtlSec` с последней записи: забытый плейтест убирает себя сам.
 *
 * Ключи:
 * - `pt:player:{id}` — хэш: имя, фото;
 * - `pt:lb:{сложность}` — сортированное множество: игрок → лучшее время;
 * - `pt:lbrun:{сложность}` — хэш: игрок → лучший забег строкой JSON;
 * - `pt:stats:{id}` — хэш счётчиков; `pt:runs:{id}` — последние забеги;
 * - `pt:run:{runId}` — отметка «забег уже записан» против повторов.
 *
 * Подключение общее на модуль (`playtest-redis.ts`), с таймаутом на каждую
 * команду: недоступный Redis не должен вешать запрос игрока.
 */

const RECENT_RUNS_KEPT = 20;

/**
 * Лучшее время обновляется атомарно вместе с деталями забега: иначе два
 * параллельных запроса одного игрока могли бы записать время одного забега,
 * а уровень и оружие — другого.
 */
const UPDATE_BEST_SCRIPT = `
local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
if (not current) or tonumber(ARGV[2]) > tonumber(current) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  redis.call('EXPIRE', KEYS[2], ARGV[4])
  return {1, ARGV[2]}
end
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return {0, current}
`;

const bestRunSchema = z.object({
  level: z.number(),
  startingWeaponId: z.string(),
  enemiesKilled: z.number(),
});

const storedRunSchema = z.object({
  runId: z.string(),
  difficultyId: z.enum(["easy", "normal", "hard"]),
  outcome: z.enum(["died", "abandoned"]),
  survivalSec: z.number(),
  level: z.number(),
  enemiesKilled: z.number(),
  startingWeaponId: z.string(),
  weapons: z.array(z.object({ id: z.string(), level: z.number() })),
  contentHash: z.string(),
  at: z.number(),
});

@Injectable()
export class RedisPlaytestStore implements PlaytestStore {
  private readonly ttlSec: number;

  constructor(
    @Inject(PLAYTEST_REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ttlSec = config.playtest.dataTtlSec;
  }

  async savePlayer(player: TelegramPlayer): Promise<void> {
    const key = `pt:player:${player.id}`;
    await this.redis
      .multi()
      .hset(key, { name: player.name, photoUrl: player.photoUrl ?? "" })
      .expire(key, this.ttlSec)
      .exec();
  }

  async recordRun(playerId: string, run: StoredRun): Promise<RecordRunResult> {
    // Повтор того же забега — ретрай клиента после обрыва сети: статистика
    // не удваивается, но лучшее время ответ всё равно сообщает.
    const fresh = await this.redis.set(`pt:run:${run.runId}`, playerId, "EX", this.ttlSec, "NX");
    if (fresh === null) {
      const best = await this.best(run.difficultyId, playerId);
      return { duplicate: true, isNewBest: false, bestSurvivalSec: best ?? 0 };
    }

    const statsKey = `pt:stats:${playerId}`;
    const runsKey = `pt:runs:${playerId}`;
    await this.redis
      .multi()
      .hincrby(statsKey, "runs", 1)
      .hincrby(statsKey, "totalKills", run.enemiesKilled)
      .hincrbyfloat(statsKey, "totalSurvivalSec", run.survivalSec)
      .expire(statsKey, this.ttlSec)
      .lpush(runsKey, JSON.stringify(run))
      .ltrim(runsKey, 0, RECENT_RUNS_KEPT - 1)
      .expire(runsKey, this.ttlSec)
      .exec();

    const details = JSON.stringify({
      level: run.level,
      startingWeaponId: run.startingWeaponId,
      enemiesKilled: run.enemiesKilled,
    });
    const reply = (await this.redis.eval(
      UPDATE_BEST_SCRIPT,
      2,
      `pt:lb:${run.difficultyId}`,
      `pt:lbrun:${run.difficultyId}`,
      playerId,
      String(run.survivalSec),
      details,
      String(this.ttlSec),
    )) as [number, string];

    return { duplicate: false, isNewBest: reply[0] === 1, bestSurvivalSec: Number(reply[1]) };
  }

  async rank(difficulty: Difficulty, playerId: string): Promise<number | null> {
    const rank = await this.redis.zrevrank(`pt:lb:${difficulty}`, playerId);
    return rank === null ? null : rank + 1;
  }

  async best(difficulty: Difficulty, playerId: string): Promise<number | null> {
    const score = await this.redis.zscore(`pt:lb:${difficulty}`, playerId);
    return score === null ? null : Number(score);
  }

  async leaderboard(difficulty: Difficulty, limit: number): Promise<LeaderboardRow[]> {
    const flat = await this.redis.zrevrange(`pt:lb:${difficulty}`, 0, limit - 1, "WITHSCORES");
    const ids: string[] = [];
    const scores: number[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      ids.push(flat[i]);
      scores.push(Number(flat[i + 1]));
    }
    if (ids.length === 0) return [];

    const pipeline = this.redis.pipeline();
    pipeline.hmget(`pt:lbrun:${difficulty}`, ...ids);
    for (const id of ids) pipeline.hmget(`pt:player:${id}`, "name", "photoUrl");
    const replies = (await pipeline.exec()) ?? [];

    const detailsRaw = (replies[0]?.[1] as (string | null)[] | undefined) ?? [];
    return ids.map((playerId, index) => {
      const details = parseBestRun(detailsRaw[index] ?? null);
      const [name, photoUrl] = (replies[index + 1]?.[1] as (string | null)[] | undefined) ?? [];
      return {
        playerId,
        name: name ?? "Игрок",
        photoUrl: photoUrl === null || photoUrl === undefined || photoUrl === "" ? null : photoUrl,
        survivalSec: scores[index],
        level: details.level,
        startingWeaponId: details.startingWeaponId,
        enemiesKilled: details.enemiesKilled,
      };
    });
  }

  async playerCount(difficulty: Difficulty): Promise<number> {
    return this.redis.zcard(`pt:lb:${difficulty}`);
  }

  async stats(playerId: string): Promise<PlayerStats> {
    const raw = await this.redis.hgetall(`pt:stats:${playerId}`);
    return {
      runs: Number(raw.runs ?? 0),
      totalKills: Number(raw.totalKills ?? 0),
      totalSurvivalSec: Number(raw.totalSurvivalSec ?? 0),
    };
  }

  async recentRuns(playerId: string, limit: number): Promise<StoredRun[]> {
    const raw = await this.redis.lrange(`pt:runs:${playerId}`, 0, limit - 1);
    return raw.flatMap((line) => {
      // Строки пишет этот же сервис, но Redis — граница системы: битая строка
      // пропускается, а не роняет профиль.
      try {
        const parsed = storedRunSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }
}

function parseBestRun(raw: string | null): z.infer<typeof bestRunSchema> {
  const fallback = { level: 0, startingWeaponId: "", enemiesKilled: 0 };
  if (raw === null) return fallback;
  try {
    const parsed = bestRunSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    // Детали лучшего забега не читаются — строка лидерборда покажет время без них.
    return fallback;
  }
}
