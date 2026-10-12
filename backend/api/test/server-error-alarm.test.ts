import "reflect-metadata";
import { Controller, Get, Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { ServerErrorAlarm, type ServerErrorAlarmApi } from "../src/modules/admin-notify/server-error-alarm.js";
import { targetsOf } from "./helpers/notify-targets.js";

/**
 * Тревога о всплеске ошибок 5xx (tasks/T-0035): 20 ответов за календарную
 * минуту — одно сообщение, затем тишина 15 минут. Счётчик — в Redis, а без
 * него — в памяти процесса.
 */

const MINUTE = 60_000;
/** начало календарной минуты: 2026-10-06 09:05:00 UTC */
const T0 = Date.UTC(2026, 9, 6, 9, 5);

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ADMIN_CHAT_ID: "-1001234567890", TELEGRAM_BOT_TOKEN: "123:TEST", ...patch } as NodeJS.ProcessEnv);
}

/** Redis на `multi` с `hincrby` и `expire`, `SET … NX EX` и `HGETALL`; сроки жизни — по часам теста. */
class FakeRedis {
  now = T0;
  broken = false;
  private readonly hashes = new Map<string, Map<string, number>>();
  private readonly keys = new Map<string, { value: string; until: number }>();

  multi() {
    const operations: (() => number)[] = [];
    const chain = {
      hincrby: (key: string, field: string | number, by: number) => {
        operations.push(() => {
          const hash = this.hashes.get(key) ?? new Map<string, number>();
          this.hashes.set(key, hash);
          const next = (hash.get(String(field)) ?? 0) + by;
          hash.set(String(field), next);
          return next;
        });
        return chain;
      },
      expire: () => {
        operations.push(() => 1);
        return chain;
      },
      exec: async (): Promise<[Error | null, number][]> => {
        if (this.broken) throw new Error("connection refused");
        return operations.map((operation) => [null, operation()]);
      },
    };
    return chain;
  }

  async set(key: string, value: string, _ex: "EX", seconds: number, _nx: "NX"): Promise<"OK" | null> {
    if (this.broken) throw new Error("connection refused");
    const existing = this.keys.get(key);
    if (existing !== undefined && existing.until > this.now) return null;
    this.keys.set(key, { value, until: this.now + seconds * 1000 });
    return "OK";
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    if (this.broken) throw new Error("connection refused");
    return Object.fromEntries([...(this.hashes.get(key) ?? [])].map(([field, count]) => [field, String(count)]));
  }
}

function setup(cfg: AppConfig = config()) {
  const sent: { chat: unknown; text: string }[] = [];
  const redis = new FakeRedis();
  const api: ServerErrorAlarmApi = { sendMessage: async (chat, text) => (sent.push({ chat, text }), 1) };
  const alarm = new ServerErrorAlarm(cfg, targetsOf(cfg), redis as never, api);
  const burst = async (count: number, status: number, at: number): Promise<void> => {
    redis.now = at;
    for (let index = 0; index < count; index++) await alarm.record(status, at);
  };
  return { alarm, sent, redis, api, burst };
}

describe("тревога о всплеске 5xx", () => {
  it("19 ответов за минуту — тишина, 20-й — одно сообщение с числом и кодом", async () => {
    const { sent, burst } = setup();

    await burst(19, 500, T0);
    expect(sent).toHaveLength(0);

    await burst(1, 500, T0 + 30_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chat).toEqual({ chatId: "-1001234567890", threadId: null });
    expect(sent[0]?.text).toContain("20 ответов 5xx");
    expect(sent[0]?.text).toContain("500 × 20");
    expect(sent[0]?.text).toContain("09:05 UTC");
  });

  it("25 за ту же минуту — по-прежнему одно сообщение", async () => {
    const { sent, burst } = setup();

    await burst(25, 500, T0);

    expect(sent).toHaveLength(1);
  });

  it("следующая минута, ещё 20 — тишина: 15 минут не прошло", async () => {
    const { sent, burst } = setup();

    await burst(20, 500, T0);
    await burst(20, 500, T0 + MINUTE);

    expect(sent).toHaveLength(1);
  });

  it("через 16 минут и 20 за минуту — второе сообщение", async () => {
    const { sent, burst } = setup();

    await burst(20, 500, T0);
    await burst(20, 500, T0 + 16 * MINUTE);

    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain("09:21 UTC");
  });

  it("коды — по убыванию количества: 12 × 500 и 8 × 503", async () => {
    const { sent, redis, alarm } = setup();
    redis.now = T0;
    for (let index = 0; index < 8; index++) await alarm.record(503, T0);
    for (let index = 0; index < 12; index++) await alarm.record(500, T0);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Коды: 500 × 12, 503 × 8");
  });

  it("в сообщении нет путей, текстов ошибок и данных игроков", async () => {
    const { sent, burst } = setup();

    await burst(20, 500, T0);

    expect(sent[0]?.text).toBe(
      [
        "🔥 Всплеск ошибок API: 20 ответов 5xx за минуту с 09:05 UTC",
        "Коды: 500 × 20",
        "Следующее сообщение — не раньше чем через 15 минут. Логи: docker compose logs --tail 200 api",
      ].join("\n"),
    );
  });

  it("Redis недоступен — счёт в памяти, на 20-м одно сообщение, а затем тишина", async () => {
    const { sent, redis, burst } = setup();
    redis.broken = true;

    await burst(19, 500, T0);
    expect(sent).toHaveLength(0);
    await burst(10, 500, T0);
    expect(sent).toHaveLength(1);

    await burst(20, 500, T0 + MINUTE);
    expect(sent).toHaveLength(1);

    await burst(20, 500, T0 + 16 * MINUTE);
    expect(sent).toHaveLength(2);
  });

  it("отправка бросает — `record` не бросает", async () => {
    const { alarm, api } = setup();
    api.sendMessage = async () => {
      throw new Error("telegram недоступен");
    };

    for (let index = 0; index < 20; index++) await expect(alarm.record(500, T0)).resolves.toBeUndefined();
  });

  it("чата нет — предупреждение в лог и без отправки", async () => {
    const { sent, burst } = setup(config({ ADMIN_CHAT_ID: "" }));

    await burst(20, 500, T0);

    expect(sent).toHaveLength(0);
  });
});

describe("хук ответов", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  @Controller("boom")
  class BoomController {
    @Get()
    boom(): never {
      throw new Error("секретный текст ошибки");
    }
  }

  it("каждый ответ 5xx — в счётчик со своим кодом, ответ игроку не ждёт", async () => {
    const record = vi.fn(async () => undefined);
    @Module({
      controllers: [BoomController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: ServerErrorAlarm, useValue: { record } },
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    for (let index = 0; index < 21; index++) {
      const response = await app.inject({ method: "GET", url: "/api/v1/boom" });
      expect(response.statusCode).toBe(500);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(record).toHaveBeenCalledTimes(21);
    expect(record).toHaveBeenCalledWith(500);
  });

  it("без провайдера тревоги приложение работает: хук не ставится", async () => {
    @Module({ controllers: [BoomController], providers: [{ provide: APP_CONFIG, useValue: config() }] })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    expect((await app.inject({ method: "GET", url: "/api/v1/boom" })).statusCode).toBe(500);
  });
});
