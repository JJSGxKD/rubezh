import { Inject, Injectable, Logger } from "@nestjs/common";
import { checkSubscriptionUrl } from "@bh/proxy-kit";
import type { Redis } from "ioredis";
import { RateLimitedError, ValidationError } from "../../../common/domain-error.js";
import { APP_CONFIG, type AppConfig } from "../../../config/app-config.js";
import { REDIS } from "../../../infra/redis.js";
import { RolesService, type AccountRef } from "../../roles/roles.service.js";
import { SecretUnreadableError, type SecretCipher } from "../../secrets/secret-cipher.js";
import { SubscriptionBusyError, SubscriptionNotFoundError, SubscriptionStorageDisabledError } from "../proxies-errors.js";
import { PROXY_CIPHER } from "../proxy-password.js";
import { ProxyRoutes } from "../proxy-routes.service.js";
import { SubscriptionCommands } from "./subscription-commands.js";
import { takeMinute } from "./subscription-lock.js";
import { SubscriptionRoutes } from "./subscription-routes.js";
import { newSubscriptionKey, slotQuota, SUBSCRIPTIONS_MAX } from "./subscription-rules.js";
import { openUrl, sealUrl } from "./subscription-url.js";
import { nodeViews, subscriptionAudit, subscriptionView, type SubscriptionsOverview } from "./subscription-views.js";
import { SUBSCRIPTION_REPOSITORY, type StoredSubscription, type SubscriptionRepository } from "./subscription.repository.js";
import { SubscriptionSync } from "./subscription.sync.js";
import { CONFIG_WRITER, type ConfigWriter } from "./xray-config-writer.js";

/**
 * Подписки Xray в панели (docs/35-stage4-plan.md Р101, Р192, tasks/T-0093,
 * tasks/T-0384): список, создание, правка, включение, удаление, обновление и
 * проверка узлов. Смотреть — `proxies.view`, менять — `proxies.edit` (права
 * T-0065, новых нет). Адрес подписки панель не получает никогда и в аудит он не
 * попадает: там название и подсказка «хост …abcd». Каждая правка — в аудит с
 * ключом подписки целью и сообщением репликам.
 *
 * Всё, что меняет конфиг Xray, делает `SubscriptionCommands` под общим замком.
 */

export interface SubscriptionInput {
  name: string;
  /** при создании обязателен; при правке нет — прежний адрес */
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
    private readonly commands: SubscriptionCommands,
    private readonly routes: SubscriptionRoutes,
    @Inject(CONFIG_WRITER) private readonly writer: ConfigWriter,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly proxyRoutes: ProxyRoutes,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(actor: AccountRef): Promise<SubscriptionsOverview> {
    await this.roles.require(actor, "proxies.view");
    return await this.overview();
  }

  async create(actor: AccountRef, input: SubscriptionInput, at = new Date()): Promise<SubscriptionsOverview> {
    await this.roles.require(actor, "proxies.edit");
    const url = this.checkedUrl(input.url);
    if (url === null) throw new ValidationError("Укажите адрес подписки");
    if (this.cipher === null) throw new SubscriptionStorageDisabledError();

    const key = newSubscriptionKey();
    const row: StoredSubscription = {
      key,
      name: input.name,
      ...sealUrl(this.cipher, key, url),
      enabled: input.enabled,
      countries: [...new Set(input.countries)],
      lastRefreshAt: null,
      lastRefreshOk: null,
      lastRefreshNote: null,
      providerIntervalHours: null,
      trafficUsedBytes: null,
      trafficTotalBytes: null,
      expiresAt: null,
      updatedBy: actor.accountId,
      updatedAt: at,
      createdAt: at,
    };
    await this.commands.create(row);
    await this.reload();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxy_subscription.save", target: key, after: subscriptionAudit(row) });
    await this.proxyRoutes.changed("subscription");
    return await this.overview();
  }

  async update(actor: AccountRef, key: string, input: SubscriptionInput, at = new Date()): Promise<SubscriptionsOverview> {
    await this.roles.require(actor, "proxies.edit");
    const before = await this.subscriptionOf(key);
    const url = this.checkedUrl(input.url);
    const draft: StoredSubscription = { ...before, name: input.name, enabled: input.enabled, countries: [...new Set(input.countries)], updatedBy: actor.accountId, updatedAt: at };

    let row = draft;
    let replaced = false;
    if (url !== null) {
      if (this.cipher === null) throw new SubscriptionStorageDisabledError();
      replaced = this.openOrNull(before) !== url;
      if (replaced) row = { ...draft, ...sealUrl(this.cipher, key, url) };
    }
    // Новый адрес — другая подписка: итог и узлы прежней к ней не относятся.
    if (replaced) row = { ...row, lastRefreshAt: null, lastRefreshOk: null, lastRefreshNote: null, providerIntervalHours: null, trafficUsedBytes: null, trafficTotalBytes: null, expiresAt: null };

    await this.commands.update(before, row, replaced);
    await this.reload();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxy_subscription.save", target: key, before: subscriptionAudit(before), after: subscriptionAudit(row) });
    if (before.enabled !== row.enabled) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "proxy_subscription.toggle", target: key, before: { enabled: before.enabled }, after: { enabled: row.enabled } });
    }
    await this.proxyRoutes.changed("subscription");
    return await this.overview();
  }

  /** «Обновить сейчас»: не чаще раза в минуту на подписку; итог — в строке подписки. */
  async refresh(actor: AccountRef, key: string, at = new Date()): Promise<SubscriptionsOverview> {
    await this.roles.require(actor, "proxies.edit");
    const subscription = await this.subscriptionOf(key);
    if (!subscription.enabled) throw new ValidationError("Подписка выключена — сначала включите её");
    await this.requireMinute(`${MANUAL_REFRESH_KEY}:${key}`);
    const result = await this.sync.refresh(key, at);
    if (result.status === "absent") throw new SubscriptionNotFoundError();
    if (result.status === "disabled") throw new ValidationError("Подписка выключена — сначала включите её");
    if (result.status === "busy") throw new SubscriptionBusyError();
    const current = (await this.repository.load(key))?.subscription;
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "proxy_subscription.refresh",
      target: key,
      after: { name: current?.name ?? null, urlHint: current?.urlHint ?? null, ok: result.status === "ok", note: result.note },
    });
    return await this.overview();
  }

  /** «Проверить узлы»: все узлы подписки встают в очередь проверок, их разберёт расписание. */
  async probe(actor: AccountRef, key: string, at = new Date()): Promise<SubscriptionsOverview> {
    await this.roles.require(actor, "proxies.edit");
    const snapshot = await this.repository.load(key);
    if (snapshot === null) throw new SubscriptionNotFoundError();
    await this.requireMinute(`${MANUAL_PROBE_KEY}:${key}`);
    await this.repository.scheduleAllProbes(key, at);
    await this.reload();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxy_subscription.probe", target: key, after: { name: snapshot.subscription.name, urlHint: snapshot.subscription.urlHint, nodes: snapshot.nodes.length } });
    await this.proxyRoutes.changed("subscription");
    return await this.overview();
  }

  async remove(actor: AccountRef, key: string): Promise<void> {
    await this.roles.require(actor, "proxies.edit");
    const before = await this.subscriptionOf(key);
    await this.commands.remove(key);
    await this.reload();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "proxy_subscription.delete", target: key, before: subscriptionAudit(before) });
    await this.proxyRoutes.changed("subscription");
  }

  private async overview(): Promise<SubscriptionsOverview> {
    const [all, connected] = await Promise.all([this.repository.list(), this.writer.available()]);
    const slotCount = this.config.xray.slotCount;
    return {
      encryption: this.cipher !== null,
      sidecar: { connected },
      limit: SUBSCRIPTIONS_MAX,
      slotCount,
      slotQuota: slotQuota(slotCount, all.length),
      subscriptions: all.map(({ subscription, nodes }) => ({ ...subscriptionView(subscription), nodes: nodeViews(nodes) })),
    };
  }

  private async subscriptionOf(key: string): Promise<StoredSubscription> {
    const snapshot = await this.repository.load(key);
    if (snapshot === null) throw new SubscriptionNotFoundError();
    return snapshot.subscription;
  }

  /** Адрес из формы: пусто — `null` (прежний остаётся); непубличный — отказ. */
  private checkedUrl(raw: string | undefined): string | null {
    const url = raw?.trim();
    if (url === undefined || url === "") return null;
    if (!checkSubscriptionUrl(url).ok) throw new ValidationError(PUBLIC_HTTPS);
    return url;
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
