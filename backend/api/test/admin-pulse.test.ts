import { describe, expect, it } from "vitest";
import { AdminPulseService } from "../src/modules/admin/admin-pulse.service.js";
import type { BroadcastRecord, DeliveryStats } from "../src/modules/broadcasts/broadcasts.repository.js";
import type { CspSummary } from "../src/modules/csp-reports/csp-reports.service.js";
import type { OnlineSnapshot } from "../src/modules/online/online.service.js";
import type { Role } from "../src/modules/roles/permissions.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";

/**
 * Пульс в шапке панели (tasks/T-0360): онлайн, ход рассылки и блокировки
 * клиента за час — каждая часть по своему праву и независимо от остальных.
 */

const NOW = new Date("2026-11-01T12:00:00.000Z");
const MIN = 60_000;
const ACTOR: AccountRef = { accountId: "a1", platform: "telegram", platformUserId: "1" };

function broadcast(id: string, status: BroadcastRecord["status"], startedAt: Date | null): BroadcastRecord {
  return {
    broadcastId: id, title: id, platform: "telegram", text: "", buttonText: null, buttonUrl: null, linkCode: null,
    segment: {} as BroadcastRecord["segment"], status, audience: 100, createdBy: "x", approvedBy: null, startedBy: null,
    createdAt: NOW, updatedAt: NOW, startedAt, finishedAt: null,
  };
}

function setup(options: { roles?: Role[]; online?: number | "fail"; broadcasts?: BroadcastRecord[]; stats?: Record<string, DeliveryStats>; csp?: CspSummary["entries"] | "fail" }) {
  const roles = { rolesFor: async () => options.roles ?? ["owner"] };
  const online = {
    adminSnapshot: async (): Promise<OnlineSnapshot> => {
      if (options.online === "fail") throw new Error("redis лёг");
      return { total: { app: options.online ?? 0, run: 0, today: 0 }, byPlatform: {} as OnlineSnapshot["byPlatform"], peak: null, at: 0 };
    },
  };
  const broadcasts = {
    list: async () => options.broadcasts ?? [],
    view: async (_actor: AccountRef, id: string) => ({ ...broadcast(id, "sending", NOW), stats: options.stats?.[id] ?? null, approvalAudience: 1000 }),
  };
  const csp = {
    summary: async (): Promise<CspSummary> => {
      if (options.csp === "fail") throw new Error("redis лёг");
      return { entries: options.csp ?? [], overflow: 0, maxEntries: 200 };
    },
  };
  return new AdminPulseService(roles as never, online as never, broadcasts as never, csp as never);
}

const stats = (sent: number, queued: number): DeliveryStats => ({ queued, sent, blocked: 0, failed: 0, blockedAfter: 0 });
const entry = (host: string, minutesAgo: number) => ({ directive: "img-src", host, count: 1, lastAt: new Date(NOW.getTime() - minutesAgo * MIN).toISOString() });

describe("пульс панели", () => {
  it("без прав все части null", async () => {
    const service = setup({ roles: [], online: 5, broadcasts: [broadcast("b1", "sending", NOW)], csp: [entry("a", 1)] });
    expect(await service.pulse(ACTOR, NOW)).toEqual({ online: null, broadcast: null, csp: null });
  });

  it("онлайн — число людей в приложении", async () => {
    const pulse = await setup({ online: 128 }).pulse(ACTOR, NOW);
    expect(pulse.online).toEqual({ total: 128 });
  });

  it("рассылка sending 40 из 100 — percent 40", async () => {
    const service = setup({ broadcasts: [broadcast("b1", "sending", NOW)], stats: { b1: stats(40, 60) } });
    expect((await service.pulse(ACTOR, NOW)).broadcast).toEqual({ id: "b1", percent: 40 });
  });

  it("две sending — берётся начатая раньше", async () => {
    const early = broadcast("early", "sending", new Date(NOW.getTime() - 60 * MIN));
    const late = broadcast("late", "sending", new Date(NOW.getTime() - 5 * MIN));
    const service = setup({ broadcasts: [late, early, broadcast("done", "finished", NOW)], stats: { early: stats(10, 90), late: stats(50, 50) } });
    expect((await service.pulse(ACTOR, NOW)).broadcast).toEqual({ id: "early", percent: 10 });
  });

  it("нет идущей рассылки — null", async () => {
    const service = setup({ broadcasts: [broadcast("d", "draft", null)] });
    expect((await service.pulse(ACTOR, NOW)).broadcast).toBeNull();
  });

  it("CSP: записи 10 мин, 50 мин и 2 ч назад — два адреса за час", async () => {
    const service = setup({ csp: [entry("a.example", 10), entry("b.example", 50), entry("c.example", 120)] });
    expect((await service.pulse(ACTOR, NOW)).csp).toEqual({ hosts: 2 });
  });

  it("CSP: пары «директива · адрес» считаются раздельно", async () => {
    const service = setup({ csp: [entry("a.example", 10), { ...entry("a.example", 20), directive: "script-src" }] });
    expect((await service.pulse(ACTOR, NOW)).csp).toEqual({ hosts: 2 });
  });

  it("упавший онлайн — online null, остальное есть", async () => {
    const service = setup({ online: "fail", csp: [entry("a.example", 10)] });
    expect(await service.pulse(ACTOR, NOW)).toEqual({ online: null, broadcast: null, csp: { hosts: 1 } });
  });

  it("упавший CSP — csp null, онлайн есть", async () => {
    const service = setup({ online: 7, csp: "fail" });
    expect(await service.pulse(ACTOR, NOW)).toEqual({ online: { total: 7 }, broadcast: null, csp: null });
  });
});
