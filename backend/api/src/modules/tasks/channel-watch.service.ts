import { Inject, Injectable, Logger } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { ChannelMemberships, MembershipRejectedError, MembershipUnavailableError, type ChannelMembership } from "../../platforms/ports/channel-membership.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { RestrictionsService } from "../restrictions/restrictions.service.js";
import type { AccountRef } from "../roles/roles.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { TASK_REVOKE_REASON, type WalletResource } from "../wallet/wallet-types.js";
import { ASK_TIMEOUT_MS, BATCH, CLOSE_MS, closesPartnerTasks, isFinalCheck, nextCheckAfter, shouldGiveUp, watchUntil } from "./channel-watch-rules.js";
import { CHANNEL_WATCH_REPOSITORY, type ChannelWatchRepository, type Penalty, type Revoked, type WatchKey, type WatchRow } from "./channel-watch.repository.js";
import type { TaskDef } from "./task-rules.js";
import { TASKS_REPOSITORY, type TasksRepository } from "./tasks.repository.js";

/**
 * Перепроверка подписки после награды (docs/35-stage4-plan.md Р115,
 * tasks/T-0178). Партнёр платит за подписчиков, а не за тех, кто подписался
 * ради награды и ушёл: после забора награды за подписку сервер неделю
 * спрашивает бота площадки, остался ли игрок в канале. Отписался — награда
 * списывается (не ниже нуля, потраченное не возвращается), игрок получает
 * уведомление; повторная отписка в том же задании закрывает партнёрские
 * задания на 30 суток.
 *
 * Правила работы:
 * - у одной пары «игрок + задание» одна отписка — одно событие, сколько бы
 *   окон ни было открыто (ежедневная подписка, забранная несколько дней);
 * - нет ответа площадки — нет штрафа: сбой, таймаут и ошибка настройки канала
 *   откладывают окно, а не штрафуют;
 * - событие отписки идемпотентно до самой отметки `penalized`: списание и
 *   уведомление держатся на ключах, ограничение накладывается один раз под
 *   замком пары, поэтому оборвавшийся проход доделывает событие, а не
 *   удваивает;
 * - площадку спрашивают по одному вопросу, без замка и вне транзакции
 *   (docs/15 §4.2); замок пары — только вокруг записей.
 */

/** Ресурсы награды задания: поле в итоге и ресурс в кошельке (осколки заданий — обычные). */
const REWARD_RESOURCES = [
  ["coins", "coins"],
  ["gems", "gems"],
  ["shards", "shard_common"],
] as const satisfies readonly (readonly [keyof Revoked, WalletResource])[];

/**
 * Что показал вопрос площадке. `unsure` — ответа нет: сбой, таймаут, ошибка
 * настройки; `failed` — причина не ожидаемая, её считают отдельно.
 */
type Answer = { kind: "member" } | { kind: "absent" } | { kind: "unsure"; failed: boolean };

interface Pair {
  accountId: string;
  taskId: string;
  windows: WatchRow[];
}

/** Итог прохода. Окна считаются штуками, пары — парами «игрок + задание». */
export interface TickResult {
  /** окон к проверке взято */
  windows: number;
  pairs: number;
  kept: number;
  expired: number;
  postponed: number;
  penalized: number;
  /** пар, которые уже обрабатывал другой проход, — их подберёт следующий */
  busy: number;
  /** пар, на которых проход споткнулся; окна ждут следующего */
  failed: number;
}

const keyOf = (window: WatchKey): WatchKey => ({ accountId: window.accountId, taskId: window.taskId, periodStart: window.periodStart });

@Injectable()
export class ChannelWatchService {
  private readonly logger = new Logger("tasks");

  constructor(
    @Inject(CHANNEL_WATCH_REPOSITORY) private readonly watch: ChannelWatchRepository,
    @Inject(TASKS_REPOSITORY) private readonly tasks: TasksRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly memberships: ChannelMemberships,
    private readonly wallet: WalletService,
    private readonly restrictions: RestrictionsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Завести окно на выданную награду за подписку. Только у `channel` и только
   * там, где у площадки есть проверка подписки: MAX и VK штрафа не знают.
   * `false` — окна не будет или оно уже есть. Зовёт забор награды, поэтому
   * сам решает, наблюдается ли это задание.
   */
  async start(account: AccountRef, def: TaskDef, periodStart: string, at: Date): Promise<boolean> {
    const params = def.params;
    if (def.kind !== "channel" || params === null || params.chat === undefined || params.platform === undefined) return false;
    if (this.memberships.for(params.platform) === null) return false;
    const until = watchUntil(at);
    const created = await this.watch.start({ accountId: account.accountId, taskId: def.taskId, periodStart, startedAt: at, watchUntil: until, nextCheckAt: nextCheckAfter(at, until) });
    if (created) this.logger.log(JSON.stringify({ module: "tasks", event: "channel_watch_started", accountId: account.accountId, taskId: def.taskId, periodStart }));
    return created;
  }

  /**
   * Один проход по расписанию: окна, чей срок проверки наступил, не больше
   * `BATCH`. Пары обходятся по очереди — площадка ограничивает темп, — и сбой
   * одной пары остальных не останавливает.
   */
  async tick(now: Date): Promise<TickResult> {
    const result: TickResult = { windows: 0, pairs: 0, kept: 0, expired: 0, postponed: 0, penalized: 0, busy: 0, failed: 0 };
    const due = await this.watch.due(now, BATCH);
    result.windows = due.length;
    if (due.length === 0) return result;
    // Каталог читается один раз за проход; выключенное задание проверяется по-прежнему: награда выдана.
    const catalog = new Map((await this.tasks.catalog()).map((def) => [def.taskId, def]));
    const pairs = groupByPair(due);
    result.pairs = pairs.length;
    for (const pair of pairs) {
      try {
        await this.checkPair(pair, catalog.get(pair.taskId), now, result);
      } catch (error: unknown) {
        result.failed += 1;
        this.logger.error(JSON.stringify({ module: "tasks", event: "channel_watch_failed", accountId: pair.accountId, taskId: pair.taskId, reason: reasonOf(error) }));
      }
    }
    return result;
  }

  private async checkPair(pair: Pair, def: TaskDef | undefined, now: Date, result: TickResult): Promise<void> {
    const account = await this.accounts.byId(pair.accountId);
    const params = def?.params;
    if (account === null || def === undefined || params === null || params === undefined || params.chat === undefined) {
      await this.closeOrphans(pair, account === null ? "аккаунта нет" : "у задания нет канала", now, result);
      return;
    }
    // Порта проверки не стало (бот не настроен на этой сборке) — это не ответ «не состоит»: окно ждёт и сдаётся по сроку.
    const membership = params.platform === undefined ? null : this.memberships.for(params.platform);
    const answer = membership === null ? this.unsure(pair, new MembershipUnavailableError("у площадки нет проверки подписки")) : await this.ask(membership, params.chat, account.platformUserId, pair);
    if (answer.kind === "member") await this.keep(pair.windows, now, result);
    else if (answer.kind === "absent") await this.punish(pair, def, now, result);
    else {
      if (answer.failed) result.failed += 1;
      await this.waitOrGiveUp(pair, now, result);
    }
  }

  /** Вопрос площадке одним запросом и с потолком времени; любой исход, кроме ответа, — `unsure`. */
  private async ask(membership: ChannelMembership, chat: string, platformUserId: string, pair: Pair): Promise<Answer> {
    let abandoned = false;
    // Этот промис не отклоняется: бросить из `withTimeout` может только истёкший потолок.
    const answered = (async (): Promise<Answer> => {
      try {
        return (await membership.isMember(chat, platformUserId)) ? { kind: "member" } : { kind: "absent" };
      } catch (error: unknown) {
        // Опоздавший сбой — после того, как вопрос уже записан как «не ответила»: второй строки в лог не нужно.
        return abandoned ? { kind: "unsure", failed: false } : this.unsure(pair, error, chat);
      }
    })();
    try {
      return await withTimeout(answered, ASK_TIMEOUT_MS, "проверка подписки");
    } catch (error: unknown) {
      abandoned = true;
      return this.unsure(pair, new MembershipUnavailableError(reasonOf(error)), chat);
    }
  }

  /** Ответа нет: в лог по виду причины. Штрафа не будет в любом случае. */
  private unsure(pair: Pair, error: unknown, chat?: string): Answer {
    const { accountId, taskId } = pair;
    if (error instanceof MembershipRejectedError) {
      // Ошибка настройки задания (бота нет в канале, нет права видеть участников): ждёт человека.
      this.logger.error(JSON.stringify({ module: "tasks", event: "channel_watch_misconfigured", accountId, taskId, chat, reason: error.message }));
      return { kind: "unsure", failed: false };
    }
    if (error instanceof MembershipUnavailableError) {
      this.logger.warn(JSON.stringify({ module: "tasks", event: "channel_watch_unavailable", accountId, taskId, reason: error.message }));
      return { kind: "unsure", failed: false };
    }
    // Неожиданное падение порта штрафом не кончается, но и тишиной тоже.
    this.logger.error(JSON.stringify({ module: "tasks", event: "channel_watch_failed", accountId, taskId, reason: reasonOf(error) }));
    return { kind: "unsure", failed: true };
  }

  /** Состоит: окна на исходе закрываются сохранёнными, остальные откладываются. */
  private async keep(windows: readonly WatchRow[], now: Date, result: TickResult): Promise<void> {
    const final = windows.filter((window) => isFinalCheck(now, window.watchUntil));
    if (final.length > 0) await this.watch.close(final.map(keyOf), "kept", now);
    result.kept += final.length;
    const rest = windows.filter((window) => !isFinalCheck(now, window.watchUntil));
    await this.postpone(rest, now, now);
    result.postponed += rest.length;
  }

  /** Нет ответа: окно ждёт следующей проверки, а через сутки после конца закрывается без штрафа. */
  private async waitOrGiveUp(pair: Pair, now: Date, result: TickResult): Promise<void> {
    const giveUp = pair.windows.filter((window) => shouldGiveUp(now, window.watchUntil));
    if (giveUp.length > 0) {
      await this.watch.close(giveUp.map(keyOf), "expired", now);
      result.expired += giveUp.length;
      this.logger.log(JSON.stringify({ module: "tasks", event: "channel_watch_expired", accountId: pair.accountId, taskId: pair.taskId, windows: giveUp.length }));
    }
    const wait = pair.windows.filter((window) => !shouldGiveUp(now, window.watchUntil));
    await this.postpone(wait, now, null);
    result.postponed += wait.length;
  }

  /** Окна одной пары откладываются каждое на свой срок: у кого конец окна ближе шести часов — до конца. */
  private async postpone(windows: readonly WatchRow[], now: Date, checkedAt: Date | null): Promise<void> {
    const byNext = new Map<number, WatchKey[]>();
    for (const window of windows) {
      const next = nextCheckAfter(now, window.watchUntil).getTime();
      byNext.set(next, [...(byNext.get(next) ?? []), keyOf(window)]);
    }
    for (const [next, keys] of byNext) await this.watch.postpone(keys, new Date(next), checkedAt);
  }

  /** Аккаунта или канала у задания больше нет — проверять нечего, и окна закрываются без штрафа. */
  private async closeOrphans(pair: Pair, why: string, now: Date, result: TickResult): Promise<void> {
    await this.watch.close(pair.windows.map(keyOf), "expired", now);
    result.expired += pair.windows.length;
    this.logger.warn(JSON.stringify({ module: "tasks", event: "channel_watch_orphaned", accountId: pair.accountId, taskId: pair.taskId, windows: pair.windows.length, reason: why }));
  }

  /** Событие отписки под замком пары: занято — пару ведёт другой проход, это не ошибка. */
  private async punish(pair: Pair, def: TaskDef, now: Date, result: TickResult): Promise<void> {
    const locked = await this.watch.withPairLock(pair.accountId, pair.taskId, async () => await this.unsubscribed(pair, def, now));
    if (locked.locked) result.penalized += locked.value;
    else result.busy += 1;
  }

  /**
   * Событие отписки пары. Порядок важен: всё до `markPenalized` идемпотентно —
   * списание держится на ключе отзыва, уведомление на ключе события, закрытие
   * не ослабляет действующее, — поэтому оборванный проход при повторе доделывает
   * событие. Номер события тот же: он считается от последнего отмеченного.
   * Возвращает, сколько окон оштрафовано.
   */
  private async unsubscribed(pair: Pair, def: TaskDef, now: Date): Promise<number> {
    const { accountId, taskId } = pair;
    // Под замком окна читаются заново: пока ждали замок, другой проход мог уже всё закрыть. Окно,
    // заведённое после начала прохода, ответа площадки не слышало: его очередь — следующий проход.
    const open = (await this.watch.openOf(accountId, taskId)).filter((window) => window.startedAt.getTime() <= now.getTime());
    if (open.length === 0) return 0;
    const eventNo = (await this.watch.lastEventNo(accountId, taskId)) + 1;
    const items: Penalty[] = [];
    for (const window of open) items.push({ key: keyOf(window), revoked: await this.revokeReward(window, now) });
    const total = sumOf(items);
    const closedUntil = closesPartnerTasks(eventNo) ? await this.closePartnerTasks(accountId, taskId, eventNo, now) : null;
    await this.tell(pair, def, eventNo, total, closedUntil, now);
    await this.watch.markPenalized(items, eventNo, now);
    this.logger.log(JSON.stringify({ module: "tasks", event: "channel_unsubscribed", accountId, taskId, eventNo, ...total, closed: closesPartnerTasks(eventNo) }));
    return open.length;
  }

  /**
   * Отозвать награду окна по всем ресурсам. Ресурсы перебираются все, а не по
   * текущей награде задания: правка награды в панели после забора не должна
   * оставить начисленное нетронутым. Сколько отзывать, решает запись начисления.
   */
  private async revokeReward(window: WatchRow, now: Date): Promise<Revoked> {
    const revoked: Revoked = { coins: 0, gems: 0, shards: 0 };
    const suffix = `${window.accountId}:${window.taskId}:${window.periodStart}`;
    for (const [field, resource] of REWARD_RESOURCES) {
      const outcome = await this.wallet.revokeUpTo({
        accountId: window.accountId,
        resource,
        grantKey: `task:${suffix}:${resource}`,
        idempotencyKey: `taskrevoke:${suffix}:${resource}`,
        reason: TASK_REVOKE_REASON,
        source: `task:${window.taskId}`,
        at: now,
      });
      // `duplicate` — отзыв уже был (оборванный проход), в ответе то, что забрали тогда.
      revoked[field] = outcome.status === "nothing" ? 0 : outcome.revoked;
    }
    return revoked;
  }

  /** Закрыть партнёрские задания на 30 суток; конец срока — если закрыто этим событием, иначе `null`. */
  private async closePartnerTasks(accountId: string, taskId: string, eventNo: number, now: Date): Promise<string | null> {
    const comment = `Повторная отписка от канала после награды: задание ${taskId}, событие ${String(eventNo)}`;
    const outcome = await this.restrictions.imposeBySystemFor(accountId, "partner_tasks", "task_unsubscribe", comment, CLOSE_MS, now);
    return outcome === "imposed" ? new Date(now.getTime() + CLOSE_MS).toISOString() : null;
  }

  /**
   * Уведомление игроку, одно на событие. Сбой базы пробрасывается — проход
   * повторится, ключ события не даст продублировать; данные не по схеме
   * повтор не вылечит, и штраф из-за них не должен зависнуть.
   */
  private async tell(pair: Pair, def: TaskDef, eventNo: number, total: Revoked, closedUntil: string | null, now: Date): Promise<void> {
    try {
      await this.notifications.deliver({
        accountId: pair.accountId,
        kind: "task_unsubscribed",
        payload: { title: def.title, coins: total.coins, gems: total.gems, shards: total.shards, closedUntil },
        dedupeKey: `task_unsubscribed:${pair.accountId}:${pair.taskId}:${String(eventNo)}`,
        at: now,
      });
    } catch (error: unknown) {
      if (!(error instanceof ValidationError)) throw error;
      this.logger.error(JSON.stringify({ module: "tasks", event: "channel_watch_notice_rejected", accountId: pair.accountId, taskId: pair.taskId, eventNo, reason: error.message }));
    }
  }
}

function groupByPair(rows: readonly WatchRow[]): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const row of rows) {
    const id = `${row.accountId}|${row.taskId}`;
    const pair = pairs.get(id) ?? { accountId: row.accountId, taskId: row.taskId, windows: [] };
    pair.windows.push(row);
    pairs.set(id, pair);
  }
  return [...pairs.values()];
}

function sumOf(items: readonly Penalty[]): Revoked {
  const total: Revoked = { coins: 0, gems: 0, shards: 0 };
  for (const { revoked } of items) {
    total.coins += revoked.coins;
    total.gems += revoked.gems;
    total.shards += revoked.shards;
  }
  return total;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
