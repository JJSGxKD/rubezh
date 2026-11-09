import { assignSlots, buildXrayConfig, parseSubscription, SubscriptionFetchError, SubscriptionFormatError, type ProxyNode } from "@bh/proxy-kit";
import type { Outbound } from "../../../infra/outbound/outbound.js";
import { SecretUnreadableError, type SecretCipher } from "../../secrets/secret-cipher.js";
import { loadSubscription, subscriptionHwid, type HostResolver } from "./subscription-download.js";
import { REFRESH_LOCK_KEY, REFRESH_LOCK_TTL_MS, withLock, type LockRedis } from "./subscription-lock.js";
import { fetchErrorNote, formatErrorNote, joinNotes, noNodesNote, NOTES, overflowNote, successNote } from "./subscription.messages.js";
import type { StoredNode, StoredSubscription, SubscriptionRepository } from "./subscription.repository.js";
import type { SubscriptionRoutes } from "./subscription-routes.js";
import { openUrl } from "./subscription-url.js";
import { SidecarMissingError, type ConfigWriter } from "./xray-config-writer.js";

/**
 * Обновление подписки (docs/35-stage4-plan.md Р101, tasks/T-0093): адрес →
 * загрузка → разбор → слоты → конфиг Xray → транзакция с узлами → пул.
 *
 * **Сбой поставщика не обнуляет рабочий пул.** Любая ошибка до записи конфига
 * (сеть, код ответа, формат, ноль подходящих узлов, нет каталога тома) оставляет
 * и конфиг, и узлы в таблице прежними; меняется только итог в строке подписки.
 * Конфиг пишется раньше таблицы: если контейнера нет, узлы, которых Xray не
 * видит, в таблицу не попадают.
 *
 * Идёт под замком Redis — при нескольких репликах обновляет одна.
 */

/** Внутри сети tunnel вход слушает на всех интерфейсах: API живёт в другом контейнере. Порты наружу не публикуются. */
export const XRAY_LISTEN = "0.0.0.0";
const NAME_MAX = 80;
const HOST_MAX = 255;

export interface SyncDeps {
  repository: SubscriptionRepository;
  /** `null` — нет ключа шифрования: адрес не прочитать */
  cipher: SecretCipher | null;
  outbound: Pick<Outbound, "forService">;
  resolve: HostResolver;
  writer: ConfigWriter;
  routes: SubscriptionRoutes;
  redis: LockRedis;
  /** сообщить остальным репликам, что таблицы изменились */
  changed: () => Promise<void>;
  xray: { basePort: number; slotCount: number };
}

export type RefreshResult = { status: "busy" } | { status: "absent" } | { status: "disabled" } | { status: "ok" | "failed"; note: string };

export class SubscriptionSync {
  constructor(private readonly deps: SyncDeps) {}

  async refresh(now: Date = new Date()): Promise<RefreshResult> {
    const locked = await withLock(this.deps.redis, REFRESH_LOCK_KEY, REFRESH_LOCK_TTL_MS, () => this.run(now));
    return locked.ran ? locked.value : { status: "busy" };
  }

  private async run(now: Date): Promise<RefreshResult> {
    const snapshot = await this.deps.repository.load();
    if (snapshot === null) return { status: "absent" };
    if (!snapshot.subscription.enabled) return { status: "disabled" };
    const key = snapshot.subscription.key;

    const failed = async (note: string): Promise<RefreshResult> => {
      await this.deps.repository.recordFailure(key, now, note);
      await this.deps.changed();
      return { status: "failed", note };
    };

    const source = this.sourceOf(snapshot.subscription);
    if ("note" in source) return await failed(source.note);

    let fetched;
    try {
      fetched = await loadSubscription(this.deps.outbound, this.deps.resolve, source.url, source.hwid);
    } catch (error: unknown) {
      return await failed(error instanceof SubscriptionFetchError ? fetchErrorNote(error) : NOTES.network);
    }

    let parsed;
    try {
      parsed = parseSubscription(fetched.body);
    } catch (error: unknown) {
      return await failed(error instanceof SubscriptionFormatError ? formatErrorNote(error) : NOTES.unsupportedFormat);
    }
    if (parsed.nodes.length === 0) return await failed(noNodesNote(parsed.skipped));

    const previous = new Map(snapshot.nodes.map((node) => [node.nodeKey, node]));
    const { slots, overflow } = assignSlots(
      parsed.nodes.map((node) => node.key),
      new Map(snapshot.nodes.map((node) => [node.nodeKey, node.slot])),
      this.deps.xray.slotCount,
    );
    const placed = parsed.nodes.filter((node) => slots.has(node.key));
    const config = buildXrayConfig(placed, slots, { ...this.deps.xray, listen: XRAY_LISTEN });

    try {
      await this.deps.writer.write(config);
    } catch (error: unknown) {
      return await failed(error instanceof SidecarMissingError ? NOTES.noSidecar : NOTES.writeFailed);
    }

    const note = overflow.length === 0 ? successNote(placed.length, parsed.skipped) : joinNotes(successNote(placed.length, parsed.skipped), overflowNote(overflow.length));
    const info = fetched.userInfo;
    const used = info === null || (info.uploadBytes === null && info.downloadBytes === null) ? null : BigInt((info.uploadBytes ?? 0) + (info.downloadBytes ?? 0));
    const total = info?.totalBytes ?? null;
    const expires = info?.expireUnixSec ?? null;
    await this.deps.repository.applyRefresh(key, {
      at: now,
      ok: overflow.length === 0,
      note,
      nodes: placed.map((node) => storedNode(key, node, slots.get(node.key) ?? 0, previous.get(node.key), now)),
      providerIntervalHours: fetched.updateIntervalHours,
      trafficUsedBytes: used,
      trafficTotalBytes: total === null ? null : BigInt(total),
      expiresAt: expires === null ? null : new Date(expires * 1000),
    });
    await this.deps.routes.reload();
    await this.deps.changed();
    return { status: "ok", note };
  }

  /** Адрес открытым текстом и идентификатор устройства либо причина, по которой адрес не прочитать. */
  private sourceOf(subscription: StoredSubscription): { url: string; hwid: string } | { note: string } {
    const cipher = this.deps.cipher;
    if (cipher === null) return { note: NOTES.noCipher };
    try {
      return { url: openUrl(cipher, subscription), hwid: subscriptionHwid(cipher, subscription.key) };
    } catch (error: unknown) {
      if (error instanceof SecretUnreadableError) return { note: NOTES.unreadable };
      throw error;
    }
  }
}

/** Узел для таблицы; уцелевший узел сохраняет итоги проверок, новый ждёт первой. */
function storedNode(subscriptionKey: string, node: ProxyNode, slot: number, previous: StoredNode | undefined, now: Date): StoredNode {
  const base = { subscriptionKey, nodeKey: node.key, slot, protocol: node.protocol, name: node.name.slice(0, NAME_MAX), country: node.country, host: node.host.slice(0, HOST_MAX) };
  return previous === undefined
    ? { ...base, state: "unknown", failures: 0, latencyMs: null, lastProbeAt: null, nextProbeAt: now }
    : { ...base, state: previous.state, failures: previous.failures, latencyMs: previous.latencyMs, lastProbeAt: previous.lastProbeAt, nextProbeAt: previous.nextProbeAt };
}
