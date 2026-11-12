import { assignSlots, parseSubscription, SubscriptionFetchError, SubscriptionFormatError, type ProxyNode } from "@bh/proxy-kit";
import type { Outbound } from "../../../infra/outbound/outbound.js";
import { SecretUnreadableError, type SecretCipher } from "../../secrets/secret-cipher.js";
import { loadSubscription, subscriptionHwid, type HostResolver } from "./subscription-download.js";
import { REFRESH_LOCK_KEY, REFRESH_LOCK_TTL_MS, withLock, type LockRedis, type LockResult } from "./subscription-lock.js";
import { fetchErrorNote, formatErrorNote, joinNotes, noNodesNote, NOTES, overflowNote, successNote } from "./subscription.messages.js";
import { slotQuota } from "./subscription-rules.js";
import type { StoredNode, StoredSubscription, SubscriptionRepository } from "./subscription.repository.js";
import type { SubscriptionRoutes } from "./subscription-routes.js";
import { openUrl } from "./subscription-url.js";
import { assembleConfig, missingParts, type AssemblyDeps, type AssemblyResult } from "./xray-config-assembly.js";
import { SidecarMissingError, type ConfigPart, type ConfigWriter } from "./xray-config-writer.js";

/**
 * Обновление подписки (docs/35-stage4-plan.md Р101, Р192, tasks/T-0093,
 * tasks/T-0384): адрес → загрузка → разбор → слоты → часть подписки в томе →
 * общий конфиг Xray → транзакция с узлами → пул.
 *
 * **Сбой поставщика не обнуляет рабочий пул.** Любая ошибка до записи части
 * (сеть, код ответа, формат, ноль подходящих узлов, нет каталога тома) оставляет
 * и конфиг, и узлы в таблице прежними; меняется только итог в строке подписки.
 * Конфиг пишется раньше таблицы: если контейнера нет, узлы, которых Xray не
 * видит, в таблицу не попадают. Узлы других подписок обновление не трогает: их
 * части в томе остаются на месте, а их слоты (из базы и из частей) не берутся.
 *
 * Идёт под замком Redis — при нескольких репликах обновляет одна. Тот же замок
 * держит всё, что меняет конфиг (`exclusive`).
 */

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
  xray: AssemblyDeps["xray"];
  /** снять счётчики трафика перед записью конфига (tasks/T-0386) */
  beforeWrite?: AssemblyDeps["beforeWrite"];
}

export type RefreshResult = { status: "busy" } | { status: "absent" } | { status: "disabled" } | { status: "ok" | "failed"; note: string };

/** Итог пересборки конфига без загрузки подписок. */
export type RebuildResult = { status: "busy" } | { status: "failed"; note: string } | ({ status: "ok" } & AssemblyResult);

export class SubscriptionSync {
  constructor(private readonly deps: SyncDeps) {}

  async refresh(key: string, now: Date = new Date()): Promise<RefreshResult> {
    const locked = await this.exclusive(() => this.run(key, now));
    return locked.ran ? locked.value : { status: "busy" };
  }

  /**
   * Пересобрать `config.json` из частей, ничего не загружая: пропал файл конфига,
   * а части на месте. Подписки без части вернёт в `missing` — их обновит расписание.
   */
  async rebuild(): Promise<RebuildResult> {
    const locked = await this.exclusive(async (): Promise<RebuildResult> => {
      try {
        return { status: "ok", ...(await this.assemble()) };
      } catch (error: unknown) {
        return { status: "failed", note: error instanceof SidecarMissingError ? NOTES.noSidecar : NOTES.writeFailed };
      }
    });
    return locked.ran ? locked.value : { status: "busy" };
  }

  /** Работа, меняющая конфиг, — под общим замком; `ran: false` — замок занят, ничего не сделано. */
  exclusive<T>(work: () => Promise<T>): Promise<LockResult<T>> {
    return withLock(this.deps.redis, REFRESH_LOCK_KEY, REFRESH_LOCK_TTL_MS, work);
  }

  /** Включённые подписки без годной части в томе: расписание обновит их сразу. Конфиг не пишет. */
  missingParts(): Promise<string[]> {
    return missingParts(this.deps);
  }

  /** Собрать `config.json` из частей включённых подписок. Только под замком (`exclusive`). */
  assemble(override?: { key: string; part: ConfigPart }): Promise<AssemblyResult> {
    return assembleConfig(this.deps, override);
  }

  private async run(key: string, now: Date): Promise<RefreshResult> {
    const snapshot = await this.deps.repository.load(key);
    if (snapshot === null) return { status: "absent" };
    if (!snapshot.subscription.enabled) return { status: "disabled" };

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

    const all = await this.deps.repository.list();
    const quota = slotQuota(this.deps.xray.slotCount, all.length);
    const previous = new Map(snapshot.nodes.map((node) => [node.nodeKey, node]));
    const { slots, overflow } = assignSlots(
      parsed.nodes.map((node) => node.key),
      new Map(snapshot.nodes.map((node) => [node.nodeKey, node.slot])),
      { slotCount: this.deps.xray.slotCount, reserved: await this.reservedSlots(all, key), limit: quota },
    );
    const placed = parsed.nodes.filter((node) => slots.has(node.key));
    const part: ConfigPart = { version: 1, nodes: placed.map((node) => ({ node, slot: slots.get(node.key) ?? 0 })) };

    try {
      await this.deps.writer.writePart(key, part);
      await this.assemble({ key, part });
    } catch (error: unknown) {
      return await failed(error instanceof SidecarMissingError ? NOTES.noSidecar : NOTES.writeFailed);
    }

    const note = overflow.length === 0 ? successNote(placed.length, parsed.skipped) : joinNotes(successNote(placed.length, parsed.skipped), overflowNote(overflow.length, quota));
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

  /**
   * Слоты, которые эта подписка не берёт: узлы всех остальных подписок, включая
   * выключенные, — из базы и из их частей в томе. Часть может опережать базу
   * (запись итога не прошла), и узлы двух подписок на одном входе дали бы чужой выход.
   */
  private async reservedSlots(all: readonly { subscription: StoredSubscription; nodes: readonly StoredNode[] }[], own: string): Promise<Set<number>> {
    const reserved = new Set<number>();
    for (const { subscription, nodes } of all) {
      if (subscription.key === own) continue;
      for (const node of nodes) reserved.add(node.slot);
      const part = await this.deps.writer.readPart(subscription.key);
      for (const entry of part?.nodes ?? []) reserved.add(entry.slot);
    }
    return reserved;
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
