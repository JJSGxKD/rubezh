import type {
  BroadcastRecord,
  BroadcastStatus,
  BroadcastsRepository,
  DeliveryResult,
  DeliveryStats,
  DraftPatch,
  NewBroadcast,
  Recipient,
} from "../../src/modules/broadcasts/broadcasts.repository.js";

interface Delivery {
  status: "queued" | "sent" | "blocked" | "failed";
  attempts: number;
  error: string | null;
  claimed: boolean;
}

/**
 * Рассылки в памяти — для сервиса и отправщика. Сегмент здесь не считается:
 * аудиторию задаёт тест списком получателей, а SQL сегмента проверяет
 * интеграционный тест на Postgres.
 */
export class MemoryBroadcastsRepository implements BroadcastsRepository {
  readonly records = new Map<string, BroadcastRecord>();
  readonly deliveries = new Map<string, Map<string, Delivery>>();
  /** кого наберёт старт любой рассылки */
  audience: Recipient[] = [];
  private readonly userIds = new Map<string, string>();

  async create(input: NewBroadcast): Promise<BroadcastRecord> {
    const now = new Date();
    const record: BroadcastRecord = { ...input, status: "draft", audience: null, approvedBy: null, startedBy: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
    this.records.set(input.broadcastId, record);
    return record;
  }

  async updateDraft(broadcastId: string, patch: DraftPatch): Promise<BroadcastRecord | null> {
    const record = this.records.get(broadcastId);
    if (record?.status !== "draft") return null;
    const updated = { ...record, ...patch, approvedBy: null, updatedAt: new Date() };
    this.records.set(broadcastId, updated);
    return updated;
  }

  async byId(broadcastId: string): Promise<BroadcastRecord | null> {
    return this.records.get(broadcastId) ?? null;
  }

  async list(limit: number): Promise<BroadcastRecord[]> {
    return [...this.records.values()].reverse().slice(0, limit);
  }

  async approve(broadcastId: string, accountId: string): Promise<boolean> {
    const record = this.records.get(broadcastId);
    if (record?.status !== "draft") return false;
    this.records.set(broadcastId, { ...record, approvedBy: accountId });
    return true;
  }

  async count(): Promise<number> {
    return this.audience.length;
  }

  async start(broadcastId: string, startedBy: string, at: Date): Promise<number | null> {
    const record = this.records.get(broadcastId);
    if (record?.status !== "draft") return null;
    const rows = new Map<string, Delivery>();
    for (const recipient of this.audience) {
      rows.set(recipient.accountId, { status: "queued", attempts: 0, error: null, claimed: false });
      this.userIds.set(recipient.accountId, recipient.platformUserId);
    }
    this.deliveries.set(broadcastId, rows);
    this.records.set(broadcastId, { ...record, status: "sending", audience: rows.size, startedBy, startedAt: at });
    return rows.size;
  }

  async transition(broadcastId: string, from: readonly BroadcastStatus[], to: BroadcastStatus, at: Date): Promise<boolean> {
    const record = this.records.get(broadcastId);
    if (record === undefined || !from.includes(record.status)) return false;
    this.records.set(broadcastId, { ...record, status: to, ...(to === "done" || to === "cancelled" ? { finishedAt: at } : {}) });
    return true;
  }

  async claim(broadcastId: string, limit: number): Promise<Recipient[]> {
    const taken: Recipient[] = [];
    for (const [accountId, delivery] of this.deliveries.get(broadcastId) ?? []) {
      if (taken.length >= limit) break;
      if (delivery.status !== "queued" || delivery.claimed) continue;
      delivery.claimed = true;
      taken.push({ accountId, platformUserId: this.userIds.get(accountId) ?? "" });
    }
    return taken;
  }

  async record(broadcastId: string, accountId: string, result: DeliveryResult): Promise<void> {
    const delivery = this.row(broadcastId, accountId);
    delivery.status = result.status;
    delivery.error = result.status === "failed" ? result.error : null;
    delivery.claimed = false;
  }

  async release(broadcastId: string, accountIds: readonly string[]): Promise<void> {
    for (const accountId of accountIds) this.row(broadcastId, accountId).claimed = false;
  }

  async defer(broadcastId: string, accountId: string): Promise<number> {
    const delivery = this.row(broadcastId, accountId);
    delivery.attempts += 1;
    delivery.claimed = false;
    return delivery.attempts;
  }

  async stats(broadcastId: string): Promise<DeliveryStats> {
    const stats: DeliveryStats = { queued: 0, sent: 0, blocked: 0, failed: 0, blockedAfter: 0 };
    for (const delivery of this.deliveries.get(broadcastId)?.values() ?? []) stats[delivery.status] += 1;
    return stats;
  }

  async sending(): Promise<string[]> {
    return [...this.records.values()].filter((record) => record.status === "sending").map((record) => record.broadcastId);
  }

  row(broadcastId: string, accountId: string): Delivery {
    const delivery = this.deliveries.get(broadcastId)?.get(accountId);
    if (delivery === undefined) throw new Error(`нет доставки ${broadcastId}/${accountId}`);
    return delivery;
  }
}
