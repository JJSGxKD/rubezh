import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";
import { LiveCards, type LiveCardRef, type LiveCardUpdateOutcome } from "../../platforms/ports/live-card.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { MessagingService } from "../messaging/messaging.service.js";
import { BotNotifyQueue } from "../notifications-bot/bot-notify-queue.js";
import { BotCardKinds } from "./bot-card-kinds.js";
import { CARD_FLAGS, CARD_JOBS, CardCallTimeout, acquireLock, cardJobSchema, cardLockKey, encodeState, finalJobSchema, parseState, releaseLock, stateHash, withCardTimeout } from "./bot-card-protocol.js";
import { BOT_CARDS_REPOSITORY, type BotCardRow, type BotCardsRepository } from "./bot-cards.repository.js";
import { BotCardsService } from "./bot-cards.service.js";

/**
 * Правки уже отправленных карточек (docs/35-stage4-plan.md Р199, Р225, tasks/T-0395): три задания очереди
 * `notifications-bot`, которые ставит `BotCardsService` и финализатор.
 *
 * - `card-edit` — прореженная правка: состояние собирается заново, тот же хэш — площадка не зовётся;
 * - `card-moved` — прежней карточке «перенесена ниже»: её сохранённое состояние с `moved: 1`;
 * - `card-final` — финал периода: заранее собранное состояние, после правки карточка закрывается.
 *
 * Правка, перенос и финал одной карточки не затирают друг друга: каждое задание берёт лок карточки, а
 * занятый лок — исключение и повтор BullMQ, к которому карточка уже закрыта (правка выйдет) или уже
 * получила финал. Повтор безвреден: ключ задания один на карточку, закрытая карточка правок не получает,
 * а тот же финал площадка ответит `unchanged`.
 */

const CARD_LOCK_TTL_MS = 30_000;
/** Сборка состояния и площадка ограничены сроком: зависший вызов не держит обработчик очереди до конца лока. */
const STATE_TIMEOUT_MS = 8_000;
const PORT_TIMEOUT_MS = 10_000;

/** Что вышло из правки: `ok` — площадка приняла, `dead` — карточку больше не править, `failed` — отказ без повтора. */
type UpdateResult = "ok" | "dead" | "failed";

@Injectable()
export class BotCardsUpdater implements OnModuleInit {
  private readonly logger = new Logger("bot-cards");

  constructor(
    private readonly liveCards: LiveCards,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byId">,
    // Токены — явно: у `Pick` в метаданных типов остаётся `Object`, и Nest не нашёл бы, что внедрять.
    @Inject(MessagingService) private readonly messaging: Pick<MessagingService, "platformChanged">,
    private readonly kinds: BotCardKinds,
    @Inject(BOT_CARDS_REPOSITORY) private readonly repository: BotCardsRepository,
    @Inject(BotNotifyQueue) private readonly queue: Pick<BotNotifyQueue, "registerPaced">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    private readonly service: BotCardsService,
  ) {}

  onModuleInit(): void {
    this.queue.registerPaced(CARD_JOBS.edit, (data) => this.edit(data));
    this.queue.registerPaced(CARD_JOBS.moved, (data) => this.moved(data));
    this.queue.registerPaced(CARD_JOBS.final, (data) => this.final(data));
  }

  /** Прореженная правка. Пауза площадки и выключенные карточки — выход без вызова площадки, карточка остаётся живой. */
  async edit(data: unknown, at = new Date()): Promise<void> {
    const { cardId } = cardJobSchema.parse(data);
    await this.exclusive(cardId, async () => {
      const card = await this.repository.byId(cardId);
      if (card === null || card.closedAt !== null) return;
      const kind = this.kinds.get(card.kind);
      const port = this.liveCards.for(card.platform);
      if (kind === undefined || port === null || (await this.service.unavailable(card.platform, kind))) return;
      // Границу периода правка не переходит: карточка закрывает свою неделю, и состояние нового периода в неё
      // не пишем — иначе финал старого периода уйдёт с данными нового (tasks/T-0395, «доработка», шаг 10).
      if (kind.periodKey(at) !== card.periodKey) return;
      const json = encodeState(await withCardTimeout(kind.state(card.accountId, at), STATE_TIMEOUT_MS, "состояние карточки"));
      const hash = stateHash(json);
      if (hash === card.stateHash) return;
      // Слот правки занимается до вызова площадки: состояние, изменившееся за время вызова, поставит новое
      // задание (`touch` считает задержку от этого времени), а не потеряется под выполняющимся.
      if (!(await this.repository.touched(card.id, card.state, card.stateHash, at))) return;
      const result = await this.apply(card, await withCardTimeout(port.update(refOf(card), json), PORT_TIMEOUT_MS, "правка карточки у площадки"), at);
      if (result === "ok") await this.repository.touched(card.id, json, hash, at);
      else if (result === "dead") await this.repository.close(card.id, at);
    });
  }

  /** «Перенесена ниже»: карточка уже закрыта отправкой новой, остаётся сказать об этом в чате. */
  async moved(data: unknown, at = new Date()): Promise<void> {
    const { cardId } = cardJobSchema.parse(data);
    await this.exclusive(cardId, async () => {
      const card = await this.repository.byId(cardId);
      if (card === null) return;
      const kind = this.kinds.get(card.kind);
      const port = this.liveCards.for(card.platform);
      const last = parseState(card.state);
      if (kind === undefined || port === null || last === null || (await this.service.unavailable(card.platform, kind))) return;
      await this.apply(card, await withCardTimeout(port.update(refOf(card), encodeState({ ...last, [CARD_FLAGS.moved]: 1 })), PORT_TIMEOUT_MS, "перенос карточки у площадки"), at);
    });
  }

  /**
   * Финал периода. Карточки выключены в панели — площадка не зовётся, а карточка закрывается: иначе
   * проходы финализатора вечно ставили бы задания на карточки, которых бот не правит. Площадка на паузе —
   * выход без закрытия: проход подберёт карточку после паузы. Закрыта карточка уже — финал был, второго нет.
   */
  async final(data: unknown, at = new Date()): Promise<void> {
    const { cardId, state } = finalJobSchema.parse(data);
    await this.exclusive(cardId, async () => {
      const card = await this.repository.byId(cardId);
      if (card === null || card.closedAt !== null) return;
      const kind = this.kinds.get(card.kind);
      const port = this.liveCards.for(card.platform);
      if (kind === undefined || port === null || !this.service.cardsEnabled(kind)) {
        await this.repository.close(card.id, at);
        return;
      }
      if (await this.service.isPaused(card.platform)) return;
      await this.apply(card, await withCardTimeout(port.update(refOf(card), state), PORT_TIMEOUT_MS, "финал карточки у площадки"), at);
      // Финал одноразовый: принят, карточку больше не править или площадка отказала без повтора — закрываем в любом случае.
      await this.repository.close(card.id, at);
    });
  }

  /** Исход площадки на правку. `retry` — исключение: BullMQ повторит задание с растущей паузой. */
  private async apply(card: BotCardRow, outcome: LiveCardUpdateOutcome, at: Date): Promise<UpdateResult> {
    switch (outcome.status) {
      case "edited":
      case "unchanged":
        return "ok";
      case "gone":
        return "dead";
      case "unsupported":
        // Площадка отказала в методе карточек: пауза для всех реплик, а эту карточку больше не правим.
        await this.service.pause(card.platform);
        return "dead";
      case "blocked": {
        // Игрок заблокировал бота: пометка у игрока (дальше ему не пишут ничего), а карточку больше не правим.
        const account = await this.accounts.byId(card.accountId);
        if (account !== null) await this.messaging.platformChanged(account.platform, account.platformUserId, "blocked", at);
        return "dead";
      }
      case "retry":
        throw new Error(`Площадка просит подождать ${String(outcome.afterSec)} с`);
      case "failed":
        this.logger.warn(JSON.stringify({ module: "bot-cards", event: "card_update_failed", card: card.kind, reason: outcome.reason }));
        return "failed";
    }
  }

  /** Лок карточки на время операции. Занят — исключение и повтор BullMQ: операция одной карточки идёт по одной. */
  private async exclusive(cardId: string, run: () => Promise<void>): Promise<void> {
    const key = cardLockKey(cardId);
    const token = await acquireLock(this.redis, key, CARD_LOCK_TTL_MS);
    if (token === null) throw new Error(`Карточка ${cardId} занята другой операцией`);
    let timedOut = false;
    try {
      await run();
    } catch (error: unknown) {
      // Вызов не ответил за срок и может ещё доработать: лок не снимаем, он истечёт сам, и вторая операция
      // не пойдёт поверх брошенной.
      timedOut = error instanceof CardCallTimeout;
      if (timedOut) this.logger.warn(JSON.stringify({ module: "bot-cards", event: "card_lock_kept_after_timeout", card: cardId }));
      throw error;
    } finally {
      if (!timedOut) await releaseLock(this.redis, key, token).catch((error: unknown) => this.logger.warn(JSON.stringify({ module: "bot-cards", event: "unlock_failed", reason: error instanceof Error ? error.message : "unknown" })));
    }
  }
}

function refOf(card: BotCardRow): LiveCardRef {
  return { chatId: card.chatId, messageId: card.messageId };
}
