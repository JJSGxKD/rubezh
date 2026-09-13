import ru from "./ru.json";

/**
 * Тексты интерфейса — только ключами (docs/01-tech-stack.md §7). Своя функция
 * вместо библиотеки: нужен один язык, подстановка и множественное число, а
 * библиотека i18n весит больше, чем весь этот файл
 * (docs/16-tech-stack-decisions.md §3.1).
 *
 * Множественное число — через `Intl.PluralRules`, а не конкатенацией: «1
 * волна / 2 волны / 5 волн» руками не собирается, а в русском категорий три.
 */

const DICTIONARY: Record<string, string> = ru;
const LOCALE = "ru-RU";
const pluralRules = new Intl.PluralRules(LOCALE);

export type TranslationParams = Record<string, string | number>;

/**
 * Перевод по ключу. Неизвестный ключ возвращается как есть: в интерфейсе он
 * бросается в глаза, и это лучше пустой строки, за которой не видно ошибки.
 */
export function t(key: string, params: TranslationParams = {}): string {
  const template = DICTIONARY[key];
  if (template === undefined) return key;
  return format(template, params);
}

/** Есть ли такой ключ — нужно тем экранам, где текст необязателен. */
export function hasTranslation(key: string): boolean {
  return DICTIONARY[key] !== undefined;
}

// Формы содержат вложенные фигурные скобки, поэтому один лишь `[^}]` не
// годится: он съедает открывающую скобку первой формы и обрывает разбор на ней.
const PLURAL_PATTERN = /\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g;
const FORM_PATTERN = /(\w+)\s*\{([^}]*)\}/g;
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

function format(template: string, params: TranslationParams): string {
  // Сначала множественное число: его формы сами содержат подстановки.
  const withPlurals = template.replace(PLURAL_PATTERN, (whole, name: string, forms: string) => {
    const value = params[name];
    if (typeof value !== "number") return whole;
    return pickForm(forms, value);
  });

  return withPlurals.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

function pickForm(forms: string, value: number): string {
  const category = pluralRules.select(value);
  const byCategory = new Map<string, string>();

  for (const match of forms.matchAll(FORM_PATTERN)) {
    byCategory.set(match[1], match[2]);
  }
  return byCategory.get(category) ?? byCategory.get("other") ?? "";
}

/**
 * Время выживания как «минуты:секунды». Отрицательное и NaN приходят только
 * из битого хранилища, но показывать игроку «NaN:aN» нельзя.
 */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}

/** Числа — через Intl: разряды и минус выглядят по-русски, а не по-английски. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(Math.round(value));
}

/** Дробное число без хвоста нулей: 0,28 и 7, а не 0,280 и 7,00. */
export function formatDecimal(value: number, maxFractionDigits = 2): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: maxFractionDigits }).format(value);
}
