import type { AdPlace } from "../../src/modules/ads/ads-rules.js";
import type {
  AdBlockRow,
  AdOutcome,
  AdSessionRow,
  AdsRepository,
  ClaimOutcome,
  ClaimVerdict,
  NewAdSession,
  NewPassSession,
  PlaceHistory,
} from "../../src/modules/ads/ads.repository.js";

/**
 * Реклама в памяти для юнит-тестов (docs/17-testing-strategy.md §4.1): те же
 * условия, что в SQL, — открытая своя не истёкшая сессия, забор мест игрока
 * по одному. Сама блокировка и московские сутки базы проверяются
 * интеграционным тестом `ads.integration.test.ts`.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Начало московских суток: UTC+3 без перехода на летнее время. */
export function moscowDayStart(time: Date): Date {
  return new Date(Math.floor((time.getTime() + 3 * HOUR) / DAY) * DAY - 3 * HOUR);
}

type StoredSession = AdSessionRow & { expiresAt: Date; clickedAt: Date | null; failedAt: Date | null; failReason: string | null };

/** Репозиторий в памяти с теми же условиями, что SQL: открытая сессия, своя, не истёкшая. */
export class MemoryAds implements AdsRepository {
  blocks: AdBlockRow[] = [];
  readonly sessions: StoredSession[] = [];
  blockReads = 0;
  /** забор мест игрока — по одному, как под блокировкой в базе */
  private queue: Promise<unknown> = Promise.resolve();

  async activeBlocks(): Promise<AdBlockRow[]> {
    this.blockReads++;
    return this.blocks;
  }

  async history(accountId: string, place: AdPlace, time: Date): Promise<PlaceHistory> {
    const dayStart = moscowDayStart(time);
    const sessions = this.sessions
      .filter((session) => session.accountId === accountId && session.place === place && session.createdAt.getTime() >= dayStart.getTime() - DAY)
      .sort((a, b) => Number(b.claimedAt !== null) - Number(a.claimedAt !== null) || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 500);
    return { dayStart, sessions: sessions.map((session) => ({ ...session })) };
  }

  async createSession(session: NewAdSession): Promise<void> {
    this.sessions.push({
      sessionId: session.sessionId,
      accountId: session.accountId,
      place: session.place,
      networkKey: session.block.networkKey,
      success: session.block.success,
      status: "pending",
      createdAt: session.createdAt,
      shownAt: null,
      completedAt: null,
      claimedAt: null,
      expiresAt: session.expiresAt,
      clickedAt: null,
      failedAt: null,
      failReason: null,
    });
  }

  async createPassSession(session: NewPassSession): Promise<void> {
    this.sessions.push({
      sessionId: session.sessionId,
      accountId: session.accountId,
      place: session.place,
      networkKey: session.pass,
      success: "view",
      status: "completed",
      createdAt: session.createdAt,
      shownAt: null,
      completedAt: session.createdAt,
      claimedAt: null,
      expiresAt: session.expiresAt,
      clickedAt: null,
      failedAt: null,
      failReason: null,
    });
  }

  async report(sessionId: string, accountId: string, outcome: AdOutcome, time: Date): Promise<boolean> {
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId && candidate.accountId === accountId);
    if (session === undefined || session.expiresAt <= time || (session.status !== "pending" && session.status !== "shown")) return false;
    switch (outcome.kind) {
      case "shown":
        session.shownAt ??= time;
        session.status = "shown";
        return true;
      case "completed":
        if (session.success !== "view") return false;
        session.shownAt ??= time;
        session.completedAt = time;
        session.status = "completed";
        return true;
      case "clicked":
        session.clickedAt ??= time;
        return true;
      case "failed":
        session.failedAt = time;
        session.failReason = outcome.reason;
        session.status = "failed";
        return true;
    }
  }

  async claim(sessionId: string, accountId: string, place: AdPlace, time: Date, verdict: (session: AdSessionRow, history: PlaceHistory) => ClaimVerdict): Promise<ClaimOutcome> {
    const run = this.queue.then(async () => await this.claimLocked(sessionId, accountId, place, time, verdict));
    this.queue = run.catch(() => undefined);
    return await run;
  }

  private async claimLocked(sessionId: string, accountId: string, place: AdPlace, time: Date, verdict: (session: AdSessionRow, history: PlaceHistory) => ClaimVerdict): Promise<ClaimOutcome> {
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId && candidate.accountId === accountId && candidate.place === place);
    if (session === undefined) return { status: "not_completed" };
    if (session.claimedAt !== null) return { status: "claimed", session: { ...session }, repeat: true };
    const decision = verdict({ ...session }, await this.history(accountId, place, time));
    if (decision.kind === "not_completed") return { status: "not_completed" };
    if (decision.kind === "cooldown") return { status: "cooldown", retryAt: decision.retryAt };
    session.claimedAt = time;
    session.status = "claimed";
    return { status: "claimed", session: { ...session }, repeat: false };
  }

  /** Как выполнение подтвердил бы сервер: постбэк сети или свой редирект клика. */
  confirm(sessionId: string, time: Date): void {
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session === undefined) throw new Error(`нет сессии ${sessionId}`);
    session.completedAt = time;
    session.status = "completed";
  }
}

let blockNo = 0;
export function adBlock(networkKey: string, priority: number, overrides: Partial<AdBlockRow> = {}): AdBlockRow {
  blockNo++;
  return { blockId: `block-${String(blockNo)}`, networkKey, place: "wheel_spin", externalId: `${networkKey}-${String(blockNo)}`, success: "view", priority, platforms: [], devices: [], ...overrides };
}

