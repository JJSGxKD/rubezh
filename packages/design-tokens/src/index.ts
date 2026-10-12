/**
 * Те же токены числами — для всего, что не читает CSS.
 *
 * Канва Phaser, SDK площадки (цвет шапки, фона и нижней панели) и графики
 * панели берут цвета отсюда, а не из стилей. Две копии без проверки разошлись
 * бы на первой правке палитры, поэтому `test/tokens.test.ts` разбирает
 * `tokens.css` и сверяет каждое значение (docs/27-design-system-and-app-shell.md §4.2).
 *
 * Палитра мира забега живёт в самом движке: `core-game` не импортирует
 * оболочку — направление зависимостей запрещает (§2). Здесь только то, что
 * рисует оболочка: HUD, полосы, слоты, цвета площадки.
 */
export const COLORS = {
  bg: "#1d1c31",
  surface: "#28273f",
  surfaceRaised: "#353452",
  surfaceSunken: "#17162a",
  border: "#43425f",
  borderStrong: "#5b5980",
  text: "#f3eee6",
  textMuted: "#aeaac4",
  textDisabled: "#6f6c8a",

  accent: "#ff8f3f",
  accentPressed: "#f0782a",
  accentGlow: "#ffb67f",
  accentEdge: "#a0582a",
  onAccent: "#230f02",
  secondary: "#46d9c6",
  onSecondary: "#062b26",

  danger: "#ff5d5d",
  warning: "#ffc14d",
  success: "#8ee86b",
  info: "#5ccfff",

  hp: "#ff6f90",
  hpLow: "#ff3b5c",
  xp: "#b6ff4a",
  elite: "#ffd15c",
  weapon: "#ffe066",
  passive: "#c47dff",

  stars: "#ffd000",
  onStars: "#2a1f00",

  coinHi: "#fff16a",
  coin: "#ffd400",
  coinLo: "#ff9f00",
  gemHi: "#ffc9cc",
  gemLight: "#ff8891",
  gem: "#ff515e",
  gemLo: "#f0303e",
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
  secondary: "--color-secondary",
  onSecondary: "--color-on-secondary",
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
  stars: "--color-stars",
  onStars: "--color-on-stars",
  coinHi: "--color-coin-hi",
  coin: "--color-coin",
  coinLo: "--color-coin-lo",
  gemHi: "--color-gem-hi",
  gemLight: "--color-gem-light",
  gem: "--color-gem",
  gemLo: "--color-gem-lo",
};

/**
 * Имена гарнитур — первые в стеках `--font-display` и `--font-text`. Экран
 * загрузки дожидается именно их, чтобы главная не перескочила с системного
 * шрифта на свой у игрока на глазах.
 */
export const FONT_FAMILY = {
  display: "Russo One",
  text: "IBM Plex Sans Variable",
} as const;

/** Длительности переходов, мс. Совпадают с `--duration-*` в tokens.css. */
export const DURATION = {
  fast: 120,
  base: 200,
  slow: 300,
} as const;
