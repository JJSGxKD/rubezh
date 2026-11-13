import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanActivate, Controller, ExecutionContext, Get, Injectable, Module, UseGuards } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Public, RequirePermission } from "../src/common/access.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Причина внутренней ошибки на админских маршрутах (docs/35-stage4-plan.md,
 * Р193): видна только аккаунту с `diagnostics.view`. Охранник входа тут
 * подмена — он берёт аккаунт из заголовка; охранник прав и сервис ролей —
 * те же, что в проде.
 */

const SECRET_REASON = "relation proxies does not exist";

@Injectable()
class HeaderAccountGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; account?: unknown }>();
    request.account = { accountId: request.headers["x-test-account"], platform: "telegram", platformUserId: "1" };
    return true;
  }
}

@Controller("admin/boom")
@UseGuards(HeaderAccountGuard, PermissionGuard)
class AdminBoomController {
  @Get()
  @RequirePermission("players.view")
  boom(): never {
    throw new Error(`${SECRET_REASON}\n    at query (db.ts:1:1)`);
  }

  @Get("closed")
  @RequirePermission("secrets.edit")
  closed(): never {
    throw new Error("до сюда дойти нельзя");
  }
}

@Controller("boom")
class GameBoomController {
  @Get()
  @Public()
  boom(): never {
    throw new Error(SECRET_REASON);
  }
}

describe("причина внутренней ошибки в панели", () => {
  const roles = new MemoryRolesRepository();
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
    @Module({
      controllers: [AdminBoomController, GameBoomController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ACCOUNT_REPOSITORY, useValue: new MemoryAccountRepository() },
        RolesService,
        HeaderAccountGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function accountWith(role: Role): Promise<string> {
    const accountId = randomUUID();
    await roles.grant(accountId, role, null);
    return accountId;
  }

  it("отдаёт причину аккаунту с diagnostics.view", async () => {
    const accountId = await accountWith("owner");
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/boom", headers: { "x-test-account": accountId } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "internal_error", message: "Внутренняя ошибка сервера", requestId: response.headers["x-request-id"], reason: SECRET_REASON },
    });
  });

  it("не отдаёт причину роли без diagnostics.view, но номер отдаёт", async () => {
    const accountId = await accountWith("moderator");
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/boom", headers: { "x-test-account": accountId } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "internal_error", message: "Внутренняя ошибка сервера", requestId: response.headers["x-request-id"] },
    });
    expect(response.body).not.toContain(SECRET_REASON);
  });

  it("не отдаёт причину на игровом маршруте", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/boom" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(SECRET_REASON);
    expect(response.json()).toMatchObject({ error: { requestId: response.headers["x-request-id"] } });
  });

  it("отказ охранника прав прежний: 403 с тем же текстом и без причины", async () => {
    const accountId = await accountWith("moderator");
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/boom/closed", headers: { "x-test-account": accountId } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "forbidden", message: "Недостаточно прав", requestId: response.headers["x-request-id"] },
    });
  });
});
