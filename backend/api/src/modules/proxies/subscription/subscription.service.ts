import { Inject, Injectable, Logger } from "@nestjs/common";
import { buildXrayConfig, checkSubscriptionUrl } from "@bh/proxy-kit";
import type { Redis } from "ioredis";
import { RateLimitedError, ValidationError } from "../../../common/domain-error.js";
import { APP_CONFIG, type AppConfig } from "../../../config/app-config.js";
import { REDIS } from "../../../infra/redis.js";
import { RolesService, type AccountRef } from "../../roles/roles.service.js";
import { SecretUnreadableError, type SecretCipher } from "../../secrets/secret-cipher.js";
import { SubscriptionBusyError, SubscriptionNotFoundError, SubscriptionStorageDisabledError } from "../proxies-errors.js";
import { PROXY_CIPHER } from "../proxy-password.js";
import { ProxyRoutes } from "../proxy-routes.service.js";
import { takeMinute } from "./subscription-lock.js";
import { SubscriptionRoutes } from "./subscription-routes.js";
import { openUrl, sealUrl } from "./subscription-url.js";
import { nodeViews, subscriptionAudit, subscriptionView, type SubscriptionOverview } from "./subscription-views.js";
import { SUBSCRIPTION_KEY, SUBSCRIPTION_REPOSITORY, type StoredSubscription, type SubscriptionRepository } from "./subscription.repository.js";
import { SubscriptionSync, XRAY_LISTEN } from "./subscription.sync.js";
import { CONFIG_WRITER, SidecarMissingError, type ConfigWriter } from "./xray-config-writer.js";

/**
 * Подписка Xray в панели (docs/35-stage4-plan.md Р101, tasks/T-0093): просмотр,
 * сохранение, включение, удаление, обновление и проверка узлов. Смотреть —
 * `proxies.view`, менять — `proxies.edit` (права T-0065, новых нет). Адрес
 * подписки панель не получает никогда и в аудит он не попадает: там название и
 * подсказка «хост …abcd». Каждая правка — в аудит и сообщением репликам.
 */

export interface SubscriptionInput {
  name: string;
  /** нет — прежний адрес; при первом подключении обязателен */
  url?: string | undefined;
  countries: string[];
  enabled: boolean;
}

const PUBLIC_HTTPS = "Нужен публичный https-адрес без логина и пароля";
const MANUAL_REFRESH_KEY = "proxy-subscription:manual:refresh";
const MANUAL_PROBE_KEY = "proxy-subscription:manual:probe";

@Injectable()
export class ProxySubscriptionService {
  private readonly logger = new Logger("proxy-subscription");

  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY) private readonly repository: SubscriptionRepository,
    @Inject(PROXY_CIPHER) private readonly cipher: SecretCipher | null,
    private readonly roles: RolesService,
    private readonly sync: SubscriptionSync,
    private readonly routes: SubscriptionRoutes,
    @Inject(CONFIG_WRITER) private readonly writer: ConfigWriter,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly proxyRoutes: ProxyRoutes,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async view(actor: AccountRef): Promise<SubscriptionOverview> {
    await this.roles.require(actor, "proxies.view");
    return await this.overview();
  }

  async save(actor: AccountRef, input: SubscriptionInput, at = new Date()): Promise<SubscriptionOverview> {
    await this.roles.require(actor, "proxies.edit");
    const before = (await this.repository.load())?.subscription ?? null;
    const url = input.url?.trim();
    if (before === null && (url === undefined || url === "")) throw new ValidationError("Укажите адрес подписки");

    let row: StoredSubscription;
    let replaced = false;
    if (url !== undefined && url !== "") {
      if (!checkSubscriptionUrl(url).ok) throw new ValidationError(PUBLIC_HTTPS);
      if (this.cipher === null) throw new SubscriptionStorageDisabledError();
      replaced = before === null || this.openOrNull(before) !== url;
      row = { ...this.draft(before, input, actor, at), ...(replaced ? sealUrl(this.cipher, SUBSCRIPTION_KEY, url) : this.urlOf(before)) };
    } else if (before !== null) {
      row = this.draft(before, input, actor, at);
    } else {
      throw new ValidationError("Укажите адрес подписки");
    }
    // Новый адрес — другая подписка: итог и узлы прежней к ней не относятся.
    if (replaced) row = { ...row, lastRefreshAt: null, lastRefreshOk: null, lastRefreshNote: null, providerIntervalHours: null, trafficUsedBytes: null, trafficTotalBytes: null, expiresAt: null };

    await this.repository.save(row, { dropNodes: replaced && before !== null });
    await this.reload();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxy_subscription.save", target: SUBSCRIPTION_KEY, ...(before === null ? {} : { before: subscriptionAudit(before) }), after: subscriptionAudit(row) });
    if (before !== null && before.enabled !== row.enabled) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "proxy_subscription.toggle", target: SUBSCRIPTION_KEY, before: { enabled: before.enabled }, after: { enabled: row.enabled } });
    }
    await this.proxyRoutes.changed("subscription");
    return await this.overview();
  }

  /** «Обновить сейчас»: не чаще раза в минуту; итог — в строке подписки. */
  async refresh(actor: AccountRef, at = new Date()): Promise<SubscriptionOverview> {
    await this.roles.require(actor, "proxies.edit");
    await this.requireMinute(MANUAL_REFRESH_KEY);
    const result = await this.sync.refresh(at);
    if (result.status === "absent") throw new SubscriptionNotFoundError();
    if (result.status === "disabled") throw new ValidationError("Подписка выключена — сначала включите её");
    if (result.status === "busy") throw new SubscriptionBusyError();
    const current = (await this.repository.load())?.subscription;
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "proxy_subscription.refresh",
      target: SUBSCRIPTION_KEY,
      after: { name: current?.name ?? null, urlHint: current?.urlHint ?? null, ok: result.status === "ok", note: result.note },
    });
    return await this.overview();
  }

  /** «Проверить узлы»: все узлы встают в очередь проверок, их разберёт расписание. */
  async probe(actor: AccountRef, at = new Date()): Promise<SubscriptionOverview> {
    await this.roles.require(actor, "proxies.edit");
    const snapshot = await this.repository.load();
    if (snapshot === null) throw new SubscriptionNotFoundError();
    await this.requireMinute(MANUAL_PROBE_KEY);
    await this.repository.scheduleAllProbes(SUBSCRIPTION_KEY, at);
    await this.reload();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxy_subscription.probe", target: SUBSCRIPTION_KEY, after: { name: snapshot.subscription.name, urlHint: snapshot.subscription.urlHint, nodes: snapshot.nodes.length } });
    await this.proxyRoutes.changed("subscription");
    return await this.overview();
  }

  async remove(actor: AccountRef): Promise<void> {
    await this.roles.require(actor, "proxies.edit");
    const snapshot = await this.repository.load();
    if (snapshot === null) throw new SubscriptionNotFoundError();

    // Пустой конфиг убирает входы Xray. Нет контейнера — удалять нечего, подписка всё равно уходит.
    try {
      await this.writer.write(buildXrayConfig([], new Map(), { basePort: this.config.xray.socksPortBase, slotCount: this.config.xray.slotCount, listen: XRAY_LISTEN }));
    } catch (error: unknown) {
      if (!(error instanceof SidecarMissingError)) this.logger.warn(JSON.stringify({ module: "proxy-subscription", event: "empty_config_failed", reason: error instanceof Error ? error.name : "unknown" }));
    }
    await this.repository.remove(SUBSCRIPTION_KEY);
    await this.reload();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxy_subscription.delete", target: SUBSCRIPTION_KEY, before: subscriptionAudit(snapshot.subscription) });
    await this.proxyRoutes.changed("subscription");
  }

  private async overview(): Promise<SubscriptionOverview> {
    const [snapshot, connected] = await Promise.all([this.repository.load(), this.writer.available()]);
    return {
      encryption: this.cipher !== null,
      sidecar: { connected },
      subscription: snapshot === null ? null : subscriptionView(snapshot.subscription),
      nodes: snapshot === null ? [] : nodeViews(snapshot.nodes),
    };
  }

  /** Строка без адреса: поля формы поверх прежней строки (или пустой для первого подключения). */
  private draft(before: StoredSubscription | null, input: SubscriptionInput, actor: AccountRef, at: Date): StoredSubscription {
    const base = before ?? {
      key: SUBSCRIPTION_KEY,
      urlIv: new Uint8Array(),
      urlTag: new Uint8Array(),
      urlCt: new Uint8Array(),
      urlKeyId: "",
      urlHint: "",
      lastRefreshAt: null,
      lastRefreshOk: null,
      lastRefreshNote: null,
      providerIntervalHours: null,
      trafficUsedBytes: null,
      trafficTotalBytes: null,
      expiresAt: null,
    };
    return { ...base, name: input.name, enabled: input.enabled, countries: [...new Set(input.countries)], updatedBy: actor.accountId, updatedAt: at };
  }

  private urlOf(row: StoredSubscription | null): Pick<StoredSubscription, "urlIv" | "urlTag" | "urlCt" | "urlKeyId" | "urlHint"> {
    if (row === null) throw new ValidationError("Укажите адрес подписки");
    return { urlIv: row.urlIv, urlTag: row.urlTag, urlCt: row.urlCt, urlKeyId: row.urlKeyId, urlHint: row.urlHint };
  }

  /** Прежний адрес для сравнения с новым; не читается — считается другим. */
  private openOrNull(row: StoredSubscription): string | null {
    if (this.cipher === null) return null;
    try {
      return openUrl(this.cipher, row);
    } catch (error: unknown) {
      if (error instanceof SecretUnreadableError) return null;
      throw error;
    }
  }

  private async reload(): Promise<void> {
    try {
      await this.routes.reload();
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "proxy-subscription", event: "reload_failed", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  private async requireMinute(key: string): Promise<void> {
    if (!(await takeMinute(this.redis, key))) throw new RateLimitedError("Подождите минуту");
  }
}
