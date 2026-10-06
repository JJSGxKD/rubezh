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
    profile: async () => ({ runs: 7, best: { hard: null, normal: { survivalSec: 612, rank: 3 }, easy: { survivalSec: 900, rank: 1 } } }),
    boardSize: async () => 40,
  } as unknown as RunsViewService;

  it("подключается без условий и берёт самую сложную сложность с рекордом", async () => {
    const accounts = new MemoryAccountRepository();
    await accounts.upsert({ platform: "telegram", platformUserId: "7", displayName: "Анна", username: null, photoUrl: null }, Date.now());
    const registry = new WelcomeProgressRegistry();
    const progress = new RunsWelcomeProgress(registry, accounts, view);
    progress.onModuleInit();
    expect(registry.source).toBe(progress);
    expect(await progress.progress("7")).toEqual({ best: { difficulty: "normal", survivalSec: 612, rank: 3, total: 40 }, runs: 7 });
  });

  it("не открывавший игру — без аккаунта: карточка зовёт сыграть", async () => {
    const progress = new RunsWelcomeProgress(new WelcomeProgressRegistry(), new MemoryAccountRepository(), view);
    expect(await progress.progress("404")).toEqual({ best: null, runs: 0 });
  });
});
