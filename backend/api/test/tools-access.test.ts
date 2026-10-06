import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { ToolsAccessService } from "../src/modules/roles/tools-access.js";
import { environmentSettings, type SettingsReader } from "../src/modules/settings/settings.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Инструменты команды в клиенте (docs/28-diagnostics.md §2.3): режим
 * разработчика — по праву `tools.dev`, стресс-тест — ему же, а всем — когда
 * команда включила «Стресс-тест для всех игроков». Приёмник спрашивает то же.
 */

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ...env } as NodeJS.ProcessEnv);
}

function account(platformUserId = "555"): AccountRef {
  return { accountId: randomUUID(), platform: "telegram", platformUserId };
}

/** «Стресс-тест для всех» включён в панели. */
function stressForAll(cfg: AppConfig): SettingsReader {
  const env = environmentSettings(cfg);
  return { get: (setting) => (setting.key === "diagnostics.stress-for-all" ? setting.schema.parse(true) : env.get(setting)), onChange: () => undefined };
}

function tools(cfg: AppConfig, settings: SettingsReader = environmentSettings(cfg)): ToolsAccessService {
  return new ToolsAccessService(new RolesService(cfg, new MemoryRolesRepository(), new MemoryAccountRepository()), settings, cfg);
}

describe("что открыто игроку", () => {
  it("режим разработчика и стресс-тест — по праву, остальным — ничего", async () => {
    // Ролей в базе нет, поэтому работает аварийный путь: список в окружении
    // даёт владельца, пока владельца нет (docs/34-stage3-plan.md, WP2).
    const cfg = config({ ADMIN_TELEGRAM_IDS: "111, 222" });
    expect(await tools(cfg).forAccount(account("333"))).toEqual({ admin: false, stressTest: false, devMode: false });
    expect(await tools(cfg).forAccount(account("222"))).toEqual({ admin: true, stressTest: true, devMode: true });
  });

  it("стресс-тест для всех — из панели: режим разработчика он не открывает", async () => {
    const cfg = config({ ADMIN_TELEGRAM_IDS: "222" });
    expect(await tools(cfg, stressForAll(cfg)).forAccount(account("333"))).toEqual({ admin: false, stressTest: true, devMode: false });
  });

  it("вход разработчика на своей машине открывает всё", async () => {
    const local = config({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
    const remote = config();
    expect(await tools(local).forAccount(account("dev-me"))).toEqual({ admin: true, stressTest: true, devMode: true });
    // Без флага `dev-` — просто имя: права оно не даёт.
    expect((await tools(remote).forAccount(account("dev-me"))).devMode).toBe(false);
  });
});

describe("приёмник стресс-теста", () => {
  it("принимает от команды и — когда включено в панели — от всех; без подписи — только при «для всех»", async () => {
    const cfg = config({ ADMIN_TELEGRAM_IDS: "222" });
    expect(await tools(cfg).stressTestOpen("222")).toBe(true);
    expect(await tools(cfg).stressTestOpen("333")).toBe(false);
    expect(await tools(cfg).stressTestOpen(null)).toBe(false);
    expect(await tools(cfg, stressForAll(cfg)).stressTestOpen("333")).toBe(true);
    expect(await tools(cfg, stressForAll(cfg)).stressTestOpen(null)).toBe(true);
  });

  it("на машине разработчика открыт всем", async () => {
    expect(await tools(config({ NODE_ENV: "development" })).stressTestOpen(null)).toBe(true);
  });
});

describe("список администраторов в окружении", () => {
  it("мусор в списке роняет старт, пустой — пуст", () => {
    expect(() => loadAppConfig({ ADMIN_TELEGRAM_IDS: "123,@admin" } as NodeJS.ProcessEnv)).toThrow(/ADMIN_TELEGRAM_IDS/);
    expect(loadAppConfig({ ADMIN_TELEGRAM_IDS: "" } as NodeJS.ProcessEnv).adminTelegramIds.size).toBe(0);
  });
});
