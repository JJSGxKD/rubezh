import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { OUTBOUND_MODES, defaultModeOf, type OutboundMode, type OutboundProxy, type OutboundRoutes } from "../../infra/outbound/outbound-route.js";
import type { OutboundService } from "../../infra/outbound/outbound-services.js";
import { REDIS } from "../../infra/redis.js";
import { SecretUnreadableError, type SecretCipher } from "../secrets/secret-cipher.js";
import { PROXY_CIPHER, hasPassword, openPassword } from "./proxy-password.js";
import { PROXIES_REPOSITORY, type ProxiesRepository, type StoredProxy } from "./proxies.repository.js";

/**
 * Прокси и режимы сервисов для клиента исходящих в памяти процесса
 * (docs/35-stage4-plan.md Р91, tasks/T-0065).
 *
 * Клиент спрашивает маршрут на каждом исходящем запросе, поэтому читается
 * синхронно из снимка, а база опрашивается раз в 30 секунд и по сообщению в
 * Redis сразу после правки из панели (устройство то же, что у ключей
 * интеграций — `secrets.service.ts`). Недоступная база не роняет запросы:
 * остаётся последний снимок. В снимке пароль расшифрован — он живёт только в
 * памяти процесса; прокси, чей пароль не прочитать, в маршруты не попадает.
 */

export const PROXIES_CHANNEL = "proxies:changed";
const REFRESH_MS = 30_000;
const DB_TIMEOUT_MS = 3_000;
const REDIS_TIMEOUT_MS = 2_000;
/** о сбое чтения сообщаем не чаще раза в минуту: иначе лог заливает каждый опрос */
const FAILURE_LOG_MS = 60_000;

const isMode = (value: string): value is OutboundMode => (OUTBOUND_MODES as readonly string[]).includes(value);

@Injectable()
export class ProxyRoutes implements OutboundRoutes, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("proxies");
  private proxies: readonly OutboundProxy[] = [];
  private modes: ReadonlyMap<string, OutboundMode> = new Map();
  /** нечитаемый пароль называется в логе один раз, а не на каждом опросе */
  private readonly warned = new Set<string>();
  private lastFailureLogAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private subscriber: Redis | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROXIES_REPOSITORY) private readonly repository: ProxiesRepository,
    @Inject(PROXY_CIPHER) private readonly cipher: SecretCipher | null,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    // Без базы прокси негде хранить — клиент ходит напрямую, как раньше.
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

  list(): readonly OutboundProxy[] {
    return this.proxies;
  }

  modeOf(service: OutboundService): OutboundMode {
    return this.modes.get(service) ?? defaultModeOf(service);
  }

  async refresh(): Promise<void> {
    try {
      const [rows, modeRows] = await withTimeout(Promise.all([this.repository.list(), this.repository.modes()]), DB_TIMEOUT_MS, "прокси и режимы");
      this.proxies = rows.flatMap((row) => this.routeOf(row));
      this.modes = new Map(modeRows.flatMap((row) => (isMode(row.mode) ? [[row.service, row.mode] as const] : [])));
    } catch (error: unknown) {
      const now = Date.now();
      if (now - this.lastFailureLogAt < FAILURE_LOG_MS) return;
      this.lastFailureLogAt = now;
      this.log("proxies_refresh_failed", { reason: reasonOf(error) });
    }
  }

  /**
   * Правка записана: эта реплика перечитывает сразу, остальные — по
   * сообщению. Не ушло сообщение — они увидят правку при опросе раз в 30 секунд.
   */
  async changed(target: string): Promise<void> {
    await this.refresh();
    try {
      await withTimeout(this.redis.publish(PROXIES_CHANNEL, target), REDIS_TIMEOUT_MS, "сообщение о прокси");
    } catch (error: unknown) {
      this.log("proxies_not_published", { target, reason: reasonOf(error) });
    }
  }

  /** Строка снимка; пустой массив — прокси выключен или его пароль не прочитать. */
  private routeOf(row: StoredProxy): OutboundProxy[] {
    if (!row.enabled) return [];
    let password: string | null = null;
    if (hasPassword(row)) {
      try {
        if (this.cipher === null) throw new SecretUnreadableError("нет ключа шифрования");
        password = openPassword(this.cipher, row);
        this.warned.delete(row.proxyId);
      } catch (error: unknown) {
        if (!(error instanceof SecretUnreadableError)) throw error;
        if (!this.warned.has(row.proxyId)) this.log("proxy_password_unreadable", { proxyId: row.proxyId, keyId: row.passwordKeyId, reason: error.message });
        this.warned.add(row.proxyId);
        return [];
      }
    }
    return [{ id: row.proxyId, scheme: row.scheme, host: row.host, port: row.port, username: row.username, password, priority: row.priority, updatedAt: row.updatedAt.getTime() }];
  }

  /**
   * Подписка — отдельным соединением: подписанное соединение Redis другие
   * команды не принимает. Не вышло — остаётся опрос раз в 30 секунд.
   */
  private async subscribe(): Promise<void> {
    let subscriber: Redis;
    try {
      subscriber = this.redis.duplicate();
    } catch (error: unknown) {
      this.log("proxies_not_subscribed", { reason: reasonOf(error) });
      return;
    }
    subscriber.on("message", () => void this.refresh());
    // Сообщения, пропущенные за обрыв, не придут: после переподключения снимок перечитывается.
    let down = false;
    subscriber.on("error", (error: Error) => {
      if (!down) this.log("proxies_subscriber_down", { reason: error.message });
      down = true;
    });
    subscriber.on("ready", () => {
      if (!down) return;
      down = false;
      void this.refresh();
    });
    try {
      await withTimeout(subscriber.subscribe(PROXIES_CHANNEL), REDIS_TIMEOUT_MS, "подписка на прокси");
      this.subscriber = subscriber;
    } catch (error: unknown) {
      subscriber.disconnect();
      this.log("proxies_not_subscribed", { reason: reasonOf(error) });
    }
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.warn(JSON.stringify({ module: "proxies", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
