import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { LEADERBOARD_STORE, type LeaderboardStore } from "../runs/leaderboard.store.js";
import { DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";
import { renderStatsCaption, renderStatsPng, renderStatsSvg } from "./playtest-stats.image.js";
import { PLAYTEST_STATS_STORE, type PlaytestStatsStore } from "./playtest-stats.store.js";
import { buildStatsSummary, type StatsSummary } from "./playtest-stats.summary.js";

export interface StatsReport {
  summary: StatsSummary;
  png: Buffer;
  caption: string;
}

/**
 * Сводка плейтеста целиком: счётчики из хранилища статистики, рекорды из
 * рейтинга аккаунтов (модуль `runs`), картинка и подпись. Не знает о Telegram — бот лишь доставляет
 * результат, и модуль бота на вебхуке позже вызовет этот же сервис.
 */
@Injectable()
export class PlaytestStatsService {
  constructor(
    @Inject(PLAYTEST_STATS_STORE) private readonly statsStore: PlaytestStatsStore,
    @Inject(LEADERBOARD_STORE) private readonly leaderboard: LeaderboardStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async summary(nowMs: number): Promise<StatsSummary> {
    const [snapshot, ...tops] = await Promise.all([
      this.statsStore.snapshot(nowMs),
      ...DIFFICULTIES.map((difficulty) => this.leaderboard.top(difficulty, 1)),
    ]);
    const bests = Object.fromEntries(
      DIFFICULTIES.map((difficulty, index) => [difficulty, tops[index]?.[0]?.survivalSec ?? null]),
    ) as Record<Difficulty, number | null>;
    return buildStatsSummary(snapshot, bests, nowMs, this.config.playtest.statsUtcOffsetMin);
  }

  async report(nowMs: number): Promise<StatsReport> {
    const summary = await this.summary(nowMs);
    const svg = renderStatsSvg(summary, this.config.playtest.statsUtcOffsetMin);
    return { summary, png: renderStatsPng(svg), caption: renderStatsCaption(summary) };
  }
}
