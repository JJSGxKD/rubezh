import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSION_METADATA } from "../../common/access.js";
import { ForbiddenError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import type { Permission } from "./permissions.js";
import { RolesService } from "./roles.service.js";

/** Минимальная форма запроса вместо типов Fastify — см. domain-error.filter.ts. */
interface PermissionRequest {
  adminPermissions?: ReadonlySet<Permission>;
}

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

    const request = context.switchToHttp().getRequest<PermissionRequest>();
    const permissions = await this.roles.permissions(accountOf(request));
    if (!permissions.has(permission)) {
      // Что именно закрыто, знать необязательно: сообщение не описывает
      // внутреннее устройство (docs/15-engineering-standards.md §7).
      throw new ForbiddenError("Недостаточно прав");
    }
    // Фильтр ошибок читает права отсюда и в базу на пути ошибки не ходит:
    // упала база до охранника — прав в запросе нет, причина не отдаётся.
    request.adminPermissions = permissions;
    return true;
  }
}
