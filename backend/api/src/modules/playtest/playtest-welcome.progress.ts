import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { LEADERBOARD_STORE, type LeaderboardStore } from "../runs/leaderboard.store.js";
import type { Difficulty } from "../runs/run-rules.js";
import { RunsViewService } from "../runs/runs-view.service.js";
import type { WelcomeProgress } from "../welcome/welcome-card.js";
import { WelcomeProgressRegistry, type WelcomeProgressSource } from "../welcome/welcome.command.js";

/** Сложнее — выше: рекорд на «Сложной» говорит об игроке больше, чем на «Лёгкой». */
const HARDEST_FIRST: readonly Difficulty[] = ["hard", "normal", "easy"];

/**
 * Рекорд и место игрока для карточки `/start` — по его аккаунту
 * (docs/34-stage3-plan.md, WP4). Бот знает только Telegram ID отправителя,
 * поэтому аккаунт ищется по нему; не открывал игру — аккаунта нет, и карточка
 * зовёт сыграть первый раз.
 */
@Injectable()
export class PlaytestWelcomeProgress implements WelcomeProgressSource, OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: WelcomeProgressRegistry,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly view: RunsViewService,
    @Inject(LEADERBOARD_STORE) private readonly leaderboard: LeaderboardStore,
  ) {}

  onModuleInit(): void {
    if (this.config.playtest.enabled) this.registry.source = this;
  }

  async progress(telegramId: string): Promise<WelcomeProgress | null> {
    const account = await this.accounts.byPlatformUser("telegram", telegramId);
    if (account === null) return { best: null, runs: 0 };

    const profile = await this.view.profile(account.accountId);
    const difficulty = HARDEST_FIRST.find((candidate) => profile.best[candidate] !== null);
    const best = difficulty === undefined ? null : profile.best[difficulty];
    if (difficulty === undefined || best === null) return { best: null, runs: profile.runs };
    const total = await this.leaderboard.count(difficulty);
    return { best: { difficulty, survivalSec: best.survivalSec, rank: best.rank, total }, runs: profile.runs };
  }
}
