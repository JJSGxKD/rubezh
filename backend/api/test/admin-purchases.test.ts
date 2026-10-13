import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminPurchasesController } from "../src/modules/admin/admin-purchases.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PurchaseActionUnavailableError } from "../src/modules/payments/payments-errors.js";
import { PurchaseSupport, type SupportResult } from "../src/modules/payments/purchase-support.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Маршруты поддержки покупок по HTTP (tasks/T-0037): вернуть звёзды и повторить
 * выдачу. Сервис — подмена: проверяется путь запроса до него — права,
 * разбор адреса и тела, код ошибки в ответе.
 */

const OWNER_ID = "777000111";
const NOW = new Date(Date.UTC(2026, 9, 7, 12));
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);

interface Call {
  method: "refund" | "fulfill";
  actor: AccountRef;
  accountId: string;
  purchaseId: string;
  note: string;
}

function purchaseOf(accountId: string, purchaseId: string): StoredPurchase {
  return {
    purchaseId,
    accountId,
    product: "shop_item",
    runId: null,
    continueNo: null,
    elapsedSec: null,
    sku: "starter_pack",
    priceStars: 50,
    chargedStars: 50,
    mode: "live",
    status: "paid",
    telegramChargeId: "charge-1",
    invoicedAt: NOW,
    paidAt: NOW,
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: null,
    renewalOf: null,
  };
}

describe("поддержка покупок в панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  let calls: Call[];
  let failWith: Error | null;
  let accounts: MemoryAccountRepository;
  let roles: MemoryRolesRepository;
  const accountId = randomUUID();
  const purchaseId = randomUUID();

  beforeEach(async () => {
    calls = [];
    failWith = null;
    accounts = new MemoryAccountRepository();
    roles = new MemoryRolesRepository();
    const store = new MemoryAdminSessionStore();
    const support = {
      refund: async (actor: AccountRef, forAccount: string, forPurchase: string, note: string): Promise<SupportResult> => {
        calls.push({ method: "refund", actor, accountId: forAccount, purchaseId: forPurchase, note });
        if (failWith !== null) throw failWith;
        return { purchase: { ...purchaseOf(forAccount, forPurchase), refundReason: "manual", refundRequestedAt: NOW }, actions: [] };
      },
      fulfill: async (actor: AccountRef, forAccount: string, forPurchase: string, note: string): Promise<SupportResult> => {
        calls.push({ method: "fulfill", actor, accountId: forAccount, purchaseId: forPurchase, note });
        if (failWith !== null) throw failWith;
        return { purchase: { ...purchaseOf(forAccount, forPurchase), fulfilledAt: NOW }, actions: ["refund"] };
      },
    };

    @Module({
      controllers: [AdminPurchasesController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PurchaseSupport, useValue: support },
        RateLimiter,
        RolesService,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    for (const [token, id, role] of [
      ["adm", "700001", "admin"],
      ["mod", "700002", "moderator"],
    ] as const) {
      const account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Человек ${id}`, username: null, photoUrl: null }, NOW.getTime());
      await roles.grant(account.accountId, role, null);
      await store.put(hashSessionToken(token), { accountId: account.accountId, platform: "telegram", platformUserId: id, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    }
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function server(): NestFastifyApplication {
    if (app === null) throw new Error("приложение не поднято");
    return app;
  }

  const headersOf = (token: string) => ({ cookie: `${ADMIN_SESSION_COOKIE}=${token}`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });
  const urlOf = (action: "refund" | "fulfill", forAccount = accountId, forPurchase = purchaseId) => `/api/v1/admin/players/${forAccount}/purchases/${forPurchase}/${action}`;

  it.each([["refund" as const], ["fulfill" as const]])("админ, %s: 200 и { data: { purchase, actions } }; сервис получил причину без пробелов по краям", async (action) => {
    const response = await server().inject({ method: "POST", url: urlOf(action), headers: headersOf("adm"), payload: { note: "  Игрок написал в поддержку  " } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: SupportResult & { purchase: { purchaseId: string } } };
    expect(body.data.purchase.purchaseId).toBe(purchaseId);
    expect(body.data.actions).toEqual(action === "refund" ? [] : ["refund"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: action, accountId, purchaseId, note: "Игрок написал в поддержку" });
    expect(calls[0]?.actor.platformUserId).toBe("700001");
  });

  it.each([["refund" as const], ["fulfill" as const]])("модератор, %s: 403, сервис не зовётся", async (action) => {
    const response = await server().inject({ method: "POST", url: urlOf(action), headers: headersOf("mod"), payload: { note: "Игрок написал" } });

    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it("без сессии — 401, сервис не зовётся", async () => {
    const response = await server().inject({ method: "POST", url: urlOf("refund"), payload: { note: "Игрок написал" } });

    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([
    ["нет тела", undefined],
    ["нет причины", {}],
    ["причина из двух знаков", { note: "ок" }],
    ["причина из пробелов", { note: "     " }],
    ["причина длиннее двухсот знаков", { note: "я".repeat(201) }],
    ["причина не строка", { note: 12345 }],
  ] as const)("%s — 400 «Укажите причину: от 3 до 200 символов»", async (_name, payload) => {
    const response = await server().inject({ method: "POST", url: urlOf("refund"), headers: headersOf("adm"), ...(payload === undefined ? {} : { payload }) });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("Укажите причину: от 3 до 200 символов");
    expect(calls).toEqual([]);
  });

  it("причина ровно из трёх и ровно из двухсот знаков проходит", async () => {
    const short = await server().inject({ method: "POST", url: urlOf("refund"), headers: headersOf("adm"), payload: { note: "три" } });
    const long = await server().inject({ method: "POST", url: urlOf("fulfill"), headers: headersOf("adm"), payload: { note: "я".repeat(200) } });

    expect(short.statusCode).toBe(200);
    expect(long.statusCode).toBe(200);
  });

  it("purchaseId не UUID — 400 «Некорректный идентификатор покупки»; accountId не UUID — «Некорректный идентификатор аккаунта»", async () => {
    const badPurchase = await server().inject({ method: "POST", url: urlOf("refund", accountId, "not-a-uuid"), headers: headersOf("adm"), payload: { note: "Игрок написал" } });
    const badAccount = await server().inject({ method: "POST", url: urlOf("fulfill", "not-a-uuid", purchaseId), headers: headersOf("adm"), payload: { note: "Игрок написал" } });

    expect(badPurchase.statusCode).toBe(400);
    expect(badPurchase.json().error.message).toBe("Некорректный идентификатор покупки");
    expect(badAccount.statusCode).toBe(400);
    expect(badAccount.json().error.message).toBe("Некорректный идентификатор аккаунта");
    expect(calls).toEqual([]);
  });

  it("ошибка сервиса PurchaseActionUnavailableError — 409 с её кодом и текстом", async () => {
    failWith = new PurchaseActionUnavailableError("Возврат уже заказан — звёзды в пути");

    const response = await server().inject({ method: "POST", url: urlOf("refund"), headers: headersOf("adm"), payload: { note: "Игрок написал" } });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "purchase_action_unavailable", message: "Возврат уже заказан — звёзды в пути" });
  });
});
