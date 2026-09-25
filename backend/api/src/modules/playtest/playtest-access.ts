import type { AppConfig } from "../../config/app-config.js";
import type { AccountRef, RolesService } from "../roles/roles.service.js";

/**
 * Что игроку открыто в клиенте (docs/26-stage2-plan.md, WP14).
 *
 * Доступ решает **право `tools.dev`** аккаунта. Скрытая кнопка — не защита,
 * поэтому то, что влияет на чужие данные (забег с читами в рейтинге), сервер
 * проверяет сам, а не верит этому ответу.
 *
 * - **стресс-тест** — всем, пока идёт плейтест: он нагружает только
 *   устройство того, кто его запустил (docs/28-diagnostics.md §2.3);
 * - **режим разработчика** — по праву. Вход разработчика на своей машине
 *   (`AUTH_DEV_LOGIN`) даёт роль владельца, а с ней и это право.
 */
export interface PlaytestAccess {
  admin: boolean;
  stressTest: boolean;
  devMode: boolean;
}

export async function accessFor(account: AccountRef, config: AppConfig, roles: RolesService): Promise<PlaytestAccess> {
  const admin = await roles.can(account, "tools.dev");
  return { admin, stressTest: config.playtest.enabled || admin, devMode: admin };
}
