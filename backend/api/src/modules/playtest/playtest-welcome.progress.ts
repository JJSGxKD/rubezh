import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { WelcomeProgress } from "../welcome/welcome-card.js";
import { WelcomeProgressRegistry, type WelcomeProgressSource } from "../welcome/welcome.command.js";
import { PLAYTEST_STORE, type Difficulty, type PlaytestStore } from "./playtest.store.js";
import { PlaytestService } from "./playtest.service.js";

/** Сложнее — выше: рекорд на «Сложной» говорит об игроке больше, чем на «Лёгкой». */
const HARDEST_FIRST: readonly Difficulty[] = ["hard", "normal", "easy"];

/**
 * Рекорд и место игрока для карточки `/start` — из лидерборда плейтеста
 * (docs/26-stage2-plan.md, WP13).
 */
@Injectable()
export class PlaytestWelcomeProgress implements WelcomeProgressSource, OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: WelcomeProgressRegistry,
    private readonly service: PlaytestService,
    @Inject(PLAYTEST_STORE) private readonly store: PlaytestStore,
  ) {}

  onModuleInit(): void {
    if (this.config.playtest.enabled) this.registry.source = this;
  }

  async progress(playerId: string): Promise<WelcomeProgress | null> {
    const profile = await this.service.profile(playerId);
    const difficulty = HARDEST_FIRST.find((candidate) => profile.best[candidate] !== null);
    const best = difficulty === undefined ? null : profile.best[difficulty];
    if (difficulty === undefined || best === null) return { best: null, runs: profile.runs };
    const total = await this.store.playerCount(difficulty);
    return { best: { difficulty, survivalSec: best.survivalSec, rank: best.rank, total }, runs: profile.runs };
  }
}
