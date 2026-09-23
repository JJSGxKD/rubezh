import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { DomainError } from "../src/common/domain-error.js";
import {
  runSubmissionSchema,
  sessionReportSchema,
} from "../src/modules/playtest/dto/run-submission.dto.js";
import { DiagnosticsHooks } from "../src/modules/diagnostics/diagnostics-hooks.js";
import { benchSummaryOf } from "../src/modules/diagnostics/diagnostics-summary.js";
import { submitBenchReportSchema } from "../src/modules/diagnostics/dto/bench-report.dto.js";
import { PlaytestStressListener } from "../src/modules/playtest/playtest-stress.listener.js";
import { benchSubmission, DEVICE, REPORT_ID } from "./helpers/bench-report.js";
import { accessFor } from "../src/modules/playtest/playtest-access.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { PlaytestAuthGuard } from "../src/modules/playtest/playtest-auth.guard.js";
import { PlaytestService } from "../src/modules/playtest/playtest.service.js";
import { verifyInitData } from "../src/modules/telegram/telegram-init-data.js";
import { MemoryPlaytestStatsStore } from "./helpers/memory-playtest-stats.store.js";
import { MemoryPlaytestStore } from "./helpers/memory-playtest.store.js";

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
    const request: Record<string, unknown> = { headers };
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
    const dev = { "x-playtest-dev-user": encodeURIComponent("dev-me:Разработчик") };
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

  it("открывает стресс-тест всем на плейтесте, а режим разработчика — по праву", async () => {
    const player = (id: string) => ({ id, name: "Игрок", username: null, photoUrl: null });
    // Ролей в базе нет, поэтому работает аварийный путь: список в окружении
    // даёт владельца, пока владельца нет (docs/34-stage3-plan.md, WP2).
    const roles = (config: AppConfig) => new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    const playtest = loadAppConfig({ PLAYTEST_ENABLED: "true", TELEGRAM_BOT_TOKEN: BOT_TOKEN, ADMIN_TELEGRAM_IDS: "111, 222" });

    expect(await accessFor(player("333"), playtest, roles(playtest))).toEqual({ admin: false, stressTest: true, devMode: false });
    expect(await accessFor(player("222"), playtest, roles(playtest))).toEqual({ admin: true, stressTest: true, devMode: true });
    // Вход заголовком разработчика — ещё не администратор, пока вход не включён.
    expect((await accessFor(player("dev-me"), playtest, roles(playtest))).devMode).toBe(false);

    const local = loadAppConfig({ NODE_ENV: "development", PLAYTEST_ENABLED: "true", TELEGRAM_BOT_TOKEN: BOT_TOKEN, PLAYTEST_DEV_AUTH: "true" });
    expect((await accessFor(player("dev-me"), local, roles(local))).devMode).toBe(true);
  });

  it("не поднимается с мусором в списке администраторов", () => {
    expect(() => loadAppConfig({ ADMIN_TELEGRAM_IDS: "123,@admin" })).toThrow(/ADMIN_TELEGRAM_IDS/);
    expect(loadAppConfig({ ADMIN_TELEGRAM_IDS: "" }).adminTelegramIds.size).toBe(0);
  });
});

describe("сервис плейтеста", () => {
  let store: MemoryPlaytestStore;
  let stats: MemoryPlaytestStatsStore;
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
    stats = new MemoryPlaytestStatsStore();
    service = new PlaytestService(store, stats);
  });

  it("обновляет лучшее время только улучшением и сообщает место", async () => {
    expect(await service.submitRun(anna, run("a", 120), NOW)).toEqual({
      bestSurvivalSec: 120,
      isNewBest: true,
      rank: 1,
      recorded: true,
    });
    expect(await service.submitRun(anna, run("b", 90), NOW)).toEqual({
      bestSurvivalSec: 120,
      isNewBest: false,
      rank: 1,
      recorded: true,
    });
    expect(await service.submitRun(boris, run("c", 300), NOW)).toMatchObject({ isNewBest: true, rank: 1 });
    expect(await store.rank("normal", anna.id)).toBe(2);
  });

  it("не удваивает статистику на повторе того же забега после обрыва сети", async () => {
    await service.submitRun(anna, run("same", 100), NOW);
    await service.submitRun(anna, run("same", 100), NOW);
    expect((await service.profile(anna.id)).runs).toBe(1);
    expect((await stats.snapshot(NOW)).difficulties.normal.runs).toBe(1);
  });

  it("не пишет забег с читами ни в рейтинг, ни в статистику", async () => {
    await service.submitRun(anna, run("honest", 100), NOW);
    const cheated = { ...run("god", 5000), cheats: true, countInRating: true };

    // Флаг «учесть в рейтинге» от обычного игрока не работает: право решает сервер.
    expect(await service.submitRun(anna, cheated, NOW)).toEqual({
      bestSurvivalSec: 100,
      isNewBest: false,
      rank: 1,
      recorded: false,
    });
    expect((await service.profile(anna.id)).runs).toBe(1);
    expect((await stats.snapshot(NOW)).difficulties.normal.runs).toBe(1);
  });

  it("учитывает забег с читами, если администратор явно попросил", async () => {
    const cheated = { ...run("god", 5000), cheats: true };
    expect(await service.submitRun(anna, cheated, NOW, true)).toMatchObject({ recorded: false });
    expect(await service.submitRun(anna, { ...cheated, countInRating: true }, NOW, true)).toMatchObject({
      bestSurvivalSec: 5000,
      recorded: true,
    });
  });

  it("считает игроков, установки и устройства по запускам", async () => {
    const device = {
      clientPlatform: "android",
      clientVersion: "8.0",
      os: "android",
      formFactor: "phone",
      screenWidth: 412,
      screenHeight: 915,
      pixelRatio: 2.63,
      cores: 8,
      memoryGb: 8,
    };
    // Схема разбирает сырое тело запроса — строки ОС здесь как с клиента.
    const report = (installId: string, patch: Record<string, unknown> = {}) =>
      sessionReportSchema.parse({ installId, build: "0.3.0", contentHash: "abc123", device: { ...device, ...patch } });

    await service.recordSession(anna, report("install-anna-phone"), NOW);
    await service.recordSession(anna, report("install-anna-phone"), NOW + 1000);
    await service.recordSession(anna, report("install-anna-desk", { os: "windows", formFactor: "desktop", clientPlatform: "tdesktop" }), NOW);
    await service.recordSession(boris, report("install-boris", { os: "ios", clientPlatform: "ios" }), NOW);
    await service.submitRun(boris, { ...run("b", 200), deathCause: "swarm_rat" }, NOW);

    const snapshot = await stats.snapshot(NOW);
    expect(snapshot).toMatchObject({ playersSeen: 2, playersPlayed: 1, installs: 3, runsToday: 1 });
    expect(snapshot.byOs).toEqual({ android: 1, windows: 1, ios: 1 });
    expect(snapshot.byFormFactor).toEqual({ phone: 2, desktop: 1 });
    expect(snapshot.deathCauses).toEqual({ swarm_rat: 1 });
  });

  it("сводит отчёт стресс-теста из приёмника диагностики к итогу без таймлайна и не считает повтор", async () => {
    const hooks = new DiagnosticsHooks();
    const listener = new PlaytestStressListener(loadAppConfig({ NODE_ENV: "test", PLAYTEST_ENABLED: "true", TELEGRAM_BOT_TOKEN: BOT_TOKEN }), hooks, stats);
    listener.onModuleInit();
    const payload = submitBenchReportSchema.parse(benchSubmission());
    const report = {
      reportId: REPORT_ID,
      kind: "bench" as const,
      appVersion: "0.3.0",
      installId: "install-anna-phone",
      platformUserId: "777000111",
      device: DEVICE,
      summary: benchSummaryOf(payload),
      payload,
      receivedAt: new Date(NOW),
    };

    await hooks.emit(report);
    await hooks.emit(report);
    expect(stats.stressRecent).toHaveLength(1);
    expect(stats.stressRecent[0]).toEqual({
      reportId: REPORT_ID,
      build: "0.3.0",
      mode: "stress",
      loadout: "full",
      outcome: "degradation",
      device: DEVICE,
      peakObjects: 1211,
      peakEnemies: 900,
      peakProjectiles: 310,
      avgFps: 58.4,
      p95FrameMs: 21.4,
      displayHz: 60,
      durationSec: 10,
      interruptions: 0,
      breakingLoad: 660,
    });
    expect((await stats.snapshot(NOW)).stress.byOs.android).toEqual({ reports: 1, totalPeak: 1211, outcomes: { degradation: 1 } });
  });

  it("не принимает запуск без установки и с неизвестной ОС", () => {
    const base = { installId: "install-1", build: "0.3.0", contentHash: "abc", device: {} };
    expect(() => sessionReportSchema.parse({ ...base, installId: "x" })).toThrow();
    expect(() =>
      sessionReportSchema.parse({
        ...base,
        device: { clientPlatform: null, clientVersion: null, os: "symbian", formFactor: "phone", screenWidth: 1, screenHeight: 1, pixelRatio: 1, cores: null, memoryGb: null },
      }),
    ).toThrow();
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
