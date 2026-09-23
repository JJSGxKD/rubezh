import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z, ZodError } from "zod";
import { ValidationError } from "../../common/domain-error.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { Inject } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { PermissionGuard } from "./permission.guard.js";
import { ROLES, isRole, permissionsOf, type Permission, type Role } from "./permissions.js";
import { ROLES_REPOSITORY, type RolesRepository } from "./roles.repository.js";
import { RolesService } from "./roles.service.js";

/**
 * Роли и журнал (docs/34-stage3-plan.md, WP2). Интерфейса у панели пока нет —
 * это её будущий бэкенд, а сейчас точка, через которую владелец раздаёт роли
 * команде.
 *
 * Аккаунт называется либо своим идентификатором, либо идентификатором на
 * площадке: пока нет списка игроков, найти человека можно только по его
 * Telegram ID, и требовать uuid означало бы, что выдать роль нечем.
 */

const targetSchema = z
  .object({
    accountId: z.string().uuid().optional(),
    platformUserId: z.string().min(1).max(32).optional(),
    platform: z.enum(["telegram", "max", "vk", "web"]).default("telegram"),
    role: z.string().refine(isRole, { message: `роль — одна из: ${ROLES.join(", ")}` }),
  })
  .refine((value) => value.accountId !== undefined || value.platformUserId !== undefined, {
    message: "нужен accountId или platformUserId",
  });

const auditQuerySchema = z.coerce.number().int().min(1).max(200).default(50);

@Controller("roles")
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(ROLES_REPOSITORY) private readonly repository: RolesRepository,
  ) {}

  /** Что может сам спрашивающий. Своё — всегда, права на это не нужно. */
  @Get("me")
  @UseGuards(AuthGuard)
  async me(@Req() request: unknown): Promise<{ data: { roles: Role[]; permissions: Permission[] } }> {
    const roles = await this.roles.rolesFor(accountOf(request));
    return { data: { roles, permissions: [...permissionsOf(roles)] } };
  }

  @Post("grant")
  @UseGuards(AuthGuard, PermissionGuard)
  @RequirePermission("roles.assign")
  async grant(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { granted: boolean } }> {
    const { accountId, role } = await this.resolve(body);
    return { data: { granted: await this.roles.grant(accountOf(request), accountId, role) } };
  }

  @Post("revoke")
  @UseGuards(AuthGuard, PermissionGuard)
  @RequirePermission("roles.assign")
  async revoke(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { revoked: boolean } }> {
    const { accountId, role } = await this.resolve(body);
    return { data: { revoked: await this.roles.revoke(accountOf(request), accountId, role) } };
  }

  @Get("audit")
  @UseGuards(AuthGuard, PermissionGuard)
  @RequirePermission("audit.view")
  async audit(@Query("limit") limit?: string): Promise<{ data: { entries: unknown[] } }> {
    const parsed = parse(() => auditQuerySchema.parse(limit ?? undefined), "Некорректный предел");
    return { data: { entries: await this.repository.recentAudit(parsed) } };
  }

  private async resolve(body: unknown): Promise<{ accountId: string; role: Role }> {
    const target = parse(() => targetSchema.parse(body), "Некорректная цель");
    const role = target.role as Role;

    if (target.accountId !== undefined) return { accountId: target.accountId, role };

    const account = await this.accounts.byPlatformUser(target.platform, target.platformUserId ?? "");
    // Аккаунт заводится первым входом в игру: пока человек не открыл
    // приложение, выдавать роль некому, и молчать об этом нельзя.
    if (account === null) throw new ValidationError("Аккаунт не найден — пусть сначала откроет игру");
    return { accountId: account.accountId, role };
  }
}

function parse<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new ValidationError(message);
    throw error;
  }
}
