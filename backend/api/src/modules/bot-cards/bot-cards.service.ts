import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { AppLinks } from "../../platforms/ports/app-links.js";
import { LiveCards, type LiveCardPort } from "../../platforms/ports/live-card.js";
import { Messengers, type Messenger, type SendOutcome } from "../../platforms/ports/messenger.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { AccountSettingsService } from "../account-settings/account-settings.service.js";
import { ACCOUNT_REPOSITORY, type Account, type AccountRepository } from "../auth/account.repository.js";
import { BotMessageEvents } from "../bot-messages/bot-message-events.js";
import { BotMessagePolicy, type MessageOrigin } from "../bot-messages/bot-message-policy.js";
import { BotMessages } from "../bot-messages/bot-messages.service.js";
import { MessagingService } from "../messaging/messaging.service.js";
import { BotNotifyQueue } from "../notifications-bot/bot-notify-queue.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { BotCardKinds, type BotCardKind } from "./bot-card-kinds.js";
import { CARD_JOBS, acquireLock, encodeState, pacedJobId, pausedKey, releaseLock, sendJobSchema, sendLockKey, stateHash } from "./bot-card-protocol.js";
import { BOT_CARDS_REPOSITORY, type BotCardsRepository } from "./bot-cards.repository.js";

/**
 * Отправка живых карточек бота (docs/35-stage4-plan.md Р199, Р225, tasks/T-0395).
 * По порядку — от дешёвого к дорогому:
 *
 * - выключен `bot.formats.enabled` — `off`: бот пишет как до Р199;
 * - аккаунта нет, он заблокирован или у площадки нет бота — `skipped`; писать нельзя — `not_allowed`;
 * - карточка по триггеру при выключенном выборе игрока — `opted_out`; команду игрока выбор не касается;
 * - звук и тихие часы решает `BotMessagePolicy`; ночью отправка ждёт в очереди (`deferred`);
 * - лок на аккаунт и вид: две отправки разом — вторая `busy`; живая карточка вида одна и без лока —
 *   её держит индекс таблицы, а проигравший гонку закрывается сразу;
 * - карточка уходит, только если включены `bot.widget.enabled` и ключ вида, нет паузы площадки и порт
 *   вид поддерживает; иначе — запасное сообщение с тем же содержанием, а не тишина (Р225). Отказ площадки
 *   на методе карточек (`unsupported`) ставит паузу для всех реплик и тут же отдаёт запасное.
 *
 * Правки, перенос и финал уже отправленных карточек — `bot-cards.updater.ts`; ответы на запросы —
 * `bot-cards-answerer.ts`. Темп правок и отправок по триггерам общий с дублем уведомлений: те же
 * задания очереди `notifications-bot`, один лимитер.
 */

const TIMEOUT_MS = 3_000;
const SEND_LOCK_TTL_MS = 15_000;
/** Кнопка под карточкой и запасным сообщением: считает приход игрока по параметру запуска вида. */
const PLAY_BUTTON_TEXT = "▶ Играть";
/** Сбой Redis повторяется на каждом сообщении — в лог не чаще раза в минуту. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

export type CardSendResult = "sent" | "fallback" | "off" | "opted_out" | "not_allowed" | "deferred" | "skipped" | "blocked" | "failed" | "busy";

export interface CardSendInput {
  accountId: string;
  kind: string;
  origin: MessageOrigin;
  /** звук уже решил вызывающий (дубль уведомлений): политика не спрашивается, счётчик звука не растёт дважды */
  silent?: boolean;
}

/** Итог отправки и просьба площадки подождать: задание `card-send` по ней бросает исключение — повтор BullMQ. */
export interface CardSendAttempt {
  result: CardSendResult;
  retryAfterSec: number | null;
}

const done = (result: CardSendResult, retryAfterSec: number | null = null): CardSendAttempt => ({ result, retryAfterSec });

@Injectable()
export class BotCardsService implements OnModuleInit {
  private readonly logger = new Logger("bot-cards");
  private lastFailureLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(
    @Inject(SETTINGS_READER) private readonly panel: SettingsReader,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byId">,
    private readonly messengers: Messengers,
    private readonly liveCards: LiveCards,
    private readonly links: AppLinks,
    // Токены — явно: у `Pick` в метаданных типов остаётся `Object`, и Nest не нашёл бы, что внедрять.
    @Inject(MessagingService) private readonly messaging: Pick<MessagingService, "state" | "platformChanged">,
    @Inject(AccountSettingsService) private readonly accountSettings: Pick<AccountSettingsService, "valueOf">,
    @Inject(BotMessagePolicy) private readonly policy: Pick<BotMessagePolicy, "decide">,
    @Inject(BotMessages) private readonly messages: Pick<BotMessages, "compose">,
    @Inject(BotMessageEvents) private readonly events: Pick<BotMessageEvents, "sent">,
    private readonly kinds: BotCardKinds,
    @Inject(BOT_CARDS_REPOSITORY) private readonly repository: BotCardsRepository,
    @Inject(BotNotifyQueue) private readonly queue: Pick<BotNotifyQueue, "registerPaced" | "addPaced">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "get" | "eval">,
  ) {}

  onModuleInit(): void {
    this.queue.registerPaced(CARD_JOBS.send, async (data) => {
      const input = sendJobSchema.parse(data);
      const outcome = await this.trySend(input, new Date());
      // Площадка просит подождать — повтор BullMQ с растущей паузой; карточка при этом не отправлена.
      if (outcome.retryAfterSec !== null) throw new Error(`Площадка просит подождать ${String(outcome.retryAfterSec)} с`);
    });
  }

  async send(input: CardSendInput, at = new Date()): Promise<CardSendResult> {
    return (await this.trySend(input, at)).result;
  }

  /**
   * Отправка по триггеру (забег, пришедший друг) через очередь: так отправки идут общим темпом с дублем
   * уведомлений. `false` — вида нет или очередь не запущена (вход игроков выключен).
   */
  async sendLater(input: Omit<CardSendInput, "silent">, at = new Date()): Promise<boolean> {
    const kind = this.kinds.get(input.kind);
    if (kind === undefined) return false;
    return await this.queue.addPaced(CARD_JOBS.send, { accountId: input.accountId, kind: input.kind, origin: input.origin }, { jobId: this.sendJobId(input.accountId, kind, at), delayMs: 0 });
  }

  /**
   * Состояние живой карточки вида изменилось: поставить правку не раньше `bot.widget.edit-min-minutes`
   * после предыдущей. Повторный вызов, пока задание ждёт, ничего не добавляет — правки сливаются.
   */
  async touch(accountId: string, kindId: string, at = new Date()): Promise<void> {
    const kind = this.kinds.get(kindId);
    if (kind === undefined || !this.cardsEnabled(kind)) return;
    const card = await this.repository.live(accountId, kindId);
    if (card === null) return;
    const gapMs = this.panel.get(SETTINGS.botWidgetEditMinMinutes) * 60_000;
    // Время последней правки — в идентификаторе: пока задание ждёт, повторные касания сливаются в него, а касание
    // во время самой правки (она занимает слот до вызова площадки) получает уже другой идентификатор и не теряется.
    await this.queue.addPaced(
      CARD_JOBS.edit,
      { cardId: card.id },
      { jobId: pacedJobId(CARD_JOBS.edit, card.id, String(card.updatedAt.getTime())), delayMs: Math.max(0, card.updatedAt.getTime() + gapMs - at.getTime()) },
    );
  }

  /**
   * Пауза карточек площадки после отказа в методе (Р225): `bot.widget.retry-minutes` минут все реплики
   * шлют запасные сообщения. Ключ поставлен этим вызовом — строка `warn` (тревога в чат команды идёт по
   * ней, одна на паузу); уже стоял — тишина. Redis недоступен — паузы нет, но сообщение игроку это не
   * задерживает: запасное уходит всё равно.
   */
  async pause(platform: PlatformId): Promise<void> {
    const ttlMs = this.panel.get(SETTINGS.botWidgetRetryMinutes) * 60_000;
    try {
      const set = await withTimeout(this.redis.set(pausedKey(platform), "1", "PX", ttlMs, "NX"), TIMEOUT_MS, "пауза карточек бота");
      if (set === "OK") this.logger.warn(JSON.stringify({ module: "bot-cards", event: "widgets_unavailable", platform }));
    } catch (error: unknown) {
      this.warnRedis("pause_failed", error);
    }
  }

  /** Redis недоступен — паузы «нет»: попытка карточки при отказе площадки сама кончится запасным сообщением. */
  async isPaused(platform: PlatformId): Promise<boolean> {
    try {
      return (await withTimeout(this.redis.get(pausedKey(platform)), TIMEOUT_MS, "пауза карточек бота")) !== null;
    } catch (error: unknown) {
      this.warnRedis("pause_unreadable", error);
      return false;
    }
  }

  /** Карточки вида включены в панели: выключатель сообщений нового поколения, общий выключатель карточек и ключ вида. */
  cardsEnabled(kind: BotCardKind): boolean {
    return this.panel.get(SETTINGS.botFormatsEnabled) && this.panel.get(SETTINGS.botWidgetEnabled) && this.panel.get(kind.enabled);
  }

  /** Карточек вида на этой площадке сейчас нет: выключены в панели или площадка на паузе. */
  async unavailable(platform: PlatformId, kind: BotCardKind): Promise<boolean> {
    return !this.cardsEnabled(kind) || (await this.isPaused(platform));
  }

  /** Отправка с просьбой площадки подождать в ответе: задание `card-send` по ней повторяется, прямой вызов получает `failed`. */
  async trySend(input: CardSendInput, at: Date): Promise<CardSendAttempt> {
    if (!this.panel.get(SETTINGS.botFormatsEnabled)) return done("off");
    const kind = this.kinds.get(input.kind);
    if (kind === undefined) {
      this.logger.warn(JSON.stringify({ module: "bot-cards", event: "kind_unknown", kind: input.kind }));
      return done("skipped");
    }
    const account = await withTimeout(this.accounts.byId(input.accountId), TIMEOUT_MS, "аккаунт");
    if (account === null || account.bannedAt !== null) return done("skipped");
    const messenger = this.messengers.for(account.platform);
    if (messenger === null) return done("skipped");
    const state = await withTimeout(this.messaging.state(input.accountId), TIMEOUT_MS, "можно ли писать");
    if (state?.canMessage !== true) return done("not_allowed");
    if (input.origin !== "reply" && !(await this.chosen(input.accountId, kind))) return done("opted_out");

    let silent = input.silent;
    if (silent === undefined) {
      const decision = await this.policy.decide({ accountId: input.accountId, origin: input.origin }, at);
      if (decision.action === "skip") return done("skipped");
      if (decision.action === "wait") return await this.defer(input, kind, decision.untilMs, at);
      silent = decision.silent;
    }
    return await this.locked(account, kind, messenger, silent, at);
  }

  /** Тихие часы: задание на их конец. Идентификатор свой: у текущего задания (оно же идёт сейчас) тот же `card-send-…` — BullMQ счёл бы повтор дублем. */
  private async defer(input: CardSendInput, kind: BotCardKind, untilMs: number, at: Date): Promise<CardSendAttempt> {
    const queued = await this.queue.addPaced(
      CARD_JOBS.send,
      { accountId: input.accountId, kind: input.kind, origin: "bot" },
      { jobId: pacedJobId(CARD_JOBS.send, input.accountId, input.kind, kind.periodKey(at) ?? "", "late"), delayMs: Math.max(0, untilMs - at.getTime()) },
    );
    return done(queued ? "deferred" : "skipped");
  }

  /** Выбор игрока для карточки по триггеру: не выбирал — решает умолчание вида. */
  private async chosen(accountId: string, kind: BotCardKind): Promise<boolean> {
    if (kind.choice === null) return true;
    const value = await this.accountSettings.valueOf(accountId, kind.choice.setting);
    return typeof value === "boolean" ? value : kind.choice.byDefault;
  }

  private sendJobId(accountId: string, kind: BotCardKind, at: Date): string {
    return pacedJobId(CARD_JOBS.send, accountId, kind.kind, kind.periodKey(at) ?? "");
  }

  /**
   * Лок на аккаунт и вид. Занят — `busy`; Redis недоступен — отправка идёт без лока: живую карточку
   * вида всё равно держит индекс таблицы, а проигравший гонку закрывается сразу.
   */
  private async locked(account: Account, kind: BotCardKind, messenger: Messenger, silent: boolean, at: Date): Promise<CardSendAttempt> {
    const key = sendLockKey(account.accountId, kind.kind);
    let token: string | null = null;
    try {
      token = await acquireLock(this.redis, key, SEND_LOCK_TTL_MS);
      if (token === null) return done("busy");
    } catch (error: unknown) {
      this.warnRedis("lock_unavailable", error);
    }
    try {
      return await this.deliver(account, kind, messenger, silent, at);
    } finally {
      if (token !== null) await releaseLock(this.redis, key, token).catch((error: unknown) => this.warnRedis("unlock_failed", error));
    }
  }

  private async deliver(account: Account, kind: BotCardKind, messenger: Messenger, silent: boolean, at: Date): Promise<CardSendAttempt> {
    const state = await kind.state(account.accountId, at);
    const json = encodeState(state);
    const playUrl = this.links.launch(account.platform, kind.startRef);
    const button = playUrl === null ? null : { text: PLAY_BUTTON_TEXT, url: playUrl };

    const port = await this.portFor(account.platform, kind);
    if (port !== null) {
      const outcome = await port.send(account.platformUserId, { kind: kind.kind, state: json, caption: kind.caption(state), button, silent, ...(kind.topic === undefined ? {} : { topic: kind.topic }) });
      switch (outcome.status) {
        case "sent":
          await this.recordSent(account, kind, json, outcome.ref, outcome.version, at);
          await this.report(account, kind, "card", "sent", silent);
          return done("sent");
        case "unsupported":
          // Не сбой доставки, а «карточек сейчас нет»: пауза для всех реплик и запасное сообщение этому игроку.
          await this.pause(account.platform);
          break;
        case "retry":
          return done("failed", outcome.afterSec);
        case "blocked":
          await this.report(account, kind, "card", "blocked", silent);
          await this.markBlocked(account, at);
          return done("blocked");
        case "failed":
          this.logger.warn(JSON.stringify({ module: "bot-cards", event: "card_send_failed", card: kind.kind, reason: outcome.reason }));
          await this.report(account, kind, "card", "failed", silent);
          return done("failed");
      }
    }
    return await this.sendFallback(account, kind, messenger, state, button, silent, at);
  }

  /** Порт, которому карточку можно отдать: включено в панели, площадка не на паузе, вид поддержан. */
  private async portFor(platform: PlatformId, kind: BotCardKind): Promise<LiveCardPort | null> {
    if (await this.unavailable(platform, kind)) return null;
    const port = this.liveCards.for(platform);
    return port !== null && port.supports(kind.kind) ? port : null;
  }

  /** Запасное сообщение вместо карточки: то же содержание документом вида, оформление или простой текст — как решит `compose`. */
  private async sendFallback(
    account: Account,
    kind: BotCardKind,
    messenger: Messenger,
    state: Record<string, unknown>,
    button: { text: string; url: string } | null,
    silent: boolean,
    at: Date,
  ): Promise<CardSendAttempt> {
    const composed = this.messages.compose(kind.fallback(state), { button, ...(kind.topic === undefined ? {} : { topic: kind.topic }) });
    const message = silent ? { ...composed, silent: true } : composed;
    const outcome = await messenger.send(account.platformUserId, message);
    if (outcome.status === "retry") return done("failed", outcome.afterSec);
    await this.report(account, kind, message.rich === undefined ? "text" : "rich", eventOutcomeOf(outcome), silent);
    if (outcome.status === "blocked") {
      await this.markBlocked(account, at);
      return done("blocked");
    }
    return done(outcome.status === "sent" ? "fallback" : "failed");
  }

  /**
   * Карточка ушла: записать и закрыть прежнюю. Прежней — задание «перенесена ниже». Проигравшая гонку
   * (вторая живая вида мимо лока) закрыта сразу и сама получает «перенесена»: игрок видит одну живую.
   */
  private async recordSent(account: Account, kind: BotCardKind, json: string, ref: { chatId: string; messageId: number }, version: string, at: Date): Promise<void> {
    const opened = await this.repository.openReplacing({
      accountId: account.accountId,
      platform: account.platform,
      kind: kind.kind,
      chatId: ref.chatId,
      messageId: ref.messageId,
      version,
      periodKey: kind.periodKey(at),
      state: json,
      stateHash: stateHash(json),
      at,
    });
    if (opened.status === "raced") this.logger.warn(JSON.stringify({ module: "bot-cards", event: "card_race", card: kind.kind }));
    const moved = opened.status === "raced" ? opened.id : opened.replacedId;
    if (moved === null) return;
    // Перенос — правка вдогонку: сбой очереди карточку не отменяет, она уже у игрока и в таблице.
    await this.queue
      .addPaced(CARD_JOBS.moved, { cardId: moved }, { jobId: pacedJobId(CARD_JOBS.moved, moved), delayMs: 0 })
      .catch((error: unknown) => this.logger.warn(JSON.stringify({ module: "bot-cards", event: "moved_not_queued", reason: error instanceof Error ? error.message : "unknown" })));
  }

  private async markBlocked(account: Account, at: Date): Promise<void> {
    await this.messaging.platformChanged(account.platform, account.platformUserId, "blocked", at);
  }

  private async report(account: Account, kind: BotCardKind, format: "text" | "rich" | "card", outcome: "sent" | "blocked" | "failed" | "fallback", silent: boolean): Promise<void> {
    await this.events.sent({ kind: `${kind.kind}_card`, format, outcome, topic: kind.topic ?? "none", silent, platform: account.platform });
  }

  private warnRedis(event: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureLoggedAt = now;
    this.logger.warn(JSON.stringify({ module: "bot-cards", event, reason: error instanceof Error ? error.message : String(error) }));
  }
}

/** Исход площадки в словаре события: запасной текст отличается от обычной отправки. */
function eventOutcomeOf(outcome: Exclude<SendOutcome, { status: "retry" }>): "sent" | "blocked" | "failed" | "fallback" {
  if (outcome.status === "sent") return outcome.fallback === true ? "fallback" : "sent";
  return outcome.status;
}
