import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { type Tx } from "../wallet/wallet-ledger.js";
import { AD_DEVICES, AD_PLACES, AD_SUCCESS, type AdDevice, type AdPlace, type AdSuccess, type PlaceHistoryEntry } from "./ads-rules.js";

/**
 * Реклама в базе (docs/35-stage4-plan.md §3.7, WP12): сети, блоки мест и
 * сессии показа. Игровые сутки считает база — одна граница у всех реплик
 * (`common/game-day.ts`).
 */

export interface AdBlockRow {
  blockId: string;
  networkKey: string;
  place: AdPlace;
  /** `null` — формат без блока в кабинете: показ по ключам сети */
  externalId: string | null;
  success: AdSuccess;
  /** приоритет сети блока — место в круге */
  priority: number;
  /** публичные ключи сети — их ждёт SDK вместе с блоком */
  networkKeys: Record<string, string>;
  platforms: PlatformId[];
  devices: AdDevice[];
}

export const AD_SESSION_STATUSES = ["pending", "shown", "completed", "claimed", "failed", "expired"] as const;
export type AdSessionStatus = (typeof AD_SESSION_STATUSES)[number];

export interface AdSessionRow extends PlaceHistoryEntry {
  sessionId: string;
  accountId: string;
  place: AdPlace;
  success: AdSuccess;
  status: AdSessionStatus;
  completedAt: Date | null;
}

/** Что было у игрока в месте с начала вчерашних игровых суток — для паузы сетей и кулдауна. */
export interface PlaceHistory {
  /** начало текущих игровых суток */
  dayStart: Date;
  sessions: AdSessionRow[];
}

export interface NewAdSession {
  sessionId: string;
  accountId: string;
  place: AdPlace;
  block: AdBlockRow;
  createdAt: Date;
  expiresAt: Date;
}

/** Сессия без ролика: выполнена в момент выдачи, блока и сети нет — вместо сети имя пропуска. */
export interface NewPassSession {
  sessionId: string;
  accountId: string;
  place: AdPlace;
  pass: string;
  createdAt: Date;
  expiresAt: Date;
}

/** Что клиент сообщил о показе. `completed` — SDK подтвердил досмотр. */
export type AdOutcome = { kind: "shown" } | { kind: "completed" } | { kind: "clicked" } | { kind: "failed"; reason: string };

/** Решение хозяина правил о заборе — принимается под блокировкой места. */
export type ClaimVerdict = { kind: "allow" } | { kind: "not_completed" } | { kind: "cooldown"; retryAt: Date };

export type ClaimOutcome =
  /** `repeat` — сессию забрали раньше: хозяин места дожимает свою награду ключом сессии */
  | { status: "claimed"; session: AdSessionRow; repeat: boolean }
  | { status: "not_completed" }
  | { status: "cooldown"; retryAt: Date };

export const ADS_REPOSITORY = Symbol("ADS_REPOSITORY");

export interface AdsRepository {
  /** включённые блоки включённых сетей — все места разом: их немного, и сервис держит их в памяти */
  activeBlocks(): Promise<AdBlockRow[]>;
  history(accountId: string, place: AdPlace, at: Date): Promise<PlaceHistory>;
  createSession(session: NewAdSession): Promise<void>;
  /** сессия пропуска — сразу выполненная, забирается хозяином места как обычная */
  createPassSession(session: NewPassSession): Promise<void>;
  /** отметить шаг воронки; `false` — сессии нет, чужая, истекла или шаг уже невозможен */
  report(sessionId: string, accountId: string, outcome: AdOutcome, at: Date): Promise<boolean>;
  /**
   * Забрать сессию места. Забор мест игрока идёт по одному: история и решение
   * читаются под блокировкой, и две сессии разом не проскочат кулдаун.
   */
  claim(sessionId: string, accountId: string, place: AdPlace, at: Date, verdict: (session: AdSessionRow, history: PlaceHistory) => ClaimVerdict): Promise<ClaimOutcome>;
}

const blockSchema = z.object({
  block_id: z.string(),
  network_key: z.string(),
  place: z.enum(AD_PLACES),
  external_id: z.string().nullable(),
  success: z.enum(AD_SUCCESS),
  priority: z.number().int(),
  network_keys: z.record(z.string(), z.string()),
  platforms: z.array(z.enum(PLATFORM_IDS)),
  devices: z.array(z.enum(AD_DEVICES)),
});

const sessionSchema = z.object({
  session_id: z.string(),
  account_id: z.string(),
  place: z.enum(AD_PLACES),
  network_key: z.string(),
  success: z.enum(AD_SUCCESS),
  status: z.enum(AD_SESSION_STATUSES),
  created_at: z.date(),
  shown_at: z.date().nullable(),
  completed_at: z.date().nullable(),
  claimed_at: z.date().nullable(),
});

function toSession(raw: unknown): AdSessionRow {
  const row = sessionSchema.parse(raw);
  return {
    sessionId: row.session_id,
    accountId: row.account_id,
    place: row.place,
    networkKey: row.network_key,
    success: row.success,
    status: row.status,
    createdAt: row.created_at,
    shownAt: row.shown_at,
    completedAt: row.completed_at,
    claimedAt: row.claimed_at,
  };
}

const SESSION_COLUMNS = "session_id, account_id::text, place::text, network_key, success::text, status::text, created_at, shown_at, completed_at, claimed_at";

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

type Db = PrismaClient | Tx;

@Injectable()
export class PrismaAdsRepository implements AdsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async activeBlocks(): Promise<AdBlockRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT b.block_id::text, b.network_key, b.place::text, b.external_id, b.success::text, n.priority, n.keys AS network_keys,
             b.platforms::text[] AS platforms, b.devices::text[] AS devices
      FROM ad_block b JOIN ad_network n ON n.network_key = b.network_key
      WHERE b.active AND n.active`;
    return rows.map((raw) => {
      const row = blockSchema.parse(raw);
      return {
        blockId: row.block_id,
        networkKey: row.network_key,
        place: row.place,
        externalId: row.external_id,
        success: row.success,
        priority: row.priority,
        networkKeys: row.network_keys,
        platforms: row.platforms,
        devices: row.devices,
      };
    });
  }

  async history(accountId: string, place: AdPlace, at: Date): Promise<PlaceHistory> {
    return await historyWithin(this.prisma, accountId, place, at);
  }

  async createSession(session: NewAdSession): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, status, created_at, expires_at)
      VALUES (${session.sessionId}, ${session.accountId}::uuid, ${session.place}::"AdPlace", ${session.block.blockId}::uuid,
              ${session.block.networkKey}, ${session.block.success}::"AdSuccess", 'pending', ${session.createdAt}, ${session.expiresAt})`;
  }

  async createPassSession(session: NewPassSession): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, status, created_at, completed_at, expires_at)
      VALUES (${session.sessionId}, ${session.accountId}::uuid, ${session.place}::"AdPlace", NULL, ${session.pass}, 'view', 'completed',
              ${session.createdAt}, ${session.createdAt}, ${session.expiresAt})`;
  }

  async report(sessionId: string, accountId: string, outcome: AdOutcome, at: Date): Promise<boolean> {
    const open = `session_id = $1 AND account_id = $2::uuid AND expires_at > $3 AND status IN ('pending', 'shown')`;
    switch (outcome.kind) {
      case "shown":
        return (
          (await this.prisma.$executeRawUnsafe(
            `UPDATE ad_session SET shown_at = COALESCE(shown_at, $3), status = 'shown' WHERE ${open}`,
            sessionId,
            accountId,
            at,
          )) > 0
        );
      case "completed":
        // По ответу SDK засчитывается только показ: клик — своим редиректом,
        // целевое действие — постбэком сети (§3.7, «Доверие»).
        return (
          (await this.prisma.$executeRawUnsafe(
            `UPDATE ad_session SET shown_at = COALESCE(shown_at, $3), completed_at = $3, status = 'completed' WHERE ${open} AND success = 'view'`,
            sessionId,
            accountId,
            at,
          )) > 0
        );
      case "clicked":
        return (
          (await this.prisma.$executeRawUnsafe(`UPDATE ad_session SET clicked_at = COALESCE(clicked_at, $3) WHERE ${open}`, sessionId, accountId, at)) > 0
        );
      case "failed":
        return (
          (await this.prisma.$executeRawUnsafe(
            `UPDATE ad_session SET failed_at = $3, fail_reason = $4, status = 'failed' WHERE ${open}`,
            sessionId,
            accountId,
            at,
            outcome.reason,
          )) > 0
        );
    }
  }

  async claim(sessionId: string, accountId: string, place: AdPlace, at: Date, verdict: (session: AdSessionRow, history: PlaceHistory) => ClaimVerdict): Promise<ClaimOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ads:${accountId}:${place}`}))`;
      const [raw] = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT ${SESSION_COLUMNS} FROM ad_session WHERE session_id = $1 AND account_id = $2::uuid AND place = $3::"AdPlace"`,
        sessionId,
        accountId,
        place,
      );
      if (raw === undefined) return { status: "not_completed" };
      const session = toSession(raw);
      if (session.claimedAt !== null) return { status: "claimed", session, repeat: true };

      const decision = verdict(session, await historyWithin(tx, accountId, place, at));
      if (decision.kind === "not_completed") return { status: "not_completed" };
      if (decision.kind === "cooldown") return { status: "cooldown", retryAt: decision.retryAt };

      const [claimed] = await tx.$queryRawUnsafe<unknown[]>(
        `UPDATE ad_session SET claimed_at = $2, status = 'claimed' WHERE session_id = $1 AND status = 'completed' RETURNING ${SESSION_COLUMNS}`,
        sessionId,
        at,
      );
      return claimed === undefined ? { status: "not_completed" } : { status: "claimed", session: toSession(claimed), repeat: false };
    }, TX_OPTIONS);
  }
}

/**
 * Сессии места с начала вчерашних игровых суток: этого хватает и на часовую
 * паузу сети, и на кулдаун, переживающий полночь. Начало суток — полночь по
 * Москве, считает база. Окно — по выдаче: награды в местах с кулдауном
 * забирают в пределах часа после неё, а вчерашнюю награду сессии,
 * выданной позавчера в последний час, счёт вчерашних просто не увидит.
 *
 * Забранные идут первыми: сотни невостребованных выдач не вытеснят из
 * окна награду и не обнулят этим кулдаун.
 */
async function historyWithin(db: Db, accountId: string, place: AdPlace, at: Date): Promise<PlaceHistory> {
  const rows = await db.$queryRawUnsafe<{ day_start: unknown; session_id: unknown }[]>(
    `WITH day AS (SELECT (date_trunc('day', $3::timestamptz AT TIME ZONE $4) AT TIME ZONE $4) AS day_start)
     SELECT day.day_start, s.* FROM day LEFT JOIN LATERAL (
       SELECT ${SESSION_COLUMNS} FROM ad_session
       WHERE account_id = $1::uuid AND place = $2::"AdPlace" AND created_at >= day.day_start - interval '1 day'
       ORDER BY claimed_at IS NOT NULL DESC, created_at DESC LIMIT 500
     ) s ON true`,
    accountId,
    place,
    at,
    GAME_DAY_TIME_ZONE,
  );
  // Без сессий LEFT JOIN отдаёт одну строку с началом суток и пустыми полями сессии.
  const dayStart = z.date().parse(rows[0]?.day_start);
  return { dayStart, sessions: rows.filter((row) => row.session_id !== null).map(toSession) };
}
