import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSION_METADATA } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import type { Permission } from "./permissions.js";
import { RolesService } from "./roles.service.js";

/**
 * Проверка права на маршруте. Сами декораторы — в `common/access.ts`: они
 * метаданные и ничего не тянут за собой, а этот гвард тянет сервис ролей и
 * через него базу.
 *
 * Ставится **после** `AuthGuard`: аккаунт в запрос кладёт он, и без него
 * проверять права не у кого.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly roles: RolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.get<Permission | undefined>(PERMISSION_METADATA, context.getHandler());
    if (permission === undefined) return true;

    await this.roles.require(accountOf(context.switchToHttp().getRequest()), permission);
    return true;
  }
}
