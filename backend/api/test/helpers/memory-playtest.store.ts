import type {
  Difficulty,
  LeaderboardRow,
  PlayerStats,
  PlaytestStore,
  RecordRunResult,
  StoredRun,
} from "../../src/modules/playtest/playtest.store.js";
import type { TelegramPlayer } from "../../src/modules/playtest/telegram-init-data.js";

/**
 * Хранилище плейтеста в памяти — для тестов сервиса. Повторяет смысл
 * реализации на Redis: лучшее время только растёт, повтор забега не
 * удваивает статистику, при равном времени порядок — по id игрока по
 * убыванию, как у ZREVRANGE. Сама реализация на Redis проверяется отдельно.
 */
export class MemoryPlaytestStore implements PlaytestStore {
  failing = false;
  private readonly players = new Map<string, TelegramPlayer>();
  private readonly seenRuns = new Set<string>();
  private readonly bestByDifficulty = new Map<Difficulty, Map<string, { survivalSec: number; run: StoredRun }>>();
  private readonly statsById = new Map<string, PlayerStats>();
  private readonly runsById = new Map<string, StoredRun[]>();

  async savePlayer(player: TelegramPlayer): Promise<void> {
    this.check();
    this.players.set(player.id, player);
  }

  async recordRun(playerId: string, run: StoredRun): Promise<RecordRunResult> {
    this.check();
    const table = this.table(run.difficultyId);
    if (this.seenRuns.has(run.runId)) {
      return { duplicate: true, isNewBest: false, bestSurvivalSec: table.get(playerId)?.survivalSec ?? 0 };
    }
    this.seenRuns.add(run.runId);

    const stats = this.statsById.get(playerId) ?? { runs: 0, totalKills: 0, totalSurvivalSec: 0 };
    this.statsById.set(playerId, {
      runs: stats.runs + 1,
      totalKills: stats.totalKills + run.enemiesKilled,
      totalSurvivalSec: stats.totalSurvivalSec + run.survivalSec,
    });
    this.runsById.set(playerId, [run, ...(this.runsById.get(playerId) ?? [])].slice(0, 20));

    const current = table.get(playerId);
    if (current === undefined || run.survivalSec > current.survivalSec) {
      table.set(playerId, { survivalSec: run.survivalSec, run });
      return { duplicate: false, isNewBest: true, bestSurvivalSec: run.survivalSec };
    }
    return { duplicate: false, isNewBest: false, bestSurvivalSec: current.survivalSec };
  }

  async rank(difficulty: Difficulty, playerId: string): Promise<number | null> {
    this.check();
    const index = this.sorted(difficulty).findIndex(([id]) => id === playerId);
    return index < 0 ? null : index + 1;
  }

  async best(difficulty: Difficulty, playerId: string): Promise<number | null> {
    this.check();
    return this.table(difficulty).get(playerId)?.survivalSec ?? null;
  }

  async leaderboard(difficulty: Difficulty, limit: number): Promise<LeaderboardRow[]> {
    this.check();
    return this.sorted(difficulty)
      .slice(0, limit)
      .map(([playerId, entry]) => ({
        playerId,
        name: this.players.get(playerId)?.name ?? "Игрок",
        photoUrl: this.players.get(playerId)?.photoUrl ?? null,
        survivalSec: entry.survivalSec,
        level: entry.run.level,
        startingWeaponId: entry.run.startingWeaponId,
        enemiesKilled: entry.run.enemiesKilled,
      }));
  }

  async playerCount(difficulty: Difficulty): Promise<number> {
    this.check();
    return this.table(difficulty).size;
  }

  async stats(playerId: string): Promise<PlayerStats> {
    this.check();
    return this.statsById.get(playerId) ?? { runs: 0, totalKills: 0, totalSurvivalSec: 0 };
  }

  async recentRuns(playerId: string, limit: number): Promise<StoredRun[]> {
    this.check();
    return (this.runsById.get(playerId) ?? []).slice(0, limit);
  }

  private table(difficulty: Difficulty): Map<string, { survivalSec: number; run: StoredRun }> {
    let table = this.bestByDifficulty.get(difficulty);
    if (table === undefined) {
      table = new Map();
      this.bestByDifficulty.set(difficulty, table);
    }
    return table;
  }

  private sorted(difficulty: Difficulty): [string, { survivalSec: number; run: StoredRun }][] {
    return [...this.table(difficulty).entries()].sort(
      ([leftId, left], [rightId, right]) => right.survivalSec - left.survivalSec || (rightId > leftId ? 1 : -1),
    );
  }

  private check(): void {
    if (this.failing) throw new Error("хранилище недоступно");
  }
}
