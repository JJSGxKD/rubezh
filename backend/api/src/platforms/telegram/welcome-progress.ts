import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../../modules/auth/account.repository.js";
import { RunsViewService } from "../../modules/runs/runs-view.service.js";
import type { WelcomeProgress } from "./welcome-card.js";
import { WelcomeProgressRegistry, type WelcomeProgressSource } from "./welcome.command.js";

/**
 * Рекорд и место игрока для карточки `/start` — по его аккаунту
 * (docs/34-stage3-plan.md, WP4). Бот знает только Telegram ID отправителя,
 * поэтому аккаунт ищется по нему; не открывал игру — аккаунта нет, и карточка
 * зовёт сыграть первый раз. Сложность одна (Р126): рекорд и место — на единой,
 * рейтинговой; рекордов на обучающей и прежней нормальной в рейтинге нет.
 */
@Injectable()
export class RunsWelcomeProgress implements WelcomeProgressSource, OnModuleInit {
  constructor(
    private readonly registry: WelcomeProgressRegistry,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly view: RunsViewService,
  ) {}

  onModuleInit(): void {
    this.registry.source = this;
  }

  async progress(telegramId: string): Promise<WelcomeProgress | null> {
    const account = await this.accounts.byPlatformUser("telegram", telegramId);
    if (account === null) return { best: null, runs: 0 };

    const profile = await this.view.profile(account.accountId);
    const best = profile.best.hard;
    if (best === null) return { best: null, runs: profile.runs };
    // Глазами игрока: в тени ограничения рейтинга он видит в доске и себя.
    const total = await this.view.boardSize(account.accountId, "hard");
    return { best: { survivalSec: best.survivalSec, rank: best.rank, total }, runs: profile.runs };
  }
}
