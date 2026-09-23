import { SetMetadata, type CustomDecorator } from "@nestjs/common";
import type { Permission } from "../modules/roles/permissions.js";

/**
 * Объявление доступа на маршруте (docs/29-admin-panel.md §3.4, «закрыто по
 * умолчанию»).
 *
 * Декораторы живут отдельно от гварда и ничего не тянут за собой: это просто
 * метаданные. Когда они лежали рядом с `PermissionGuard`, контроллер
 * здоровья через них подтягивал сервис ролей, репозиторий и клиент Prisma —
 * а ему нужна одна строчка «этот маршрут открыт».
 *
 * `@Public()` не значит «без защиты»: приёмники и плейтест проверяют подпись
 * запуска своими гвардами, вход защищён подписью и лимитом частоты, вебхук —
 * секретным токеном. Значит она ровно одно: решение принято осознанно, а не
 * забыто. Маршрут, не объявивший ничего, роняет
 * `backend/api/test/route-permissions.test.ts`.
 */

export const PERMISSION_METADATA = "rubezh:permission";
export const PUBLIC_METADATA = "rubezh:public";

export function RequirePermission(permission: Permission): CustomDecorator<string> {
  return SetMetadata(PERMISSION_METADATA, permission);
}

export function Public(): CustomDecorator<string> {
  return SetMetadata(PUBLIC_METADATA, true);
}
