import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminChangeRequestsController } from "../src/modules/admin/admin-change-requests.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { ChangeRequestValueError } from "../src/modules/change-requests/change-request-errors.js";
import { ChangeKindRegistry, type ChangeKindHandler, type ChangeTargetView } from "../src/modules/change-requests/change-request-kinds.js";
import { expiresAt, isExpired, rolesGranting, sameJson } from "../src/modules/change-requests/change-request-rules.js";
import { CHANGE_TTL_MS, type ChangeKind, type ChangeRequestRow, type ChangeTx, type ClosedStatus, type JsonValue } from "../src/modules/change-requests/change-request-types.js";
import { ChangeRequestsNotifier } from "../src/modules/change-requests/change-requests-notifier.js";
import type { ChangeRequestsRepository, ChangeSession } from "../src/modules/change-requests/change-requests.repository.js";
import { ChangeRequestsService } from "../src/modules/change-requests/change-requests.service.js";
import { SkuPriceKind, describeSkuChange } from "../src/modules/change-requests/sku-price.kind.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { NOTIFICATION_KINDS } from "../src/modules/notifications/notification-kinds.js";
import type { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLE_PERMISSIONS } from "../src/modules/roles/permissions.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { NotifyTargets } from "../src/modules/settings/notify-targets.js";
import { SHOP_SKUS, shopSkuSchema, skuById, type ShopSku } from "../src/modules/shop/shop-catalog.js";
import { ShopSkuNotFoundError } from "../src/modules/shop/shop-errors.js";
import { NO_SHOP_OVERRIDES, ShopOverrides, applyOverride, skuOverrideSchema } from "../src/modules/shop/shop-overrides.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import type { Messengers } from "../src/platforms/ports/messenger.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Заявки на правку цен с подтверждением второго участника
 * (docs/19-content-admin.md §6, tasks/T-0309): подтверждает не автор и с тем же
 * правом, заявка живёт 72 часа, новая на ту же цель гасит прежнюю, правка
 * применяется, только если цель всё ещё равна «было». Живой Postgres и
 * гонки — `change-requests.integration.test.ts`.
 */

const HOUR = 3_600_000;
const NOW = new Date(Date.UTC(2026, 10, 13, 9));
const OWNER_ID = "777000111";

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("ожидался отказ");
}

/** Вид правки для теста: «цена» цели — одно число, как у товара в звёздах. */
class FakeKind implements ChangeKindHandler {
  readonly kind = "sku_price" as const;
  readonly permission = "sku.price.edit" as const;
  readonly prices = new Map<string, number>([
    ["gems_60", 50],
    ["gems_330", 250],
  ]);
  readonly applied: { target: string; stars: number; by: string }[] = [];
  readonly committed: string[] = [];

  async prepare(_tx: ChangeTx, target: string, after: unknown): Promise<{ before: JsonValue; after: JsonValue }> {
    const price = this.prices.get(target);
    if (price === undefined) throw new ShopSkuNotFoundError();
    const parsed = z.object({ stars: z.number().int().min(1).max(10_000) }).strict().safeParse(after);
    if (!parsed.success) throw new ChangeRequestValueError("Цена в звёздах: целое от 1 до 10 000");
    if (parsed.data.stars === price) throw new ChangeRequestValueError("Ничего не меняется");
    return { before: { stars: price }, after: { stars: parsed.data.stars } };
  }

  async current(_tx: ChangeTx, request: ChangeRequestRow): Promise<JsonValue> {
    return { stars: this.prices.get(request.target) ?? null };
  }

  async apply(_tx: ChangeTx, request: ChangeRequestRow, by: string): Promise<void> {
    const { stars } = request.after as { stars: number };
    this.prices.set(request.target, stars);
    this.applied.push({ target: request.target, stars, by });
  }

  afterCommit(request: ChangeRequestRow): void {
    this.committed.push(request.requestId);
  }

  async targets(): Promise<ChangeTargetView[]> {
    return [...this.prices].map(([target, stars]) => ({ target, title: target, current: { stars }, inCode: { stars }, overridden: false }));
  }

  describe(request: ChangeRequestRow): string {
    return `${request.target}: ${JSON.stringify(request.before)} → ${JSON.stringify(request.after)}`;
  }
}

/** Хранилище заявок в памяти: смысл тот же, что у Postgres, кроме блокировок — они проверяются на живой базе. */
class MemoryChangeRequests implements ChangeRequestsRepository {
  readonly rows = new Map<string, ChangeRequestRow>();
  peersOf: string[] = [];

  async locked<T>(_kind: ChangeKind, _target: string, work: (session: ChangeSession) => Promise<T>): Promise<T> {
    const session: ChangeSession = {
      tx: {} as ChangeTx,
      find: async (requestId) => this.rows.get(requestId) ?? null,
      pending: async (kind, target) => [...this.rows.values()].filter((row) => row.kind === kind && row.target === target && row.status === "pending"),
      insert: async (row) => {
        this.rows.set(row.requestId, row);
      },
      close: async (requestId, status: ClosedStatus, by, at) => {
        const row = this.rows.get(requestId);
        if (row === undefined || row.status !== "pending") return false;
        this.rows.set(requestId, { ...row, status, decidedBy: by, decidedAt: at });
        return true;
      },
    };
    return await work(session);
  }

  async find(requestId: string): Promise<ChangeRequestRow | null> {
    return this.rows.get(requestId) ?? null;
  }

  async list(since: Date, limit: number): Promise<ChangeRequestRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === "pending" || row.createdAt >= since)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async expireOverdue(createdBefore: Date, at: Date): Promise<number> {
    let count = 0;
    for (const [id, row] of this.rows) {
      if (row.status === "pending" && row.createdAt < createdBefore) {
        this.rows.set(id, { ...row, status: "expired", decidedBy: null, decidedAt: at });
        count += 1;
      }
    }
    return count;
  }

  async peers(): Promise<string[]> {
    return this.peersOf;
  }
}

function setup(config: AppConfig = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv)) {
  const repository = new MemoryChangeRequests();
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const kind = new FakeKind();
  const requested: string[] = [];
  const notifier = { requested: async (view: { requestId: string }) => void requested.push(view.requestId) } as unknown as ChangeRequestsNotifier;
  const rolesService = new RolesService(config, roles, accounts);
  const service = new ChangeRequestsService(repository, accounts, rolesService, new ChangeKindRegistry([kind]), notifier);
  return { config, repository, accounts, roles, kind, requested, notifier, service };
}

type Ctx = ReturnType<typeof setup>;

async function person(ctx: Ctx, id: string, role?: "admin" | "game_designer" | "moderator" | "owner"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Участник ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: "telegram", platformUserId: id };
}

function proposal(patch: Record<string, unknown> = {}) {
  return { kind: "sku_price", target: "gems_60", after: { stars: 60 }, reason: "Малый набор дешевле соседнего за штуку", ...patch };
}

describe("заявки: правила", () => {
  const row = (patch: Partial<ChangeRequestRow> = {}): ChangeRequestRow => ({
    requestId: randomUUID(),
    kind: "sku_price",
    target: "gems_60",
    before: { stars: 50 },
    after: { stars: 60 },
    reason: "причина",
    author: randomUUID(),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    createdAt: NOW,
    ...patch,
  });

  it("заявка живёт 72 часа: на последней миллисекунде жива, ровно через срок — просрочена", () => {
    expect(CHANGE_TTL_MS).toBe(72 * HOUR);
    expect(expiresAt(row())).toEqual(at(72 * HOUR));
    expect(isExpired(row(), at(72 * HOUR - 1))).toBe(false);
    expect(isExpired(row(), at(72 * HOUR))).toBe(true);
  });

  it("сравнение «было» с состоянием цели не зависит от порядка ключей", () => {
    expect(sameJson({ stars: 50, contents: { gems: 60 } }, { contents: { gems: 60 }, stars: 50 })).toBe(true);
    expect(sameJson({ stars: 50 }, { stars: 51 })).toBe(false);
    expect(sameJson({ badge: null }, {})).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
  });

  it("подтверждать цены вправе владелец и геймдизайнер; администратору, финансисту и модератору права нет", () => {
    expect([...rolesGranting("sku.price.edit")].sort()).toEqual(["game_designer", "owner"]);
    expect(ROLE_PERMISSIONS.admin).not.toContain("sku.price.edit");
  });
});

describe("заявки: сервис", () => {
  it("заявка «было → стало» с причиной: было берёт сервер, автор — тот, кто подал, аудит и уведомление есть", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const view = await ctx.service.propose(author, proposal(), NOW);
    expect(view).toMatchObject({ kind: "sku_price", target: "gems_60", before: { stars: 50 }, after: { stars: 60 }, status: "pending", author: author.accountId, authorName: "Участник 100", decidedBy: null });
    expect(view.expiresAt).toEqual(at(72 * HOUR));
    expect(ctx.requested).toEqual([view.requestId]);
    expect(ctx.roles.entries.at(-1)).toMatchObject({ actorAccountId: author.accountId, action: "change_request.create", target: view.requestId, after: { kind: "sku_price", target: "gems_60", before: { stars: 50 }, after: { stars: 60 }, reason: "Малый набор дешевле соседнего за штуку" } });
    // Цена пока прежняя: заявка — только предложение.
    expect(ctx.kind.prices.get("gems_60")).toBe(50);
  });

  it("причина обязательна и до 200 знаков; вид и цель — из списка; лишние поля заявки — отказ", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    for (const bad of [proposal({ reason: "" }), proposal({ reason: "   " }), proposal({ reason: "я".repeat(201) }), proposal({ kind: "other" }), proposal({ target: "" }), proposal({ extra: 1 }), proposal({ after: "60" })]) {
      expect(await codeOf(ctx.service.propose(author, bad, NOW)), JSON.stringify(bad)).toBe("validation_failed");
    }
    expect((await ctx.service.propose(author, proposal({ reason: "я".repeat(200) }), NOW)).reason).toHaveLength(200);
    expect(ctx.repository.rows.size).toBe(1);
  });

  it("форма правки — на виде: цена 0 и неизвестная цель — отказ, заявки нет; без права — 403", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    expect(await codeOf(ctx.service.propose(author, proposal({ after: { stars: 0 } }), NOW))).toBe("change_request_value_invalid");
    expect(await codeOf(ctx.service.propose(author, proposal({ target: "gems_9999" }), NOW))).toBe("shop_sku_not_found");
    const moderator = await person(ctx, "101", "moderator");
    expect(await codeOf(ctx.service.propose(moderator, proposal(), NOW))).toBe("forbidden");
    const admin = await person(ctx, "102", "admin");
    expect(await codeOf(ctx.service.propose(admin, proposal(), NOW))).toBe("forbidden");
    expect(ctx.repository.rows.size).toBe(0);
    expect(ctx.requested).toEqual([]);
  });

  it("автор не может подтвердить свою заявку: отказ, заявка жива, цена прежняя", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const view = await ctx.service.propose(author, proposal(), NOW);
    expect(await codeOf(ctx.service.approve(author, view.requestId, at(HOUR)))).toBe("change_request_own");
    expect(await codeOf(ctx.service.reject(author, view.requestId, at(HOUR)))).toBe("change_request_own");
    expect(ctx.repository.rows.get(view.requestId)?.status).toBe("pending");
    expect(ctx.kind.applied).toEqual([]);
    // Даже владелец не подтверждает собственную заявку: «второй участник» — другой человек.
    const owner = await person(ctx, "200", "owner");
    const ownersOwn = await ctx.service.propose(owner, proposal({ target: "gems_330", after: { stars: 300 } }), NOW);
    expect(await codeOf(ctx.service.approve(owner, ownersOwn.requestId, at(HOUR)))).toBe("change_request_own");
  });

  it("другой человек с правом подтверждает: цель меняется один раз, заявка approved с его именем, аудит — подтверждение и применение", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const view = await ctx.service.propose(author, proposal(), NOW);
    const done = await ctx.service.approve(reviewer, view.requestId, at(2 * HOUR));
    expect(done).toMatchObject({ status: "approved", decidedBy: reviewer.accountId, decidedByName: "Участник 200", decidedAt: at(2 * HOUR) });
    expect(ctx.kind.prices.get("gems_60")).toBe(60);
    expect(ctx.kind.applied).toEqual([{ target: "gems_60", stars: 60, by: reviewer.accountId }]);
    expect(ctx.kind.committed).toEqual([view.requestId]);
    expect(ctx.roles.entries.slice(-2).map((entry) => entry.action)).toEqual(["change_request.approve", "change_request.apply"]);
    expect(ctx.roles.entries.at(-1)).toMatchObject({ actorAccountId: reviewer.accountId, target: "sku_price:gems_60", before: { stars: 50 }, after: { stars: 60 } });

    // Повторное подтверждение не применяет второй раз.
    expect(await codeOf(ctx.service.approve(reviewer, view.requestId, at(3 * HOUR)))).toBe("change_request_closed");
    expect(ctx.kind.applied).toHaveLength(1);
  });

  it("подтверждает только тот, у кого есть право: модератор, администратор и аноним — 403", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const view = await ctx.service.propose(author, proposal(), NOW);
    for (const [id, role] of [["300", "moderator"], ["301", "admin"], ["302", undefined]] as const) {
      const outsider = await person(ctx, id, role);
      expect(await codeOf(ctx.service.approve(outsider, view.requestId, at(HOUR))), id).toBe("forbidden");
      expect(await codeOf(ctx.service.reject(outsider, view.requestId, at(HOUR))), id).toBe("forbidden");
    }
    expect(ctx.repository.rows.get(view.requestId)?.status).toBe("pending");
    expect(ctx.kind.applied).toEqual([]);
  });

  it("заявка старше 72 часов — expired: подтвердить нельзя, цена прежняя", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const view = await ctx.service.propose(author, proposal(), NOW);
    expect(await codeOf(ctx.service.approve(reviewer, view.requestId, at(72 * HOUR)))).toBe("change_request_expired");
    expect(ctx.repository.rows.get(view.requestId)).toMatchObject({ status: "expired", decidedBy: null, decidedAt: at(72 * HOUR) });
    expect(ctx.kind.applied).toEqual([]);
    expect(await codeOf(ctx.service.reject(reviewer, view.requestId, at(73 * HOUR)))).toBe("change_request_closed");
  });

  it("список гасит просроченные: pending старше срока становится expired, у свежих остаётся", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const old = await ctx.service.propose(author, proposal(), NOW);
    const fresh = await ctx.service.propose(author, proposal({ target: "gems_330", after: { stars: 300 } }), at(60 * HOUR));
    const overview = await ctx.service.overview(author, at(73 * HOUR));
    expect(overview.requests.find((request) => request.requestId === old.requestId)?.status).toBe("expired");
    expect(overview.requests.find((request) => request.requestId === fresh.requestId)?.status).toBe("pending");
    expect(overview.ttlHours).toBe(72);
    expect(overview.targets.sku_price?.map((target) => target.target)).toEqual(["gems_60", "gems_330"]);
  });

  it("новая заявка на ту же цель гасит прежнюю — superseded; заявки на другие цели не трогает; просроченная остаётся expired", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const other = await person(ctx, "101", "game_designer");
    const first = await ctx.service.propose(author, proposal(), NOW);
    const aside = await ctx.service.propose(author, proposal({ target: "gems_330", after: { stars: 300 } }), NOW);
    const second = await ctx.service.propose(other, proposal({ after: { stars: 55 } }), at(HOUR));
    expect(ctx.repository.rows.get(first.requestId)).toMatchObject({ status: "superseded", decidedBy: null });
    expect(ctx.repository.rows.get(aside.requestId)?.status).toBe("pending");
    expect(ctx.repository.rows.get(second.requestId)?.status).toBe("pending");
    expect([...ctx.repository.rows.values()].filter((row) => row.target === "gems_60" && row.status === "pending")).toHaveLength(1);
    expect(ctx.roles.entries.at(-1)).toMatchObject({ action: "change_request.create", after: { supersedes: [first.requestId] } });

    // Погашенную подтвердить нельзя.
    const reviewer = await person(ctx, "200", "owner");
    expect(await codeOf(ctx.service.approve(reviewer, first.requestId, at(2 * HOUR)))).toBe("change_request_closed");

    const stale = await ctx.service.propose(author, proposal({ target: "gems_330", after: { stars: 310 } }), at(80 * HOUR));
    expect(ctx.repository.rows.get(aside.requestId)?.status).toBe("expired");
    expect(stale.status).toBe("pending");
  });

  it("цель изменилась между заявкой и подтверждением: 409, заявка superseded, правка не применена", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const view = await ctx.service.propose(author, proposal(), NOW);
    ctx.kind.prices.set("gems_60", 52);
    const failure = ctx.service.approve(reviewer, view.requestId, at(HOUR));
    expect(await codeOf(failure)).toBe("change_request_stale");
    expect(ctx.repository.rows.get(view.requestId)).toMatchObject({ status: "superseded", decidedBy: null });
    expect(ctx.kind.applied).toEqual([]);
    expect(ctx.kind.prices.get("gems_60")).toBe(52);
  });

  it("отклонить может любой другой с правом, отозвать — только автор; обе заявки закрываются как rejected", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const first = await ctx.service.propose(author, proposal(), NOW);
    const rejected = await ctx.service.reject(reviewer, first.requestId, at(HOUR));
    expect(rejected).toMatchObject({ status: "rejected", decidedBy: reviewer.accountId });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ actorAccountId: reviewer.accountId, action: "change_request.reject", target: first.requestId });

    const second = await ctx.service.propose(author, proposal({ after: { stars: 70 } }), at(2 * HOUR));
    expect(await codeOf(ctx.service.withdraw(reviewer, second.requestId, at(3 * HOUR)))).toBe("change_request_not_author");
    const withdrawn = await ctx.service.withdraw(author, second.requestId, at(3 * HOUR));
    expect(withdrawn).toMatchObject({ status: "rejected", decidedBy: author.accountId });
    expect(ctx.roles.entries.at(-1)).toMatchObject({ actorAccountId: author.accountId, action: "change_request.withdraw", target: second.requestId });
    expect(ctx.kind.applied).toEqual([]);
    expect(await codeOf(ctx.service.withdraw(author, second.requestId, at(4 * HOUR)))).toBe("change_request_closed");
    expect(await codeOf(ctx.service.approve(reviewer, randomUUID(), at(HOUR)))).toBe("change_request_not_found");
  });

  it("сбой уведомления не отменяет заявку", async () => {
    const ctx = setup();
    const failing = { requested: async () => Promise.reject(new Error("чат недоступен")) } as unknown as ChangeRequestsNotifier;
    const service = new ChangeRequestsService(ctx.repository, ctx.accounts, new RolesService(ctx.config, ctx.roles, ctx.accounts), new ChangeKindRegistry([ctx.kind]), failing);
    const author = await person(ctx, "100", "game_designer");
    const view = await service.propose(author, proposal(), NOW);
    expect(ctx.repository.rows.get(view.requestId)?.status).toBe("pending");
  });

  it("сбой журнала не отменяет подтверждение: цена применена", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const view = await ctx.service.propose(author, proposal(), NOW);
    ctx.roles.failAudit = true;
    expect((await ctx.service.approve(reviewer, view.requestId, at(HOUR))).status).toBe("approved");
    expect(ctx.kind.prices.get("gems_60")).toBe(60);
  });
});

describe("правка товара поверх каталога", () => {
  const starter = skuById("starter") as ShopSku;
  const gems60 = skuById("gems_60") as ShopSku;
  const gems330 = skuById("gems_330") as ShopSku;

  it("правятся цена в звёздах и в рублях, самоцветы состава, значок и порядок; id, вид и «один на аккаунт» — нет", () => {
    for (const field of [{ stars: 60 }, { baseRub: "99.50" }, { contents: { gems: 70 } }, { badge: "hit" }, { badge: null }, { sort: 25 }]) {
      expect(skuOverrideSchema.safeParse(field).success, JSON.stringify(field)).toBe(true);
    }
    for (const bad of [{ id: "x_gems" }, { kind: "bundle" }, { once: false }, { title: "Другое" }, { description: "Другое" }, { contents: { coins: 10 } }, { contents: { gems: 10, coins: 1 } }, {}]) {
      expect(skuOverrideSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("правка с stars: 0 отвергается схемой, как и дробная, отрицательная и выше потолка цена", () => {
    for (const stars of [0, -5, 1.5, 10_001, "60"]) expect(skuOverrideSchema.safeParse({ stars }).success, String(stars)).toBe(false);
    for (const gems of [0, -1, 2.5]) expect(skuOverrideSchema.safeParse({ contents: { gems } }).success, String(gems)).toBe(false);
    for (const baseRub of ["", "-1", "86,5", "86.555", "бесплатно"]) expect(skuOverrideSchema.safeParse({ baseRub }).success, baseRub).toBe(false);
    expect(skuOverrideSchema.safeParse({ badge: "best" }).success).toBe(false);
  });

  it("поверх каталога: незаданное — из кода, заданное — из правки, итог проходит схему товара", () => {
    const merged = applyOverride(gems60, { stars: 60, sort: 25 });
    expect(merged).toMatchObject({ id: "gems_60", kind: "gems", once: false, stars: 60, sort: 25, baseRub: gems60.baseRub, contents: gems60.contents });
    expect(shopSkuSchema.safeParse(merged).success).toBe(true);
    expect(applyOverride(gems60, undefined)).toBe(gems60);
    // «Хит» снимается значением null и ставится значением hit.
    expect(applyOverride(gems330, { badge: null })?.badge).toBeUndefined();
    expect(applyOverride(gems60, { badge: "hit" })?.badge).toBe("hit");
  });

  it("правка, не прошедшая схему целиком, товар не портит: null вместо товара", () => {
    expect(applyOverride(gems60, { stars: 0 } as never)).toBeNull();
    expect(applyOverride(gems60, { stars: 20_000 } as never)).toBeNull();
    expect(applyOverride(gems60, { contents: { gems: 1.5 } } as never)).toBeNull();
  });

  it("состав изменили — название и описание в окне оплаты пересобираются по новому числу, чтобы не обещать старое", () => {
    const changed = applyOverride(gems330, { contents: { gems: 360 } });
    expect(changed?.title).toBe("360 самоцветов");
    expect(changed?.description).toContain("360 самоцветов");
    expect(changed?.description).not.toContain("330");
    const startChanged = applyOverride(starter, { contents: { gems: 200 } });
    expect(startChanged?.title).toBe(starter.title);
    expect(startChanged?.description).toContain("200 самоцветов");
    expect(startChanged?.description).toContain("один раз");
    // Состав не менялся — тексты каталога остаются.
    expect(applyOverride(gems330, { stars: 240 })).toMatchObject({ title: gems330.title, description: gems330.description });
    expect(applyOverride(gems330, { contents: { gems: 330 } })).toMatchObject({ title: gems330.title, description: gems330.description });
    for (const sku of [changed, startChanged]) expect(shopSkuSchema.safeParse(sku).success).toBe(true);
  });

  it("витрина читает товары с правками: порядок каталога, битая правка пропускается, чужой товар не появляется", async () => {
    const overrides = new ShopOverrides({
      all: async () => [
        { skuId: "gems_60", fields: { stars: 60 }, setBy: randomUUID(), setAt: NOW },
        { skuId: "gems_330", fields: { stars: 0 }, setBy: randomUUID(), setAt: NOW },
        { skuId: "no_such_sku", fields: { stars: 5 }, setBy: randomUUID(), setAt: NOW },
      ],
    });
    const skus = await overrides.skus();
    expect(skus.map((sku) => sku.id)).toEqual(SHOP_SKUS.map((sku) => sku.id));
    expect(skus.find((sku) => sku.id === "gems_60")?.stars).toBe(60);
    expect(skus.find((sku) => sku.id === "gems_330")?.stars).toBe(gems330.stars);
    expect((await overrides.sku("gems_60"))?.stars).toBe(60);
    expect(await overrides.sku("no_such_sku")).toBeUndefined();
  });

  it("без правок витрина — это каталог в коде; после сброса кэша новая правка видна сразу", async () => {
    expect(await new ShopOverrides(NO_SHOP_OVERRIDES).skus()).toEqual([...SHOP_SKUS]);
    let rows: { skuId: string; fields: unknown; setBy: string; setAt: Date }[] = [];
    const overrides = new ShopOverrides({ all: async () => rows });
    expect((await overrides.sku("gems_60"))?.stars).toBe(50);
    rows = [{ skuId: "gems_60", fields: { stars: 65 }, setBy: randomUUID(), setAt: NOW }];
    // Кэш живёт доли минуты: пока он не сброшен, видна прежняя цена.
    expect((await overrides.sku("gems_60"))?.stars).toBe(50);
    overrides.invalidate();
    expect((await overrides.sku("gems_60"))?.stars).toBe(65);
  });
});

/** Транзакция для вида «цена товара»: только то, что он читает и пишет. */
function fakeTx(initial: { fields: unknown } | null = null) {
  const state = { row: initial, writes: [] as { fields: unknown; setBy: string }[] };
  const tx = {
    shopSkuOverride: {
      findUnique: async () => state.row,
      upsert: async (args: { create: { fields: unknown; setBy: string } }) => {
        state.row = { fields: args.create.fields };
        state.writes.push({ fields: args.create.fields, setBy: args.create.setBy });
      },
    },
  } as unknown as ChangeTx;
  return { tx, state };
}

describe("вид правки «цена товара»", () => {
  const kind = () => new SkuPriceKind(new ShopOverrides(NO_SHOP_OVERRIDES));
  const request = (patch: Partial<ChangeRequestRow> = {}): ChangeRequestRow => ({
    requestId: randomUUID(),
    kind: "sku_price",
    target: "gems_60",
    before: { stars: 50 },
    after: { stars: 60 },
    reason: "причина",
    author: randomUUID(),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    createdAt: NOW,
    ...patch,
  });

  it("право — sku.price.edit", () => {
    expect(kind().kind).toBe("sku_price");
    expect(kind().permission).toBe("sku.price.edit");
  });

  it("«было» берёт из каталога сам, а то, что не меняется, из заявки убирает", async () => {
    const { tx } = fakeTx();
    expect(await kind().prepare(tx, "gems_60", { stars: 60, sort: 20 })).toEqual({ before: { stars: 50 }, after: { stars: 60 } });
    expect(await kind().prepare(tx, "gems_330", { contents: { gems: 360 }, badge: null })).toEqual({
      before: { contents: { gems: 330 }, badge: "hit" },
      after: { contents: { gems: 360 }, badge: null },
    });
  });

  it("«было» учитывает уже применённую правку: поверх неё, а не поверх каталога", async () => {
    const { tx } = fakeTx({ fields: { stars: 55 } });
    expect(await kind().prepare(tx, "gems_60", { stars: 60 })).toEqual({ before: { stars: 55 }, after: { stars: 60 } });
  });

  it("отказы: цена 0, лишнее поле, неизвестный товар, ничего не меняется", async () => {
    const { tx } = fakeTx();
    expect(await codeOf(kind().prepare(tx, "gems_60", { stars: 0 }))).toBe("change_request_value_invalid");
    expect(await codeOf(kind().prepare(tx, "gems_60", { id: "x_other" }))).toBe("change_request_value_invalid");
    expect(await codeOf(kind().prepare(tx, "gems_60", { once: true }))).toBe("change_request_value_invalid");
    expect(await codeOf(kind().prepare(tx, "gems_60", {}))).toBe("change_request_value_invalid");
    expect(await codeOf(kind().prepare(tx, "gems_60", { stars: 50 }))).toBe("change_request_value_invalid");
    expect(await codeOf(kind().prepare(tx, "no_such_sku", { stars: 5 }))).toBe("shop_sku_not_found");
  });

  it("текст отказа называет поле и предел словами, а не кодом схемы", async () => {
    const { tx } = fakeTx();
    const message = async (after: unknown): Promise<string> => {
      try {
        await kind().prepare(tx, "gems_60", after);
      } catch (error: unknown) {
        if (error instanceof DomainError) return error.message;
      }
      return "";
    };
    expect(await message({ stars: 0 })).toMatch(/Цена в звёздах.*от 1 до 10 000/);
    expect(await message({ contents: { gems: 0 } })).toMatch(/Самоцветов в наборе/);
    expect(await message({ baseRub: "бесплатно" })).toMatch(/Цена в рублях/);
  });

  it("цель сейчас — те же поля, что в «было»: совпало — можно применять, разошлось — нет", async () => {
    const same = fakeTx();
    expect(sameJson(await kind().current(same.tx, request()), { stars: 50 })).toBe(true);
    const moved = fakeTx({ fields: { stars: 52 } });
    expect(sameJson(await kind().current(moved.tx, request()), { stars: 50 })).toBe(false);
    // Правка другого поля «было» не задевает.
    const other = fakeTx({ fields: { sort: 99 } });
    expect(sameJson(await kind().current(other.tx, request()), { stars: 50 })).toBe(true);
  });

  it("применение дописывает правку к сохранённой и ставит автора подтверждения", async () => {
    const { tx, state } = fakeTx({ fields: { sort: 99 } });
    const by = randomUUID();
    await kind().apply(tx, request(), by, NOW);
    expect(state.writes).toEqual([{ fields: { sort: 99, stars: 60 }, setBy: by }]);
    const fresh = fakeTx();
    await kind().apply(fresh.tx, request({ target: "gems_330", before: { contents: { gems: 330 } }, after: { contents: { gems: 360 } } }), by, NOW);
    expect(fresh.state.writes[0]?.fields).toEqual({ contents: { gems: 360 } });
  });

  it("строка для чата и журнала: название товара и «было → стало» словами", () => {
    expect(describeSkuChange("gems_60", { stars: 50 }, { stars: 60 })).toBe(`${gems60.title}: цена 50 → 60 ⭐`);
    const text = describeSkuChange("gems_330", { contents: { gems: 330 }, badge: "hit", sort: 30 }, { contents: { gems: 360 }, badge: null, sort: 35 });
    expect(text).toContain("самоцветов 330 → 360");
    expect(text).toContain("значок «Хит» → нет");
    expect(text).toContain("порядок 30 → 35");
    expect(describeSkuChange("gems_60", { baseRub: "86" }, { baseRub: "99" })).toContain("цена 86 → 99 ₽");
  });

  it("обзор для панели: что в коде, что сейчас и меняли ли", async () => {
    const overrides = new ShopOverrides({ all: async () => [{ skuId: "gems_60", fields: { stars: 60 }, setBy: randomUUID(), setAt: NOW }] });
    const targets = await new SkuPriceKind(overrides).targets();
    expect(targets.map((target) => target.target)).toEqual(SHOP_SKUS.map((sku) => sku.id));
    expect(targets.find((target) => target.target === "gems_60")).toMatchObject({
      title: gems60.title,
      current: { stars: 60, baseRub: gems60.baseRub, contents: { gems: 60 }, badge: null, sort: 20 },
      inCode: { stars: 50, baseRub: gems60.baseRub, contents: { gems: 60 }, badge: null, sort: 20 },
      overridden: true,
    });
    expect(targets.find((target) => target.target === "gems_330")).toMatchObject({ current: { badge: "hit" }, overridden: false });
  });
});

describe("уведомление о новой заявке", () => {
  function notifierSetup(options: { general?: boolean; deliverFails?: boolean; chatFails?: boolean } = {}) {
    const delivered: { accountIds: readonly string[]; kind: string; payload: unknown; dedupeKey: string }[] = [];
    const chat: { chatId: string; text: string }[] = [];
    const asked: { roles: readonly string[] }[] = [];
    const author = randomUUID();
    const peers = [randomUUID(), randomUUID(), author];
    const notifier = new ChangeRequestsNotifier(
      { peers: async (roles: readonly string[]) => (asked.push({ roles }), peers) } as unknown as ChangeRequestsRepository,
      {
        deliverMany: async (input: { accountIds: readonly string[]; kind: string; payload: unknown; dedupeKey: string }) => {
          if (options.deliverFails === true) throw new Error("лента недоступна");
          delivered.push(input);
          return input.accountIds.length;
        },
      } as unknown as NotificationsService,
      { chats: () => ({ general: options.general === false ? null : { chatId: "-1001", threadId: 7 } }) } as unknown as NotifyTargets,
      {
        for: () => ({
          sendToChat: async (target: { chatId: string }, text: string) => {
            if (options.chatFails === true) throw new Error("Telegram недоступен");
            chat.push({ chatId: target.chatId, text });
            return { status: "sent" as const };
          },
        }),
      } as unknown as Messengers,
      new ChangeKindRegistry([new FakeKind()]),
    );
    const view = {
      requestId: randomUUID(),
      kind: "sku_price" as const,
      target: "gems_60",
      before: { stars: 50 },
      after: { stars: 60 },
      reason: "Малый набор дешевле соседнего за штуку",
      author,
      authorName: "Аня",
      status: "pending" as const,
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      createdAt: NOW,
      expiresAt: at(72 * HOUR),
    };
    return { notifier, delivered, chat, asked, view, peers, author };
  }

  it("уведомление получают те, кто вправе подтвердить, кроме автора; ключ события — заявка, данные проходят схему вида", async () => {
    const { notifier, delivered, asked, view, peers } = notifierSetup();
    await notifier.requested(view);
    expect(asked[0]?.roles.slice().sort()).toEqual(["game_designer", "owner"]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: "change_request_pending", dedupeKey: `change_request:${view.requestId}` });
    expect(delivered[0]?.accountIds).toEqual([peers[0], peers[1]]);
    expect(NOTIFICATION_KINDS.change_request_pending.safeParse(delivered[0]?.payload).success).toBe(true);
    expect(delivered[0]?.payload).toEqual({ requestId: view.requestId, kind: "sku_price", target: "gems_60", authorName: "Аня" });
  });

  it("в чат админов уходит «было → стало», автор, причина и срок; адрес — общий чат, тема сохраняется", async () => {
    const { notifier, chat, view } = notifierSetup();
    await notifier.requested(view);
    expect(chat).toHaveLength(1);
    expect(chat[0]?.chatId).toBe("-1001");
    expect(chat[0]?.text).toContain("gems_60");
    expect(chat[0]?.text).toContain("Аня");
    expect(chat[0]?.text).toContain("Малый набор дешевле соседнего за штуку");
    expect(chat[0]?.text).toContain("72");
  });

  it("чат не задан — только лента; сбой ленты не мешает чату, сбой чата не бросает", async () => {
    const noChat = notifierSetup({ general: false });
    await noChat.notifier.requested(noChat.view);
    expect(noChat.delivered).toHaveLength(1);
    expect(noChat.chat).toEqual([]);

    const brokenFeed = notifierSetup({ deliverFails: true });
    await expect(brokenFeed.notifier.requested(brokenFeed.view)).resolves.toBeUndefined();
    expect(brokenFeed.chat).toHaveLength(1);

    const brokenChat = notifierSetup({ chatFails: true });
    await expect(brokenChat.notifier.requested(brokenChat.view)).resolves.toBeUndefined();
    expect(brokenChat.delivered).toHaveLength(1);
  });
});

describe("заявки по HTTP панели", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const ctx = setup(cfg);
    @Module({
      controllers: [AdminSessionController, AdminChangeRequestsController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: ROLES_REPOSITORY, useValue: ctx.roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: ChangeRequestsService, useValue: ctx.service },
        PanelLoginService,
        RateLimiter,
        RolesService,
        PermissionGuard,
        AuthGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const login = async (user: string) => {
      const response = await app!.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: user } });
      return `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(response.headers["set-cookie"]))?.[1] ?? ""}`;
    };
    return { ctx, login };
  }

  const headers = (cookie: string) => ({ cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });

  it("заявка, подтверждение другим, 409 на повтор; автор и без права — отказ; без заголовка панели — 403", async () => {
    const { ctx, login } = await start();
    const owner = headers(await login(`dev-${OWNER_ID}:Владелец`));
    const designer = headers(await login("dev-player-501:Геймдизайнер"));
    const moderator = headers(await login("dev-player-502:Модератор"));
    const designerAccount = await ctx.accounts.byPlatformUser("telegram", "dev-player-501");
    const moderatorAccount = await ctx.accounts.byPlatformUser("telegram", "dev-player-502");
    await ctx.roles.grant(designerAccount?.accountId ?? "", "game_designer", null);
    await ctx.roles.grant(moderatorAccount?.accountId ?? "", "moderator", null);
    const call = (method: "GET" | "POST", url: string, h: Record<string, string>, payload?: Record<string, unknown>) =>
      app!.inject({ method, url: `/api/v1/admin/change-requests${url}`, headers: h, ...(payload === undefined ? {} : { payload }) });

    expect((await call("POST", "", { cookie: designer.cookie }, proposal())).statusCode).toBe(403);
    expect((await call("POST", "", headers(moderator.cookie), proposal())).statusCode).toBe(403);
    expect((await call("POST", "", designer, proposal({ after: { stars: 0 } }))).statusCode).toBe(422);
    expect((await call("POST", "", designer, proposal({ reason: "" }))).statusCode).toBe(400);

    const created = await call("POST", "", designer, proposal());
    expect(created.statusCode).toBe(201);
    const { requestId } = created.json<{ data: { requestId: string } }>().data;

    expect((await call("POST", `/${requestId}/approve`, designer)).statusCode).toBe(403);
    expect((await call("POST", `/${requestId}/approve`, moderator)).statusCode).toBe(403);
    expect((await call("POST", "/не-uuid/approve", owner)).statusCode).toBe(400);
    expect((await call("POST", `/${randomUUID()}/approve`, owner)).statusCode).toBe(404);

    const overview = await call("GET", "", owner);
    expect(overview.statusCode).toBe(200);
    expect(overview.json<{ data: { requests: { requestId: string; status: string }[]; targets: Record<string, unknown[]> } }>().data.requests).toMatchObject([{ requestId, status: "pending" }]);

    const approved = await call("POST", `/${requestId}/approve`, owner);
    expect(approved.statusCode).toBe(201);
    expect(approved.json<{ data: { status: string; decidedBy: string } }>().data.status).toBe("approved");
    expect(ctx.kind.prices.get("gems_60")).toBe(60);
    expect((await call("POST", `/${requestId}/approve`, owner)).statusCode).toBe(409);
  });
});

/** Каждая запись каталога по умолчанию доступна правке — без перечня полей руками. */
describe("каталог и правки", () => {
  it("правки не затрагивают поля, которых нет в схеме правки", () => {
    const fields = Object.keys(skuOverrideSchema.shape).sort();
    expect(fields).toEqual(["badge", "baseRub", "contents", "sort", "stars"]);
  });
});
