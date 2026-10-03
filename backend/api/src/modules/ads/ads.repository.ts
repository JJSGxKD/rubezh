import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { type Tx } from "../wallet/wallet-ledger.js";
import { AD_DEVICES, AD_PLACES, AD_SUCCESS, CLAIM_WINDOW_MIN, type AdDevice, type AdPlace, type AdSuccess, type PlaceHistoryEntry } from "./ads-rules.js";
import type { InterstitialFacts } from "./interstitial-policy.js";

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
  /**
   * Креатив сети с API, который рисует наш блок: по `id` сервер сообщает сети
   * показ, а досмотр примет не раньше `viewSec` секунд после выдачи. `null` —
   * показывает SDK сети, досмотр подтверждает он.
   */
  creative: { id: string; viewSec: number } | null;
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

/** Принятый шаг: чья сессия и что сообщить сети, у которой креатив рисуем сами. */
export interface AdReport {
  networkKey: string;
  /** креатив сети с API; `null` — показывал SDK */
  creativeId: string | null;
  /** показ отмечен этим шагом впервые — сеть считает его один раз */
  firstShown: boolean;
}

/** Решение хозяина правил о заборе — принимается под блокировкой места. */
export type ClaimVerdict = { kind: "allow" } | { kind: "not_completed" } | { kind: "cooldown"; retryAt: Date };

export type ClaimOutcome =
  /** `repeat` — сессию забрали раньше: хозяин места дожимает свою награду ключом сессии */
  | { status: "claimed"; session: AdSessionRow; repeat: boolean }
  | { status: "not_completed" }
  | { status: "cooldown"; retryAt: Date };

/** Что считать, собирая факты для межстраничной: какие забеги и места и докуда остановить счёт. */
export interface InterstitialQuery {
  /** забег короче — не в счёт */
  countedRunSec: number;
  /** до скольких считать забеги всего — порог новичка */
  newbieRuns: number;
  /** до скольких считать забеги после последней межстраничной — N */
  everyRuns: number;
  /** места роликов за награду */
  rewardedPlaces: readonly AdPlace[];
  /** с какого времени искать ролик за награду — по выдаче, чтобы идти индексом */
  rewardedSince: Date;
}

/** Сессия задания сети: открытая — та же, что раньше; `created` — заведена этим вызовом. */
export interface TaskSessionOutcome {
  session: AdSessionRow;
  created: boolean;
}

/** Подтверждённое сетью задание; `repeat` — сессия выполнена раньше, но награда за неё ещё не выдана. */
export interface ConfirmedTask {
  session: AdSessionRow;
  repeat: boolean;
}

export const ADS_REPOSITORY = Symbol("ADS_REPOSITORY");

export interface AdsRepository {
  /** включённые блоки включённых сетей — все места разом: их немного, и сервис держит их в памяти */
  activeBlocks(): Promise<AdBlockRow[]>;
  history(accountId: string, place: AdPlace, at: Date): Promise<PlaceHistory>;
  createSession(session: NewAdSession): Promise<void>;
  /** сессия пропуска — сразу выполненная, забирается хозяином места как обычная */
  createPassSession(session: NewPassSession): Promise<void>;
  /**
   * Сеть с API не дала креатива — сессия сразу неудачная: сеть уходит на
   * паузу места, как отказавшая на клиенте, а воронка видит отказ.
   */
  createFailedSession(session: NewAdSession, reason: string): Promise<void>;
  /** отметить шаг воронки; `null` — сессии нет, чужая, истекла или шаг уже невозможен */
  report(sessionId: string, accountId: string, outcome: AdOutcome, at: Date): Promise<AdReport | null>;
  /** публичные ключи всех сетей — включённых и выключенных */
  networkKeys(): Promise<{ networkKey: string; keys: Record<string, string> }[]>;
  /** факты для политики межстраничной; `null` — аккаунта нет */
  interstitialFacts(accountId: string, at: Date, query: InterstitialQuery): Promise<InterstitialFacts | null>;
  /**
   * Забрать сессию места. Забор мест игрока идёт по одному: история и решение
   * читаются под блокировкой, и две сессии разом не проскочат кулдаун.
   */
  claim(sessionId: string, accountId: string, place: AdPlace, at: Date, verdict: (session: AdSessionRow, history: PlaceHistory) => ClaimVerdict): Promise<ClaimOutcome>;
  /**
   * Сессия задания сети в месте `task`: открытая сессия сети отдаётся снова,
   * новую заводит `create` по истории места — или не заводит (`null`).
   * Под той же блокировкой места, что забор: два экрана разом не заведут
   * две сессии, и обе не проскочат потолок хозяина.
   */
  openTask(accountId: string, networkKey: string, at: Date, create: (history: PlaceHistory) => NewAdSession | null): Promise<TaskSessionOutcome | null>;
  /**
   * Сеть подтвердила задание игрока: самая свежая открытая сессия сети
   * становится выполненной. Открытой нет, а выполненная не забрана — она
   * отдаётся снова (`repeat`): прошлая выдача награды сорвалась, и сеть
   * повторила подтверждение. `null` — подтверждать нечего.
   */
  confirmTask(accountId: string, networkKey: string, at: Date): Promise<ConfirmedTask | null>;
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

const reportSchema = z.object({ network_key: z.string(), creative_id: z.string().nullable(), first_shown: z.boolean().nullable() });

const networkKeysSchema = z.object({ network_key: z.string(), keys: z.record(z.string(), z.string()) });

const interstitialFactsSchema = z.object({
  days_since_signup: z.number().int(),
  counted_runs: z.number().int(),
  runs_since_shown: z.number().int(),
  last_shown_at: z.date().nullable(),
  last_purchase_at: z.date().nullable(),
  last_rewarded_at: z.date().nullable(),
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
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, status, created_at, expires_at, creative_id, view_sec)
      VALUES (${session.sessionId}, ${session.accountId}::uuid, ${session.place}::"AdPlace", ${session.block.blockId}::uuid,
              ${session.block.networkKey}, ${session.block.success}::"AdSuccess", 'pending', ${session.createdAt}, ${session.expiresAt},
              ${session.creative?.id ?? null}, ${session.creative?.viewSec ?? null}::smallint)`;
  }

  async createFailedSession(session: NewAdSession, reason: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, status, created_at, failed_at, fail_reason, expires_at)
      VALUES (${session.sessionId}, ${session.accountId}::uuid, ${session.place}::"AdPlace", ${session.block.blockId}::uuid,
              ${session.block.networkKey}, ${session.block.success}::"AdSuccess", 'failed', ${session.createdAt}, ${session.createdAt},
              ${reason}, ${session.expiresAt})`;
  }

  async networkKeys(): Promise<{ networkKey: string; keys: Record<string, string> }[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT network_key, keys FROM ad_network`;
    return rows.map((raw) => {
      const row = networkKeysSchema.parse(raw);
      return { networkKey: row.network_key, keys: row.keys };
    });
  }

  /**
   * Каждый счёт — индексом и с потолком: забеги игрока — по
   * `(account_id, finished_at)` до порога, сессии — по
   * `(account_id, place, created_at)` с конца до первой показанной. Покупки
   * игрока — все его строки: их единицы, и оплата бывает позже выставления
   * счёта. Игровые сутки считает база — та же граница, что у заданий.
   */
  async interstitialFacts(accountId: string, at: Date, query: InterstitialQuery): Promise<InterstitialFacts | null> {
    const [raw] = await this.prisma.$queryRawUnsafe<unknown[]>(
      `WITH last_shown AS (
         SELECT shown_at FROM ad_session
         WHERE account_id = $1::uuid AND place = 'interstitial' AND shown_at IS NOT NULL
         ORDER BY created_at DESC LIMIT 1
       )
       SELECT
         (($2::timestamptz AT TIME ZONE $3)::date - (a.created_at AT TIME ZONE $3)::date) AS days_since_signup,
         (SELECT count(*)::int FROM (
            SELECT 1 FROM run r WHERE r.account_id = a.account_id AND r.finished_at IS NOT NULL AND r.survival_sec >= $4 LIMIT $5
          ) counted) AS counted_runs,
         (SELECT count(*)::int FROM (
            SELECT 1 FROM run r
            WHERE r.account_id = a.account_id AND r.finished_at > COALESCE((SELECT shown_at FROM last_shown), '-infinity'::timestamptz) AND r.survival_sec >= $4
            LIMIT $6
          ) since) AS runs_since_shown,
         (SELECT shown_at FROM last_shown) AS last_shown_at,
         (SELECT max(p.paid_at) FROM purchase p WHERE p.account_id = a.account_id) AS last_purchase_at,
         (SELECT max(s.shown_at) FROM ad_session s WHERE s.account_id = a.account_id AND s.place = ANY($7::text[]::"AdPlace"[]) AND s.created_at >= $8) AS last_rewarded_at
       FROM account a WHERE a.account_id = $1::uuid`,
      accountId,
      at,
      GAME_DAY_TIME_ZONE,
      query.countedRunSec,
      query.newbieRuns,
      query.everyRuns,
      query.rewardedPlaces,
      query.rewardedSince,
    );
    if (raw === undefined) return null;
    const row = interstitialFactsSchema.parse(raw);
    return {
      daysSinceSignup: row.days_since_signup,
      countedRuns: row.counted_runs,
      runsSinceShown: row.runs_since_shown,
      lastShownAt: row.last_shown_at,
      lastPurchaseAt: row.last_purchase_at,
      lastRewardedAt: row.last_rewarded_at,
    };
  }

  async createPassSession(session: NewPassSession): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, status, created_at, completed_at, expires_at)
      VALUES (${session.sessionId}, ${session.accountId}::uuid, ${session.place}::"AdPlace", NULL, ${session.pass}, 'view', 'completed',
              ${session.createdAt}, ${session.createdAt}, ${session.expiresAt})`;
  }

  async report(sessionId: string, accountId: string, outcome: AdOutcome, at: Date): Promise<AdReport | null> {
    const open = `session_id = $1 AND account_id = $2::uuid AND expires_at > $3 AND status IN ('pending', 'shown')`;
    // Показ отмечен впервые, если после шага он равен его времени: прежний
    // COALESCE оставил бы более раннее. Так сеть узнаёт о показе один раз.
    const returning = `RETURNING network_key, creative_id, shown_at = $3 AS first_shown`;
    const step = async (sql: string, ...extra: unknown[]): Promise<AdReport | null> => {
      const [raw] = await this.prisma.$queryRawUnsafe<unknown[]>(sql, sessionId, accountId, at, ...extra);
      if (raw === undefined) return null;
      const row = reportSchema.parse(raw);
      return { networkKey: row.network_key, creativeId: row.creative_id, firstShown: row.first_shown === true };
    };
    switch (outcome.kind) {
      case "shown":
        return await step(`UPDATE ad_session SET shown_at = COALESCE(shown_at, $3), status = 'shown' WHERE ${open} ${returning}`);
      case "completed":
        // По ответу SDK засчитывается только показ: клик — своим редиректом,
        // целевое действие — постбэком сети (§3.7, «Доверие»). Креатив,
        // который рисуем сами, досмотрен не раньше своего срока от выдачи.
        return await step(
          `UPDATE ad_session SET shown_at = COALESCE(shown_at, $3), completed_at = $3, status = 'completed'
           WHERE ${open} AND success = 'view' AND (view_sec IS NULL OR created_at + make_interval(secs => view_sec) <= $3) ${returning}`,
        );
      case "clicked":
        return await step(`UPDATE ad_session SET clicked_at = COALESCE(clicked_at, $3) WHERE ${open} RETURNING network_key, creative_id, false AS first_shown`);
      case "failed":
        return await step(
          `UPDATE ad_session SET failed_at = $3, fail_reason = $4, status = 'failed' WHERE ${open} RETURNING network_key, creative_id, false AS first_shown`,
          outcome.reason,
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

  async openTask(accountId: string, networkKey: string, at: Date, create: (history: PlaceHistory) => NewAdSession | null): Promise<TaskSessionOutcome | null> {
    return await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ads:${accountId}:task`}))`;
      const [open] = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT ${SESSION_COLUMNS} FROM ad_session
         WHERE account_id = $1::uuid AND place = 'task' AND network_key = $2 AND status IN ('pending', 'shown') AND expires_at > $3
         ORDER BY created_at DESC LIMIT 1`,
        accountId,
        networkKey,
        at,
      );
      if (open !== undefined) return { session: toSession(open), created: false };
      const session = create(await historyWithin(tx, accountId, "task", at));
      if (session === null) return null;
      const [inserted] = await tx.$queryRawUnsafe<unknown[]>(
        `INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, status, created_at, expires_at)
         VALUES ($1, $2::uuid, 'task', $3::uuid, $4, $5::"AdSuccess", 'pending', $6, $7)
         RETURNING ${SESSION_COLUMNS}`,
        session.sessionId,
        accountId,
        session.block.blockId,
        session.block.networkKey,
        session.block.success,
        session.createdAt,
        session.expiresAt,
      );
      return { session: toSession(inserted), created: true };
    }, TX_OPTIONS);
  }

  async confirmTask(accountId: string, networkKey: string, at: Date): Promise<ConfirmedTask | null> {
    return await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ads:${accountId}:task`}))`;
      // Открытая — первой: она и есть только что выполненное задание.
      // Выполненная без забора — после: её подтверждение сеть повторила.
      const [raw] = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT ${SESSION_COLUMNS} FROM ad_session
         WHERE account_id = $1::uuid AND place = 'task' AND network_key = $2
           AND ((status IN ('pending', 'shown') AND expires_at > $3) OR (status = 'completed' AND completed_at > $3::timestamptz - make_interval(mins => $4::int)))
         ORDER BY status = 'completed', created_at DESC LIMIT 1`,
        accountId,
        networkKey,
        at,
        CLAIM_WINDOW_MIN.cpa,
      );
      if (raw === undefined) return null;
      const found = toSession(raw);
      if (found.status === "completed") return { session: found, repeat: true };
      const [done] = await tx.$queryRawUnsafe<unknown[]>(
        `UPDATE ad_session SET status = 'completed', completed_at = $2, shown_at = COALESCE(shown_at, $2)
         WHERE session_id = $1 AND status IN ('pending', 'shown') RETURNING ${SESSION_COLUMNS}`,
        found.sessionId,
        at,
      );
      return done === undefined ? null : { session: toSession(done), repeat: false };
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
