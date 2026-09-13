/**
 * Те же токены числами — для всего, что не читает CSS.
 *
 * Канва Phaser и SDK площадки (цвет шапки, фона и нижней панели) берут цвета
 * отсюда, а не из стилей. Две копии без проверки разошлись бы на первой
 * правке палитры, поэтому `tokens.test.ts` разбирает `tokens.css` и сверяет
 * каждое значение (docs/27-design-system-and-app-shell.md §4.2).
 *
 * Палитра мира забега живёт в самом движке: `core-game` не импортирует
 * оболочку — направление зависимостей запрещает (§2). Здесь только то, что
 * рисует оболочка: HUD, полосы, слоты, цвета площадки.
 */
export const COLORS = {
  bg: "#07090e",
  surface: "#121622",
  surfaceRaised: "#1b2130",
  surfaceSunken: "#0b0e15",
  border: "#262e40",
  borderStrong: "#3a4560",
  text: "#f3f6fc",
  textMuted: "#a8b2c6",
  textDisabled: "#69738a",

  accent: "#ffb22e",
  accentPressed: "#f09a12",
  accentGlow: "#ffd27a",
  accentEdge: "#a85a06",
  onAccent: "#1d1102",

  danger: "#ff5d5d",
  warning: "#ff8c42",
  success: "#5fe3a1",
  info: "#5ccfff",

  hp: "#5fe3a1",
  hpLow: "#ff5d5d",
  xp: "#5ccfff",
  elite: "#ffd36b",
  weapon: "#ffe066",
  passive: "#c47dff",
} as const;

export type ColorToken = keyof typeof COLORS;

/**
 * Соответствие имени токена в TypeScript имени переменной в CSS. Держится
 * явным списком, а не преобразованием camelCase → kebab-case: преобразование
 * молча «починило» бы опечатку и тест перестал бы ловить расхождение.
 */
export const CSS_VAR_BY_COLOR: Record<ColorToken, string> = {
  bg: "--color-bg",
  surface: "--color-surface",
  surfaceRaised: "--color-surface-raised",
  surfaceSunken: "--color-surface-sunken",
  border: "--color-border",
  borderStrong: "--color-border-strong",
  text: "--color-text",
  textMuted: "--color-text-muted",
  textDisabled: "--color-text-disabled",
  accent: "--color-accent",
  accentPressed: "--color-accent-pressed",
  accentGlow: "--color-accent-glow",
  accentEdge: "--color-accent-edge",
  onAccent: "--color-on-accent",
  danger: "--color-danger",
  warning: "--color-warning",
  success: "--color-success",
  info: "--color-info",
  hp: "--color-hp",
  hpLow: "--color-hp-low",
  xp: "--color-xp",
  elite: "--color-elite",
  weapon: "--color-weapon",
  passive: "--color-passive",
};

/** Цвета площадки: шапка, фон и нижняя панель Telegram — из наших токенов. */
export const PLATFORM_COLORS = {
  header: COLORS.bg,
  background: COLORS.bg,
  bottomBar: COLORS.surface,
} as const;

/**
 * Имена гарнитур — первые в стеках `--font-display` и `--font-text`. Экран
 * загрузки дожидается именно их, чтобы главная не перескочила с системного
 * шрифта на свой у игрока на глазах.
 */
export const FONT_FAMILY = {
  display: "Rubik Variable",
  text: "Inter Variable",
} as const;

/** Длительности переходов, мс. Совпадают с `--duration-*` в tokens.css. */
export const DURATION = {
  fast: 120,
  base: 200,
  slow: 300,
} as const;
