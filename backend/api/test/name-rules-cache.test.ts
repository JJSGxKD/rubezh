import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { cleanName } from "../src/modules/auth/display-name.js";
import { NAME_RULES_CHANNEL, NameRulesCache } from "../src/modules/name-rules/name-rules-cache.service.js";
import type { NameRulesRepository, StoredNameRule } from "../src/modules/name-rules/name-rules.repository.js";

/**
 * Кэш правил фильтра имён (tasks/T-0338): читается из памяти синхронно,
 * обновляется сообщением в Redis и раз в минуту; сбой базы и битое правило
 * вход не роняют.
 */

const DB_CONFIG = loadAppConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://user:secret@localhost:5432/db" } as NodeJS.ProcessEnv);
const NO_DB_CONFIG = loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function stored(n: number, patch: Partial<StoredNameRule> = {}): StoredNameRule {
  return { ruleId: id(n), category: "brand", kind: "exact", pattern: `пример-бренд-${String(n)}`, active: true, note: null, createdAt: new Date(0), updatedAt: new Date(0), updatedBy: null, ...patch };
}

/** Только то, что читает кэш; остальное хранилище кэшу не нужно. */
class MemoryRules {
  rows: StoredNameRule[] = [];
  fail = false;
  reads = 0;

  async listActive(): Promise<StoredNameRule[]> {
    this.reads += 1;
    if (this.fail) throw new Error("connection refused");
    return this.rows.filter((row) => row.active).map((row) => ({ ...row }));
  }
}

class FakeRedis {
  readonly published: string[] = [];
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  subscribed: string[] = [];
  disconnected = false;
  failPublish = false;

  async publish(channel: string, message: string): Promise<number> {
    if (this.failPublish) throw new Error("redis down");
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

function setup(config = DB_CONFIG) {
  const repository = new MemoryRules();
  const redis = new FakeRedis();
  const cache = new NameRulesCache(config, repository as unknown as NameRulesRepository, redis as unknown as Redis);
  return { repository, redis, cache };
}

let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("кэш правил: чтение", () => {
  it("до первого чтения набор пуст, после — с нужным числом правил, и ник чистится по нему", async () => {
    const { repository, cache } = setup();
    repository.rows = [stored(1), stored(2), stored(3, { active: false })];
    expect(cache.current().size).toBe(0);

    await cache.refresh();

    expect(cache.current().size).toBe(2);
    expect(cleanName("Вася пример-бренд-1", cache.current()).name).toBe("Вася");
    expect(cleanName("Вася пример-бренд-3", cache.current()).name).toBe("Вася пример-бренд-3");
  });

  it("подпись не изменилась — набор остаётся тем же объектом, а не пересобирается", async () => {
    const { repository, cache } = setup();
    repository.rows = [stored(1), stored(2)];
    await cache.refresh();
    const first = cache.current();

    await cache.refresh();
    expect(cache.current()).toBe(first);

    repository.rows = [stored(1), stored(2, { pattern: "пример-бренд-два" })];
    await cache.refresh();
    expect(cache.current()).not.toBe(first);
    expect(cleanName("Вася пример-бренд-два", cache.current()).name).toBe("Вася");
  });

  it("правило выключили — оно пропадает из набора", async () => {
    const { repository, cache } = setup();
    repository.rows = [stored(1)];
    await cache.refresh();
    repository.rows = [stored(1, { active: false })];
    await cache.refresh();
    expect(cache.current().size).toBe(0);
  });

  it("битое правило пропущено, остальные работают; в лог оно идёт один раз на ruleId и без шаблона", async () => {
    const { repository, cache } = setup();
    repository.rows = [stored(1), stored(2, { category: "ads", kind: "regex", pattern: "(секретный-шаблон" })];
    await cache.refresh();
    expect(cache.current().size).toBe(1);

    repository.rows = [...repository.rows, stored(3)];
    await cache.refresh();
    expect(cache.current().size).toBe(2);

    const invalid = warnings.filter((line) => line.includes("name_rule_invalid"));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain(id(2));
    expect(warnings.join("\n")).not.toContain("секретный-шаблон");
  });

  it("ошибка базы — остаётся прежний набор, в лог name_rules_refresh_failed не чаще раза в минуту", async () => {
    const { repository, cache } = setup();
    repository.rows = [stored(1)];
    await cache.refresh();
    const before = cache.current();

    repository.fail = true;
    await cache.refresh();
    await cache.refresh();

    expect(cache.current()).toBe(before);
    expect(warnings.filter((line) => line.includes("name_rules_refresh_failed"))).toHaveLength(1);
    expect(warnings.join("\n")).not.toContain("secret");
  });
});

describe("кэш правил: реплики", () => {
  it("onModuleInit читает правила, подписывается на канал; сообщение вызывает перечитывание", async () => {
    const { repository, redis, cache } = setup();
    repository.rows = [stored(1)];
    await cache.onModuleInit();
    expect(cache.current().size).toBe(1);
    expect(redis.subscribed).toEqual([NAME_RULES_CHANNEL]);
    expect(NAME_RULES_CHANNEL).toBe("name-rules:changed");

    repository.rows = [stored(1), stored(2)];
    redis.emit("message", NAME_RULES_CHANNEL, id(2));
    await expect.poll(() => cache.current().size).toBe(2);

    cache.onModuleDestroy();
    expect(redis.disconnected).toBe(true);
  });

  it("после обрыва подписки правила перечитываются: сообщения за обрыв не придут", async () => {
    const { repository, redis, cache } = setup();
    await cache.onModuleInit();
    redis.emit("error", new Error("ECONNRESET"));
    repository.rows = [stored(1)];
    redis.emit("ready");
    await expect.poll(() => cache.current().size).toBe(1);
    cache.onModuleDestroy();
  });

  it("без databaseUrl ничего не читает и не подписывается", async () => {
    const { repository, redis, cache } = setup(NO_DB_CONFIG);
    await cache.onModuleInit();
    expect(repository.reads).toBe(0);
    expect(redis.subscribed).toEqual([]);
    expect(cache.current().size).toBe(0);
  });

  it("publishChanged шлёт id правила в канал; сбой публикации не бросает, а пишет предупреждение", async () => {
    const { redis, cache } = setup();
    await cache.publishChanged(id(1));
    expect(redis.published).toEqual([`${NAME_RULES_CHANNEL}:${id(1)}`]);

    redis.failPublish = true;
    await expect(cache.publishChanged(id(2))).resolves.toBeUndefined();
    expect(warnings.some((line) => line.includes("name_rules_not_published"))).toBe(true);
  });
});
