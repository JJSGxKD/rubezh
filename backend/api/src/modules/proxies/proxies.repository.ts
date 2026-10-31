import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PROXY_SCHEMES, type ProxyScheme } from "./proxies-rules.js";

/**
 * Прокси и режимы сервисов в базе (`outbound_proxy`, `outbound_service_mode`,
 * docs/35-stage4-plan.md Р91). Запрос к базе живёт здесь, а не в сервисе
 * (docs/15-engineering-standards.md §2.3). Прокси читаются целиком: их единицы.
 */

export interface StoredProxy {
  proxyId: string;
  name: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  username: string | null;
  passwordIv: Uint8Array | null;
  passwordTag: Uint8Array | null;
  passwordCt: Uint8Array | null;
  passwordKeyId: string | null;
  country: string;
  enabled: boolean;
  priority: number;
  note: string | null;
  lastCheckAt: Date | null;
  lastCheckOk: boolean | null;
  lastCheckNote: string | null;
  updatedBy: string;
  updatedAt: Date;
}

/** Строка режима как в базе: значение разбирает тот, кто читает, — незнакомое он пропускает. */
export interface StoredMode {
  service: string;
  mode: string;
  updatedBy: string;
  updatedAt: Date;
}

export interface ProxyCheck {
  at: Date;
  ok: boolean;
  note: string;
}

export const PROXIES_REPOSITORY = Symbol("PROXIES_REPOSITORY");

export interface ProxiesRepository {
  /** все прокси: по порядку перебора, затем по названию */
  list(): Promise<StoredProxy[]>;
  find(proxyId: string): Promise<StoredProxy | null>;
  insert(row: StoredProxy): Promise<void>;
  /** `false` — такого прокси нет */
  replace(row: StoredProxy): Promise<boolean>;
  /** строка после записи итога проверки; `null` — прокси нет */
  saveCheck(proxyId: string, check: ProxyCheck): Promise<StoredProxy | null>;
  modes(): Promise<StoredMode[]>;
  saveMode(row: StoredMode): Promise<void>;
}

const isScheme = (value: string): value is ProxyScheme => (PROXY_SCHEMES as readonly string[]).includes(value);

/** Схему держит CHECK в базе; незнакомое значение — строка, записанная в обход миграции. */
function proxyOf(row: Omit<StoredProxy, "scheme"> & { scheme: string }): StoredProxy {
  if (!isScheme(row.scheme)) throw new Error(`outbound_proxy ${row.proxyId}: схема «${row.scheme}» вне перечня`);
  return { ...row, scheme: row.scheme };
}

const bytes = (value: Uint8Array | null): Uint8Array<ArrayBuffer> | null => (value === null ? null : Uint8Array.from(value));

@Injectable()
export class PrismaProxiesRepository implements ProxiesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(): Promise<StoredProxy[]> {
    const rows = await this.prisma.outboundProxy.findMany({ orderBy: [{ priority: "asc" }, { name: "asc" }, { proxyId: "asc" }] });
    return rows.map(proxyOf);
  }

  async find(proxyId: string): Promise<StoredProxy | null> {
    const row = await this.prisma.outboundProxy.findUnique({ where: { proxyId } });
    return row === null ? null : proxyOf(row);
  }

  async insert(row: StoredProxy): Promise<void> {
    await this.prisma.outboundProxy.create({ data: { proxyId: row.proxyId, ...columnsOf(row) } });
  }

  async replace(row: StoredProxy): Promise<boolean> {
    const { count } = await this.prisma.outboundProxy.updateMany({ where: { proxyId: row.proxyId }, data: columnsOf(row) });
    return count > 0;
  }

  async saveCheck(proxyId: string, check: ProxyCheck): Promise<StoredProxy | null> {
    const { count } = await this.prisma.outboundProxy.updateMany({ where: { proxyId }, data: { lastCheckAt: check.at, lastCheckOk: check.ok, lastCheckNote: check.note } });
    return count > 0 ? await this.find(proxyId) : null;
  }

  async modes(): Promise<StoredMode[]> {
    return await this.prisma.outboundServiceMode.findMany({ orderBy: { service: "asc" } });
  }

  async saveMode(row: StoredMode): Promise<void> {
    const data = { mode: row.mode, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
    await this.prisma.outboundServiceMode.upsert({ where: { service: row.service }, create: { service: row.service, ...data }, update: data });
  }
}

/** Колонки для записи без ключа строки: байты — свежими массивами, как у ключей интеграций. */
function columnsOf(row: StoredProxy) {
  return {
    name: row.name,
    scheme: row.scheme,
    host: row.host,
    port: row.port,
    username: row.username,
    passwordIv: bytes(row.passwordIv),
    passwordTag: bytes(row.passwordTag),
    passwordCt: bytes(row.passwordCt),
    passwordKeyId: row.passwordKeyId,
    country: row.country,
    enabled: row.enabled,
    priority: row.priority,
    note: row.note,
    lastCheckAt: row.lastCheckAt,
    lastCheckOk: row.lastCheckOk,
    lastCheckNote: row.lastCheckNote,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}
