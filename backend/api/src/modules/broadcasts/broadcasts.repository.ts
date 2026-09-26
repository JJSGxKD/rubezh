import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { segmentSchema, type Milestone, type Segment } from "./segment.js";

/**
 * Хранилище рассылок (docs/29-admin-panel.md §7). Аудитория считается и
 * набирается одним и тем же условием (`segmentWhere`): оценка в панели и
 * список получателей на старте не расходятся.
 */

export type BroadcastStatus = "draft" | "sending" | "paused" | "done" | "cancelled";

export interface BroadcastRecord {
  broadcastId: string;
  title: string;
  platform: PlatformId;
  text: string;
  buttonText: string | null;
  buttonUrl: string | null;
  linkCode: string | null;
  segment: Segment;
  status: BroadcastStatus;
  audience: number | null;
  createdBy: string;
  approvedBy: string | null;
  startedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface NewBroadcast {
  broadcastId: string;
  title: string;
  platform: PlatformId;
  text: string;
  buttonText: string | null;
  buttonUrl: string | null;
  linkCode: string | null;
  segment: Segment;
  createdBy: string;
}

/** Что меняется в черновике: текст, кнопка без ссылки — ссылка заводится при создании, аудитория. */
export type DraftPatch = Pick<NewBroadcast, "title" | "text" | "segment"> & { buttonText: string | null };

export interface Recipient {
  accountId: string;
  platformUserId: string;
}

export interface DeliveryStats {
  queued: number;
  sent: number;
  blocked: number;
  failed: number;
  /** получили и заблокировали бота после рассылки — главный показатель, не переборщили ли */
  blockedAfter: number;
}

export type DeliveryResult = { status: "sent" | "blocked"; at: Date } | { status: "failed"; error: string };

export const BROADCASTS_REPOSITORY = Symbol("BROADCASTS_REPOSITORY");

export interface BroadcastsRepository {
  create(input: NewBroadcast): Promise<BroadcastRecord>;
  /** Правка черновика; одобрение при этом снимается. `null` — не черновик или нет такой. */
  updateDraft(broadcastId: string, patch: DraftPatch): Promise<BroadcastRecord | null>;
  byId(broadcastId: string): Promise<BroadcastRecord | null>;
  list(limit: number): Promise<BroadcastRecord[]>;
  /** Одобрить черновик; `false` — уже не черновик. */
  approve(broadcastId: string, accountId: string): Promise<boolean>;
  /** Сколько получателей у сегмента сейчас. */
  count(platform: PlatformId, segment: Segment): Promise<number>;
  /**
   * Старт: черновик становится отправляемым и набирает получателей одной
   * транзакцией. `null` — уже не черновик: второй старт никого не добавит.
   */
  start(broadcastId: string, startedBy: string, at: Date): Promise<number | null>;
  /** Сменить состояние, если оно сейчас одно из `from`. */
  transition(broadcastId: string, from: readonly BroadcastStatus[], to: BroadcastStatus, at: Date): Promise<boolean>;
  /** Взять следующих получателей на `claimSec`: второе задание очереди их не увидит. */
  claim(broadcastId: string, limit: number, claimSec: number): Promise<Recipient[]>;
  record(broadcastId: string, accountId: string, result: DeliveryResult): Promise<void>;
  /** Отпустить взятых, но не обработанных: пачка оборвалась. */
  release(broadcastId: string, accountIds: readonly string[]): Promise<void>;
  /** Площадка попросила подождать: получатель отпускается, счётчик отсрочек растёт. Возвращает счётчик. */
  defer(broadcastId: string, accountId: string): Promise<number>;
  stats(broadcastId: string): Promise<DeliveryStats>;
  /** Идущие рассылки — поднять после перезапуска. */
  sending(): Promise<string[]>;
}

type BroadcastRow = Prisma.BroadcastGetPayload<object>;

/** Колонки вех — белый список: ключ из панели в SQL не попадает. */
const MILESTONE_COLUMNS: Record<Milestone, string> = {
  entered: "entered_at",
  app_opened: "app_opened_at",
  first_run_started: "first_run_started_at",
  first_run_finished: "first_run_finished_at",
  runs_2: "runs_2_at",
  runs_5: "runs_5_at",
  returned_d1: "returned_d1_at",
  returned_d7: "returned_d7_at",
  first_purchase: "first_purchase_at",
};

/**
 * Условие аудитории. Всегда: площадка рассылки, писать можно, не заблокирован.
 * Без строки воронки или первого касания аккаунт не проходит фильтры по ним:
 * «не прошёл веху» для него верно, «пришёл по кампании» — нет.
 */
export function segmentWhere(platform: PlatformId, segment: Segment): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`a.platform = ${platform}::"Platform"`, Prisma.sql`a.banned_at IS NULL`, Prisma.sql`m.can_message`];
  if (segment.startKinds.length > 0) conditions.push(Prisma.sql`q.first_start_kind::text IN (${Prisma.join(segment.startKinds)})`);
  if (segment.campaign !== undefined) {
    conditions.push(Prisma.sql`q.first_start_kind = 'click' AND EXISTS (
      SELECT 1 FROM link_click lc JOIN link l ON l.code = lc.link_code
      WHERE lc.click_id = q.first_start_ref AND l.campaign = ${segment.campaign})`);
  }
  for (const milestone of segment.reached) conditions.push(Prisma.sql`f.${Prisma.raw(MILESTONE_COLUMNS[milestone])} IS NOT NULL`);
  for (const milestone of segment.notReached) conditions.push(Prisma.sql`f.${Prisma.raw(MILESTONE_COLUMNS[milestone])} IS NULL`);
  if (segment.registeredWithinDays !== undefined) conditions.push(Prisma.sql`a.created_at >= now() - make_interval(days => ${segment.registeredWithinDays}::int)`);
  if (segment.activeWithinDays !== undefined) conditions.push(Prisma.sql`a.last_seen_at >= now() - make_interval(days => ${segment.activeWithinDays}::int)`);
  if (segment.inactiveForDays !== undefined) conditions.push(Prisma.sql`a.last_seen_at < now() - make_interval(days => ${segment.inactiveForDays}::int)`);
  if (segment.skipRecentDays > 0) {
    conditions.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM broadcast_delivery d
      WHERE d.account_id = a.account_id AND d.status = 'sent' AND d.sent_at >= now() - make_interval(days => ${segment.skipRecentDays}::int))`);
  }
  return Prisma.sql`
    FROM account a
    JOIN account_messaging m ON m.account_id = a.account_id
    LEFT JOIN account_funnel f ON f.account_id = a.account_id
    LEFT JOIN acquisition q ON q.account_id = a.account_id
    WHERE ${Prisma.join(conditions, " AND ")}`;
}

@Injectable()
export class PrismaBroadcastsRepository implements BroadcastsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async create(input: NewBroadcast): Promise<BroadcastRecord> {
    return toRecord(await this.prisma.broadcast.create({ data: { ...input, segment: input.segment } }));
  }

  async updateDraft(broadcastId: string, patch: DraftPatch): Promise<BroadcastRecord | null> {
    const { count } = await this.prisma.broadcast.updateMany({
      where: { broadcastId, status: "draft" },
      data: { title: patch.title, text: patch.text, buttonText: patch.buttonText, segment: patch.segment, approvedBy: null },
    });
    return count === 0 ? null : await this.byId(broadcastId);
  }

  async byId(broadcastId: string): Promise<BroadcastRecord | null> {
    const row = await this.prisma.broadcast.findUnique({ where: { broadcastId } });
    return row === null ? null : toRecord(row);
  }

  async list(limit: number): Promise<BroadcastRecord[]> {
    return (await this.prisma.broadcast.findMany({ orderBy: { createdAt: "desc" }, take: limit })).map(toRecord);
  }

  async approve(broadcastId: string, accountId: string): Promise<boolean> {
    const { count } = await this.prisma.broadcast.updateMany({ where: { broadcastId, status: "draft" }, data: { approvedBy: accountId } });
    return count > 0;
  }

  async count(platform: PlatformId, segment: Segment): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count ${segmentWhere(platform, segment)}`;
    return row?.count ?? 0;
  }

  async start(broadcastId: string, startedBy: string, at: Date): Promise<number | null> {
    return await this.prisma.$transaction(async (tx) => {
      const draft = await tx.$queryRaw<{ platform: PlatformId; segment: unknown }[]>`
        SELECT platform, segment FROM broadcast WHERE broadcast_id = ${broadcastId}::uuid AND status = 'draft' FOR UPDATE`;
      const row = draft[0];
      if (row === undefined) return null;
      const segment = segmentSchema.parse(row.segment);
      const audience = await tx.$executeRaw`
        INSERT INTO broadcast_delivery (broadcast_id, account_id)
        SELECT ${broadcastId}::uuid, a.account_id ${segmentWhere(row.platform, segment)}
        ON CONFLICT DO NOTHING`;
      await tx.broadcast.update({ where: { broadcastId }, data: { status: "sending", audience, startedBy, startedAt: at } });
      return audience;
    });
  }

  async transition(broadcastId: string, from: readonly BroadcastStatus[], to: BroadcastStatus, at: Date): Promise<boolean> {
    const finished = to === "done" || to === "cancelled";
    const { count } = await this.prisma.broadcast.updateMany({
      where: { broadcastId, status: { in: [...from] } },
      data: { status: to, ...(finished ? { finishedAt: at } : {}) },
    });
    return count > 0;
  }

  async claim(broadcastId: string, limit: number, claimSec: number): Promise<Recipient[]> {
    // SKIP LOCKED и срок захвата: два задания одной рассылки (перезапуск,
    // пауза и продолжение) берут разные строки, и игрок не получит дважды.
    return await this.prisma.$queryRaw<Recipient[]>`
      UPDATE broadcast_delivery d SET claimed_until = now() + make_interval(secs => ${claimSec}::int)
      FROM account a
      WHERE a.account_id = d.account_id AND (d.broadcast_id, d.account_id) IN (
        SELECT broadcast_id, account_id FROM broadcast_delivery
        WHERE broadcast_id = ${broadcastId}::uuid AND status = 'queued' AND (claimed_until IS NULL OR claimed_until < now())
        ORDER BY account_id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING d.account_id AS "accountId", a.platform_user_id AS "platformUserId"`;
  }

  async record(broadcastId: string, accountId: string, result: DeliveryResult): Promise<void> {
    await this.prisma.broadcastDelivery.update({
      where: { broadcastId_accountId: { broadcastId, accountId } },
      data: result.status === "failed" ? { status: "failed", error: result.error, claimedUntil: null } : { status: result.status, sentAt: result.at, claimedUntil: null },
    });
  }

  async release(broadcastId: string, accountIds: readonly string[]): Promise<void> {
    if (accountIds.length === 0) return;
    await this.prisma.broadcastDelivery.updateMany({ where: { broadcastId, accountId: { in: [...accountIds] }, status: "queued" }, data: { claimedUntil: null } });
  }

  async defer(broadcastId: string, accountId: string): Promise<number> {
    const row = await this.prisma.broadcastDelivery.update({
      where: { broadcastId_accountId: { broadcastId, accountId } },
      data: { attempts: { increment: 1 }, claimedUntil: null },
      select: { attempts: true },
    });
    return row.attempts;
  }

  async stats(broadcastId: string): Promise<DeliveryStats> {
    const [row] = await this.prisma.$queryRaw<DeliveryStats[]>`
      SELECT count(*) FILTER (WHERE d.status = 'queued')::int AS queued,
             count(*) FILTER (WHERE d.status = 'sent')::int AS sent,
             count(*) FILTER (WHERE d.status = 'blocked')::int AS blocked,
             count(*) FILTER (WHERE d.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE d.status = 'sent' AND m.reason = 'blocked' AND m.changed_at > d.sent_at)::int AS "blockedAfter"
      FROM broadcast_delivery d
      LEFT JOIN account_messaging m ON m.account_id = d.account_id
      WHERE d.broadcast_id = ${broadcastId}::uuid`;
    return row ?? { queued: 0, sent: 0, blocked: 0, failed: 0, blockedAfter: 0 };
  }

  async sending(): Promise<string[]> {
    return (await this.prisma.broadcast.findMany({ where: { status: "sending" }, select: { broadcastId: true } })).map((row) => row.broadcastId);
  }
}

function toRecord(row: BroadcastRow): BroadcastRecord {
  return {
    broadcastId: row.broadcastId,
    title: row.title,
    platform: row.platform,
    text: row.text,
    buttonText: row.buttonText,
    buttonUrl: row.buttonUrl,
    linkCode: row.linkCode,
    // JSON из базы — данные с границы: разбирается той же схемой, что и ввод панели.
    segment: segmentSchema.parse(row.segment),
    status: row.status,
    audience: row.audience,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    startedBy: row.startedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
