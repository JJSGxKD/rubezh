import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { loadCustomerReport } from "../src/modules/tasks/customer-report.js";
import { PrismaCustomerReportRepository } from "../src/modules/tasks/customer-report.repository.js";
import { NO_ACHIEVEMENT_FIELDS, type TaskDef } from "../src/modules/tasks/task-rules.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Отчёт заказчику на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск; tasks/T-0225): в отчёте только задания
 * своего заказчика, сутки — по Москве, а в ответе нет идентификаторов игроков.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RUN = randomUUID().slice(0, 8);
const CUSTOMER = `Заказчик А ${RUN}`;
const OTHER = `Заказчик Б ${RUN}`;
const TASK_CPA = `it_rep_a1_${RUN}`;
const TASK_FREE = `it_rep_a2_${RUN}`;
const TASK_OTHER = `it_rep_b1_${RUN}`;
const STAMP = new Date("2026-10-01T00:00:00Z");
const PERIOD = "2026-10-19";

describe.skipIf(DATABASE_URL === "")("отчёт заказчику на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaCustomerReportRepository;
  let accounts: PrismaAccountRepository;
  const playerIds: string[] = [];

  function def(taskId: string, customer: string, patch: Partial<TaskDef> = {}): TaskDef {
    return {
      taskId,
      period: "daily",
      kind: "channel",
      params: { platform: "telegram", chat: `@rubezh_rep_${RUN}`, url: "https://t.me/rubezh_rep" },
      filter: null,
      tier: null,
      target: 1,
      title: taskId === TASK_CPA ? "Канал для отчёта" : null,
      coins: 100,
      gems: 0,
      shards: 0,
      passPoints: 0,
      sort: 0,
      active: true,
      limit: null,
      image: null,
      ...NO_ACHIEVEMENT_FIELDS,
      customer,
      payModel: "cpa",
      rate: 40,
      holdDays: 3,
      ...patch,
    };
  }

  async function player(): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(950_000_000 + Math.floor(Math.random() * 40_000_000)), displayName: "Подписчик", username: null }, Date.now());
    playerIds.push(created.accountId);
    return created.accountId;
  }

  async function event(type: "task_shown" | "task_link_opened", taskId: string, at: string): Promise<void> {
    const when = new Date(at);
    await prisma.analyticsEvent.create({
      data: {
        eventId: randomUUID(),
        eventType: type,
        schemaVersion: 1,
        installId: `rep-${RUN}`,
        sessionId: "s1",
        platform: "telegram",
        appVersion: "0.0.0-test",
        payload: { task: taskId, kind: "channel" } as never,
        occurredAt: when,
        receivedAt: new Date(when.getTime() + 60_000),
      },
    });
  }

  /** Забор награды в `claimedAt` и, если задано, окно с отметками. */
  async function claim(accountId: string, taskId: string, claimedAt: string, window: { state: "watching" | "kept"; d3: boolean | null } | null): Promise<void> {
    const at = new Date(claimedAt);
    await prisma.$executeRaw`
      INSERT INTO task_progress (account_id, task_id, period_start, value, target, completed_at, claimed_at, updated_at)
      VALUES (${accountId}::uuid, ${taskId}, ${PERIOD}::date, 1, 1, ${at}, ${at}, ${at})`;
    if (window === null) return;
    await prisma.$executeRaw`
      INSERT INTO task_channel_watch (account_id, task_id, period_start, started_at, watch_until, next_check_at, state, held_d3)
      VALUES (${accountId}::uuid, ${taskId}, ${PERIOD}::date, ${at}, ${new Date(at.getTime() + 7 * 86_400_000)}, ${at}, ${window.state}, ${window.d3})`;
  }

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 6);
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaCustomerReportRepository(prisma);
    const tasks = new PrismaTasksRepository(prisma);
    const author = await player();
    await tasks.insert(def(TASK_CPA, CUSTOMER), author, STAMP);
    await tasks.insert(def(TASK_FREE, CUSTOMER, { holdDays: 0 }), author, STAMP);
    await tasks.insert(def(TASK_OTHER, OTHER), author, STAMP);

    // Показы: 23:59 МСК 23-го и 00:00 МСК 26-го — вне периода 24–25 октября.
    await event("task_shown", TASK_CPA, "2026-10-23T20:59:00Z");
    await event("task_shown", TASK_CPA, "2026-10-24T20:00:00Z"); // 23:00 МСК, 24-е
    await event("task_shown", TASK_CPA, "2026-10-24T09:00:00Z"); // 12:00 МСК, 24-е
    await event("task_shown", TASK_CPA, "2026-10-24T22:30:00Z"); // 01:30 МСК, 25-е
    await event("task_link_opened", TASK_CPA, "2026-10-24T22:30:00Z"); // 25-е
    await event("task_shown", TASK_CPA, "2026-10-25T21:00:00Z"); // 00:00 МСК, 26-е
    await event("task_shown", TASK_OTHER, "2026-10-24T09:00:00Z");
    await event("task_shown", TASK_OTHER, "2026-10-24T09:00:00Z");

    const [one, two, three, four, five] = [await player(), await player(), await player(), await player(), await player()];
    await claim(one, TASK_CPA, "2026-10-24T09:00:00Z", { state: "kept", d3: true });
    await claim(two, TASK_CPA, "2026-10-24T22:30:00Z", { state: "kept", d3: false }); // 25-е по Москве
    await claim(three, TASK_CPA, "2026-10-25T08:00:00Z", { state: "watching", d3: null });
    await claim(four, TASK_FREE, "2026-10-25T08:00:00Z", null);
    await claim(five, TASK_OTHER, "2026-10-24T09:00:00Z", { state: "kept", d3: true });
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM task_channel_watch WHERE task_id LIKE ${`it\\_rep\\_%\\_${RUN}`}`;
    await prisma.$executeRaw`DELETE FROM task_progress WHERE task_id LIKE ${`it\\_rep\\_%\\_${RUN}`}`;
    await prisma.$executeRaw`DELETE FROM analytics_event WHERE install_id = ${`rep-${RUN}`}`;
    await prisma.$executeRaw`UPDATE task_def SET active = false WHERE task_id LIKE ${`it\\_rep\\_%\\_${RUN}`}`;
    await prisma.$disconnect();
  });

  it("список заказчиков — из заданий, каждый один раз", async () => {
    const customers = await repository.customers();
    expect(customers.filter((name) => name === CUSTOMER)).toHaveLength(1);
    expect(customers).toContain(OTHER);
  });

  it("в отчёте только свои задания; день — по Москве; показ в 22:30 UTC попадает в следующий день", async () => {
    const report = await loadCustomerReport(repository, { customer: CUSTOMER, from: "2026-10-24", to: "2026-10-25" });

    expect(report.rows.map((row) => `${row.day} ${row.taskId}`)).toEqual([`2026-10-24 ${TASK_CPA}`, `2026-10-25 ${TASK_CPA}`, `2026-10-25 ${TASK_FREE}`]);
    expect(report.rows[0]).toMatchObject({ title: "Канал для отчёта", shown: 2, opened: 0, completed: 1, paid: 1, amountCents: 40 });
    expect(report.rows[0]?.retention.d3).toEqual({ kept: 1, pending: 0, unknown: 0 });
    // 25-е: показ и нажатие из 22:30 UTC; два выполнения — отписавшийся (false) и ещё в окне (null)
    expect(report.rows[1]).toMatchObject({ shown: 1, opened: 1, completed: 2, paid: 0, amountCents: 0 });
    expect(report.rows[1]?.retention.d3).toEqual({ kept: 0, pending: 1, unknown: 0 });
    // задание без срока удержания оплачивается сразу, окна у него нет
    expect(report.rows[2]).toMatchObject({ shown: 0, completed: 1, paid: 1, amountCents: 40 });
    expect(report.totals).toMatchObject({ shown: 3, opened: 1, completed: 4, paid: 2, amountCents: 80, hasRevenueShare: false });
  });

  it("чужой заказчик видит только своё", async () => {
    const report = await loadCustomerReport(repository, { customer: OTHER, from: "2026-10-24", to: "2026-10-25" });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ taskId: TASK_OTHER, shown: 2, completed: 1 });
  });

  it("заказчика с таким именем нет — пустой отчёт", async () => {
    const report = await loadCustomerReport(repository, { customer: `Нет такого ${RUN}`, from: "2026-10-24", to: "2026-10-25" });
    expect(report.rows).toEqual([]);
    expect(report.totals).toMatchObject({ shown: 0, completed: 0, amountCents: 0 });
  });

  it("в ответе нет идентификаторов игроков", async () => {
    const report = await loadCustomerReport(repository, { customer: CUSTOMER, from: "2026-10-24", to: "2026-10-25" });
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/accountId|account_id|platformUserId/i);
    for (const id of playerIds) expect(text).not.toContain(id);
  });
});
