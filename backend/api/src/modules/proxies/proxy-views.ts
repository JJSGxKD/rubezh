import type { OutboundMode } from "../../infra/outbound/outbound-route.js";
import type { ProxyScheme } from "./proxies-rules.js";
import { hasPassword } from "./proxy-password.js";
import type { StoredProxy } from "./proxies.repository.js";

/** Прокси в ответе панели. Пароль не возвращается никогда: только «задан» и «не читается». */
export interface ProxyView {
  proxyId: string;
  name: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  username: string | null;
  passwordSet: boolean;
  /** пароль зашифрован другим ключом: прокси не работает, пока пароль не задан заново */
  passwordUnreadable: boolean;
  country: string;
  enabled: boolean;
  priority: number;
  note: string | null;
  lastCheck: { at: string; ok: boolean; note: string | null } | null;
  updatedBy: string;
  updatedAt: string;
}

export interface ProxiesView {
  /** можно ли сохранять пароли: есть ключ шифрования и база */
  enabled: boolean;
  proxies: ProxyView[];
}

export interface ModeView {
  service: string;
  mode: OutboundMode;
  default: OutboundMode;
  /** режим задан в панели, а не взят по умолчанию */
  custom: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface CheckView {
  ok: boolean;
  message: string;
  proxy: ProxyView;
}

export function proxyView(row: StoredProxy, readable: boolean): ProxyView {
  return {
    proxyId: row.proxyId,
    name: row.name,
    scheme: row.scheme,
    host: row.host,
    port: row.port,
    username: row.username,
    passwordSet: hasPassword(row),
    passwordUnreadable: !readable,
    country: row.country,
    enabled: row.enabled,
    priority: row.priority,
    note: row.note,
    lastCheck: row.lastCheckAt === null || row.lastCheckOk === null ? null : { at: row.lastCheckAt.toISOString(), ok: row.lastCheckOk, note: row.lastCheckNote },
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Прокси в аудите: название и адрес, признак пароля вместо пароля
 * (docs/35-stage4-plan.md Р91). Название — чтобы журнал читался и после
 * удаления строки.
 */
export function proxyAudit(row: StoredProxy): Record<string, unknown> {
  return { name: row.name, scheme: row.scheme, host: row.host, port: row.port, username: row.username, passwordSet: hasPassword(row), country: row.country, enabled: row.enabled, priority: row.priority, note: row.note };
}
