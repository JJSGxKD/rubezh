import { randomBytes, randomInt } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { PLACE_FORMAT, blockShapeProblem, keysProblem, missingKeys, profileOf, type AdFormat } from "./ad-networks.js";
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
  type NetworkCandidate,
} from "./ads-rules.js";
import { ADS_REPOSITORY, type AdBlockRow, type AdOutcome, type AdSessionRow, type AdsRepository, type ClaimVerdict, type PlaceHistory } from "./ads.repository.js";

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
  ) {}

  async offer(viewer: AdViewer, place: AdPlace, at = new Date()): Promise<AdOffer> {
    const [history, pass] = await Promise.all([this.db(this.repository.history(viewer.accountId, place, at)), this.db(this.passes.of(viewer.accountId, at))]);
    if (pass !== null && !PLACE_RULES[place].rewarded) return this.unavailable(viewer, place, "pass", null);
    const state = placeState(history.sessions, history.dayStart, at);
    const retryAt = nextAllowedAt(place, state, at);
    if (retryAt !== null) return this.unavailable(viewer, place, "cooldown", retryAt);
    if (pass !== null) return await this.passOffer(viewer, place, pass, at);

    const blocks = eligibleBlocks(await this.blocks(), place, viewer);
    const [network] = networkOrder(networksOf(blocks), state.seenAt, state.lastRewardedToday);
    if (network === undefined) return this.unavailable(viewer, place, "no_fill", null);

    // Внутри сети — случайный блок: у сети может быть несколько блоков места,
    // и ни один не должен выгорать по частоте раньше других.
    const own = blocks.filter((block) => block.networkKey === network.networkKey);
    const block = own[this.roll(own.length)] ?? own[0];
    if (block === undefined) return this.unavailable(viewer, place, "no_fill", null);

    const sessionId = randomBytes(12).toString("base64url");
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MIN[block.success] * MINUTE_MS);
    await this.db(this.repository.createSession({ sessionId, accountId: viewer.accountId, place, block, createdAt: at, expiresAt }));
    this.log({ event: "ad_offered", accountId: viewer.accountId, place, network: block.networkKey, success: block.success });
    return {
      available: true,
      sessionId,
      network: block.networkKey,
      blockId: block.externalId,
      format: PLACE_FORMAT[place],
      keys: block.networkKeys,
      success: block.success,
      expiresAt: expiresAt.toISOString(),
      pass: null,
      debug: this.settings.get(SETTINGS.adsTestMode),
    };
  }

  /** Сессия без ролика: выполнена сразу, окно забора — как у досмотренного показа. */
  private async passOffer(viewer: AdViewer, place: AdPlace, pass: string, at: Date): Promise<AdOffer> {
    const sessionId = randomBytes(12).toString("base64url");
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MIN.view * MINUTE_MS);
    await this.db(this.repository.createPassSession({ sessionId, accountId: viewer.accountId, place, pass, createdAt: at, expiresAt }));
    this.log({ event: "ad_passed", accountId: viewer.accountId, place, pass });
    return { available: true, sessionId, network: pass, blockId: null, format: PLACE_FORMAT[place], keys: {}, success: "view", expiresAt: expiresAt.toISOString(), pass, debug: false };
  }

  /** Шаг воронки от клиента. Засчитать выполнение он может только показу — клик и целевое действие подтверждает сервер. */
  async report(accountId: string, sessionId: string, outcome: AdOutcome, at = new Date()): Promise<void> {
    if (!(await this.db(this.repository.report(sessionId, accountId, outcome, at)))) throw new AdSessionClosedError();
    this.log({ event: `ad_${outcome.kind}`, accountId, ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}) });
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
    const available = pass !== null || blocks.some((block) => block.place === place && (block.platforms.length === 0 || block.platforms.includes(viewer.platform)));
    return { available, readyAt: nextAllowedAt(place, placeState(history.sessions, history.dayStart, at), at), pass };
  }

  /** Сеть или блок поменяли в панели — следующий показ берёт свежие. */
  forgetBlocks(): void {
    this.cache = null;
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

/** Блоки места для площадки и устройства зрителя: пустой список площадок или устройств — везде. */
export function eligibleBlocks(blocks: readonly AdBlockRow[], place: AdPlace, viewer: Pick<AdViewer, "platform" | "device">): AdBlockRow[] {
  return blocks.filter(
    (block) =>
      block.place === place &&
      servable(block) &&
      (block.platforms.length === 0 || block.platforms.includes(viewer.platform)) &&
      (block.devices.length === 0 || (viewer.device !== null && block.devices.includes(viewer.device))),
  );
}

/**
 * Блок, который SDK сможет показать: он по профилю своей сети, и у сети
 * заданы ключи. Панель такого не сохранит, но блок, заведённый до профилей, —
 * мог: выдача его пропускает, а панель показывает, что с ним не так.
 */
export function servable(block: Pick<AdBlockRow, "networkKey" | "place" | "externalId" | "success" | "networkKeys">): boolean {
  const profile = profileOf(block.networkKey);
  if (profile === undefined || blockShapeProblem(block) !== null) return false;
  return missingKeys(profile, block.networkKeys).length === 0 && keysProblem(profile, block.networkKeys) === null;
}

function networksOf(blocks: readonly AdBlockRow[]): NetworkCandidate[] {
  const networks = new Map<string, NetworkCandidate>();
  for (const block of blocks) networks.set(block.networkKey, { networkKey: block.networkKey, priority: block.priority });
  return [...networks.values()];
}

/** Можно ли забрать: условие успеха выполнено, окно забора не прошло, место не на кулдауне. */
export function claimVerdict(session: AdSessionRow, history: PlaceHistory, at: Date): ClaimVerdict {
  if (session.status !== "completed" || session.completedAt === null) return { kind: "not_completed" };
  if (at.getTime() - session.completedAt.getTime() > CLAIM_WINDOW_MIN[session.success] * MINUTE_MS) return { kind: "not_completed" };
  // Промежуток показов забору не мешает: сама забираемая сессия только что показана.
  const retryAt = nextRewardAt(session.place, placeState(history.sessions, history.dayStart, at), at);
  return retryAt === null ? { kind: "allow" } : { kind: "cooldown", retryAt };
}
