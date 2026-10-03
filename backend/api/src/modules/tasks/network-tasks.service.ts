import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { AdRequester } from "../ads/ad-creatives.js";
import { profileOf } from "../ads/ad-networks.js";
import { AdTaskFeeds, type FeedCheckOutcome, type FeedTask } from "../ads/ad-task-feeds.js";
import { AdTaskHooks, AdTasks, TASK_NETWORKS, openTaskIn, type AdTaskOffer, type ConfirmedNetworkTask, type TaskDelivery, type TaskReadiness } from "../ads/ad-tasks.js";
import type { AdBlockRow } from "../ads/ads.repository.js";
import { AdsService } from "../ads/ads.service.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import { admitsTask, networkTaskState, nextTaskAt, type NetworkTaskDef } from "./network-task-rules.js";
import { NETWORK_TASKS_REPOSITORY, type NetworkTaskRow, type NetworkTasksRepository } from "./network-tasks.repository.js";
import { TaskNotFoundError } from "./tasks-errors.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";

/**
 * Задания рекламных сетей во вкладке «Партнёры» (docs/35-stage4-plan.md
 * WP13, часть 6, Р80). Модуль заданий — хозяин места `task`: решает, сколько
 * заданий сети игрок получит и когда, и выдаёт награду, когда сеть
 * подтвердила выполнение. Что показывает сеть и как подтверждает — модуль
 * рекламы (`ads/ad-tasks.ts`, лента — `ads/ad-task-feeds.ts`).
 *
 * Задание ленты (обмен трафиком Taddy) экран заданий не ждёт: список
 * отвечает сразу, а строка сети спрашивает своё задание отдельно (`item`) —
 * сеть может думать секунды.
 *
 * Награда — кошельком по ключу сессии, потом забор сессии: сорвись выдача,
 * сессия остаётся выполненной, и её дожмёт повтор подтверждения сети или
 * следующее открытие экрана заданий тем же ключом.
 */

const DB_TIMEOUT_MS = 3_000;
const CATALOG_TTL_MS = 30_000;

export interface NetworkTaskReward {
  coins: number;
  gems: number;
  shards: number;
}

export interface NetworkTaskView {
  network: string;
  /** как задание доходит до игрока: элементом SDK сети или лентой — тогда строка спрашивает задание сама */
  delivery: TaskDelivery;
  /** имя сети — для пометки «Реклама · AdsGram» */
  title: string;
  reward: NetworkTaskReward;
  /** выполнено за игровые сутки и потолок суток */
  doneToday: number;
  dailyCap: number;
  /** задание сети сейчас — что передать SDK; `null` — потолок суток, пауза или задание ленты */
  offer: AdTaskOffer | null;
  /** когда сеть даст следующее задание; `null` — даёт сейчас */
  nextAt: string | null;
}

/** Строка ленты получила задание, выполненное задание или ничего — строки нет. */
export type NetworkFeedItem = { kind: "task"; task: FeedTask } | ({ kind: "done" } & NetworkTaskProgress) | { kind: "none" };

/** Ответ «Проверить» — с тем, что показать в строке после него. */
export type NetworkFeedCheck = { result: FeedCheckOutcome } & NetworkTaskProgress;

/** Счёт суток сети после выполнения — для «Награда получена · следующее через …». */
export interface NetworkTaskProgress {
  doneToday: number;
  nextAt: string | null;
}

export interface NetworkTaskAdminView extends NetworkTaskRow {
  title: string;
  /**
   * Что нужно, чтобы игроки увидели задания сети: включённый блок в месте
   * «Задания» раздела «Реклама» и чем подтвердить выполнение — у AdsGram
   * адрес награды.
   */
  ready: TaskReadiness;
}

const REWARD_RESOURCES = [
  ["coins", "coins"],
  ["gems", "gems"],
  ["shards", "shard_common"],
] as const satisfies readonly (readonly [keyof NetworkTaskReward, WalletResource])[];

@Injectable()
export class NetworkTasksService implements OnModuleInit {
  private readonly logger = new Logger("tasks");
  private cache: { rows: NetworkTaskRow[]; until: number } | null = null;

  constructor(
    @Inject(NETWORK_TASKS_REPOSITORY) private readonly repository: NetworkTasksRepository,
    private readonly adTasks: AdTasks,
    private readonly feeds: AdTaskFeeds,
    private readonly hooks: AdTaskHooks,
    private readonly ads: AdsService,
    private readonly wallet: WalletService,
    private readonly roles: RolesService,
    private readonly restrictions: AccountRestrictions,
  ) {}

  onModuleInit(): void {
    this.hooks.onConfirmed((task) => this.reward(task));
  }

  /**
   * Строки сетей у игрока. Сбой здесь не роняет экран заданий: задания
   * сетей — добавка к своим, и без них вкладка работает.
   */
  async view(account: AccountRef, at = new Date()): Promise<NetworkTaskView[]> {
    try {
      return await this.build(account, at);
    } catch (error: unknown) {
      this.log("warn", { event: "network_tasks_unavailable", accountId: account.accountId, reason: error instanceof Error ? error.message : "unknown" });
      return [];
    }
  }

  private async build(account: AccountRef, at: Date): Promise<NetworkTaskView[]> {
    // Партнёрские задания закрыты ограничением — заданий сетей у игрока нет.
    if ((await this.restrictions.status(account.accountId, "partner_tasks", at)) !== null) return [];
    const defs = (await this.rows()).filter((row) => row.active);
    const ready: { def: NetworkTaskRow; block: NonNullable<Awaited<ReturnType<AdTasks["block"]>>> }[] = [];
    for (const def of defs) {
      const block = await this.adTasks.block(def.networkKey, account.platform);
      if (block !== null) ready.push({ def, block });
    }
    if (ready.length === 0) return [];

    const history = await this.adTasks.history(account.accountId, at);
    await this.heal(account.accountId, history.sessions, at);
    const views: NetworkTaskView[] = [];
    for (const { def, block } of ready) {
      const delivery = TASK_NETWORKS[def.networkKey]?.delivery ?? "element";
      const state = networkTaskState(def.networkKey, history);
      const next = nextTaskAt(def, state, history.dayStart, at)?.toISOString() ?? null;
      // Ленту экран не ждёт: строка спросит задание сама. Открытая сессия —
      // задание уже выдано, и его можно выполнить, даже если пауза ещё идёт.
      const offer = delivery === "element" ? await this.adTasks.session(account.accountId, block, at, (fresh) => admitsTask(def, fresh, def.networkKey, at)) : null;
      const waiting = delivery === "element" ? offer === null : !openTaskIn(history, def.networkKey, at);
      views.push({
        network: def.networkKey,
        delivery,
        title: profileOf(def.networkKey)?.title ?? def.networkKey,
        reward: rewardOf(def),
        doneToday: state.doneToday,
        dailyCap: def.dailyCap,
        offer,
        nextAt: waiting ? next : null,
      });
    }
    return views;
  }

  /**
   * Задание ленты для строки сети. Нет строки сети, блока или игрока —
   * заданий нет: строка просто не появится, это не ошибка экрана.
   */
  async item(account: AccountRef, networkKey: string, requester: AdRequester, at = new Date()): Promise<NetworkFeedItem> {
    if ((await this.restrictions.status(account.accountId, "partner_tasks", at)) !== null) return { kind: "none" };
    const found = await this.feedNetwork(account, networkKey);
    if (found === null) return { kind: "none" };
    const { def, block } = found;
    const outcome = await this.feeds.item(account.accountId, block, requester, at, (history) => admitsTask(def, history, networkKey, at));
    if (outcome.kind === "task") return outcome;
    if (outcome.kind === "done") return { kind: "done", ...(await this.progress(account.accountId, def, at)) };
    if (outcome.reason === "unavailable") this.log("warn", { event: "network_feed_unavailable", accountId: account.accountId, network: networkKey });
    return { kind: "none" };
  }

  /** «Проверить» у задания ленты: выполнено — награда уже выдана, ответ говорит, когда следующее. */
  async check(account: AccountRef, networkKey: string, sessionId: string, requester: AdRequester, at = new Date()): Promise<NetworkFeedCheck> {
    await this.restrictions.ensure(account.accountId, "partner_tasks", at);
    const found = await this.feedNetwork(account, networkKey);
    if (found === null) throw new TaskNotFoundError();
    const result = await this.feeds.check(account.accountId, found.block, sessionId, requester, at);
    return { result, ...(await this.progress(account.accountId, found.def, at)) };
  }

  /** Строка сети с лентой и её блок для площадки игрока; `null` — заданий этой сети у игрока нет. */
  private async feedNetwork(account: AccountRef, networkKey: string): Promise<{ def: NetworkTaskRow; block: AdBlockRow } | null> {
    if (TASK_NETWORKS[networkKey]?.delivery !== "feed") return null;
    const def = (await this.rows()).find((row) => row.networkKey === networkKey && row.active);
    if (def === undefined) return null;
    const block = await this.adTasks.block(networkKey, account.platform);
    return block === null ? null : { def, block };
  }

  private async progress(accountId: string, def: NetworkTaskRow, at: Date): Promise<NetworkTaskProgress> {
    const history = await this.adTasks.history(accountId, at);
    const state = networkTaskState(def.networkKey, history);
    const open = openTaskIn(history, def.networkKey, at);
    return { doneToday: state.doneToday, nextAt: open ? null : (nextTaskAt(def, state, history.dayStart, at)?.toISOString() ?? null) };
  }

  /**
   * Подтверждённое сетью, но не выданное — сорвалась выдача, а сеть не
   * повторила подтверждение. Выдаётся тем же ключом сессии; сбой здесь
   * только в лог: следующее открытие экрана попробует снова.
   */
  private async heal(accountId: string, sessions: readonly { sessionId: string; networkKey: string; status: string }[], at: Date): Promise<void> {
    for (const session of sessions) {
      if (session.status !== "completed") continue;
      try {
        await this.reward({ accountId, networkKey: session.networkKey, sessionId: session.sessionId, repeat: true, at });
      } catch (error: unknown) {
        this.log("warn", { event: "network_task_heal_failed", accountId, sessionId: session.sessionId, reason: error instanceof Error ? error.message : "unknown" });
      }
    }
  }

  /** Сеть подтвердила задание: награда строки сети — кошельком по ключу сессии, потом забор сессии. */
  private async reward(task: ConfirmedNetworkTask): Promise<void> {
    const def = (await this.rows()).find((row) => row.networkKey === task.networkKey);
    if (def === undefined) throw new Error(`у сети ${task.networkKey} нет строки заданий — награду не из чего выдать`);
    const credited: NetworkTaskReward = { coins: 0, gems: 0, shards: 0 };
    // Сеть подтвердила задание игроку с ограничением: награды нет и не будет,
    // а сессия забирается — иначе сеть повторяла бы подтверждение.
    const withheld = (await this.restrictions.status(task.accountId, "partner_tasks", task.at)) !== null;
    if (withheld) this.log("log", { event: "network_task_reward_withheld", accountId: task.accountId, network: task.networkKey, sessionId: task.sessionId });
    for (const [field, resource] of REWARD_RESOURCES) {
      if (withheld || def[field] <= 0) continue;
      const result = await this.wallet.grant({
        accountId: task.accountId,
        resource,
        amount: def[field],
        reason: "task_reward",
        source: `adtask:${task.networkKey}`,
        idempotencyKey: `adtask:${task.accountId}:${task.sessionId}:${resource}`,
        at: task.at,
      });
      credited[field] = result.credited;
    }
    const claimed = await this.ads.claim(task.accountId, task.sessionId, "task", task.at);
    if (!claimed.repeat && !withheld) this.log("log", { event: "network_task_rewarded", accountId: task.accountId, network: task.networkKey, sessionId: task.sessionId, ...credited });
  }

  /** Строки сетей с готовностью — панели. */
  async catalog(actor: AccountRef): Promise<NetworkTaskAdminView[]> {
    await this.roles.require(actor, "tasks.edit");
    const rows = await this.db(this.repository.all());
    return await Promise.all(rows.map(async (row) => await this.adminView(row)));
  }

  /** Правка строки сети из панели — в аудит; игроки увидят её в пределах полуминуты. */
  async save(actor: AccountRef, def: NetworkTaskDef, at = new Date()): Promise<NetworkTaskAdminView> {
    await this.roles.require(actor, "tasks.edit");
    const before = (await this.db(this.repository.all())).find((row) => row.networkKey === def.networkKey) ?? null;
    if (before === null || !(await this.db(this.repository.update(def, actor.accountId, at)))) throw new TaskNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "tasks.network.update", target: def.networkKey, before: auditOf(before), after: auditOf(def) });
    this.cache = null;
    this.log("log", { event: "network_task_updated", network: def.networkKey, actor: actor.accountId });
    return await this.adminView({ ...def, updatedAt: at, updatedBy: actor.accountId });
  }

  private async adminView(row: NetworkTaskRow): Promise<NetworkTaskAdminView> {
    return { ...row, title: profileOf(row.networkKey)?.title ?? row.networkKey, ready: await this.adTasks.readiness(row.networkKey) };
  }

  private async rows(): Promise<NetworkTaskRow[]> {
    const now = Date.now();
    if (this.cache === null || this.cache.until <= now) this.cache = { rows: await this.db(this.repository.all()), until: now + CATALOG_TTL_MS };
    return this.cache.rows;
  }

  private log(level: "log" | "warn", fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "tasks", ...fields }));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "задания сетей");
  }
}

function rewardOf(def: NetworkTaskDef): NetworkTaskReward {
  return { coins: def.coins, gems: def.gems, shards: def.shards };
}

/** В журнал — числа строки, без служебных полей. */
function auditOf(def: NetworkTaskDef): Record<string, unknown> {
  return { active: def.active, dailyCap: def.dailyCap, pauseMin: def.pauseMin, coins: def.coins, gems: def.gems, shards: def.shards };
}
