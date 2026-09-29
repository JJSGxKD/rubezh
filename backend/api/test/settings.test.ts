import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { NotifyTargets } from "../src/modules/settings/notify-targets.js";
import { SETTINGS, SETTING_KEY, SETTING_LIST } from "../src/modules/settings/setting-catalog.js";
import type { SettingValue } from "../src/modules/settings/setting-catalog.js";
import type { SettingsRepository, StoredSetting } from "../src/modules/settings/settings.repository.js";
import { SETTINGS_CHANNEL, SettingsService } from "../src/modules/settings/settings.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Настройки без релиза (docs/35-stage4-plan.md §3.18, Р53): база сильнее
 * окружения, окружение сильнее умолчания; битое значение из базы не ломает
 * чтение; запись оповещает соседние реплики.
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
