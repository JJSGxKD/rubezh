import type { AppConfig } from "../../config/app-config";
import type { TelegramPlayer } from "./telegram-init-data";

/**
 * Что игроку открыто в клиенте (docs/26-stage2-plan.md, WP14).
 *
 * Ролей в базе пока нет: администратор — Telegram ID из `ADMIN_TELEGRAM_IDS`.
 * Скрытая кнопка — не защита, поэтому то, что влияет на чужие данные
 * (забег с читами в рейтинге), сервер проверяет сам, а не верит этому ответу.
 *
 * - **стресс-тест** — всем, пока идёт плейтест: он нагружает только
 *   устройство того, кто его запустил (docs/28-diagnostics.md §2.3);
 * - **режим разработчика** — администраторам; при локальной разработке
 *   без Telegram администратор каждый, кто вошёл заголовком разработчика.
 */
export interface PlaytestAccess {
  admin: boolean;
  stressTest: boolean;
  devMode: boolean;
}

export function accessFor(player: TelegramPlayer, config: AppConfig): PlaytestAccess {
  const admin = isAdmin(player, config);
  return { admin, stressTest: config.playtest.enabled || admin, devMode: admin };
}

export function isAdmin(player: TelegramPlayer, config: AppConfig): boolean {
  if (config.adminTelegramIds.has(player.id)) return true;
  return config.playtest.devAuth && player.id.startsWith("dev-");
}
