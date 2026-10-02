import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { DomainError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { SECRET_LIST, fingerprintOf, type SecretDefinition } from "./secret-catalog.js";
import { SecretCipher, SecretUnreadableError } from "./secret-cipher.js";
import { SECRETS_REPOSITORY, type SecretsRepository, type StoredSecret } from "./secrets.repository.js";

/**
 * Ключи интеграций (docs/35-stage4-plan.md Р84, WP46): панель → окружение.
 *
 * Читаются синхронно из памяти, как настройки: ключ спрашивают в момент
 * вызова сервиса, и ходить за ним в базу незачем. Расшифровка — при
 * загрузке; запись из панели доходит до соседних реплик сообщением в Redis,
 * страховка — перечитывание раз в минуту. В сообщении — только имя ключа.
 *
 * Значение не уходит из процесса никуда, кроме вызова своего сервиса: в
 * логах, ответах панели и аудите — только последние знаки.
 */

export const SECRETS_CHANNEL = "secrets:changed";
const REFRESH_MS = 60_000;
const DB_TIMEOUT_MS = 3_000;
const REDIS_TIMEOUT_MS = 2_000;

export type SecretSource = "base" | "env" | "none";

/** Как ключи видит тот, кто их только читает, — и его заглушка в тестах. */
export interface SecretsReader {
  /** действующее значение: панель → окружение; `null` — не задан нигде */
  get(secret: SecretDefinition): string | null;
}

export const SECRETS_READER = Symbol("SECRETS_READER");

/** Только окружение — там, где хранилища нет: тесты, процесс без базы или без ключа шифрования. */
export function environmentSecrets(config: AppConfig): SecretsReader {
  return { get: (secret) => secret.fromEnv(config) };
}

export interface SecretState {
  secret: SecretDefinition;
  source: SecretSource;
  /** последние знаки действующего значения; `null` — ключа нет */
  fingerprint: string | null;
  /** в окружении что-то задано — после сброса заработает оно */
  envSet: boolean;
  /** в базе есть строка, но её не прочитать: работает окружение */
  unreadable: boolean;
  updatedBy: string | null;
  updatedAt: Date | null;
}

/** Хранилище выключено: нет ключа шифрования или базы. */
export class SecretsDisabledError extends DomainError {
  constructor() {
    super("secrets_disabled", "Хранилище ключей выключено: задайте SECRETS_ENCRYPTION_KEY в окружении сервера (openssl rand -base64 32)", 409);
  }
}

type Loaded = { readable: true; value: string; row: StoredSecret } | { readable: false; row: StoredSecret };

@Injectable()
export class SecretsService implements SecretsReader, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("secrets");
  private readonly cipher: SecretCipher | null;
  private loaded = new Map<string, Loaded>();
  /** нечитаемая строка называется в логе один раз, а не на каждом перечитывании */
  private readonly warned = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private subscriber: Redis | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRETS_REPOSITORY) private readonly repository: SecretsRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.cipher = config.secrets.encryptionKeys.length === 0 || config.databaseUrl === "" ? null : new SecretCipher(config.secrets.encryptionKeys);
  }

  /** Можно ли задавать ключи из панели. */
  get enabled(): boolean {
    return this.cipher !== null;
  }

  async onModuleInit(): Promise<void> {
    if (this.cipher === null) return;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
    await this.subscribe();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.subscriber?.disconnect();
  }

  get(secret: SecretDefinition): string | null {
    return this.resolve(secret).value;
  }

  describe(): SecretState[] {
    return SECRET_LIST.map((secret) => {
      const { value, source } = this.resolve(secret);
      const row = this.loaded.get(secret.key)?.row;
      return {
        secret,
        source,
        fingerprint: value === null ? null : fingerprintOf(value),
        envSet: secret.fromEnv(this.config) !== null,
        unreadable: this.loaded.get(secret.key)?.readable === false,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /** Запись из панели. Права, проверка вида и аудит — на вызывающем. */
  async write(secret: SecretDefinition, value: string, actorAccountId: string): Promise<void> {
    if (this.cipher === null) throw new SecretsDisabledError();
    const sealed = this.cipher.seal(secret.key, value);
    const row = await withTimeout(this.repository.save(secret.key, sealed, actorAccountId), DB_TIMEOUT_MS, "запись ключа");
    this.loaded = new Map(this.loaded).set(secret.key, { readable: true, value, row });
    await this.publish(secret.key);
  }

  /** Сброс к окружению. `false` — ключ и так не был задан в панели. */
  async clear(secret: SecretDefinition): Promise<boolean> {
    if (this.cipher === null) throw new SecretsDisabledError();
    const removed = await withTimeout(this.repository.remove(secret.key), DB_TIMEOUT_MS, "сброс ключа");
    const next = new Map(this.loaded);
    next.delete(secret.key);
    this.loaded = next;
    await this.publish(secret.key);
    return removed !== null;
  }

  async refresh(): Promise<void> {
    const cipher = this.cipher;
    if (cipher === null) return;
    let rows: StoredSecret[];
    try {
      rows = await withTimeout(this.repository.all(), DB_TIMEOUT_MS, "чтение ключей");
    } catch (error: unknown) {
      // База недоступна — остаются последние прочитанные ключи.
      this.log("warn", "secrets_not_loaded", { reason: reasonOf(error) });
      return;
    }
    const next = new Map<string, Loaded>();
    for (const row of rows) next.set(row.key, this.open(cipher, row));
    this.loaded = next;
  }

  private open(cipher: SecretCipher, row: StoredSecret): Loaded {
    try {
      const loaded: Loaded = { readable: true, value: cipher.open(row.key, row), row };
      this.warned.delete(row.key);
      return loaded;
    } catch (error: unknown) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      if (!this.warned.has(row.key)) this.log("warn", "secret_unreadable", { key: row.key, keyId: row.keyId, reason: error.message });
      this.warned.add(row.key);
      return { readable: false, row };
    }
  }

  private resolve(secret: SecretDefinition): { value: string | null; source: SecretSource } {
    const loaded = this.loaded.get(secret.key);
    if (loaded?.readable === true) return { value: loaded.value, source: "base" };
    const env = secret.fromEnv(this.config);
    return env === null ? { value: null, source: "none" } : { value: env, source: "env" };
  }

  /**
   * Подписка — отдельным соединением: подписанное соединение Redis другие
   * команды не принимает. Не вышло — остаётся перечитывание раз в минуту.
   */
  private async subscribe(): Promise<void> {
    const subscriber = this.redis.duplicate();
    subscriber.on("message", () => void this.refresh());
    let down = false;
    subscriber.on("error", (error: Error) => {
      if (!down) this.log("warn", "secrets_subscriber_down", { reason: error.message });
      down = true;
    });
    subscriber.on("ready", () => {
      if (!down) return;
      down = false;
      void this.refresh();
    });
    try {
      await withTimeout(subscriber.subscribe(SECRETS_CHANNEL), REDIS_TIMEOUT_MS, "подписка на ключи");
      this.subscriber = subscriber;
    } catch (error: unknown) {
      subscriber.disconnect();
      this.log("warn", "secrets_not_subscribed", { reason: reasonOf(error) });
    }
  }

  /** Сообщение соседним репликам — имя ключа, не значение. Не ушло — увидят при перечитывании. */
  private async publish(key: string): Promise<void> {
    try {
      await withTimeout(this.redis.publish(SECRETS_CHANNEL, key), REDIS_TIMEOUT_MS, "сообщение о ключе");
    } catch (error: unknown) {
      this.log("warn", "secrets_not_published", { key, reason: reasonOf(error) });
    }
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "secrets", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
