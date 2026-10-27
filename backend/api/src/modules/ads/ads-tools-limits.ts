import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Лимиты проверки рекламы командой (tasks/T-0333). Бизнес-параметры: меняются
 * здесь, в карте конфигурации — docs/30-configuration-map.md.
 *
 * Лимит — по аккаунту. Каталог открывают при входе на экран проверки, исход
 * присылают после каждого показа; три сотни в час перекрывают живую проверку,
 * а скрипт, долбящий маршрут, упрётся сюда.
 */
export const ADS_TOOLS_LIMITS: Record<"catalog" | "result", RateLimit> = {
  catalog: { scope: "ads_tools_catalog", limit: 120, windowSec: 3600 },
  result: { scope: "ads_tools_result", limit: 300, windowSec: 3600 },
};
