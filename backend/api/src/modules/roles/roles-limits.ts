import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Лимиты «своих ролей» и доступа к инструментам (tasks/T-0022). Бизнес-
 * параметры: меняются здесь, в карте конфигурации — docs/30-configuration-map.md.
 *
 * Лимит — по аккаунту. Клиент спрашивает доступ к инструментам один раз при
 * запуске, «свои роли» — инструменты команды; сто двадцать в час с запасом
 * перекрывают живого игрока, а скрипт, долбящий маршрут, упрётся сюда.
 */
export const ROLES_LIMITS: Record<"me" | "toolsAccess", RateLimit> = {
  me: { scope: "roles:me", limit: 120, windowSec: 3600 },
  toolsAccess: { scope: "tools:access", limit: 120, windowSec: 3600 },
};
