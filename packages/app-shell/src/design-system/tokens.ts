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
  bg: "#0d0f14",
  surface: "#161a23",
  surfaceRaised: "#1e2430",
  border: "#2a3242",
  text: "#e7ecf5",
  textMuted: "#9aa6bd",
  textDisabled: "#5d6880",

  accent: "#6ee7a8",
  accentPressed: "#4cc98a",
  onAccent: "#07120c",

  danger: "#ff6b6b",
  warning: "#ffb347",
  success: "#6ee7a8",
  info: "#6bd5ff",

  hp: "#6ee7a8",
  hpLow: "#ff6b6b",
  xp: "#7ce7ff",
  elite: "#ffd36b",
  weapon: "#ffe066",
  passive: "#c06bff",
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
  border: "--color-border",
  text: "--color-text",
  textMuted: "--color-text-muted",
  textDisabled: "--color-text-disabled",
  accent: "--color-accent",
  accentPressed: "--color-accent-pressed",
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

/** Длительности переходов, мс. Совпадают с `--duration-*` в tokens.css. */
export const DURATION = {
  fast: 120,
  base: 200,
  slow: 300,
} as const;
