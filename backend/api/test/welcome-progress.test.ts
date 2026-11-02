import { describe, expect, it } from "vitest";
import type { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { WelcomeProgressRegistry } from "../src/platforms/telegram/welcome.command.js";
import { RunsWelcomeProgress } from "../src/platforms/telegram/welcome-progress.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";

/**
 * Рекорд и место для карточки `/start` — из забегов под аккаунтом, всегда:
 * раньше источник подключался только при включённом плейтесте, и на проде
 * карточка их не показывала.
 */
describe("рекорд для карточки /start", () => {
  const view = {
    profile: async () => ({ runs: 7, best: { hard: { survivalSec: 612, rank: 3 }, normal: { survivalSec: 700, rank: 2 }, easy: { survivalSec: 900, rank: 1 } } }),
    boardSize: async (_accountId: string, difficulty: string) => (difficulty === "hard" ? 40 : 5),
  } as unknown as RunsViewService;

  it("подключается без условий и берёт рекорд единой сложности: рекорды нерейтинговых сложностей карточке не нужны", async () => {
    const accounts = new MemoryAccountRepository();
    await accounts.upsert({ platform: "telegram", platformUserId: "7", displayName: "Анна", username: null, photoUrl: null }, Date.now());
    const registry = new WelcomeProgressRegistry();
    const progress = new RunsWelcomeProgress(registry, accounts, view);
    progress.onModuleInit();
    expect(registry.source).toBe(progress);
    expect(await progress.progress("7")).toEqual({ best: { survivalSec: 612, rank: 3, total: 40 }, runs: 7 });
  });

  it("рекорд только на нерейтинговых сложностях — как будто рекорда нет, но число забегов остаётся", async () => {
    const accounts = new MemoryAccountRepository();
    await accounts.upsert({ platform: "telegram", platformUserId: "8", displayName: "Борис", username: null, photoUrl: null }, Date.now());
    const onlyOld = {
      profile: async () => ({ runs: 3, best: { hard: null, normal: { survivalSec: 700, rank: 2 }, easy: { survivalSec: 900, rank: 1 } } }),
      boardSize: async () => 5,
    } as unknown as RunsViewService;

    expect(await new RunsWelcomeProgress(new WelcomeProgressRegistry(), accounts, onlyOld).progress("8")).toEqual({ best: null, runs: 3 });
  });

  it("не открывавший игру — без аккаунта: карточка зовёт сыграть", async () => {
    const progress = new RunsWelcomeProgress(new WelcomeProgressRegistry(), new MemoryAccountRepository(), view);
    expect(await progress.progress("404")).toEqual({ best: null, runs: 0 });
  });
});
