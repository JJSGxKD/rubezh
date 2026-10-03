import { randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { taddyUser, type AdRequester } from "./ad-creatives.js";
import { AdTaskHooks, TASK_SESSION_TTL_MIN } from "./ad-tasks.js";
import { ADS_REPOSITORY, type AdBlockRow, type AdsRepository, type PlaceHistory, type TaskSessionRow } from "./ads.repository.js";
import type { TaddyUser } from "./taddy-api.js";
import { TADDY_EXCHANGE, type TaddyExchangeApi, type TaddyExchangeTask, type TaddyTaskType } from "./taddy-exchange.js";

/**
 * Задания ленты сети (docs/35-stage4-plan.md WP13, часть 6, Р80): сеть
 * отдаёт задание серверу, а не SDK на клиенте, строку рисует оболочка, а
 * выполнение сервер спрашивает у сети сам. Пока такая лента одна — обмен
 * трафиком Taddy (`taddy-exchange.ts`).
 *
 * Задание ленты — креатив сессии места `task`. Открытая сессия сети у
 * игрока одна, как у AdsGram: пока её задание есть в ленте, игрок видит
 * его же. Пропало — значит, выполнено (лента без выполненных) или снято
 * сетью: переходил — сервер спрашивает сеть и при выполнении отдаёт
 * награду, не переходил или не выполнил — сессия закрывается и выбирается
 * следующее задание в пределах потолка и паузы хозяина места.
 *
 * Награда — тем же путём, что у AdsGram: подтверждённая сессия уходит
 * хозяину места (`AdTaskHooks`).
 */

const DB_TIMEOUT_MS = 3_000;
const MINUTE_MS = 60_000;

/** Задание ленты для строки игрока — без ключей сети: игроку нужно только то, что он видит, и адрес перехода. */
export interface FeedTask {
  sessionId: string;
  network: string;
  title: string;
  description: string | null;
  image: string | null;
  /** что сделать: запустить бота, открыть приложение, перейти по ссылке — от этого надпись на кнопке */
  action: TaddyTaskType;
  /** адрес сети, который отдаёт адрес перехода, — его открывает адаптер площадки */
  link: string;
  /** игрок уже переходил — строка сразу предлагает проверить */
  opened: boolean;
}

/**
 * Что получила строка ленты: задание; выполненное задание открытой сессии —
 * награда уже выдана; или заданий сейчас нет — потолок или пауза хозяина,
 * пустая лента, сеть не ответила, игрок неизвестен сети.
 */
export type FeedItemOutcome =
  | { kind: "task"; task: FeedTask }
  | { kind: "done"; sessionId: string }
  | { kind: "none"; reason: "admit" | "empty" | "unavailable" | "no_user" };

/**
 * Ответ на «Проверить»: выполнено и награда выдана; сеть не видит
 * выполнения; сеть не ответила; сессии больше нет — истекла, закрыта или её
 * задание игрок уже выполнял.
 */
export type FeedCheckOutcome = "confirmed" | "not_done" | "unavailable" | "closed";

/** Сеть и игрок для вызова ленты; `null` — без ключа или без Telegram ID сеть игрока не узнает. */
interface FeedCaller {
  networkKey: string;
  pubId: string;
  user: TaddyUser;
}

@Injectable()
export class AdTaskFeeds {
  private readonly logger = new Logger("ads");

  constructor(
    @Inject(ADS_REPOSITORY) private readonly repository: AdsRepository,
    @Inject(TADDY_EXCHANGE) private readonly exchange: TaddyExchangeApi,
    private readonly hooks: AdTaskHooks,
  ) {}

  /**
   * Задание для строки сети. Новую сессию заводит только `admit` хозяина по
   * истории места — под блокировкой места, так что два экрана разом
   * потолок не обойдут. Ленту без открытой сессии спрашиваем, только если
   * хозяин пустит: в паузе сети звонить незачем.
   */
  async item(accountId: string, block: AdBlockRow, requester: AdRequester, at: Date, admit: (history: PlaceHistory) => boolean): Promise<FeedItemOutcome> {
    const caller = callerOf(block, requester);
    if (caller === null) return { kind: "none", reason: "no_user" };
    const open = await this.db(this.repository.openTaskSession(accountId, caller.networkKey, at));
    if (open === null && !admit(await this.db(this.repository.history(accountId, "task", at)))) return { kind: "none", reason: "admit" };

    const feed = await this.exchange.feed(caller.pubId, caller.user);
    if (feed.kind === "none") return { kind: "none", reason: "unavailable" };

    if (open !== null) {
      const listed = feed.tasks.find((task) => task.id === open.creativeId);
      if (listed !== undefined) return { kind: "task", task: feedTask(open, listed) };
      // Задания в ленте нет: выполнено — или снято сетью. Переходил —
      // спросим сеть; нет ответа — решим в следующий раз, не закрывая.
      if (open.clickedAt !== null && open.creativeId !== null) {
        const outcome = await this.settle(accountId, caller, open, open.creativeId, at);
        if (outcome === "confirmed") return { kind: "done", sessionId: open.sessionId };
        if (outcome === "unavailable") return { kind: "none", reason: "unavailable" };
      }
      await this.close(accountId, open, "task_gone", at);
    }

    let refusal: "admit" | "empty" = "admit";
    const outcome = await this.db(
      this.repository.openTask(
        accountId,
        caller.networkKey,
        at,
        (history, done) => {
          if (!admit(history)) return null;
          const pick = feed.tasks.find((task) => !done.has(task.id));
          if (pick === undefined) {
            refusal = "empty";
            return null;
          }
          return {
            sessionId: randomBytes(12).toString("base64url"),
            accountId,
            place: "task",
            block,
            creative: { id: pick.id, viewSec: null },
            createdAt: at,
            expiresAt: new Date(at.getTime() + TASK_SESSION_TTL_MIN * MINUTE_MS),
          };
        },
        feed.tasks.map((task) => task.id),
      ),
    );
    if (outcome === null) return { kind: "none", reason: refusal };
    // Сессию мог завести соседний запрос — с заданием из своей ленты.
    const listed = feed.tasks.find((task) => task.id === outcome.session.creativeId);
    if (listed === undefined) return { kind: "none", reason: "unavailable" };
    if (outcome.created) this.log({ event: "ad_offered", accountId, place: "task", network: caller.networkKey, success: block.success });
    return { kind: "task", task: feedTask(outcome.session, listed) };
  }

  /**
   * «Проверить»: выполнено ли задание сессии — по данным сети, а не по
   * словам клиента. Выполненная, но не забранная сессия — прошлая выдача
   * сорвалась — дожимается тем же ключом.
   */
  async check(accountId: string, block: AdBlockRow, sessionId: string, requester: AdRequester, at: Date): Promise<FeedCheckOutcome> {
    const session = await this.db(this.repository.taskSession(accountId, sessionId));
    if (session === null || session.networkKey !== block.networkKey || session.creativeId === null) return "closed";
    if (session.status === "claimed") return "confirmed";
    if (session.status === "completed") {
      await this.hooks.emit({ accountId, networkKey: session.networkKey, sessionId, repeat: true, at });
      return "confirmed";
    }
    if ((session.status !== "pending" && session.status !== "shown") || session.expiresAt <= at) return "closed";
    const caller = callerOf(block, requester);
    if (caller === null) return "unavailable";
    return await this.settle(accountId, caller, session, session.creativeId, at);
  }

  /** Спросить сеть и, если выполнено, выполнить сессию и отдать её хозяину места за наградой. */
  private async settle(accountId: string, caller: FeedCaller, session: TaskSessionRow, taskId: string, at: Date): Promise<FeedCheckOutcome> {
    const result = await this.exchange.check(caller.pubId, caller.user, taskId);
    if (result.kind === "none") return "unavailable";
    if (!result.done) {
      this.log({ event: "ad_task_not_done", accountId, network: caller.networkKey });
      return "not_done";
    }
    const confirmed = await this.db(this.repository.confirmTask(accountId, caller.networkKey, at, session.sessionId));
    if (confirmed === null) {
      // Это задание игрок уже выполнял в другой сессии — награда за него выдана.
      await this.close(accountId, session, "task_repeat", at);
      this.log({ event: "ad_task_repeat", accountId, network: caller.networkKey });
      return "closed";
    }
    if (!confirmed.repeat) this.log({ event: "ad_completed", accountId, place: "task", network: caller.networkKey });
    await this.hooks.emit({ accountId, networkKey: caller.networkKey, sessionId: session.sessionId, repeat: confirmed.repeat, at });
    return "confirmed";
  }

  /** Закрыть сессию отказом с кодом — для воронки: задание пропало из ленты или уже выполнено раньше. */
  private async close(accountId: string, session: TaskSessionRow, reason: string, at: Date): Promise<void> {
    await this.db(this.repository.report(session.sessionId, accountId, { kind: "failed", reason }, at));
    this.log({ event: "ad_failed", accountId, place: "task", network: session.networkKey, reason });
  }

  private log(fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "ads", ...fields }));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "задания ленты");
  }
}

/** Ключ сети и игрок для неё: лента Taddy — по `pubId` и Telegram ID. */
function callerOf(block: AdBlockRow, requester: AdRequester): FeedCaller | null {
  const pubId = block.networkKeys["pubId"] ?? "";
  const user = taddyUser(requester);
  return pubId === "" || user === null ? null : { networkKey: block.networkKey, pubId, user };
}

function feedTask(session: TaskSessionRow, task: TaddyExchangeTask): FeedTask {
  return {
    sessionId: session.sessionId,
    network: session.networkKey,
    title: task.title,
    description: task.description,
    image: task.image,
    action: task.type,
    link: task.link,
    opened: session.clickedAt !== null || task.pending,
  };
}
