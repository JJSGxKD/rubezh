import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { loadAppConfig } from "../src/config/app-config";
import { DomainError } from "../src/common/domain-error";
import { runSubmissionSchema } from "../src/modules/playtest/dto/run-submission.dto";
import { PlaytestAuthGuard } from "../src/modules/playtest/playtest-auth.guard";
import { PlaytestService } from "../src/modules/playtest/playtest.service";
import { verifyInitData } from "../src/modules/playtest/telegram-init-data";
import { MemoryPlaytestStore } from "./helpers/memory-playtest.store";

// Сохранения и лидерборд плейтеста (docs/26-stage2-plan.md, WP13).

const BOT_TOKEN = "123456:TEST-token-for-signatures";
const NOW = Date.parse("2026-09-14T12:00:00Z");

/** Подписать данные запуска так же, как это делает Telegram. */
function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function launch(overrides: Record<string, string> = {}): string {
  return signInitData({
    auth_date: String(Math.floor(NOW / 1000) - 60),
    query_id: "AAE",
    user: JSON.stringify({ id: 777000111, first_name: "Анна", last_name: "К", username: "anna" }),
    ...overrides,
  });
}

describe("проверка initData", () => {
  it("принимает подписанные данные и достаёт игрока", () => {
    const check = verifyInitData(launch(), BOT_TOKEN, 86_400, NOW);
    expect(check).toMatchObject({ ok: true, player: { id: "777000111", name: "Анна К", username: "anna" } });
  });

  it("отвергает подменённое поле: подпись считается по всем полям", () => {
    const tampered = launch().replace("777000111", "777000112");
    expect(verifyInitData(tampered, BOT_TOKEN, 86_400, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отвергает подпись чужим токеном бота", () => {
    const foreign = signInitData({ auth_date: String(Math.floor(NOW / 1000)), user: "{}" }, "999:other");
    expect(verifyInitData(foreign, BOT_TOKEN, 86_400, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отвергает устаревшие данные: подпись вечна, окно — нет", () => {
    const old = launch({ auth_date: String(Math.floor(NOW / 1000) - 90_000) });
    expect(verifyInitData(old, BOT_TOKEN, 86_400, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("отвергает данные без подписи и без пользователя", () => {
    expect(verifyInitData("auth_date=1&user=%7B%7D", BOT_TOKEN, 86_400, NOW)).toEqual({
      ok: false,
      reason: "missing_hash",
    });
    const noUser = signInitData({ auth_date: String(Math.floor(NOW / 1000)) });
    expect(verifyInitData(noUser, BOT_TOKEN, 86_400, NOW)).toEqual({ ok: false, reason: "no_user" });
  });
});

describe("доступ к эндпоинтам плейтеста", () => {
  function context(headers: Record<string, string>): { ctx: ExecutionContext; request: Record<string, unknown> } {
    const request: Record<string, unknown> = { header: (name: string) => headers[name.toLowerCase()] };
    const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    return { ctx, request };
  }

  function guard(env: Record<string, string>): PlaytestAuthGuard {
    return new PlaytestAuthGuard(loadAppConfig({ NODE_ENV: "development", ...env }));
  }

  function statusOf(run: () => unknown): number | null {
    try {
      run();
      return null;
    } catch (error: unknown) {
      return error instanceof DomainError ? error.status : -1;
    }
  }

  it("выключенный плейтест отвечает 404 и не подтверждает, что эндпоинт есть", () => {
    const { ctx } = context({ authorization: `tma ${launch()}` });
    expect(statusOf(() => guard({}).canActivate(ctx))).toBe(404);
  });

  it("пускает игрока с настоящей подписью и кладёт его в запрос", () => {
    const { ctx, request } = context({ authorization: `tma ${launch({ auth_date: String(Math.floor(Date.now() / 1000)) })}` });
    expect(guard({ PLAYTEST_ENABLED: "true", TELEGRAM_BOT_TOKEN: BOT_TOKEN }).canActivate(ctx)).toBe(true);
    expect(request.playtestPlayer).toMatchObject({ id: "777000111" });
  });

  it("без подписи — 401, а вход разработчика работает только с включённым флагом", () => {
    const dev = { "x-playtest-dev-user": "dev-me:Разработчик" };
    expect(statusOf(() => guard({ PLAYTEST_ENABLED: "true", TELEGRAM_BOT_TOKEN: BOT_TOKEN }).canActivate(context(dev).ctx))).toBe(401);

    const { ctx, request } = context(dev);
    const withDevAuth = guard({ PLAYTEST_ENABLED: "true", TELEGRAM_BOT_TOKEN: BOT_TOKEN, PLAYTEST_DEV_AUTH: "true" });
    expect(withDevAuth.canActivate(ctx)).toBe(true);
    expect(request.playtestPlayer).toMatchObject({ id: "dev-me", name: "Разработчик" });
  });

  it("не поднимается с входом разработчика вне development и с плейтестом без токена бота", () => {
    expect(() => loadAppConfig({ NODE_ENV: "production", PLAYTEST_DEV_AUTH: "true" })).toThrow(/development/);
    expect(() => loadAppConfig({ PLAYTEST_ENABLED: "true" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

describe("сервис плейтеста", () => {
  let store: MemoryPlaytestStore;
  let service: PlaytestService;
  const anna = { id: "1", name: "Анна", username: null, photoUrl: null };
  const boris = { id: "2", name: "Борис", username: null, photoUrl: "https://t.me/i/b.jpg" };

  function run(runId: string, survivalSec: number, difficultyId: "easy" | "normal" | "hard" = "normal") {
    return runSubmissionSchema.parse({
      runId: `run-000-${runId}`,
      difficultyId,
      outcome: "died",
      survivalSec,
      level: 7,
      enemiesKilled: 120,
      startingWeaponId: "spark",
      weapons: [{ id: "spark", level: 3 }],
      contentHash: "abc123",
    });
  }

  beforeEach(() => {
    store = new MemoryPlaytestStore();
    service = new PlaytestService(store);
  });

  it("обновляет лучшее время только улучшением и сообщает место", async () => {
    expect(await service.submitRun(anna, run("a", 120), NOW)).toEqual({ bestSurvivalSec: 120, isNewBest: true, rank: 1 });
    expect(await service.submitRun(anna, run("b", 90), NOW)).toEqual({ bestSurvivalSec: 120, isNewBest: false, rank: 1 });
    expect(await service.submitRun(boris, run("c", 300), NOW)).toMatchObject({ isNewBest: true, rank: 1 });
    expect(await store.rank("normal", anna.id)).toBe(2);
  });

  it("не удваивает статистику на повторе того же забега после обрыва сети", async () => {
    await service.submitRun(anna, run("same", 100), NOW);
    await service.submitRun(anna, run("same", 100), NOW);
    expect((await service.profile(anna.id)).runs).toBe(1);
  });

  it("ведёт лидерборд по каждой сложности отдельно и не отдаёт чужие Telegram ID", async () => {
    await service.submitRun(anna, run("a", 500, "easy"), NOW);
    await service.submitRun(boris, run("b", 200, "hard"), NOW);

    const hard = await service.leaderboard(anna.id, "hard");
    expect(hard.entries).toHaveLength(1);
    expect(hard.entries[0]).toMatchObject({ rank: 1, name: "Борис", isMe: false, photoUrl: "https://t.me/i/b.jpg" });
    expect(hard.entries[0]).not.toHaveProperty("playerId");
    expect(hard.me).toBeNull();

    const easy = await service.leaderboard(anna.id, "easy");
    expect(easy.me).toEqual({ rank: 1, survivalSec: 500 });
    expect(easy.entries[0]?.isMe).toBe(true);
  });

  it("собирает профиль: счётчики, рекорды с местами и последние забеги", async () => {
    await service.submitRun(anna, run("a", 100, "easy"), NOW);
    await service.submitRun(anna, run("b", 60, "normal"), NOW + 1000);

    const profile = await service.profile(anna.id);
    expect(profile).toMatchObject({ runs: 2, totalKills: 240, totalSurvivalSec: 160 });
    expect(profile.best).toEqual({ easy: { survivalSec: 100, rank: 1 }, normal: { survivalSec: 60, rank: 1 }, hard: null });
    expect(profile.recent.map((entry) => entry.difficultyId)).toEqual(["normal", "easy"]);
  });

  it("недоступное хранилище отдаёт понятный код 503, а не внутреннюю ошибку", async () => {
    store.failing = true;
    await expect(service.leaderboard(anna.id, "normal")).rejects.toMatchObject({ code: "store_unavailable", status: 503 });
  });

  it("не принимает неправдоподобный итог: забег длиннее суток и неизвестную сложность", () => {
    expect(() => runSubmissionSchema.parse({ ...run("x", 10), survivalSec: 90_000 })).toThrow();
    expect(() => runSubmissionSchema.parse({ ...run("x", 10), difficultyId: "nightmare" })).toThrow();
  });
});
