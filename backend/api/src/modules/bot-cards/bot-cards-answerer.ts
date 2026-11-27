import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import type { LiveCardAnswerer, LiveCardQuery } from "../../platforms/ports/live-card.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { BotCardEvents, type BotCardQuery } from "./bot-card-events.js";
import { BotCardKinds, type BotCardKind } from "./bot-card-kinds.js";
import { CARD_FLAGS, CARD_STATE_VERSION, REFRESH_ACTION, answerOf, parseQueryData, parseState, stateCacheKey } from "./bot-card-protocol.js";
import { BOT_CARDS_REPOSITORY, type BotCardsRepository } from "./bot-cards.repository.js";
import { BotCardsService } from "./bot-cards.service.js";

/**
 * Ответы на запросы из живых карточек (docs/35-stage4-plan.md Р199, tasks/T-0395): обновление фоном и
 * действие игрока. Площадка ждёт ответ на любой запрос, поэтому `answer` **всегда возвращает строку** до
 * 1024 байт и укладывается в `ANSWER_TIMEOUT_MS`: ошибка — тоже ответ (`err`), а не исключение.
 *
 * По порядку — от дешёвого к дорогому:
 * - не разобралось или версия не первая — `err: bad`; выключены сообщения нового поколения — `off`;
 * - нет аккаунта или он заблокирован — `err: auth`; нет карточки по сообщению или она закрыта — `x`;
 *   карточка чужая — `err: foreign`;
 * - выключены карточки (общий ключ, ключ вида) или площадка на паузе — `off`;
 * - лимит — `CARD_QUERY_LIMIT` на аккаунт; сверх него обновление отвечает из кэша с пометкой «устарело»,
 *   а действие — `err: limited`;
 * - обновление — состояние вида, кэш 30 секунд на аккаунт и вид; действие — только из `kind.actions`,
 *   дальше `kind.act`: деньги в ядре не живут, начисляет вид.
 *
 * Событие `bot_card_query` пишется после каждого ответа и не задерживает его.
 */

const ANSWER_TIMEOUT_MS = 8_000;
const CACHE_TTL_SEC = 30;
const REDIS_TIMEOUT_MS = 2_000;
/** Сбой Redis повторяется на каждом запросе — в лог не чаще раза в минуту. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/** Лимит запросов из карточек: 300 в час на аккаунт — и обновления фоном, и действия. */
export const CARD_QUERY_LIMIT: RateLimit = { scope: "bot-card", limit: 300, windowSec: 3600 };

interface Reply {
  text: string;
  outcome: BotCardQuery["outcome"];
}

/** Вид и действие для события: заполняются по мере того, как запрос доходит до карточки. */
interface Trace {
  card: string;
  action: string;
}

const reply = (object: Record<string, unknown>, outcome: Reply["outcome"], onTooBig?: () => void): Reply => {
  let big = false;
  const text = answerOf(object, () => {
    big = true;
    onTooBig?.();
  });
  return { text, outcome: big ? "error" : outcome };
};

@Injectable()
export class BotCardsAnswerer implements LiveCardAnswerer {
  private readonly logger = new Logger("bot-cards");
  private lastFailureLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(
    @Inject(SETTINGS_READER) private readonly panel: SettingsReader,
    // Токены — явно: у `Pick` в метаданных типов остаётся `Object`, и Nest не нашёл бы, что внедрять.
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byPlatformUser">,
    private readonly kinds: BotCardKinds,
    @Inject(BOT_CARDS_REPOSITORY) private readonly repository: Pick<BotCardsRepository, "byMessage">,
    @Inject(RateLimiter) private readonly limiter: Pick<RateLimiter, "consume">,
    @Inject(BotCardsService) private readonly cards: Pick<BotCardsService, "touch" | "unavailable">,
    @Inject(BotCardEvents) private readonly events: Pick<BotCardEvents, "queried">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "get" | "set" | "del">,
  ) {}

  async answer(query: LiveCardQuery): Promise<string> {
    const trace: Trace = { card: "unknown", action: "unknown" };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<Reply>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(JSON.stringify({ module: "bot-cards", event: "answer_timeout", card: trace.card, action: trace.action }));
        resolve(reply({ err: "timeout" }, "error"));
      }, ANSWER_TIMEOUT_MS);
    });
    // Ошибка — тоже ответ: площадка не должна ждать до своего срока. В лог — только имя ошибки, без данных игрока.
    const work = this.resolve(query, trace).catch((error: unknown) => {
      this.logger.warn(JSON.stringify({ module: "bot-cards", event: "answer_failed", card: trace.card, action: trace.action, reason: error instanceof Error ? error.name : "unknown" }));
      return reply({ err: "error" }, "error");
    });
    const answered = await Promise.race([work, deadline]);
    clearTimeout(timer);
    // Запись события ответ не задерживает; сбой записи `BotCardEvents` глотает сам.
    void this.events.queried({ card: trace.card, action: trace.action, outcome: answered.outcome, platform: query.platform }).catch(() => undefined);
    return answered.text;
  }

  private async resolve(query: LiveCardQuery, trace: Trace): Promise<Reply> {
    const parsed = parseQueryData(query.data);
    if (parsed === null || parsed.version !== CARD_STATE_VERSION) return reply({ err: "bad" }, "error");
    const refresh = parsed.action === REFRESH_ACTION;
    if (refresh) trace.action = "refresh";
    if (!this.panel.get(SETTINGS.botFormatsEnabled)) return reply({ [CARD_FLAGS.off]: 1 }, "off");

    const account = await this.accounts.byPlatformUser(query.platform, query.platformUserId);
    if (account === null || account.bannedAt !== null) return reply({ err: "auth" }, "error");
    const card = query.ref === null ? null : await this.repository.byMessage(query.platform, query.ref.chatId, query.ref.messageId);
    if (card === null) return reply({ [CARD_FLAGS.closed]: 1 }, "error");
    trace.card = card.kind;
    if (card.accountId !== account.accountId) return reply({ err: "foreign" }, "error");
    const kind = this.kinds.get(card.kind);
    // Закрытая и карточка вида, которого здесь больше нет, для игрока одно и то же: она своё отжила.
    if (card.closedAt !== null || kind === undefined) return reply({ [CARD_FLAGS.closed]: 1 }, "error");
    if (kind.actions.includes(parsed.action)) trace.action = parsed.action;
    if (await this.cards.unavailable(account.platform, kind)) return reply({ [CARD_FLAGS.off]: 1 }, "off");

    const allowed = await this.limiter.consume(CARD_QUERY_LIMIT, account.accountId);
    if (!allowed) {
      if (!refresh) return reply({ err: "limited" }, "limited");
      return reply({ ...((await this.cached(account.accountId, kind)) ?? {}), [CARD_FLAGS.stale]: 1 }, "limited");
    }
    if (refresh) return await this.refresh(account.accountId, kind);
    if (!kind.actions.includes(parsed.action) || kind.act === undefined) return reply({ err: "bad" }, "error");

    const done = await kind.act({ accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId }, parsed.action, parsed.arg, new Date());
    // Действие уже сделано (деньги начислены): сбой кэша или правки ответ не портит.
    await this.forget(account.accountId, kind);
    await this.cards.touch(account.accountId, kind.kind).catch((error: unknown) => this.warnRedis("touch_failed", error));
    return reply({ res: done.outcome, ...done.result }, done.outcome, () => this.tooBig(trace));
  }

  /** Обновление: кэш 30 секунд на аккаунт и вид, чтобы фоновые запросы не ходили за состоянием каждый раз. */
  private async refresh(accountId: string, kind: BotCardKind): Promise<Reply> {
    const hit = await this.readCache(accountId, kind.kind);
    if (hit !== null) return { text: hit, outcome: "ok" };
    const answered = reply(await kind.state(accountId, new Date()), "ok", () => this.tooBig({ card: kind.kind, action: "refresh" }));
    if (answered.outcome === "ok") await this.writeCache(accountId, kind.kind, answered.text);
    return answered;
  }

  private async cached(accountId: string, kind: BotCardKind): Promise<Record<string, unknown> | null> {
    const hit = await this.readCache(accountId, kind.kind);
    return hit === null ? null : parseState(hit);
  }

  private async readCache(accountId: string, kind: string): Promise<string | null> {
    try {
      const hit = await withTimeout(this.redis.get(stateCacheKey(accountId, kind)), REDIS_TIMEOUT_MS, "кэш состояния карточки");
      // Чужая или битая строка — как отсутствующая: ответом она быть не может.
      return hit !== null && parseState(hit) !== null ? hit : null;
    } catch (error: unknown) {
      this.warnRedis("cache_unreadable", error);
      return null;
    }
  }

  private async writeCache(accountId: string, kind: string, text: string): Promise<void> {
    try {
      await withTimeout(this.redis.set(stateCacheKey(accountId, kind), text, "EX", CACHE_TTL_SEC), REDIS_TIMEOUT_MS, "кэш состояния карточки");
    } catch (error: unknown) {
      this.warnRedis("cache_unwritable", error);
    }
  }

  /** После действия состояние другое: кэш нужно сбросить, иначе следующее обновление вернёт прежнее. */
  private async forget(accountId: string, kind: BotCardKind): Promise<void> {
    try {
      await withTimeout(this.redis.del(stateCacheKey(accountId, kind.kind)), REDIS_TIMEOUT_MS, "кэш состояния карточки");
    } catch (error: unknown) {
      this.warnRedis("cache_not_cleared", error);
    }
  }

  private tooBig(trace: Trace): void {
    this.logger.warn(JSON.stringify({ module: "bot-cards", event: "card_answer_too_big", card: trace.card, action: trace.action }));
  }

  private warnRedis(event: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureLoggedAt = now;
    this.logger.warn(JSON.stringify({ module: "bot-cards", event, reason: error instanceof Error ? error.message : String(error) }));
  }
}
