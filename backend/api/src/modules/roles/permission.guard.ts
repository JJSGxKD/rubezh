import { CanActivate, ExecutionContext, Injectable, SetMetadata, type CustomDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { accountOf } from "../auth/auth.guard.js";
import type { Permission } from "./permissions.js";
import { RolesService } from "./roles.service.js";

/**
 * Право на эндпоинте (docs/29-admin-panel.md §3.4, «закрыто по умолчанию»).
 *
 * Каждый маршрут объявляет либо требуемое право, либо явную публичность.
 * Маршрут, не объявивший ничего, — не «забыли», а падающий тест
 * (`backend/api/test/route-permissions.test.ts`): забытая проверка тихо
 * открывает эндпоинт, и заметить это по коду невозможно.
 *
 * `@Public()` не значит «без защиты»: приёмники телеметрии и плейтеста
 * проверяют подпись запуска своими гвардами, а вход и здоровье открыты по
 * сути. Значит она ровно одно — решение принято осознанно.
 */

export const PERMISSION_METADATA = "rubezh:permission";
export const PUBLIC_METADATA = "rubezh:public";

export function RequirePermission(permission: Permission): CustomDecorator<string> {
  return SetMetadata(PERMISSION_METADATA, permission);
}

export function Public(): CustomDecorator<string> {
  return SetMetadata(PUBLIC_METADATA, true);
}

/**
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
