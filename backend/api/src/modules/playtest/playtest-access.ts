import type { AppConfig } from "../../config/app-config.js";
import type { RolesService } from "../roles/roles.service.js";
import type { TelegramPlayer } from "../telegram/telegram-init-data.js";

/**
 * Что игроку открыто в клиенте (docs/26-stage2-plan.md, WP14).
 *
 * Доступ решает **право `tools.dev`**, а не список Telegram ID: список
 * остался только аварийным путём внутри ролей — он действует, пока в системе
 * нет ни одного владельца (docs/34-stage3-plan.md, WP2).
 *
 * Скрытая кнопка — не защита, поэтому то, что влияет на чужие данные
 * (забег с читами в рейтинге), сервер проверяет сам, а не верит этому ответу.
 *
 * - **стресс-тест** — всем, пока идёт плейтест: он нагружает только
 *   устройство того, кто его запустил (docs/28-diagnostics.md §2.3);
 * - **режим разработчика** — по праву; при локальной разработке без Telegram
 *   администратор каждый, кто вошёл заголовком разработчика.
 */
export interface PlaytestAccess {
  admin: boolean;
  stressTest: boolean;
  devMode: boolean;
}

export async function accessFor(player: TelegramPlayer, config: AppConfig, roles: RolesService): Promise<PlaytestAccess> {
  const admin = await isAdmin(player, config, roles);
  return { admin, stressTest: config.playtest.enabled || admin, devMode: admin };
}

export async function isAdmin(player: TelegramPlayer, config: AppConfig, roles: RolesService): Promise<boolean> {
  // Вход заголовком разработчика бывает только на машине разработчика: бэкенд
  // с ним вне development не стартует.
  if (config.playtest.devAuth && player.id.startsWith("dev-")) return true;
  return await roles.canByPlatformUser("telegram", player.id, "tools.dev");
}
