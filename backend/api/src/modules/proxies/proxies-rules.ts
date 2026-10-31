import { isIP } from "node:net";

/**
 * Правила полей прокси (docs/35-stage4-plan.md Р91, tasks/T-0065). Одни и те
 * же для формы панели (Zod в контроллере) и для сервиса: что не проходит здесь,
 * в базу не попадёт; длины колонок и CHECK в миграции — вторая линия.
 */

export const PROXY_SCHEMES = ["http", "https", "socks5"] as const;
export type ProxyScheme = (typeof PROXY_SCHEMES)[number];

export const PROXY_LIMITS = {
  nameMax: 60,
  hostMax: 255,
  usernameMax: 128,
  passwordMax: 256,
  noteMax: 200,
  priorityMax: 10_000,
  /** шаг, которым новый прокси встаёт в конец порядка: между соседями остаётся место */
  prioritySpacing: 10,
  /** прокси на сервере немного; предел держит список читаемым и перебор — коротким */
  countMax: 50,
} as const;

/** ISO-код страны из двух заглавных букв — вводится руками, справочника нет. */
export const PROXY_COUNTRY = /^[A-Z]{2}$/;

/** Одна метка имени: буквы, цифры, дефис и подчёркивание (имена контейнеров бывают с ним). */
const HOST_LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;

/** Домен, имя сервиса сети контейнеров («tunnel») или IP — без схемы, пути и порта. */
export function isProxyHost(value: string): boolean {
  if (value.length === 0 || value.length > PROXY_LIMITS.hostMax) return false;
  if (isIP(value) !== 0) return true;
  return value.split(".").every((label) => HOST_LABEL.test(label));
}
