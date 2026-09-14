import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { DIFFICULTIES, PLAYTEST_STORE, type Difficulty, type PlaytestStore } from "./playtest.store";
import { renderStatsCaption, renderStatsPng, renderStatsSvg } from "./playtest-stats.image";
import { PLAYTEST_STATS_STORE, type PlaytestStatsStore } from "./playtest-stats.store";
import { buildStatsSummary, type StatsSummary } from "./playtest-stats.summary";

export interface StatsReport {
  summary: StatsSummary;
  png: Buffer;
  caption: string;
}

/**
 * Сводка плейтеста целиком: счётчики из хранилища статистики, рекорды из
 * лидерборда, картинка и подпись. Не знает о Telegram — бот лишь доставляет
 * результат, и модуль бота на вебхуке позже вызовет этот же сервис.
 */
@Injectable()
export class PlaytestStatsService {
  constructor(
    @Inject(PLAYTEST_STATS_STORE) private readonly statsStore: PlaytestStatsStore,
    @Inject(PLAYTEST_STORE) private readonly store: PlaytestStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async summary(nowMs: number): Promise<StatsSummary> {
    const [snapshot, ...tops] = await Promise.all([
      this.statsStore.snapshot(nowMs),
      ...DIFFICULTIES.map((difficulty) => this.store.leaderboard(difficulty, 1)),
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
