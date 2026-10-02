import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { AdminSettingsService } from "../src/modules/admin/admin-settings.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { MemoryRateStore } from "@bh/fx";
import { FxHooks } from "../src/modules/fx/fx-hooks.js";
import { FxRefresher } from "../src/modules/fx/fx.refresher.js";
import { FeatureSwitches } from "../src/modules/settings/feature-switches.js";
import { NotifyTargets } from "../src/modules/settings/notify-targets.js";
import { SETTINGS, SETTING_KEY, SETTING_LIST } from "../src/modules/settings/setting-catalog.js";
import type { SettingDefinition, SettingValue } from "../src/modules/settings/setting-catalog.js";
import type { SettingsRepository, StoredSetting } from "../src/modules/settings/settings.repository.js";
import { SETTINGS_CHANNEL, SettingsService } from "../src/modules/settings/settings.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { environmentSecrets } from "../src/modules/secrets/secrets.service.js";

/**
 * Настройки без релиза (docs/35-stage4-plan.md §3.18, Р53): база сильнее
 * окружения, окружение сильнее умолчания; битое значение из базы не ломает
 * чтение; запись оповещает соседние реплики; в панели — с правом и в аудит.
 */

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

class MemorySettings implements SettingsRepository {
  readonly rows = new Map<string, StoredSetting>();
  fail = false;

  async all(): Promise<StoredSetting[]> {
    if (this.fail) throw new Error("connection refused");
    return [...this.rows.values()];
  }

  async save(key: string, value: SettingValue, updatedBy: string): Promise<StoredSetting> {
    const row = { key, value, updatedBy, updatedAt: new Date() };
    this.rows.set(key, row);
    return row;
  }

  async remove(key: string): Promise<StoredSetting | null> {
    const row = this.rows.get(key) ?? null;
    this.rows.delete(key);
    return row;
  }
}

/** Redis ровно настолько, насколько его трогают настройки: сообщение и подписка. */
class FakeRedis {
  readonly published: string[] = [];
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  subscribed: string[] = [];
  disconnected = false;

  async publish(channel: string, message: string): Promise<number> {
    this.published.push(`${channel}:${message}`);
    return 1;
  }

  duplicate(): FakeRedis {
    return this;
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribed.push(channel);
    return 1;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ...env } as NodeJS.ProcessEnv);
}

function setup(env: Record<string, string> = {}) {
  const repository = new MemorySettings();
  const redis = new FakeRedis();
  const service = new SettingsService(config(env), repository, redis as unknown as Redis);
  return { repository, redis, service };
}

describe("каталог настроек", () => {
  it("ключи уникальны и в формате, у каждого — название, подсказка и умолчание по своей схеме", () => {
    const keys = SETTING_LIST.map((setting) => setting.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const setting of SETTING_LIST) {
      expect(setting.key, setting.key).toMatch(SETTING_KEY);
      expect(setting.title.length, setting.key).toBeGreaterThan(3);
      expect(setting.hint.length, setting.key).toBeGreaterThan(10);
      expect(setting.schema.safeParse(setting.fallback).success, setting.key).toBe(true);
    }
  });

  it("адрес чата — id или id:тема, пусто допустимо, мусор — нет", () => {
    expect(SETTINGS.chatGeneral.schema.safeParse("-1001234567890:57").success).toBe(true);
    expect(SETTINGS.chatGeneral.schema.safeParse("").success).toBe(true);
    expect(SETTINGS.chatGeneral.schema.safeParse("@team").success).toBe(false);
    expect(SETTINGS.chatGeneral.schema.safeParse("-100:").success).toBe(false);
  });
});

describe("порядок значений", () => {
  it("база → окружение → умолчание", async () => {
    const { repository, service } = setup({ ADMIN_CHAT_ID: "-100" });
    expect(service.get(SETTINGS.chatStats)).toBe("");
    expect(service.get(SETTINGS.chatGeneral)).toBe("-100");
    expect(service.get(SETTINGS.notifyReports)).toBe(true);

    repository.rows.set("notify.chat.general", { key: "notify.chat.general", value: "-200:3", updatedBy: ACTOR_ID, updatedAt: new Date() });
    repository.rows.set("notify.reports", { key: "notify.reports", value: false, updatedBy: ACTOR_ID, updatedAt: new Date() });
    await service.refresh();
    expect(service.get(SETTINGS.chatGeneral)).toBe("-200:3");
    expect(service.get(SETTINGS.notifyReports)).toBe(false);
    expect(service.describe().find((state) => state.setting.key === "notify.chat.general")).toMatchObject({ source: "base", envValue: "-100", updatedBy: ACTOR_ID });
  });

  it("пустое значение из панели сильнее окружения: поток можно заглушить, не трогая .env", async () => {
    const { service } = setup({ ADMIN_CHAT_ID: "-100", ADMIN_CHAT_RUN_REVIEW: "-300" });
    await service.write(SETTINGS.chatRunReview, "", ACTOR_ID);
    expect(service.get(SETTINGS.chatRunReview)).toBe("");
    // Пустой поток берёт общий — как и пустое окружение.
    expect(new NotifyTargets(service).chats().runReview).toEqual({ chatId: "-100", threadId: null });
  });

  it("переключатель из окружения различает «не задан» и «включён»", () => {
    expect(setup().service.describe().find((state) => state.setting.key === "notify.reports")).toMatchObject({ value: true, source: "default", envValue: null });
    expect(setup({ ADMIN_NOTIFY_REPORTS: "true" }).service.describe().find((state) => state.setting.key === "notify.reports")).toMatchObject({ source: "env" });
    expect(setup({ ADMIN_NOTIFY_REPORTS: "false" }).service.get(SETTINGS.notifyReports)).toBe(false);
  });

  it("битое значение из базы и неизвестный ключ не ломают чтение — работает окружение", async () => {
    const { repository, service } = setup({ ADMIN_CHAT_ID: "-100" });
    repository.rows.set("notify.chat.general", { key: "notify.chat.general", value: 42, updatedBy: null, updatedAt: new Date() });
    repository.rows.set("gone.key", { key: "gone.key", value: "x", updatedBy: null, updatedAt: new Date() });
    await service.refresh();
    expect(service.get(SETTINGS.chatGeneral)).toBe("-100");
    expect(service.describe().find((state) => state.setting.key === "notify.chat.general")?.source).toBe("env");
  });

  it("база недоступна — остаётся последнее прочитанное", async () => {
    const { repository, service } = setup();
    repository.rows.set("notify.reports", { key: "notify.reports", value: false, updatedBy: null, updatedAt: new Date() });
    await service.refresh();
    repository.fail = true;
    await service.refresh();
    expect(service.get(SETTINGS.notifyReports)).toBe(false);
  });

  it("сброс возвращает окружение и говорит, была ли запись", async () => {
    const { service } = setup({ ADMIN_CHAT_ID: "-100" });
    await service.write(SETTINGS.chatGeneral, "-200", ACTOR_ID);
    expect(await service.clear(SETTINGS.chatGeneral)).toBe(true);
    expect(service.get(SETTINGS.chatGeneral)).toBe("-100");
    expect(await service.clear(SETTINGS.chatGeneral)).toBe(false);
  });
});

describe("соседние реплики", () => {
  it("запись сообщает в канал, а чужое сообщение перечитывает базу", async () => {
    const { repository, redis, service } = setup();
    await service.onModuleInit();
    expect(redis.subscribed).toEqual([SETTINGS_CHANNEL]);

    await service.write(SETTINGS.notifyReports, false, ACTOR_ID);
    expect(redis.published).toEqual([`${SETTINGS_CHANNEL}:notify.reports`]);

    // Соседняя реплика записала своё — эта узнаёт по сообщению.
    repository.rows.set("notify.chat.general", { key: "notify.chat.general", value: "-500", updatedBy: ACTOR_ID, updatedAt: new Date() });
    redis.emit("message", SETTINGS_CHANNEL, "notify.chat.general");
    await expect.poll(() => service.get(SETTINGS.chatGeneral)).toBe("-500");

    service.onModuleDestroy();
    expect(redis.disconnected).toBe(true);
  });

  it("после обрыва подписки настройки перечитываются: сообщения за обрыв не придут", async () => {
    const { repository, redis, service } = setup();
    await service.onModuleInit();
    redis.emit("error", new Error("ECONNRESET"));
    repository.rows.set("notify.reports", { key: "notify.reports", value: false, updatedBy: null, updatedAt: new Date() });
    redis.emit("ready");
    await expect.poll(() => service.get(SETTINGS.notifyReports)).toBe(false);
    service.onModuleDestroy();
  });

  it("без базы не подписывается и не читает — только окружение", async () => {
    const repository = new MemorySettings();
    repository.fail = true;
    const redis = new FakeRedis();
    const service = new SettingsService(loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), repository, redis as unknown as Redis);
    await service.onModuleInit();
    expect(redis.subscribed).toEqual([]);
    expect(service.get(SETTINGS.notifyReports)).toBe(true);
  });

  it("оповещает о смене действующего значения, а не о каждой записи", async () => {
    const { service } = setup({ ADMIN_CHAT_ID: "-100" });
    const changes: string[][] = [];
    service.onChange((changed) => changes.push([...changed]));
    // То же, что в окружении: действующее значение не поменялось.
    await service.write(SETTINGS.chatGeneral, "-100", ACTOR_ID);
    await service.write(SETTINGS.chatGeneral, "-200", ACTOR_ID);
    await service.refresh();
    expect(changes).toEqual([["notify.chat.general"]]);
  });

  it("смена адреса будит тех, кто следит за чатами, а переключатель — нет", async () => {
    const { service } = setup();
    let calls = 0;
    new NotifyTargets(service).onChatsChange(() => calls++);
    await service.write(SETTINGS.notifyReports, false, ACTOR_ID);
    expect(calls).toBe(0);
    await service.write(SETTINGS.chatStress, "-700", ACTOR_ID);
    expect(calls).toBe(1);
  });
});

describe("выключатели функций", () => {
  /** Настройки, поменянные в панели посреди теста. */
  function switches(env: Record<string, string>, panel: Record<string, boolean> = {}) {
    const cfg = config(env);
    const values = new Map(Object.entries(panel));
    const reader = {
      get: <T extends SettingValue>(setting: SettingDefinition<T>): T =>
        values.has(setting.key) ? setting.schema.parse(values.get(setting.key)) : (setting.fromEnv(cfg) ?? setting.fallback),
      onChange: () => undefined,
    };
    return { switches: new FeatureSwitches(reader, cfg), values };
  }

  it("панель сильнее окружения в обе стороны", () => {
    expect(switches({ EVENTS_INGEST_ENABLED: "true" }, { "ingest.events": false }).switches.eventsIngest()).toBe(false);
    expect(switches({}, { "ingest.events": true }).switches.eventsIngest()).toBe(true);
    expect(switches({ FX_ENABLED: "true" }, { "fx.polling": false }).switches.fxPolling()).toBe(false);
  });

  it("без ключей функция не включается и из панели", () => {
    // Приёмнику нужна база, выгрузке — ключ псевдонимов и чтение обновлений, оплате — вход и обновления.
    expect(switches({ DATABASE_URL: "", JWT_ACCESS_SECRET: "" }, { "ingest.reports": true }).switches.reportsIngest()).toBe(false);
    expect(switches({}, { "export.bot": true }).switches.exportBot()).toBe(false);
    expect(switches({}, { "payments.stars": true }).switches.payments()).toBe(false);
  });

  it("ключ задан — включено; стоп-кран оплаты выключает её на ходу", () => {
    const { switches: live, values } = switches({ TELEGRAM_BOT_UPDATES: "polling" });
    expect(live.payments()).toBe(true);
    values.set("payments.stars", false);
    expect(live.payments()).toBe(false);
  });

  it("опрос курсов, выключенный в панели, не трогает ни лок, ни источники", async () => {
    const { switches: off } = switches({ FX_ENABLED: "true" }, { "fx.polling": false });
    const redis = { set: async () => Promise.reject(new Error("лок трогать нельзя")), eval: async () => 0 };
    const refresher = new FxRefresher(environmentSecrets(config({ FX_ENABLED: "true" })), new MemoryRateStore(), redis as never, new FxHooks(), off);
    expect(await refresher.tick([])).toBeNull();
  });
});

describe("настройки в панели", () => {
  const OWNER_ID = "777000111";

  async function panel(env: Record<string, string> = {}) {
    const cfg = config({ ADMIN_TELEGRAM_IDS: OWNER_ID, ...env });
    const accounts = new MemoryAccountRepository();
    const rolesRepository = new MemoryRolesRepository();
    const settings = new SettingsService(cfg, new MemorySettings(), new FakeRedis() as unknown as Redis);
    const admin = new AdminSettingsService(settings, new RolesService(cfg, rolesRepository, accounts));
    const ownerAccount = await accounts.upsert({ platform: "telegram", platformUserId: OWNER_ID, displayName: "Владелец", username: null, photoUrl: null }, Date.now());
    const strangerAccount = await accounts.upsert({ platform: "telegram", platformUserId: "5", displayName: "Гость", username: null, photoUrl: null }, Date.now());
    const ref = (account: typeof ownerAccount) => ({ accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId });
    return { admin, settings, rolesRepository, owner: ref(ownerAccount), stranger: ref(strangerAccount) };
  }

  it("запись — с правом и в аудит: было из окружения, стало из панели", async () => {
    const { admin, rolesRepository, owner } = await panel({ ADMIN_CHAT_ID: "-100" });
    const saved = await admin.save(owner, "notify.chat.general", "-200:4");
    expect(saved).toMatchObject({ value: "-200:4", source: "base", envValue: "-100", kind: "chat" });
    const [entry] = await rolesRepository.recentAudit(10);
    expect(entry).toMatchObject({ action: "settings.save", target: "notify.chat.general", before: { value: "-100", source: "env" }, after: { value: "-200:4", source: "base" } });
  });

  it("сброс без записи в базе — не событие для журнала", async () => {
    const { admin, rolesRepository, owner } = await panel();
    await admin.reset(owner, "notify.reports");
    expect(await rolesRepository.recentAudit(10)).toEqual([]);
    await admin.save(owner, "notify.reports", false);
    const view = await admin.reset(owner, "notify.reports");
    expect(view).toMatchObject({ value: true, source: "default" });
    expect((await rolesRepository.recentAudit(10)).map((entry) => entry.action).sort()).toEqual(["settings.reset", "settings.save"]);
  });

  it("чужой ключ — 404, значение не по схеме — 400 с названием настройки", async () => {
    const { admin, owner } = await panel();
    await expect(admin.save(owner, "notify.unknown", "x")).rejects.toMatchObject({ code: "setting_not_found", status: 404 });
    await expect(admin.save(owner, "notify.chat.general", "@team")).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("Общий чат") });
    await expect(admin.save(owner, "notify.reports", "yes")).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("без права settings.edit — отказ во всём", async () => {
    const { admin, stranger } = await panel();
    await expect(admin.list(stranger)).rejects.toMatchObject({ code: "forbidden" });
    await expect(admin.save(stranger, "notify.reports", false)).rejects.toMatchObject({ code: "forbidden" });
    await expect(admin.reset(stranger, "notify.reports")).rejects.toMatchObject({ code: "forbidden" });
  });
});
