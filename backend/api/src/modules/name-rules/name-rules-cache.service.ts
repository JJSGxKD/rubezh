import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { compileNameRules, EMPTY_NAME_RULES, nameRulesSignature, type NameRuleSet } from "./name-rules-engine.js";
import type { NameRulesSource } from "./name-rules-source.js";
import { NAME_RULES_REPOSITORY, type NameRulesRepository } from "./name-rules.repository.js";

/**
 * Правила фильтра имён в памяти процесса (docs/35-stage4-plan.md, Р168).
 *
 * Чистка ника зовёт `current()` на каждом входе игрока, поэтому читается
 * синхронно из памяти, а база опрашивается раз в минуту и по сообщению в
 * Redis сразу после правки из панели (устройство то же, что у настроек —
 * `settings.service.ts`). Недоступная база не роняет вход: остаётся последний
 * набор. Если набор не поменялся, регулярки не пересобираются.
 */

export const NAME_RULES_CHANNEL = "name-rules:changed";
const REFRESH_MS = 60_000;
const DB_TIMEOUT_MS = 3_000;
const REDIS_TIMEOUT_MS = 2_000;
/** о сбое чтения сообщаем не чаще раза в минуту: иначе лог заливает каждый опрос */
const FAILURE_LOG_MS = 60_000;

export { NAME_RULES, type NameRulesSource } from "./name-rules-source.js";

@Injectable()
export class NameRulesCache implements NameRulesSource, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("name-rules");
  private set: NameRuleSet = EMPTY_NAME_RULES;
  /** битое правило называется в логе один раз, а не на каждой пересборке */
  private readonly warned = new Set<string>();
  /** о медленном правиле пишем один раз за жизнь процесса: ник у него каждый раз новый */
  private readonly slowWarned = new Set<string>();
  private lastFailureLogAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private subscriber: Redis | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NAME_RULES_REPOSITORY) private readonly repository: NameRulesRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    // Без базы правил нет — ники чистит один встроенный словарь.
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

  current(): NameRuleSet {
    return this.set;
  }

  async refresh(): Promise<void> {
    try {
      const rows = await withTimeout(this.repository.listActive(), DB_TIMEOUT_MS, "правила имён");
      if (nameRulesSignature(rows) === this.set.signature) return;
      this.set = compileNameRules(rows, (def) => {
        if (this.warned.has(def.ruleId)) return;
        this.warned.add(def.ruleId);
        // Шаблон в лог не идёт: он может быть чужим брендом или матом.
        this.log("name_rule_invalid", { ruleId: def.ruleId });
      }, {
        onSlow: (ruleId, ms) => {
          if (this.slowWarned.has(ruleId)) return;
          this.slowWarned.add(ruleId);
          // Шаблон и ник в лог не идут; правило работает дальше.
          this.log("name_rule_slow", { ruleId, ms: Math.round(ms * 10) / 10 });
        },
      });
    } catch (error: unknown) {
      const now = Date.now();
      if (now - this.lastFailureLogAt < FAILURE_LOG_MS) return;
      this.lastFailureLogAt = now;
      this.log("name_rules_refresh_failed", { reason: reasonOf(error) });
    }
  }

  /** Сообщение соседним репликам. Не ушло — они увидят правку при опросе раз в минуту. */
  async publishChanged(ruleId: string): Promise<void> {
    try {
      await withTimeout(this.redis.publish(NAME_RULES_CHANNEL, ruleId), REDIS_TIMEOUT_MS, "сообщение о правиле имён");
    } catch (error: unknown) {
      this.log("name_rules_not_published", { ruleId, reason: reasonOf(error) });
    }
  }

  /**
   * Подписка — отдельным соединением: подписанное соединение Redis другие
   * команды не принимает. Не вышло — остаётся опрос раз в минуту.
   */
  private async subscribe(): Promise<void> {
    let subscriber: Redis;
    try {
      subscriber = this.redis.duplicate();
    } catch (error: unknown) {
      // Redis без второго соединения не должен останавливать запуск: вход работает по опросу.
      this.log("name_rules_not_subscribed", { reason: reasonOf(error) });
      return;
    }
    subscriber.on("message", () => void this.refresh());
    // Сообщения, пропущенные за обрыв, не придут: после переподключения правила перечитываются.
    let down = false;
    subscriber.on("error", (error: Error) => {
      if (!down) this.log("name_rules_subscriber_down", { reason: error.message });
      down = true;
    });
    subscriber.on("ready", () => {
      if (!down) return;
      down = false;
      void this.refresh();
    });
    try {
      await withTimeout(subscriber.subscribe(NAME_RULES_CHANNEL), REDIS_TIMEOUT_MS, "подписка на правила имён");
      this.subscriber = subscriber;
    } catch (error: unknown) {
      subscriber.disconnect();
      this.log("name_rules_not_subscribed", { reason: reasonOf(error) });
    }
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.warn(JSON.stringify({ module: "name-rules", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
