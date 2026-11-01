import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { NAME_RULE_HITS_LIMITS, NameRuleHits, type HitsBatch, type NameRuleHitsTransport } from "../src/modules/name-rules/name-rule-hits.js";
import type { NameRuleHitsRepository } from "../src/modules/name-rules/name-rule-hits.repository.js";

/**
 * Счёт срабатываний правил фильтра имён (Р168, tasks/T-0340): буфер в памяти,
 * пачка раз в 5 секунд в очередь, воркер дописывает суточные счётчики. Вход
 * игрока не ждёт ничего: `record` синхронный и без исключений. Очередь,
 * хранилище и часы — подделки.
 */

const RULE_A = "11111111-1111-4111-8111-111111111111";
const RULE_B = "22222222-2222-4222-8222-222222222222";
const RULE_C = "33333333-3333-4333-8333-333333333333";

class FakeTransport implements NameRuleHitsTransport {
  readonly sent: HitsBatch[] = [];
  started = 0;
  stopped = 0;
  failing = false;
  handler: ((batch: HitsBatch) => Promise<void>) | null = null;

  async send(batch: HitsBatch): Promise<void> {
    if (this.failing) throw new Error("connection refused");
    this.sent.push(batch);
  }

  start(handler: (batch: HitsBatch) => Promise<void>): void {
    this.started++;
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.stopped++;
  }
}

class FakeRepository implements NameRuleHitsRepository {
  readonly added: { day: string; counts: Record<string, number> }[] = [];
  readonly pruned: number[] = [];
  failing = false;

  async addHits(day: string, counts: Readonly<Record<string, number>>): Promise<void> {
    if (this.failing) throw new Error("база недоступна");
    this.added.push({ day, counts: { ...counts } });
  }

  async prune(days: number): Promise<number> {
    this.pruned.push(days);
    return 0;
  }

  async statsFor(): Promise<{ rules: []; trackedSince: null }> {
    return { rules: [], trackedSince: null };
  }
}

function config(env: Record<string, string> = { DATABASE_URL: "postgresql://x" }): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...env } as NodeJS.ProcessEnv);
}

let transport: FakeTransport;
let repository: FakeRepository;
let now: Date;

function build(cfg: AppConfig = config()): NameRuleHits {
  return new NameRuleHits(cfg, transport, repository, () => now);
}

beforeEach(() => {
  vi.useFakeTimers();
  transport = new FakeTransport();
  repository = new FakeRepository();
  now = new Date("2026-10-30T12:00:00Z");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("буфер срабатываний", () => {
  it("record(['a','b'], ['c']) и record(['a'], []) копят a:2, b:1, c:1; пустой вызов ничего не меняет", async () => {
    const hits = build();
    hits.record([RULE_A, RULE_B], [RULE_C]);
    hits.record([RULE_A], []);
    hits.record([], []);

    await hits.flush();

    expect(transport.sent).toEqual([{ day: "2026-10-30", counts: { [RULE_A]: 2, [RULE_B]: 1, [RULE_C]: 1 } }]);
  });

  it("пустой буфер — задания нет", async () => {
    const hits = build();
    hits.record([], []);
    await hits.flush();
    expect(transport.sent).toEqual([]);
  });

  it("после отправки буфер пуст: второй flush ничего не шлёт", async () => {
    const hits = build();
    hits.record([RULE_A], []);
    await hits.flush();
    await hits.flush();
    expect(transport.sent).toHaveLength(1);
  });

  it("запись не ждёт и не бросает, даже если очередь отказывает", async () => {
    transport.failing = true;
    const hits = build();
    expect(() => hits.record([RULE_A], [RULE_B])).not.toThrow();
    // Синхронно: ни одного обращения к очереди на самом входе.
    expect(transport.sent).toEqual([]);
    await expect(hits.flush()).resolves.toBeUndefined();
  });

  it("переполнение буфера: id сверх предела пропускаются, уже учтённые и дальше считаются", async () => {
    const hits = build();
    const max = NAME_RULE_HITS_LIMITS.bufferMax;
    const ids = Array.from({ length: max + 3 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    hits.record(ids, []);
    hits.record([ids[0] ?? ""], []);

    await hits.flush();

    const counts = transport.sent[0]?.counts ?? {};
    expect(Object.keys(counts)).toHaveLength(max);
    expect(counts[ids[0] ?? ""]).toBe(2);
    expect(counts[ids[max + 2] ?? ""]).toBeUndefined();
  });
});

describe("таймер и сутки UTC", () => {
  it("пачка уходит раз в 5 секунд одним заданием с суммами; пустые интервалы заданий не дают", async () => {
    const hits = build();
    hits.onApplicationBootstrap();
    hits.record([RULE_A], []);
    hits.record([RULE_A], [RULE_B]);

    await vi.advanceTimersByTimeAsync(NAME_RULE_HITS_LIMITS.flushMs - 1);
    expect(transport.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.sent).toEqual([{ day: "2026-10-30", counts: { [RULE_A]: 2, [RULE_B]: 1 } }]);

    await vi.advanceTimersByTimeAsync(3 * NAME_RULE_HITS_LIMITS.flushMs);
    expect(transport.sent).toHaveLength(1);
    await hits.onModuleDestroy();
  });

  it("сутки считаются по UTC на момент отправки: 23:59:58Z и 00:00:01Z — разные day", async () => {
    const hits = build();
    now = new Date("2026-10-30T23:59:58Z");
    hits.record([RULE_A], []);
    await hits.flush();
    now = new Date("2026-10-31T00:00:01Z");
    hits.record([RULE_A], []);
    await hits.flush();

    expect(transport.sent.map((batch) => batch.day)).toEqual(["2026-10-30", "2026-10-31"]);
  });

  it("остаток буфера уходит при остановке, очередь закрывается", async () => {
    const hits = build();
    hits.onApplicationBootstrap();
    hits.record([RULE_C], []);

    await hits.onModuleDestroy();

    expect(transport.sent).toEqual([{ day: "2026-10-30", counts: { [RULE_C]: 1 } }]);
    expect(transport.stopped).toBe(1);
  });

  it("databaseUrl пуст: ни очереди, ни таймера; запись — пустая функция", async () => {
    const hits = build(config({ DATABASE_URL: "" }));
    hits.onApplicationBootstrap();
    hits.record([RULE_A], [RULE_B]);
    await vi.advanceTimersByTimeAsync(10 * NAME_RULE_HITS_LIMITS.flushMs);
    await hits.onModuleDestroy();

    expect(transport.started).toBe(0);
    expect(transport.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("сбой постановки в очередь", () => {
  it("пачка потеряна без исключения; лог name_rule_hits_dropped — не чаще раза в минуту", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    transport.failing = true;
    const hits = build();
    hits.record([RULE_A], []);
    await hits.flush();
    hits.record([RULE_A], []);
    await hits.flush();

    const dropped = () => warn.mock.calls.filter(([line]) => String(line).includes("name_rule_hits_dropped"));
    expect(dropped()).toHaveLength(1);

    // Минута прошла — следующая потеря снова пишется.
    now = new Date(now.getTime() + 61_000);
    vi.setSystemTime(now);
    hits.record([RULE_A], []);
    await hits.flush();
    expect(dropped()).toHaveLength(2);
    expect(transport.sent).toEqual([]);
  });

  it("потерянная пачка не возвращается в буфер: повтора нет", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    transport.failing = true;
    const hits = build();
    hits.record([RULE_A], []);
    await hits.flush();
    transport.failing = false;
    await hits.flush();
    expect(transport.sent).toEqual([]);
  });

  it("в логе нет id правил и ников: только причина", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    transport.failing = true;
    const hits = build();
    hits.record([RULE_A], [RULE_B]);
    await hits.flush();
    const line = String(warn.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("name_rule_hits_dropped");
    expect(line).not.toContain(RULE_A);
    expect(line).not.toContain(RULE_B);
  });
});

describe("воркер", () => {
  it("вызывает addHits(day, counts); prune — не чаще раза в сутки", async () => {
    const hits = build();
    hits.onApplicationBootstrap();
    const run = async (day: string) => await transport.handler?.({ day, counts: { [RULE_A]: 3 } });

    await run("2026-10-30");
    expect(repository.added).toEqual([{ day: "2026-10-30", counts: { [RULE_A]: 3 } }]);
    expect(repository.pruned).toEqual([NAME_RULE_HITS_LIMITS.retentionDays]);

    now = new Date(now.getTime() + 60 * 60_000);
    await run("2026-10-30");
    expect(repository.pruned).toHaveLength(1);

    now = new Date(now.getTime() + NAME_RULE_HITS_LIMITS.pruneEveryMs);
    await run("2026-10-31");
    expect(repository.pruned).toHaveLength(2);
    await hits.onModuleDestroy();
  });

  it("сбой записи — предупреждение name_rule_hits_failed с именем ошибки, без повтора и без ников", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    repository.failing = true;
    const hits = build();
    hits.onApplicationBootstrap();

    await transport.handler?.({ day: "2026-10-30", counts: { [RULE_A]: 1 } });

    const line = String(warn.mock.calls.find(([text]) => String(text).includes("name_rule_hits_failed"))?.[0] ?? "");
    expect(line).toContain('"reason":"Error"');
    expect(line).not.toContain(RULE_A);
    expect(repository.added).toEqual([]);
    await hits.onModuleDestroy();
  });

  it("сбой prune записи не ломает: счётчики уже легли", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(repository, "prune").mockRejectedValue(new Error("база недоступна"));
    const hits = build();
    hits.onApplicationBootstrap();

    await expect(transport.handler?.({ day: "2026-10-30", counts: { [RULE_A]: 1 } })).resolves.toBeUndefined();
    expect(repository.added).toHaveLength(1);
    await hits.onModuleDestroy();
  });
});

describe("пределы", () => {
  it("5 секунд, 180 суток, очистка раз в сутки", () => {
    expect(NAME_RULE_HITS_LIMITS).toMatchObject({ flushMs: 5_000, retentionDays: 180, pruneEveryMs: 86_400_000, enqueueTimeoutMs: 2_000 });
  });
});
