import type { AdCreative, AdCreativeSource, AdRequester, CreativeFetch } from "../../src/modules/ads/ad-creatives.js";
import type { AdPlace } from "../../src/modules/ads/ads-rules.js";
import { formatFor, profileOf } from "../../src/modules/ads/ad-networks.js";
import { InterstitialGate, type FlagReader } from "../../src/modules/ads/interstitial-gate.js";
import type { InterstitialFacts } from "../../src/modules/ads/interstitial-policy.js";
import type { SettingsReader } from "../../src/modules/settings/settings.service.js";
import type {
  AdBlockRow,
  AdOutcome,
  AdReport,
  AdSessionRow,
  AdsRepository,
  ClaimOutcome,
  ClaimVerdict,
  InterstitialQuery,
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

type StoredSession = AdSessionRow & {
  expiresAt: Date;
  clickedAt: Date | null;
  failedAt: Date | null;
  failReason: string | null;
  creativeId: string | null;
  viewSec: number | null;
};

/** Репозиторий в памяти с теми же условиями, что SQL: открытая сессия, своя, не истёкшая. */
export class MemoryAds implements AdsRepository {
  blocks: AdBlockRow[] = [];
  /** ключи всех сетей, включённых и нет — как `ad_network.keys` */
  networks: { networkKey: string; keys: Record<string, string> }[] = Object.entries(NETWORK_KEYS).map(([networkKey, keys]) => ({ networkKey, keys: { ...keys } }));
  readonly sessions: StoredSession[] = [];
  /** аккаунт → первый вход; нет записи — аккаунт заведён давно, новичком не считается */
  readonly signups = new Map<string, Date>();
  /** законченные забеги — для счёта межстраничной */
  readonly runs: { accountId: string; finishedAt: Date; survivalSec: number }[] = [];
  /** оплаты звёздами */
  readonly purchases: { accountId: string; paidAt: Date }[] = [];
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
    this.push(session, "pending", null);
  }

  async createFailedSession(session: NewAdSession, reason: string): Promise<void> {
    this.push(session, "failed", reason);
  }

  async networkKeys(): Promise<{ networkKey: string; keys: Record<string, string> }[]> {
    return this.networks.map((network) => ({ networkKey: network.networkKey, keys: { ...network.keys } }));
  }

  /** Те же счёты, что SQL: потолки, забеги не короче порога, сутки — по Москве. */
  async interstitialFacts(accountId: string, time: Date, query: InterstitialQuery): Promise<InterstitialFacts | null> {
    const signedUp = this.signups.get(accountId) ?? new Date(Date.UTC(2026, 0, 1));
    const lastShown = this.sessions
      .filter((session) => session.accountId === accountId && session.place === "interstitial" && session.shownAt !== null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const lastShownAt = lastShown?.shownAt ?? null;
    const counted = this.runs.filter((run) => run.accountId === accountId && run.survivalSec >= query.countedRunSec);
    const latest = (dates: (Date | null)[]): Date | null => dates.reduce<Date | null>((best, date) => (date !== null && (best === null || date > best) ? date : best), null);
    return {
      daysSinceSignup: Math.round((moscowDayStart(time).getTime() - moscowDayStart(signedUp).getTime()) / DAY),
      countedRuns: Math.min(counted.length, query.newbieRuns),
      runsSinceShown: Math.min(counted.filter((run) => lastShownAt === null || run.finishedAt > lastShownAt).length, query.everyRuns),
      lastShownAt,
      lastPurchaseAt: latest(this.purchases.filter((purchase) => purchase.accountId === accountId).map((purchase) => purchase.paidAt)),
      lastRewardedAt: latest(
        this.sessions
          .filter((session) => session.accountId === accountId && query.rewardedPlaces.includes(session.place) && session.createdAt >= query.rewardedSince)
          .map((session) => session.shownAt),
      ),
    };
  }

  private push(session: NewAdSession, status: "pending" | "failed", failReason: string | null): void {
    this.sessions.push({
      sessionId: session.sessionId,
      accountId: session.accountId,
      place: session.place,
      networkKey: session.block.networkKey,
      success: session.block.success,
      status,
      createdAt: session.createdAt,
      shownAt: null,
      completedAt: null,
      claimedAt: null,
      expiresAt: session.expiresAt,
      clickedAt: null,
      failedAt: status === "failed" ? session.createdAt : null,
      failReason,
      creativeId: session.creative?.id ?? null,
      viewSec: session.creative?.viewSec ?? null,
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
      creativeId: null,
      viewSec: null,
    });
  }

  async report(sessionId: string, accountId: string, outcome: AdOutcome, time: Date): Promise<AdReport | null> {
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId && candidate.accountId === accountId);
    if (session === undefined || session.expiresAt <= time || (session.status !== "pending" && session.status !== "shown")) return null;
    const report = (firstShown: boolean): AdReport => ({ networkKey: session.networkKey, creativeId: session.creativeId, firstShown });
    switch (outcome.kind) {
      case "shown": {
        const first = session.shownAt === null;
        session.shownAt ??= time;
        session.status = "shown";
        return report(first);
      }
      case "completed": {
        if (session.success !== "view") return null;
        // Креатив, который рисуем сами, досмотрен не раньше своего срока от выдачи.
        if (session.viewSec !== null && session.createdAt.getTime() + session.viewSec * 1000 > time.getTime()) return null;
        const first = session.shownAt === null;
        session.shownAt ??= time;
        session.completedAt = time;
        session.status = "completed";
        return report(first);
      }
      case "clicked":
        session.clickedAt ??= time;
        return report(false);
      case "failed":
        session.failedAt = time;
        session.failReason = outcome.reason;
        session.status = "failed";
        return report(false);
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

/** Флаги для политики межстраничной: включённые ключи — у всех. */
export function flagsOn(...keys: string[]): FlagReader & { keys: Set<string> } {
  const on = new Set(keys);
  return { keys: on, isOn: async (key: string) => on.has(key) };
}

/** Привратник межстраничной над репозиторием в памяти; по умолчанию флаг выката включён у всех. */
export function interstitialGate(repository: MemoryAds, settings: SettingsReader, flags: FlagReader = flagsOn("ads.interstitial")): InterstitialGate {
  return new InterstitialGate(repository, flags, settings);
}

/** Рабочие ключи сетей — того вида, что ждёт профиль (`ad-networks.ts`). */
export const NETWORK_KEYS: Readonly<Record<string, Record<string, string>>> = {
  adsgram: {},
  adsonar: { appId: "app_133d2148" },
  richads: { pubId: "1001262", appId: "6023" },
  taddy: { pubId: "14cbeb980853dd416003462ca4db7c12" },
};

/** Идентификатор блока по примеру профиля, свой у каждого блока: `int-12345` → `int-7`; выбор из списка — сам пример. */
export function unitOf(networkKey: string, place: AdPlace, no: number): string | null {
  const profile = profileOf(networkKey);
  const unit = profile === undefined ? undefined : formatFor(profile, place)?.unit;
  if (unit === undefined || unit === null) return null;
  if (unit.options !== undefined) return unit.example;
  return /[0-9]+$/.test(unit.example) ? unit.example.replace(/[0-9]+$/, String(no)) : `${unit.example}_${String(no)}`;
}

let blockNo = 0;
/** Блок по профилю сети: идентификатор нужного вида, ключи сети, условие успеха формата места. */
export function adBlock(networkKey: string, priority: number, overrides: Partial<AdBlockRow> = {}): AdBlockRow {
  blockNo++;
  const place = overrides.place ?? "wheel_spin";
  const profile = profileOf(networkKey);
  const success = (profile === undefined ? undefined : formatFor(profile, place)?.success[0]) ?? "view";
  return {
    blockId: `block-${String(blockNo)}`,
    networkKey,
    place,
    externalId: unitOf(networkKey, place, blockNo),
    success,
    priority,
    networkKeys: NETWORK_KEYS[networkKey] ?? {},
    platforms: [],
    devices: [],
    ...overrides,
  };
}

/** Объявление сети с API — как его отдал бы Taddy. */
export const CREATIVE: AdCreative = {
  id: "taddy-ad-1",
  title: "Рубеж держит",
  description: null,
  text: "Текст объявления",
  image: "https://cdn.example/ad.png",
  icon: null,
  button: "Открыть",
  link: "https://t.me/example_bot?start=taddy",
  advertiser: "Taddy",
};

/** Сеть с API в памяти: что отдаёт на запрос креатива и какие отметки ей пришли. */
export class FakeCreatives implements AdCreativeSource {
  /** ответ на запрос креатива; по умолчанию — креатив есть */
  answer: (networkKey: string) => CreativeFetch = () => ({ kind: "creative", creative: CREATIVE });
  readonly requests: { networkKey: string; keys: Readonly<Record<string, string>>; requester: AdRequester | null; timeoutMs?: number }[] = [];
  readonly notes: { kind: "shown" | "viewed"; networkKey: string; creativeId: string; requester: AdRequester | null }[] = [];

  async fetch(networkKey: string, keys: Readonly<Record<string, string>>, requester: AdRequester | null, timeoutMs?: number): Promise<CreativeFetch> {
    this.requests.push({ networkKey, keys, requester, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    return this.answer(networkKey);
  }

  shown(networkKey: string, creativeId: string, requester: AdRequester | null): Promise<void> {
    this.notes.push({ kind: "shown", networkKey, creativeId, requester });
    return Promise.resolve();
  }

  viewed(networkKey: string, creativeId: string, requester: AdRequester | null): Promise<void> {
    this.notes.push({ kind: "viewed", networkKey, creativeId, requester });
    return Promise.resolve();
  }
}
