import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { SETTING_LIST, type SettingDefinition, type SettingValue } from "./setting-catalog.js";
import { SETTINGS_REPOSITORY, type SettingsRepository, type StoredSetting } from "./settings.repository.js";

/**
 * Настройки без релиза (docs/35-stage4-plan.md §3.18, Р53): база → окружение
 * → умолчание.
 *
 * Читаются синхронно из памяти процесса: настройку спрашивают на каждой
 * отправке в чат и на каждом запросе, и ходить за ней в базу незачем.
 * Память обновляется сообщением в Redis сразу после записи из панели — на
 * всех репликах — и перечитыванием раз в минуту на случай, если сообщение
 * потерялось. Недоступная база не роняет чтение: остаётся последнее
 * прочитанное, а до первого чтения — окружение.
 */

export const SETTINGS_CHANNEL = "settings:changed";
const REFRESH_MS = 60_000;
const DB_TIMEOUT_MS = 3_000;
const REDIS_TIMEOUT_MS = 2_000;

export type SettingSource = "base" | "env" | "default";

/** Как настройки видит тот, кто их только читает, — и его заглушка в тестах. */
export interface SettingsReader {
  get<T extends SettingValue>(setting: SettingDefinition<T>): T;
  /** `changed` — ключи, у которых поменялось действующее значение */
  onChange(listener: (changed: readonly string[]) => void): void;
}

export const SETTINGS_READER = Symbol("SETTINGS_READER");

export interface SettingState {
  setting: SettingDefinition;
  value: SettingValue;
  source: SettingSource;
  /** что лежит в окружении; `null` — там не задано */
  envValue: SettingValue | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

/** Только окружение и умолчания — там, где базы нет: тесты, процесс без `DATABASE_URL`. */
export function environmentSettings(config: AppConfig): SettingsReader {
  return {
    get: (setting) => setting.fromEnv(config) ?? setting.fallback,
    onChange: () => undefined,
  };
}

@Injectable()
export class SettingsService implements SettingsReader, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("settings");
  private stored = new Map<string, StoredSetting>();
  private readonly listeners: ((changed: readonly string[]) => void)[] = [];
  /** битое значение называется в логе один раз, а не на каждом перечитывании */
  private readonly warned = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private subscriber: Redis | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SETTINGS_REPOSITORY) private readonly repository: SettingsRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    // Без базы настроек из панели нет — работают окружение и умолчания.
    if (this.config.databaseUrl === "") return;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
    await this.subscribe();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.subscriber?.disconnect();
  }

  get<T extends SettingValue>(setting: SettingDefinition<T>): T {
    return this.resolve(setting).value;
  }

  onChange(listener: (changed: readonly string[]) => void): void {
    this.listeners.push(listener);
  }

  describe(): SettingState[] {
    return SETTING_LIST.map((setting) => {
      const { value, source } = this.resolve(setting);
      const stored = source === "base" ? this.stored.get(setting.key) : undefined;
      return { setting, value, source, envValue: setting.fromEnv(this.config), updatedBy: stored?.updatedBy ?? null, updatedAt: stored?.updatedAt ?? null };
    });
  }

  /** Запись из панели. Права, разбор значения и аудит — на вызывающем. */
  async write(setting: SettingDefinition, value: SettingValue, actorAccountId: string): Promise<void> {
    const saved = await withTimeout(this.repository.save(setting.key, value, actorAccountId), DB_TIMEOUT_MS, "запись настройки");
    this.replace(new Map(this.stored).set(saved.key, saved));
    await this.publish(setting.key);
  }

  /** Сброс к окружению. `false` — настройка и так не была задана в базе. */
  async clear(setting: SettingDefinition): Promise<boolean> {
    const removed = await withTimeout(this.repository.remove(setting.key), DB_TIMEOUT_MS, "сброс настройки");
    const next = new Map(this.stored);
    next.delete(setting.key);
    this.replace(next);
    await this.publish(setting.key);
    return removed !== null;
  }

  async refresh(): Promise<void> {
    let rows: StoredSetting[];
    try {
      rows = await withTimeout(this.repository.all(), DB_TIMEOUT_MS, "чтение настроек");
    } catch (error: unknown) {
      this.log("warn", "settings_not_loaded", { reason: reasonOf(error) });
      return;
    }
    this.replace(new Map(rows.map((row) => [row.key, row])));
  }

  private resolve<T extends SettingValue>(setting: SettingDefinition<T>): { value: T; source: SettingSource } {
    const stored = this.stored.get(setting.key);
    if (stored !== undefined) {
      const parsed = setting.schema.safeParse(stored.value);
      if (parsed.success) return { value: parsed.data, source: "base" };
    }
    const env = setting.fromEnv(this.config);
    return env === null ? { value: setting.fallback, source: "default" } : { value: env, source: "env" };
  }

  /** Новое содержимое базы — и оповещение тех, у кого поменялось действующее значение. */
  private replace(next: Map<string, StoredSetting>): void {
    const before = this.effective();
    this.stored = next;
    this.warnInvalid();
    const after = this.effective();
    const changed = SETTING_LIST.map((setting) => setting.key).filter((key) => before.get(key) !== after.get(key));
    if (changed.length === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(changed);
      } catch (error: unknown) {
        this.log("warn", "settings_listener_failed", { changed, reason: reasonOf(error) });
      }
    }
  }

  private effective(): Map<string, string> {
    return new Map(SETTING_LIST.map((setting) => [setting.key, JSON.stringify(this.resolve(setting).value)]));
  }

  private warnInvalid(): void {
    for (const setting of SETTING_LIST) {
      const stored = this.stored.get(setting.key);
      const invalid = stored !== undefined && !setting.schema.safeParse(stored.value).success;
      if (invalid && !this.warned.has(setting.key)) this.log("warn", "setting_invalid", { key: setting.key });
      if (invalid) this.warned.add(setting.key);
      else this.warned.delete(setting.key);
    }
  }

  /**
   * Подписка — отдельным соединением: подписанное соединение Redis другие
   * команды не принимает. Не вышло — остаётся перечитывание раз в минуту.
   */
  private async subscribe(): Promise<void> {
    const subscriber = this.redis.duplicate();
    subscriber.on("message", () => void this.refresh());
    // ioredis шлёт ошибку на каждую попытку переподключения — в лог идёт
    // первая. Сообщения, пропущенные за обрыв, не придут: после
    // переподключения настройки перечитываются.
    let down = false;
    subscriber.on("error", (error: Error) => {
      if (!down) this.log("warn", "settings_subscriber_down", { reason: error.message });
      down = true;
    });
    subscriber.on("ready", () => {
      if (!down) return;
      down = false;
      void this.refresh();
    });
    try {
      await withTimeout(subscriber.subscribe(SETTINGS_CHANNEL), REDIS_TIMEOUT_MS, "подписка на настройки");
      this.subscriber = subscriber;
    } catch (error: unknown) {
      subscriber.disconnect();
      this.log("warn", "settings_not_subscribed", { reason: reasonOf(error) });
    }
  }

  /** Сообщение соседним репликам. Не ушло — они увидят запись при перечитывании. */
  private async publish(key: string): Promise<void> {
    try {
      await withTimeout(this.redis.publish(SETTINGS_CHANNEL, key), REDIS_TIMEOUT_MS, "сообщение о настройке");
    } catch (error: unknown) {
      this.log("warn", "settings_not_published", { key, reason: reasonOf(error) });
    }
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "settings", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
