import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../src/common/domain-error.js";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { NameRuleConflictError } from "../src/modules/name-rules/name-rules-errors.js";
import {
  RECLEAN_LOCK_KEY,
  RECLEAN_PREVIEW_TTL_MS,
  RECLEAN_STATE_KEY,
  RECLEAN_STOP_KEY,
  readRecleanState,
  recleanStateSchema,
  type RecleanState,
} from "../src/modules/name-rules/name-rules-reclean-state.js";
import { NameRulesRecleanService, type RecleanJobData } from "../src/modules/name-rules/name-rules-reclean.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Перечистка ников из панели (tasks/T-0339): права, замок на весь сервер,
 * предпросмотр как сухой прогон, запуск только после свежего предпросмотра,
 * ход по пачкам, остановка, сбой без шаблонов в логе. Redis, база и очередь —
 * подмены; пачки и запись на живой базе проверяет
 * `name-rules-reclean.integration.test.ts`.
 */

const OWNER_ID = "777000444";
const BRAND = "пример-бренд";
const T0 = new Date("2026-10-28T10:00:00Z");

/** Redis ровно в той мере, в какой его трогает перечистка: строки, NX, срок и два скрипта сверки токена. */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  renewals = 0;
  failGet = false;

  async get(key: string): Promise<string | null> {
    if (this.failGet) throw new Error("redis down");
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    const px = args.indexOf("PX");
    if (px >= 0) this.ttls.set(key, Number(args[px + 1]));
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    return this.values.has(key) ? 1 : 0;
  }

  /** Скрипты продления и снятия замка: оба сверяют токен, различаем по тексту. */
  async eval(script: string, _keys: number, key: string, token: string, ttl?: string | number): Promise<number> {
    if (this.values.get(key) !== token) return 0;
    if (/pexpire/i.test(script)) {
      this.renewals += 1;
      this.ttls.set(key, Number(ttl));
      return 1;
    }
    this.values.delete(key);
    return 1;
  }
}

interface Row {
  accountId: string;
  displayName: string;
  username: string | null;
  platformName: string | null;
  nameLockedAt: Date | null;
}

/** База ровно настолько, насколько её трогают проход пачками и чтение правил. */
class FakeDb {
  accounts: Row[] = [];
  rules: { ruleId: string; category: string; kind: string; pattern: string; active: boolean }[] = [{ ruleId: "00000000-0000-4000-8000-000000000001", category: "brand", kind: "exact", pattern: BRAND, active: true }];
  writes = 0;
  reads = 0;
  failReads = false;

  fill(total: number, locked = 0): void {
    this.accounts = Array.from({ length: total }, (_, index) => ({
      accountId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      displayName: `Вася ${BRAND}`,
      username: null,
      platformName: `Вася ${BRAND}`,
      nameLockedAt: index < locked ? new Date("2026-10-01T00:00:00Z") : null,
    }));
  }

  get prisma(): PrismaClient {
    return {
      account: {
        findMany: async (args: { where: { accountId?: { gt: string } }; take: number }) => {
          if (this.failReads) throw new Error("db down");
          this.reads += 1;
          const cursor = args.where.accountId?.gt ?? null;
          return this.accounts.filter((row) => cursor === null || row.accountId > cursor).slice(0, args.take);
        },
        updateMany: async (args: { where: { accountId: string }; data: { displayName: string; platformName: string } }) => {
          this.writes += 1;
          const row = this.accounts.find((item) => item.accountId === args.where.accountId && item.nameLockedAt === null);
          if (row === undefined) return { count: 0 };
          Object.assign(row, args.data);
          return { count: 1 };
        },
      },
      nameRule: { findMany: async () => this.rules.filter((rule) => rule.active) },
      $transaction: async (writes: Promise<{ count: number }>[]) => await Promise.all(writes),
    } as unknown as PrismaClient;
  }
}

function setup() {
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(config, rolesRepository, accounts);
  const redis = new FakeRedis();
  const db = new FakeDb();
  db.fill(1001);
  const jobs: RecleanJobData[] = [];
  const queue = { enqueue: async (data: RecleanJobData) => void jobs.push(data) };
  const service = new NameRulesRecleanService(db.prisma, redis as unknown as Redis, roles, queue);
  const sleeps: number[] = [];
  service.sleep = async (ms) => void sleeps.push(ms);
  let clock = T0.getTime();
  service.now = () => new Date(clock);
  return { service, redis, db, jobs, sleeps, rolesRepository, accounts, roles, advance: (ms: number) => void (clock += ms) };
}

type Ctx = ReturnType<typeof setup>;

async function person(ctx: Ctx, id: string, role?: "admin" | "moderator"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.rolesRepository.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

/** Предпросмотр доведён до конца: запущен и обработан воркером. */
async function previewDone(ctx: Ctx, actor: AccountRef): Promise<RecleanState> {
  const started = await ctx.service.startPreview(actor);
  const job = ctx.jobs.at(-1);
  if (job === undefined) throw new Error("задание не поставлено");
  await ctx.service.process(job);
  const state = await readRecleanState(ctx.redis as unknown as Redis);
  expect(state).toMatchObject({ runId: started.runId, mode: "preview", status: "done" });
  return state as RecleanState;
}

let logs: string[] = [];

beforeEach(() => {
  logs = [];
  vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)));
  vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void logs.push(String(message)));
  vi.spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => void logs.push(String(message)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("права", () => {
  it("каждый метод требует names.edit: игрок получает отказ, Redis и очередь не тронуты", async () => {
    const ctx = setup();
    const stranger = await person(ctx, "901");

    await expect(ctx.service.state(stranger)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ctx.service.startPreview(stranger)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ctx.service.startRun(stranger, { previewRunId: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ctx.service.stop(stranger)).rejects.toBeInstanceOf(ForbiddenError);
    expect(ctx.redis.values.size).toBe(0);
    expect(ctx.jobs).toEqual([]);
  });

  it("модератор с names.edit проходит", async () => {
    const ctx = setup();
    const moderator = await person(ctx, "902", "moderator");
    expect(await ctx.service.state(moderator)).toBeNull();
  });
});

describe("предпросмотр", () => {
  it("берёт замок, пишет queued, ставит задание и не пишет в аудит", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);

    const state = await ctx.service.startPreview(owner);

    expect(state).toMatchObject({ mode: "preview", status: "queued", scanned: 0, planned: 0, startedBy: owner.accountId, finishedAt: null, error: null });
    expect(state.signature).not.toBe("");
    expect(ctx.redis.values.has(RECLEAN_LOCK_KEY)).toBe(true);
    expect(ctx.redis.ttls.get(RECLEAN_LOCK_KEY)).toBe(120_000);
    expect(ctx.jobs).toEqual([{ runId: state.runId, mode: "preview", lockToken: ctx.redis.values.get(RECLEAN_LOCK_KEY) }]);
    expect(ctx.rolesRepository.entries).toEqual([]);
  });

  it("второй запуск при занятом замке — конфликт «Перечистка уже идёт», второго задания нет", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    await ctx.service.startPreview(owner);

    await expect(ctx.service.startPreview(owner)).rejects.toThrowError(new NameRuleConflictError("Перечистка уже идёт"));
    expect(ctx.jobs).toHaveLength(1);
  });

  it("очередь недоступна — замок снят, состояния нет, причина понятна", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    const broken = new NameRulesRecleanService(ctx.db.prisma, ctx.redis as unknown as Redis, ctx.roles, {
      enqueue: async () => {
        throw new Error("redis down");
      },
    });

    await expect(broken.startPreview(owner)).rejects.toThrow();
    expect(ctx.redis.values.has(RECLEAN_LOCK_KEY)).toBe(false);
    expect(await readRecleanState(ctx.redis as unknown as Redis)).toBeNull();
  });

  it("проход предпросмотра не пишет в базу, считает затронутых и закреплённых, ходит пачками с паузой 100 мс и продлевает замок", async () => {
    const ctx = setup();
    ctx.db.fill(1001, 11);
    const owner = await person(ctx, OWNER_ID);

    const done = await previewDone(ctx, owner);

    expect(ctx.db.writes).toBe(0);
    expect(done).toMatchObject({ scanned: 1001, planned: 990, updated: 0, locked: 11, skipped: 0, error: null });
    expect(done.finishedAt).toBe(T0.toISOString());
    // Три пачки (500 + 500 + 1), пауза после каждой.
    expect(ctx.sleeps).toEqual([100, 100, 100]);
    expect(ctx.redis.renewals).toBe(3);
    expect(ctx.redis.values.has(RECLEAN_LOCK_KEY)).toBe(false);
  });
});

describe("запуск", () => {
  it("без предпросмотра — конфликт с понятным текстом", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);

    await expect(ctx.service.startRun(owner, { previewRunId: "any" })).rejects.toThrowError(new NameRuleConflictError("Сначала посчитайте, сколько ников затронет перечистка"));
  });

  it("с чужим previewRunId и после запуска вместо предпросмотра — тот же отказ", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    await previewDone(ctx, owner);

    await expect(ctx.service.startRun(owner, { previewRunId: "00000000-0000-4000-8000-0000000000ff" })).rejects.toThrowError(
      new NameRuleConflictError("Сначала посчитайте, сколько ников затронет перечистка"),
    );
  });

  it("предпросмотр старше часа — «Предпросмотр устарел»", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    const preview = await previewDone(ctx, owner);
    ctx.advance(RECLEAN_PREVIEW_TTL_MS + 1);

    await expect(ctx.service.startRun(owner, { previewRunId: preview.runId })).rejects.toThrowError(new NameRuleConflictError("Предпросмотр устарел — посчитайте заново"));
  });

  it("правила изменились после предпросмотра — «Правила изменились после предпросмотра»", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    const preview = await previewDone(ctx, owner);
    ctx.db.rules.push({ ruleId: "00000000-0000-4000-8000-000000000002", category: "ads", kind: "word", pattern: "реклама", active: true });

    await expect(ctx.service.startRun(owner, { previewRunId: preview.runId })).rejects.toThrowError(
      new NameRuleConflictError("Правила изменились после предпросмотра — посчитайте заново"),
    );
    expect(ctx.jobs).toHaveLength(1);
  });

  it("предпросмотр, ещё не доведённый до конца, запуск не открывает", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    const queued = await ctx.service.startPreview(owner);

    await expect(ctx.service.startRun(owner, { previewRunId: queued.runId })).rejects.toBeInstanceOf(NameRuleConflictError);
  });

  it("годный предпросмотр: queued, задание с режимом run, аудит names.reclean.start с итогами предпросмотра", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    const preview = await previewDone(ctx, owner);

    const run = await ctx.service.startRun(owner, { previewRunId: preview.runId });

    expect(run).toMatchObject({ mode: "run", status: "queued", signature: preview.signature });
    expect(run.runId).not.toBe(preview.runId);
    expect(ctx.jobs.at(-1)).toMatchObject({ runId: run.runId, mode: "run" });
    expect(ctx.rolesRepository.entries).toEqual([
      expect.objectContaining({ action: "names.reclean.start", actorAccountId: owner.accountId, target: run.runId, after: { previewRunId: preview.runId, planned: preview.planned, signature: preview.signature } }),
    ]);
  });

  it("проход запуска пишет: меняет ровно запланированное, закреплённых не трогает, итог — в аудит от имени запустившего", async () => {
    const ctx = setup();
    ctx.db.fill(1001, 11);
    const owner = await person(ctx, OWNER_ID);
    const preview = await previewDone(ctx, owner);
    const run = await ctx.service.startRun(owner, { previewRunId: preview.runId });
    const job = ctx.jobs.at(-1) as RecleanJobData;

    await ctx.service.process(job);

    const done = (await readRecleanState(ctx.redis as unknown as Redis)) as RecleanState;
    expect(done).toMatchObject({ runId: run.runId, mode: "run", status: "done", scanned: 1001, planned: preview.planned, updated: preview.planned, skipped: 0, locked: 11 });
    expect(ctx.db.writes).toBe(preview.planned);
    expect(ctx.db.accounts.filter((row) => row.displayName === "Вася")).toHaveLength(990);
    expect(ctx.db.accounts.filter((row) => row.nameLockedAt !== null).every((row) => row.displayName === `Вася ${BRAND}`)).toBe(true);
    const finish = ctx.rolesRepository.entries.find((entry) => entry.action === "names.reclean.finish");
    expect(finish).toMatchObject({ actorAccountId: owner.accountId, target: run.runId, after: { scanned: 1001, updated: 990, skipped: 0, locked: 11 } });
  });

  it("правила изменились между постановкой и проходом — failed «Правила изменились — запустите заново», записи не было", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    const preview = await previewDone(ctx, owner);
    await ctx.service.startRun(owner, { previewRunId: preview.runId });
    ctx.db.rules.push({ ruleId: "00000000-0000-4000-8000-000000000002", category: "ads", kind: "word", pattern: "реклама", active: true });

    await ctx.service.process(ctx.jobs.at(-1) as RecleanJobData);

    expect(await readRecleanState(ctx.redis as unknown as Redis)).toMatchObject({ status: "failed", error: "Правила изменились — запустите заново" });
    expect(ctx.db.writes).toBe(0);
    expect(ctx.redis.values.has(RECLEAN_LOCK_KEY)).toBe(false);
  });
});

describe("остановка", () => {
  it("флаг останавливает проход: статус stopped с набранным, замок и флаг сняты, остановка в аудите", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    const preview = await previewDone(ctx, owner);
    const run = await ctx.service.startRun(owner, { previewRunId: preview.runId });
    // Остановка до начала прохода: первая же проверка перед пачкой выходит.
    const stopped = await ctx.service.stop(owner);
    expect(stopped).toMatchObject({ runId: run.runId });
    expect(ctx.redis.values.has(RECLEAN_STOP_KEY)).toBe(true);

    await ctx.service.process(ctx.jobs.at(-1) as RecleanJobData);

    expect(await readRecleanState(ctx.redis as unknown as Redis)).toMatchObject({ status: "stopped", scanned: 0, updated: 0 });
    expect(ctx.redis.values.has(RECLEAN_LOCK_KEY)).toBe(false);
    expect(ctx.redis.values.has(RECLEAN_STOP_KEY)).toBe(false);
    expect(ctx.rolesRepository.entries.map((entry) => entry.action)).toEqual(["names.reclean.start", "names.reclean.stop", "names.reclean.finish"]);
  });

  it("остановка, когда ничего не идёт, — конфликт, флаг не остаётся висеть на следующий запуск", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);

    await expect(ctx.service.stop(owner)).rejects.toThrowError(new NameRuleConflictError("Перечистка не идёт"));
    expect(ctx.redis.values.has(RECLEAN_STOP_KEY)).toBe(false);
  });
});

describe("сбои", () => {
  it("исключение в проходе — failed с общим текстом, в логе нет шаблонов и ников, замок снят", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    await ctx.service.startPreview(owner);
    ctx.db.failReads = true;

    await ctx.service.process(ctx.jobs.at(-1) as RecleanJobData);

    expect(await readRecleanState(ctx.redis as unknown as Redis)).toMatchObject({ status: "failed", error: "Перечистка прервалась — смотрите журнал сервера" });
    expect(ctx.redis.values.has(RECLEAN_LOCK_KEY)).toBe(false);
    const line = logs.find((entry) => entry.includes("reclean_failed"));
    expect(line).toBeDefined();
    expect(JSON.parse(line as string)).toEqual({ module: "name-rules", event: "reclean_failed", reason: "Error" });
    expect(logs.join("\n")).not.toContain(BRAND);
  });

  it("чужой замок (другой токен) проход не снимает", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    await ctx.service.startPreview(owner);
    const job = ctx.jobs.at(-1) as RecleanJobData;
    // Замок истёк и достался другому процессу.
    ctx.redis.values.set(RECLEAN_LOCK_KEY, "чужой-токен");

    await ctx.service.process(job);

    expect(ctx.redis.values.get(RECLEAN_LOCK_KEY)).toBe("чужой-токен");
  });

  it("задание от устаревшего запуска (состояние уже другое) ничего не делает", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    await ctx.service.startPreview(owner);
    const job = ctx.jobs.at(-1) as RecleanJobData;

    await ctx.service.process({ ...job, runId: "00000000-0000-4000-8000-0000000000aa" });

    expect(ctx.db.reads).toBe(0);
    expect(await readRecleanState(ctx.redis as unknown as Redis)).toMatchObject({ runId: job.runId, status: "queued" });
  });

  it("упавший процесс: замок истёк, а состояние всё ещё «идёт» — панель видит failed, а не вечный прогресс", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    await ctx.service.startPreview(owner);
    ctx.redis.values.delete(RECLEAN_LOCK_KEY);

    expect(await ctx.service.state(owner)).toMatchObject({ status: "failed", error: "Перечистка прервалась — запустите заново" });
    expect(await readRecleanState(ctx.redis as unknown as Redis)).toMatchObject({ status: "failed" });
  });
});

describe("состояние в Redis", () => {
  it("битое значение читается как «нет состояния»", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);

    for (const broken of ["не json", "{}", JSON.stringify({ runId: "x", mode: "preview", status: "бегает" })]) {
      ctx.redis.values.set(RECLEAN_STATE_KEY, broken);
      expect(await ctx.service.state(owner)).toBeNull();
    }
  });

  it("схема состояния отвергает отрицательные счётчики и лишние поля", () => {
    const good: RecleanState = {
      runId: "r",
      mode: "run",
      status: "done",
      signature: "s",
      scanned: 1,
      planned: 1,
      updated: 1,
      skipped: 0,
      locked: 0,
      startedAt: T0.toISOString(),
      finishedAt: T0.toISOString(),
      startedBy: "a",
      error: null,
    };
    expect(recleanStateSchema.safeParse(good).success).toBe(true);
    expect(recleanStateSchema.safeParse({ ...good, updated: -1 }).success).toBe(false);
    expect(recleanStateSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });
});
