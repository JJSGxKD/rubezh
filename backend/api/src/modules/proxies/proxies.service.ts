import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { OUTBOUND_MODES, OUTBOUND_PROXY_FETCH, defaultModeOf, type OutboundMode, type OutboundProxy, type ProxyFetch } from "../../infra/outbound/outbound-route.js";
import { OUTBOUND_SERVICES, type OutboundService } from "../../infra/outbound/outbound-services.js";
import { undiciProxyFetch } from "../../infra/outbound/proxy-dispatcher.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SecretUnreadableError, type SecretCipher } from "../secrets/secret-cipher.js";
import { OutboundServiceNotFoundError, ProxyLimitError, ProxyNotFoundError, ProxyPasswordStorageDisabledError } from "./proxies-errors.js";
import { PROXY_LIMITS, type ProxyScheme } from "./proxies-rules.js";
import { PROXIES_REPOSITORY, type ProxiesRepository, type StoredMode, type StoredProxy } from "./proxies.repository.js";
import { runProxyCheck } from "./proxy-check.js";
import { NO_PASSWORD, PROXY_CIPHER, hasPassword, isReadable, openPassword, sealPassword } from "./proxy-password.js";
import { ProxyRoutes } from "./proxy-routes.service.js";
import { proxyAudit, proxyView, type CheckView, type ModeView, type ProxiesView, type ProxyView } from "./proxy-views.js";

/**
 * Прокси для исходящих запросов в панели (docs/35-stage4-plan.md Р91,
 * tasks/T-0065): список, создание, правка, проверка и режимы сервисов.
 * Смотреть — `proxies.view`, менять и проверять — `proxies.edit`. Пароль
 * панель не получает никогда и в аудит он не попадает: там название, адрес и
 * признак «пароль задан». Каждая правка — в аудит и сообщением репликам.
 */

export interface ProxyInput {
  name: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string | null | undefined;
  /** пустая строка — пароля нет */
  password?: string | undefined;
  country: string;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  note?: string | null | undefined;
}

export interface ProxyPatch {
  name?: string | undefined;
  scheme?: ProxyScheme | undefined;
  host?: string | undefined;
  port?: number | undefined;
  username?: string | null | undefined;
  /** пусто или не задан — пароль прежний; непустой — заменить */
  password?: string | undefined;
  /** «Удалить пароль» — только явно */
  clearPassword?: boolean | undefined;
  country?: string | undefined;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  note?: string | null | undefined;
}

/** Пустое поле формы — «нет значения». */
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === "" ? null : value.trim());

@Injectable()
export class ProxiesService {
  constructor(
    @Inject(PROXIES_REPOSITORY) private readonly repository: ProxiesRepository,
    @Inject(PROXY_CIPHER) private readonly cipher: SecretCipher | null,
    private readonly roles: RolesService,
    private readonly routes: ProxyRoutes,
    @Optional() @Inject(OUTBOUND_PROXY_FETCH) private readonly proxyFetch: ProxyFetch = undiciProxyFetch,
  ) {}

  async list(actor: AccountRef): Promise<ProxiesView> {
    await this.roles.require(actor, "proxies.view");
    const rows = await this.repository.list();
    return { enabled: this.cipher !== null, proxies: rows.map((row) => this.view(row)) };
  }

  async create(actor: AccountRef, input: ProxyInput, at = new Date()): Promise<ProxyView> {
    await this.roles.require(actor, "proxies.edit");
    const existing = await this.repository.list();
    if (existing.length >= PROXY_LIMITS.countMax) throw new ProxyLimitError(PROXY_LIMITS.countMax);

    const proxyId = randomUUID();
    const username = blankToNull(input.username);
    const password = input.password === undefined || input.password === "" ? null : input.password;
    if (password !== null && username === null) throw new ValidationError("Пароль задают вместе с логином");
    const lastPriority = existing.reduce((max, row) => Math.max(max, row.priority), 0);
    const row: StoredProxy = {
      proxyId,
      name: input.name,
      scheme: input.scheme,
      host: input.host,
      port: input.port,
      username,
      ...(password === null ? NO_PASSWORD : this.seal(proxyId, password)),
      country: input.country,
      enabled: input.enabled ?? true,
      priority: input.priority ?? lastPriority + PROXY_LIMITS.prioritySpacing,
      note: blankToNull(input.note),
      lastCheckAt: null,
      lastCheckOk: null,
      lastCheckNote: null,
      updatedBy: actor.accountId,
      updatedAt: at,
    };
    await this.repository.insert(row);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxies.create", target: proxyId, after: proxyAudit(row) });
    await this.routes.changed(proxyId);
    return this.view(row);
  }

  async update(actor: AccountRef, proxyId: string, patch: ProxyPatch, at = new Date()): Promise<ProxyView> {
    await this.roles.require(actor, "proxies.edit");
    const before = await this.repository.find(proxyId);
    if (before === null) throw new ProxyNotFoundError();

    const newPassword = patch.password === undefined || patch.password === "" ? null : patch.password;
    if (newPassword !== null && patch.clearPassword === true) throw new ValidationError("Пароль нельзя одновременно задать и удалить");
    const username = patch.username === undefined ? before.username : blankToNull(patch.username);
    const columns = newPassword !== null ? this.seal(proxyId, newPassword) : patch.clearPassword === true ? NO_PASSWORD : before;
    if (columns.passwordCt !== null && username === null) throw new ValidationError("Пароль задают вместе с логином");

    const next: StoredProxy = {
      ...before,
      name: patch.name ?? before.name,
      scheme: patch.scheme ?? before.scheme,
      host: patch.host ?? before.host,
      port: patch.port ?? before.port,
      username,
      passwordIv: columns.passwordIv,
      passwordTag: columns.passwordTag,
      passwordCt: columns.passwordCt,
      passwordKeyId: columns.passwordKeyId,
      country: patch.country ?? before.country,
      enabled: patch.enabled ?? before.enabled,
      priority: patch.priority ?? before.priority,
      note: patch.note === undefined ? before.note : blankToNull(patch.note),
      updatedBy: actor.accountId,
      updatedAt: at,
    };
    // Итог проверки относился к прежнему адресу и логину: после правки подключения он врёт.
    const reconnected = next.scheme !== before.scheme || next.host !== before.host || next.port !== before.port || next.username !== before.username || newPassword !== null || patch.clearPassword === true;
    const saved: StoredProxy = reconnected ? { ...next, lastCheckAt: null, lastCheckOk: null, lastCheckNote: null } : next;
    if (!(await this.repository.replace(saved))) throw new ProxyNotFoundError();

    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxies.update", target: proxyId, before: proxyAudit(before), after: proxyAudit(saved) });
    await this.routes.changed(proxyId);
    return this.view(saved);
  }

  /** Запрос на ipify через прокси; итог сохраняется в строке и виден всем, кто смотрит список. */
  async check(actor: AccountRef, proxyId: string, at = new Date()): Promise<CheckView> {
    await this.roles.require(actor, "proxies.edit");
    const row = await this.repository.find(proxyId);
    if (row === null) throw new ProxyNotFoundError();

    const proxy = this.connection(row);
    const outcome = proxy === null ? { ok: false, note: "Пароль прокси не расшифровывается: его нужно задать заново" } : await runProxyCheck(this.proxyFetch, proxy);
    const saved = await this.repository.saveCheck(proxyId, { at, ok: outcome.ok, note: outcome.note });
    if (saved === null) throw new ProxyNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxies.check", target: proxyId, after: { name: row.name, scheme: row.scheme, host: row.host, port: row.port, ok: outcome.ok, note: outcome.note } });
    return { ok: outcome.ok, message: outcome.note, proxy: this.view(saved) };
  }

  async modes(actor: AccountRef): Promise<ModeView[]> {
    await this.roles.require(actor, "proxies.view");
    const stored = new Map((await this.repository.modes()).map((row) => [row.service, row]));
    return OUTBOUND_SERVICES.map((service) => modeView(service, stored.get(service)));
  }

  async setMode(actor: AccountRef, service: string, mode: OutboundMode, at = new Date()): Promise<ModeView> {
    await this.roles.require(actor, "proxies.edit");
    if (!isService(service)) throw new OutboundServiceNotFoundError();
    const before = modeView(service, (await this.repository.modes()).find((row) => row.service === service));
    const row: StoredMode = { service, mode, updatedBy: actor.accountId, updatedAt: at };
    await this.repository.saveMode(row);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "outbound.mode", target: service, before: { mode: before.mode }, after: { mode } });
    await this.routes.changed(service);
    return modeView(service, row);
  }

  private view(row: StoredProxy): ProxyView {
    return proxyView(row, isReadable(this.cipher, row));
  }

  private seal(proxyId: string, password: string): ReturnType<typeof sealPassword> {
    if (this.cipher === null) throw new ProxyPasswordStorageDisabledError();
    return sealPassword(this.cipher, proxyId, password);
  }

  /** Прокси для запроса с расшифрованным паролем; `null` — пароль не прочитать. */
  private connection(row: StoredProxy): OutboundProxy | null {
    let password: string | null = null;
    if (hasPassword(row)) {
      try {
        if (this.cipher === null) return null;
        password = openPassword(this.cipher, row);
      } catch (error: unknown) {
        if (error instanceof SecretUnreadableError) return null;
        throw error;
      }
    }
    return { id: row.proxyId, scheme: row.scheme, host: row.host, port: row.port, username: row.username, password, priority: row.priority, updatedAt: row.updatedAt.getTime() };
  }
}

const isService = (value: string): value is OutboundService => (OUTBOUND_SERVICES as readonly string[]).includes(value);

function modeView(service: OutboundService, stored: StoredMode | undefined): ModeView {
  const fallback = defaultModeOf(service);
  // Строка с незнакомым режимом (записана в обход панели) не действует: клиент берёт умолчание, и панель показывает то же.
  const valid = stored !== undefined && isMode(stored.mode) ? stored : undefined;
  return { service, mode: valid === undefined ? fallback : (valid.mode as OutboundMode), default: fallback, custom: valid !== undefined, updatedAt: valid?.updatedAt.toISOString() ?? null, updatedBy: valid?.updatedBy ?? null };
}

const isMode = (value: string): value is OutboundMode => (OUTBOUND_MODES as readonly string[]).includes(value);
