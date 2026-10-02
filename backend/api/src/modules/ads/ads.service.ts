import { randomBytes, randomInt } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { CREATIVE_VIEW_SEC, PLACE_FORMAT, blockReaches, type AdFormat } from "./ad-networks.js";
import { eligibleBlocks, networksOf, servable, viaApi } from "./ad-blocks.js";
import { AD_CREATIVES, type AdCreative, type AdCreativeSource, type AdRequester } from "./ad-creatives.js";
import { AdNetworkKeys } from "./ad-network-keys.js";
import { AdPasses } from "./ads-passes.js";
import { AdCooldownError, AdNotCompletedError, AdSessionClosedError } from "./ads-errors.js";
import {
  CLAIM_WINDOW_MIN,
  PLACE_RULES,
  SESSION_TTL_MIN,
  networkOrder,
  nextAllowedAt,
  nextRewardAt,
  placeState,
  type AdDevice,
  type AdPlace,
  type AdSuccess,
} from "./ads-rules.js";
import {
  ADS_REPOSITORY,
  type AdBlockRow,
  type AdOutcome,
  type AdReport,
  type AdSessionRow,
  type AdsRepository,
  type ClaimVerdict,
  type NewAdSession,
  type PlaceHistory,
} from "./ads.repository.js";

/**
 * Реклама (docs/35-stage4-plan.md §3.7, WP12): какую сеть и какой блок
 * показать игроку в месте, воронка показа и забор награды.
 *
 * Модуль ручается только за показ. Награду выдаёт хозяин места — колесо,
 * забег, задания, — забирая выполненную сессию через `claim`: один забор на
 * сессию и кулдаун места проверяются здесь, а что дать — у хозяина, ключом
 * сессии в журнале кошелька.
 *
 * У кого есть пропуск (VIP, §3.6), тому сессия места выдаётся сразу
 * выполненной — без сети и ролика, но после кулдауна места: хозяин забирает
 * её как обычную и ничего о VIP не знает. Межстраничной у него нет вовсе.
 *
 * Сеть с API (Taddy, Р78) отдаёт креатив серверу ещё при выдаче: нет
 * креатива — выдача тут же идёт к следующей сети, а игрок не ждёт отказа
 * клиента. Показ и досмотр такого креатива сервер сообщает сети сам.
 */

const DB_TIMEOUT_MS = 3_000;
/** Блоки меняются из панели редко, а спрашиваются на каждый показ. */
const BLOCKS_TTL_MS = 30_000;
const MINUTE_MS = 60_000;

/** Бросок: целое от нуля до `bound`, не включая. В тестах — предсказуемый. */
export type AdsRoll = (bound: number) => number;
export const ADS_ROLL = Symbol("ADS_ROLL");
export const cryptoRoll: AdsRoll = (bound) => randomInt(bound);

/** Кто просит показ: блок может быть только для части площадок и устройств. */
export interface AdViewer {
  accountId: string;
  platform: PlatformId;
  /** не знаем устройства — блоки с ограничением по устройству не предлагаются */
  device: AdDevice | null;
  /** что нужно сети с API для гео и антифрода; нет — такая сеть креатива не даст */
  requester?: AdRequester;
}

/** Креатив для нашего рекламного блока и через сколько секунд на экране он досмотрен. */
export interface AdCreativeShow {
  ad: AdCreative;
  viewSec: number;
}

export type AdOffer =
  | {
      available: true;
      sessionId: string;
      /** сеть показа; у пропуска — его имя */
      network: string;
      /** идентификатор блока в кабинете сети — его ждёт SDK; `null` — у пропуска и у формата без блока */
      blockId: string | null;
      /** что показать: видео за награду, межстраничную или задание — по месту */
      format: AdFormat;
      /** публичные ключи сети (pubId, appId) — SDK ждёт их вместе с блоком; у пропуска пусто */
      keys: Record<string, string>;
      success: AdSuccess;
      expiresAt: string;
      /** ролик не нужен — сессия уже выполнена, её сразу забирают у хозяина места (VIP) */
      pass: string | null;
      /** тестовые показы сети — по настройке из панели; такой показ сеть не засчитывает */
      debug: boolean;
      /** креатив сети с API — его рисует наш рекламный блок, а не SDK; `null` — показывает SDK */
      creative: AdCreativeShow | null;
    }
  /**
   * `no_fill` — ни одного подходящего блока; `cooldown` — место отдыхает до
   * `retryAt`; `pass` — рекламы без награды игроку с пропуском не показывают.
   */
  | { available: false; reason: "no_fill" | "cooldown" | "pass"; retryAt: string | null };

export interface AdReadiness {
  available: boolean;
  /** когда пройдёт кулдаун места; `null` — уже можно */
  readyAt: Date | null;
  /** награда будет без ролика (VIP); `null` — нужен показ */
  pass: string | null;
}

@Injectable()
export class AdsService {
  private readonly logger = new Logger("ads");
  private cache: { blocks: AdBlockRow[]; until: number } | null = null;

  constructor(
    @Inject(ADS_REPOSITORY) private readonly repository: AdsRepository,
    @Inject(ADS_ROLL) private readonly roll: AdsRoll,
    private readonly passes: AdPasses,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(AD_CREATIVES) private readonly creatives: AdCreativeSource,
    private readonly keys: AdNetworkKeys,
  ) {}

  async offer(viewer: AdViewer, place: AdPlace, at = new Date()): Promise<AdOffer> {
    const [history, pass] = await Promise.all([this.db(this.repository.history(viewer.accountId, place, at)), this.db(this.passes.of(viewer.accountId, at))]);
    if (pass !== null && !PLACE_RULES[place].rewarded) return this.unavailable(viewer, place, "pass", null);
    const state = placeState(history.sessions, history.dayStart, at);
    const retryAt = nextAllowedAt(place, state, at);
    if (retryAt !== null) return this.unavailable(viewer, place, "cooldown", retryAt);
    if (pass !== null) return await this.passOffer(viewer, place, pass, at);

    const blocks = eligibleBlocks(await this.blocks(), place, viewer);
    for (const network of networkOrder(networksOf(blocks), state.seenAt, state.lastRewardedToday)) {
      // Внутри сети — случайный блок: у сети может быть несколько блоков места,
      // и ни один не должен выгорать по частоте раньше других.
      const own = blocks.filter((block) => block.networkKey === network.networkKey);
      const block = own[this.roll(own.length)] ?? own[0];
      if (block === undefined) continue;
      const session = this.newSession(viewer, place, block, at);
      if (!viaApi(block, place)) return await this.open(session, null);

      const fetched = await this.creatives.fetch(block.networkKey, block.networkKeys, viewer.requester ?? null);
      if (fetched.kind === "creative") {
        const viewSec = CREATIVE_VIEW_SEC[PLACE_FORMAT[place] === "interstitial" ? "interstitial" : "rewarded"];
        return await this.open({ ...session, creative: { id: fetched.creative.id, viewSec } }, { ad: fetched.creative, viewSec });
      }
      // Отказ — сессией: сеть уходит на паузу места, как отказавшая на клиенте.
      await this.db(this.repository.createFailedSession(session, fetched.reason));
      this.log({ event: "ad_failed", accountId: viewer.accountId, place, network: block.networkKey, reason: fetched.reason });
    }
    return this.unavailable(viewer, place, "no_fill", null);
  }

  private newSession(viewer: AdViewer, place: AdPlace, block: AdBlockRow, at: Date): NewAdSession {
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MIN[block.success] * MINUTE_MS);
    return { sessionId: randomBytes(12).toString("base64url"), accountId: viewer.accountId, place, block, creative: null, createdAt: at, expiresAt };
  }

  private async open(session: NewAdSession, creative: AdCreativeShow | null): Promise<AdOffer> {
    const { block } = session;
    await this.db(this.repository.createSession(session));
    this.log({ event: "ad_offered", accountId: session.accountId, place: session.place, network: block.networkKey, success: block.success });
    return {
      available: true,
      sessionId: session.sessionId,
      network: block.networkKey,
      blockId: block.externalId,
      format: PLACE_FORMAT[session.place],
      // Ключи нужны SDK; креатив рисуем сами, и сети его показ сообщает сервер.
      keys: creative === null ? block.networkKeys : {},
      success: block.success,
      expiresAt: session.expiresAt.toISOString(),
      pass: null,
      debug: this.settings.get(SETTINGS.adsTestMode),
      creative,
    };
  }

  /** Сессия без ролика: выполнена сразу, окно забора — как у досмотренного показа. */
  private async passOffer(viewer: AdViewer, place: AdPlace, pass: string, at: Date): Promise<AdOffer> {
    const sessionId = randomBytes(12).toString("base64url");
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MIN.view * MINUTE_MS);
    await this.db(this.repository.createPassSession({ sessionId, accountId: viewer.accountId, place, pass, createdAt: at, expiresAt }));
    this.log({ event: "ad_passed", accountId: viewer.accountId, place, pass });
    return {
      available: true,
      sessionId,
      network: pass,
      blockId: null,
      format: PLACE_FORMAT[place],
      keys: {},
      success: "view",
      expiresAt: expiresAt.toISOString(),
      pass,
      debug: false,
      creative: null,
    };
  }

  /**
   * Шаг воронки от клиента. Засчитать выполнение он может только показу —
   * клик и целевое действие подтверждает сервер. Креатив, который рисуем
   * сами, досмотрен не раньше своего срока, а показ и досмотр узнаёт сеть.
   */
  async report(accountId: string, sessionId: string, outcome: AdOutcome, at = new Date(), requester: AdRequester | null = null): Promise<void> {
    const report = await this.db(this.repository.report(sessionId, accountId, outcome, at));
    if (report === null) throw new AdSessionClosedError();
    this.log({ event: `ad_${outcome.kind}`, accountId, ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}) });
    if (report.creativeId !== null) this.notifyNetwork(report, report.creativeId, outcome, requester);
  }

  /** Сети — мимо ответа игроку: ему её отметки ждать незачем, а их сбой ничего у него не отнимает. */
  private notifyNetwork(report: AdReport, creativeId: string, outcome: AdOutcome, requester: AdRequester | null): void {
    const tasks: Promise<void>[] = [];
    if (report.firstShown) tasks.push(this.creatives.shown(report.networkKey, creativeId, requester));
    if (outcome.kind === "completed") tasks.push(this.creatives.viewed(report.networkKey, creativeId, requester));
    for (const task of tasks) {
      task.catch((error: unknown) => this.log({ event: "network_notify_failed", network: report.networkKey, reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  /**
   * Забрать выполненную сессию места — для хозяина места. Повтор уже
   * забранной отдаёт её снова (`repeat`): запрос мог оборваться после забора,
   * и хозяин дожимает свою награду тем же ключом сессии. Поэтому ключ
   * награды у хозяина обязан включать `sessionId`.
   */
  async claim(accountId: string, sessionId: string, place: AdPlace, at = new Date()): Promise<{ session: AdSessionRow; repeat: boolean }> {
    const outcome = await this.db(this.repository.claim(sessionId, accountId, place, at, (session, history) => claimVerdict(session, history, at)));
    if (outcome.status === "not_completed") throw new AdNotCompletedError();
    if (outcome.status === "cooldown") throw new AdCooldownError(outcome.retryAt);
    if (!outcome.repeat) this.log({ event: "ad_claimed", accountId, place, network: outcome.session.networkKey });
    return { session: outcome.session, repeat: outcome.repeat };
  }

  /**
   * Готово ли место к рекламе — для экрана хозяина места: есть ли блоки для
   * площадки, когда пройдёт кулдаун и нужен ли ролик. Устройство экрану не
   * известно — окончательно решает выдача показа. С пропуском место с
   * наградой доступно и без единой сети.
   */
  async readiness(viewer: Pick<AdViewer, "accountId" | "platform">, place: AdPlace, at = new Date()): Promise<AdReadiness> {
    const [blocks, history, held] = await Promise.all([this.blocks(), this.db(this.repository.history(viewer.accountId, place, at)), this.db(this.passes.of(viewer.accountId, at))]);
    const pass = PLACE_RULES[place].rewarded ? held : null;
    const available = pass !== null || blocks.some((block) => block.place === place && servable(block) && blockReaches(block, viewer.platform));
    return { available, readyAt: nextAllowedAt(place, placeState(history.sessions, history.dayStart, at), at), pass };
  }

  /** Сеть или блок поменяли в панели — следующий показ берёт свежие. */
  forgetBlocks(): void {
    this.cache = null;
    this.keys.forget();
  }

  private async blocks(): Promise<AdBlockRow[]> {
    const now = Date.now();
    if (this.cache === null || this.cache.until <= now) {
      this.cache = { blocks: await this.db(this.repository.activeBlocks()), until: now + BLOCKS_TTL_MS };
    }
    return this.cache.blocks;
  }

  private unavailable(viewer: AdViewer, place: AdPlace, reason: "no_fill" | "cooldown" | "pass", retryAt: Date | null): AdOffer {
    this.log({ event: "ad_unavailable", accountId: viewer.accountId, place, reason });
    return { available: false, reason, retryAt: retryAt?.toISOString() ?? null };
  }

  private log(fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "ads", ...fields }));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "реклама");
  }
}

/** Можно ли забрать: условие успеха выполнено, окно забора не прошло, место не на кулдауне. */
export function claimVerdict(session: AdSessionRow, history: PlaceHistory, at: Date): ClaimVerdict {
  if (session.status !== "completed" || session.completedAt === null) return { kind: "not_completed" };
  if (at.getTime() - session.completedAt.getTime() > CLAIM_WINDOW_MIN[session.success] * MINUTE_MS) return { kind: "not_completed" };
  // Промежуток показов забору не мешает: сама забираемая сессия только что показана.
  const retryAt = nextRewardAt(session.place, placeState(history.sessions, history.dayStart, at), at);
  return retryAt === null ? { kind: "allow" } : { kind: "cooldown", retryAt };
}
