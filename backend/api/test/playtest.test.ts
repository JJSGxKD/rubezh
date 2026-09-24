import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { sessionReportSchema } from "../src/modules/playtest/dto/session-report.dto.js";
import { DiagnosticsHooks } from "../src/modules/diagnostics/diagnostics-hooks.js";
import { benchSummaryOf } from "../src/modules/diagnostics/diagnostics-summary.js";
import { submitBenchReportSchema } from "../src/modules/diagnostics/dto/bench-report.dto.js";
import { accessFor } from "../src/modules/playtest/playtest-access.js";
import { PlaytestRunsListener } from "../src/modules/playtest/playtest-runs.listener.js";
import { PlaytestService } from "../src/modules/playtest/playtest.service.js";
import { PlaytestStressListener } from "../src/modules/playtest/playtest-stress.listener.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { benchSubmission, DEVICE, REPORT_ID } from "./helpers/bench-report.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPlaytestStatsStore } from "./helpers/memory-playtest-stats.store.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

// Плейтест после переезда забегов в `runs` (docs/34-stage3-plan.md, WP4):
// сводка, отчёты о запуске и доступ к инструментам.

const NOW = Date.parse("2026-09-14T12:00:00Z");

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, PLAYTEST_ENABLED: "true", ...env });
}

function account(platformUserId = "555"): AccountRef {
  return { accountId: randomUUID(), platform: "telegram", platformUserId };
}

describe("конфигурация плейтеста", () => {
  it("без авторизации не поднимается: забеги и запуски приходят под аккаунтом", () => {
    expect(() => loadAppConfig({ NODE_ENV: "test", PLAYTEST_ENABLED: "true", TELEGRAM_BOT_TOKEN: "1:T" })).toThrow(/AUTH_ENABLED/);
  });

  it("старое имя входа разработчика называет новое, а строка false из старого .env не мешает", () => {
    expect(() => config({ PLAYTEST_DEV_AUTH: "true" })).toThrow(/AUTH_DEV_LOGIN/);
    expect(() => config({ PLAYTEST_DEV_AUTH: "false" })).not.toThrow();
  });

  it("не поднимается с мусором в списке администраторов", () => {
    expect(() => loadAppConfig({ ADMIN_TELEGRAM_IDS: "123,@admin" })).toThrow(/ADMIN_TELEGRAM_IDS/);
    expect(loadAppConfig({ ADMIN_TELEGRAM_IDS: "" }).adminTelegramIds.size).toBe(0);
  });
});

describe("что открыто игроку", () => {
  const roles = (cfg: AppConfig) => new RolesService(cfg, new MemoryRolesRepository(), new MemoryAccountRepository());

  it("стресс-тест — всем на плейтесте, режим разработчика — по праву", async () => {
    // Ролей в базе нет, поэтому работает аварийный путь: список в окружении
    // даёт владельца, пока владельца нет (docs/34-stage3-plan.md, WP2).
    const cfg = config({ ADMIN_TELEGRAM_IDS: "111, 222" });

    expect(await accessFor(account("333"), cfg, roles(cfg))).toEqual({ admin: false, stressTest: true, devMode: false });
    expect(await accessFor(account("222"), cfg, roles(cfg))).toEqual({ admin: true, stressTest: true, devMode: true });
  });

  it("после плейтеста стресс-тест остаётся только у команды", async () => {
    const cfg = config({ PLAYTEST_ENABLED: "false", ADMIN_TELEGRAM_IDS: "222" });

    expect((await accessFor(account("333"), cfg, roles(cfg))).stressTest).toBe(false);
    expect((await accessFor(account("222"), cfg, roles(cfg))).stressTest).toBe(true);
  });

  it("вход разработчика на своей машине открывает режим разработчика", async () => {
    const local = config({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
    const remote = config();

    expect((await accessFor(account("dev-me"), local, roles(local))).devMode).toBe(true);
    // Без флага `dev-` — просто имя: права оно не даёт.
    expect((await accessFor(account("dev-me"), remote, roles(remote))).devMode).toBe(false);
  });
});

describe("сводка плейтеста", () => {
  let stats: MemoryPlaytestStatsStore;

  beforeEach(() => {
    stats = new MemoryPlaytestStatsStore();
  });

  function recorded(accountId: string, patch: Partial<RecordedRun> = {}): RecordedRun {
    return {
      runId: randomUUID(),
      accountId,
      difficulty: "normal",
      outcome: "died",
      survivalSec: 200,
      level: 7,
      enemiesKilled: 120,
      startingWeaponId: "spark",
      deathCause: "swarm_rat",
      cheats: false,
      ranked: true,
      verdict: "ok",
      reasons: [],
      finishedAt: new Date(NOW),
      ...patch,
    };
  }

  it("считает игроков, установки и устройства по запускам, забеги — по записанным", async () => {
    const service = new PlaytestService(stats);
    const hooks = new RunsHooks();
    new PlaytestRunsListener(config(), hooks, stats).onModuleInit();
    // Схема разбирает сырое тело запроса — строки ОС здесь как с клиента.
    const report = (installId: string, patch: Record<string, unknown> = {}) =>
      sessionReportSchema.parse({ installId, build: "0.3.0", contentHash: "abc123", device: { ...DEVICE, ...patch } });
    const [anna, boris] = [randomUUID(), randomUUID()];

    await service.recordSession(anna, report("install-anna-phone"), NOW);
    await service.recordSession(anna, report("install-anna-phone"), NOW + 1000);
    await service.recordSession(anna, report("install-anna-desk", { os: "windows", formFactor: "desktop", clientPlatform: "tdesktop" }), NOW);
    await service.recordSession(boris, report("install-boris", { os: "ios", clientPlatform: "ios" }), NOW);
    await hooks.emit(recorded(boris));

    const snapshot = await stats.snapshot(NOW);
    expect(snapshot).toMatchObject({ playersSeen: 2, playersPlayed: 1, installs: 3, runsToday: 1 });
    expect(snapshot.byOs).toEqual({ android: 1, windows: 1, ios: 1 });
    expect(snapshot.byFormFactor).toEqual({ phone: 2, desktop: 1 });
    expect(snapshot.deathCauses).toEqual({ swarm_rat: 1 });
  });

  it("забег с читами и отклонённый в сводку не идут, подозрительный — идёт", async () => {
    const hooks = new RunsHooks();
    new PlaytestRunsListener(config(), hooks, stats).onModuleInit();
    const me = randomUUID();

    await hooks.emit(recorded(me, { cheats: true, survivalSec: 5000 }));
    await hooks.emit(recorded(me, { verdict: "rejected", reasons: ["longer_than_wall_clock"] }));
    await hooks.emit(recorded(me, { verdict: "suspicious", reasons: ["kill_rate"] }));

    expect((await stats.snapshot(NOW)).difficulties.normal.runs).toBe(1);
  });

  it("выключенный плейтест забеги не считает", async () => {
    const hooks = new RunsHooks();
    new PlaytestRunsListener(config({ PLAYTEST_ENABLED: "false" }), hooks, stats).onModuleInit();

    await hooks.emit(recorded(randomUUID()));

    expect((await stats.snapshot(NOW)).difficulties.normal.runs).toBe(0);
  });

  it("недоступное хранилище отдаёт понятный код 503, а не внутреннюю ошибку", async () => {
    stats.failing = true;
    const report = sessionReportSchema.parse({ installId: "install-1", build: "0.3.0", contentHash: "abc", device: DEVICE });

    await expect(new PlaytestService(stats).recordSession(randomUUID(), report, NOW)).rejects.toMatchObject({ code: "store_unavailable", status: 503 });
  });

  it("сводит отчёт стресс-теста из приёмника диагностики к итогу без таймлайна и не считает повтор", async () => {
    const hooks = new DiagnosticsHooks();
    const listener = new PlaytestStressListener(config(), hooks, stats);
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
});
