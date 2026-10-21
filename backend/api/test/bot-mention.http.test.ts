import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { BotMentionBackoff } from "../src/modules/bot-mention/bot-mention-backoff.js";
import type { BotMentionResult, BotMentionRow } from "../src/modules/bot-mention/bot-mention-rules.js";
import { BotMentionController } from "../src/modules/bot-mention/bot-mention.controller.js";
import type { BotMentionRepository } from "../src/modules/bot-mention/bot-mention.repository.js";
import { BotMentionService } from "../src/modules/bot-mention/bot-mention.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { SETTINGS, type SettingValue } from "../src/modules/settings/setting-catalog.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { BotMentions, type BotMention, type MentionFinding, type MentionKind, type MentionOutcome } from "../src/platforms/ports/bot-mention.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Маршруты заданий «юзернейм бота» по HTTP (tasks/T-0162): вход по токену,
 * проверка вида в адресе, лимит ручных проверок и форма ответа. Исходы,
 * награды и серию проверяет `bot-mention.test.ts`.
 */

const NOW = Date.UTC(2026, 9, 21, 9);
const REWARD = { coins: z.number().int(), gems: z.number().int(), shards: z.number().int() };
const RESULT = z.enum(["present", "absent", "hidden", "unavailable"]);

/** Форма ответа из спецификации (tasks/T-0162, шаг 4): клиент строит экран по ней. */
const taskSchema = z
  .object({
    kind: z.enum(["name", "bio"]),
    reward: z.object(REWARD).strict(),
    started: z.boolean(),
    streak: z.number().int().min(0),
    bestStreak: z.number().int().min(0),
    rewardedToday: z.boolean(),
    lastResult: RESULT.nullable(),
    checkedAt: z.string().nullable(),
  })
  .strict();
const viewSchema = z.object({ botUsername: z.string().nullable(), tasks: z.array(taskSchema) }).strict();
const checkSchema = z
  .object({
    outcome: z.enum(["present", "absent", "hidden", "unavailable", "retry", "done_today"]),
    credited: z.object(REWARD).strict(),
    view: viewSchema,
  })
  .strict();

class StubRepository implements BotMentionRepository {
  private readonly state = new Map<string, BotMentionRow>();

  async ensure(accountId: string, kind: MentionKind, at: Date): Promise<void> {
    const key = `${accountId}|${kind}`;
    if (!this.state.has(key)) this.state.set(key, { accountId, kind, startedAt: at, streak: 0, bestStreak: 0, rewardedDays: 0, lastDay: null, checkedDay: null, checkedAt: null, lastResult: null });
  }

  async rows(accountId: string): Promise<BotMentionRow[]> {
    return [...this.state.values()].filter((row) => row.accountId === accountId);
  }

  async markChecked(accountId: string, kind: MentionKind, day: string, result: Exclude<BotMentionResult, "present">, at: Date): Promise<void> {
    Object.assign(this.state.get(`${accountId}|${kind}`) ?? {}, { checkedDay: day, checkedAt: at, lastResult: result });
  }

  async rewardDay(accountId: string, kind: MentionKind, day: string, at: Date): Promise<BotMentionRow | null> {
    const row = this.state.get(`${accountId}|${kind}`);
    if (row === undefined || row.lastDay === day) return null;
    Object.assign(row, { streak: 1, bestStreak: 1, rewardedDays: 1, lastDay: day, checkedDay: day, checkedAt: at, lastResult: "present" });
    return { ...row };
  }

  async due(): Promise<never[]> {
    return [];
  }
}

class FakePort implements BotMention {
  readonly platform = "telegram" as const;
  readonly configured = true;
  readonly ratePerSec = 25;
  calls = 0;
  finding: MentionFinding = "absent";

  botUsername(): string {
    return "game_bot";
  }

  async check(_platformUserId: string, kinds: readonly MentionKind[]): Promise<MentionOutcome> {
    this.calls++;
    const findings: Partial<Record<MentionKind, MentionFinding>> = {};
    for (const kind of kinds) findings[kind] = this.finding;
    return { status: "checked", findings };
  }
}

describe("задания «юзернейм бота» по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  // Redis недоступен лимитеру: он считает в памяти процесса. Пауза площадки — отдельно, не держится.
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;
  const noPause = { set: async () => "OK", pttl: async () => -2 } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(settings: Record<string, SettingValue> = { [SETTINGS.botMentionEnabled.key]: true, [SETTINGS.botMentionNameCoins.key]: 100, [SETTINGS.botMentionBioGems.key]: 3 }) {
    const port = new FakePort();
    const wallet = { grant: async (input: GrantInput): Promise<GrantResult> => ({ credited: input.amount, balance: 0, duplicate: false }) } as unknown as WalletService;
    const service = new BotMentionService(new StubRepository(), new BotMentions([port]), wallet, panelSettings(settings), new BotMentionBackoff(noPause));

    @Module({
      controllers: [BotMentionController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: BotMentionService, useValue: service },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: randomUUID(), platform: "telegram", platformUserId: "555000444" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, NOW + 1e12);
    return { app, port, headers: { authorization: `Bearer ${token}` } };
  }

  it("без токена — 401 и у вида, и у проверки", async () => {
    const { app: server, port } = await start();
    expect((await server.inject({ method: "GET", url: "/api/v1/bot-mention" })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/api/v1/bot-mention/name/check" })).statusCode).toBe(401);
    expect(port.calls).toBe(0);
  });

  it("неверный вид в адресе — 400 validation_failed, площадка не спрошена", async () => {
    const { app: server, port, headers } = await start();
    for (const kind of ["avatar", "NAME", "names", "1", "%20"]) {
      const response = await server.inject({ method: "POST", url: `/api/v1/bot-mention/${kind}/check`, headers });
      expect(response.statusCode, kind).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("validation_failed");
    }
    expect(port.calls).toBe(0);
  });

  it("вид — 200 по форме спецификации: юзернейм без «@», показываемые виды с наградой", async () => {
    const { app: server, headers } = await start();
    const response = await server.inject({ method: "GET", url: "/api/v1/bot-mention", headers });

    expect(response.statusCode).toBe(200);
    const view = viewSchema.parse(response.json<{ data: unknown }>().data);
    expect(view.botUsername).toBe("game_bot");
    expect(view.tasks.map((task) => [task.kind, task.reward, task.started])).toEqual([
      ["name", { coins: 100, gems: 0, shards: 0 }, false],
      ["bio", { coins: 0, gems: 3, shards: 0 }, false],
    ]);
  });

  it("функция выключена: вид пуст, проверка — 404", async () => {
    const { app: server, port, headers } = await start({});
    const view = await server.inject({ method: "GET", url: "/api/v1/bot-mention", headers });
    expect(view.statusCode).toBe(200);
    expect(viewSchema.parse(view.json<{ data: unknown }>().data).tasks).toEqual([]);

    const check = await server.inject({ method: "POST", url: "/api/v1/bot-mention/name/check", headers });
    expect(check.statusCode).toBe(404);
    expect(port.calls).toBe(0);
  });

  it("проверка — 200 без тела запроса: исход решает сервер, клиент ничего не присылает", async () => {
    const { app: server, port, headers } = await start();
    port.finding = "present";
    const response = await server.inject({ method: "POST", url: "/api/v1/bot-mention/name/check", headers });

    expect(response.statusCode).toBe(200);
    const result = checkSchema.parse(response.json<{ data: unknown }>().data);
    expect(result.outcome).toBe("present");
    expect(result.credited).toEqual({ coins: 100, gems: 0, shards: 0 });
    expect(result.view.tasks.find((task) => task.kind === "name")).toMatchObject({ started: true, rewardedToday: true, streak: 1 });
    // присланное в теле ни на что не влияет: исход — от площадки, награда — из настроек
    const repeat = await server.inject({ method: "POST", url: "/api/v1/bot-mention/name/check", headers, payload: { outcome: "present", credited: { coins: 1_000_000 } } });
    expect(repeat.statusCode).toBe(200);
    expect(checkSchema.parse(repeat.json<{ data: unknown }>().data)).toMatchObject({ outcome: "done_today", credited: { coins: 0, gems: 0, shards: 0 } });
  });

  it("лимит ручных проверок: после двадцати в час — 429, площадка при этом не спрашивается", async () => {
    const { app: server, port, headers } = await start();
    for (let index = 0; index < 20; index++) {
      const response = await server.inject({ method: "POST", url: "/api/v1/bot-mention/bio/check", headers });
      expect(response.statusCode, `проверка ${String(index + 1)}`).toBe(200);
    }
    const limited = await server.inject({ method: "POST", url: "/api/v1/bot-mention/bio/check", headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string } }>().error.code).toBe("rate_limited");
    expect(port.calls).toBe(20);
    // чтение вида — со своим лимитом: двадцатью проверками не расходуется
    expect((await server.inject({ method: "GET", url: "/api/v1/bot-mention", headers })).statusCode).toBe(200);
  });
});
