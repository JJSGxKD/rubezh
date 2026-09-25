import { COLORS } from "@bh/design-tokens";

/**
 * Токены числами для оболочки игры. Базовые — палитра, гарнитуры,
 * длительности — в пакете `@bh/design-tokens`, общем с панелью; здесь —
 * только то, что нужно игре.
 */
export { COLORS, CSS_VAR_BY_COLOR, DURATION, FONT_FAMILY, type ColorToken } from "@bh/design-tokens";

/** Цвета площадки: шапка, фон и нижняя панель Telegram — из наших токенов. */
export const PLATFORM_COLORS = {
  header: COLORS.bg,
  background: COLORS.bg,
  bottomBar: COLORS.surface,
} as const;
