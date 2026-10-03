import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ChannelMemberships, MembershipRejectedError, MembershipUnavailableError } from "../../platforms/ports/channel-membership.js";
import { imagePath } from "../media/image-rules.js";
import { MediaService } from "../media/media.service.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { WalletService } from "../wallet/wallet.service.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import {
  TaskCheckUnavailableError,
  TaskLimitReachedError,
  TaskNotDoneError,
  TaskNotFoundError,
  TaskNotJoinedError,
  TaskNotOpenedError,
  TaskShapeLockedError,
} from "./tasks-errors.js";
import {
  OPEN_KINDS,
  RUN_KINDS,
  TASK_KIND_IDS,
  TASK_LIMIT_GRACE_MIN,
  TASK_PERIODS,
  countsForTasks,
  isRunKind,
  rewardReason,
  slotsFor,
  visibleOn,
  type TaskCategory,
  type TaskDef,
  type TaskKind,
  type TaskParticipation,
  type TaskPeriod,
} from "./task-rules.js";
import { TASKS_REPOSITORY, type TaskDelta, type TaskProgressRow, type TasksRepository } from "./tasks.repository.js";

/**
 * Задания и достижения (docs/35-stage4-plan.md Р52, WP13). Прогресс двигает
 * записанный забег — серверное событие, а не клиентская аналитика; забор —
 * начисление ключом задания и срока, потом отметка, как у награды дня: два
 * запроса разом начисляют однажды, а начисленное, но не отмеченное после
 * сбоя кошелёк узнает по ключу.
 *
 * Каталог правится из панели без релиза и держится в памяти: его читает
 * каждый записанный забег, а меняется он раз в неделю. Правка из панели
 * видна через полминуты.
 *
 * Партнёрские цели (Р52) забег не двигает. Подписку на канал проверяет бот
 * площадки в момент забора — через порт, без знания о Telegram; переход по
 * ссылке и запуск бота засчитывает сам переход через сервер (`open`).
 *
 * Лимит выполнений партнёрской цели (Р82, WP13, часть 7) — сколько игроков
 * получат награду. Игрок видит остаток; исчерпан — цель пропадает у тех, кто
 * к ней не переходил, а перешедшим в последний час место держится: иначе
 * они подписались бы зря.
 */

const DB_TIMEOUT_MS = 3_000;
const CATALOG_TTL_MS = 30_000;

export interface TaskView {
  id: string;
  period: TaskPeriod;
  /** вкладка у игрока: партнёрские цели — своей категорией */
  category: TaskCategory;
  kind: TaskKind;
  /** `null` — текст по виду цели у клиента */
  title: string | null;
  target: number;
  value: number;
  done: boolean;
  claimed: boolean;
  reward: { coins: number; gems: number; shards: number };
  passPoints: number;
  /** куда вести игрока — у цели «канал»; у целей забега — пусто */
  link: string | null;
  /** места в цели с лимитом; без лимита и у выполнившего — пусто */
  slots: { left: number; total: number; holdUntil: string | null } | null;
  /** картинка 1:1 партнёрской цели — путь от адреса API; нет — значок вида */
  image: string | null;
}

export interface TaskCatalogView {
  tasks: TaskDef[];
  kinds: readonly TaskKind[];
  periods: readonly TaskPeriod[];
  /** сколько игроков выполнили цель — у выполненных хоть раз */
  completions: Record<string, number>;
}

export interface TaskClaimResult {
  claimed: boolean;
  /** сколько легло на баланс; меньше награды — упёрлось в суточный потолок */
  credited: { coins: number; gems: number; shards: number };
  tasks: TaskView[];
}

/** Ресурс награды в кошельке: осколки заданий — обычные. */
const REWARD_RESOURCES = [
  ["coins", "coins"],
  ["gems", "gems"],
  ["shards", "shard_common"],
] as const satisfies readonly (readonly [keyof TaskView["reward"], WalletResource])[];

@Injectable()
export class TasksService implements OnModuleInit {
  private readonly logger = new Logger("tasks");
  private cache: { defs: TaskDef[]; until: number } | null = null;

  constructor(
    @Inject(TASKS_REPOSITORY) private readonly repository: TasksRepository,
    private readonly wallet: WalletService,
    private readonly runs: RunsHooks,
    private readonly roles: RolesService,
    private readonly memberships: ChannelMemberships,
    private readonly media: MediaService,
  ) {}

  onModuleInit(): void {
    this.runs.onRecorded("tasks", (run) => this.onRun(run));
  }

  async view(account: AccountRef, at = new Date()): Promise<TaskView[]> {
    const { defs, progress, participation } = await this.state(account, at);
    return viewOf(defs, progress, participation, at);
  }

  async claim(account: AccountRef, taskId: string, at = new Date()): Promise<TaskClaimResult> {
    const { accountId } = account;
    const { defs, progress, participation } = await this.state(account, at);
    const def = defs.find((candidate) => candidate.taskId === taskId);
    if (def === undefined) throw new TaskNotFoundError();
    // Мест нет, а игрок к цели не переходил — бота спрашивать незачем.
    if (!slotsFor(def.limit, participation.get(taskId) ?? null, at).visible) throw this.limitReached(accountId, taskId);
    let row = progress.find((candidate) => candidate.taskId === taskId);
    if (row === undefined || !row.done) {
      if (isRunKind(def.kind)) throw new TaskNotDoneError();
      if (OPEN_KINDS.has(def.kind)) throw new TaskNotOpenedError();
      await this.checkJoined(account, def);
      const completed = await this.db(this.repository.complete(accountId, def, at, graceSince(at)));
      if (completed === null) throw this.limitReached(accountId, taskId);
      row = completed;
      this.logger.log(JSON.stringify({ module: "tasks", event: "task_checked", accountId, taskId, kind: def.kind }));
    }
    const done = row;
    // Выполнивший место уже занял — у него лимита больше нет.
    const joined = withCompleted(participation, taskId, at);
    // Прогресс остальных целей — как был; этой — после проверки площадки.
    const others = progress.filter((candidate) => candidate.taskId !== taskId);
    const none = { coins: 0, gems: 0, shards: 0 };
    if (done.claimed) return { claimed: false, credited: none, tasks: viewOf(defs, [...others, done], joined, at) };

    const credited = { ...none };
    for (const [field, resource] of REWARD_RESOURCES) {
      if (def[field] <= 0) continue;
      const result = await this.wallet.grant({
        accountId,
        resource,
        amount: def[field],
        reason: rewardReason(def.period),
        source: `task:${taskId}`,
        idempotencyKey: `task:${accountId}:${taskId}:${done.periodStart}:${resource}`,
        at,
      });
      credited[field] = result.credited;
    }
    const claimed = await this.db(this.repository.markClaimed(accountId, taskId, done.periodStart, at));
    if (claimed) this.logger.log(JSON.stringify({ module: "tasks", event: "task_claimed", accountId, taskId, period: def.period, ...credited }));
    return { claimed, credited, tasks: viewOf(defs, [...others, { ...done, claimed: true }], joined, at) };
  }

  /**
   * Игрок переходит по ссылке партнёрской цели: переход по ссылке и запуск
   * бота этим и выполнены, подписку на канал проверит забор. Повтор ничего
   * не меняет — время выполнения остаётся первым.
   */
  async open(account: AccountRef, taskId: string, at = new Date()): Promise<{ url: string; tasks: TaskView[] }> {
    const { accountId } = account;
    const { defs, progress, participation } = await this.state(account, at);
    const def = defs.find((candidate) => candidate.taskId === taskId);
    if (def === undefined || def.params === null) throw new TaskNotFoundError();
    const mine = participation.get(taskId) ?? null;
    const place = slotsFor(def.limit, mine, at);
    if (!place.visible) throw this.limitReached(accountId, taskId);
    this.logger.log(JSON.stringify({ module: "tasks", event: "task_opened", accountId, taskId, kind: def.kind }));
    if (!OPEN_KINDS.has(def.kind)) {
      // Переход до исчерпания — начало мягкого часа. После исчерпания час не
      // продлевается: иначе игрок держал бы место переходами бесконечно.
      if ((mine === null || mine.completedAt === null) && (place.slots === null || place.slots.left > 0)) await this.db(this.repository.markOpened(accountId, taskId, at));
      return { url: def.params.url, tasks: viewOf(defs, progress, participation, at) };
    }
    const done = await this.db(this.repository.complete(accountId, def, at, graceSince(at)));
    if (done === null) throw this.limitReached(accountId, taskId);
    const others = progress.filter((candidate) => candidate.taskId !== taskId);
    return { url: def.params.url, tasks: viewOf(defs, [...others, done], withCompleted(participation, taskId, at), at) };
  }

  /** Каталог, прогресс и участие игрока — разом: экран заданий ждёт самого долгого из трёх. */
  private async state(account: AccountRef, at: Date): Promise<{ defs: TaskDef[]; progress: TaskProgressRow[]; participation: Map<string, TaskParticipation> }> {
    const [defs, progress, participation] = await Promise.all([
      this.visible(account),
      this.db(this.repository.progress(account.accountId, at)),
      this.db(this.repository.participation(account.accountId)),
    ]);
    return { defs, progress, participation };
  }

  private limitReached(accountId: string, taskId: string): TaskLimitReachedError {
    this.logger.log(JSON.stringify({ module: "tasks", event: "task_limit_reached", accountId, taskId }));
    return new TaskLimitReachedError();
  }

  /**
   * Подписка — у площадки игрока, ботом. Не подписан — отказ, который
   * клиент показывает как «подпишитесь и нажмите ещё раз». Площадка
   * проверить не может — это настройка задания: игроку «позже», команде —
   * ошибка в лог с заданием.
   */
  private async checkJoined(account: AccountRef, def: TaskDef): Promise<void> {
    const params = def.params;
    const chat = params?.chat;
    const membership = params?.platform === undefined ? null : this.memberships.for(params.platform);
    if (params === null || chat === undefined || membership === null) throw new TaskCheckUnavailableError();
    let joined: boolean;
    try {
      joined = await membership.isMember(chat, account.platformUserId);
    } catch (error: unknown) {
      if (error instanceof MembershipRejectedError) {
        this.logger.error(JSON.stringify({ module: "tasks", event: "task_check_misconfigured", taskId: def.taskId, chat, reason: error.message }));
        throw new TaskCheckUnavailableError();
      }
      if (error instanceof MembershipUnavailableError) throw new TaskCheckUnavailableError();
      throw error;
    }
    if (!joined) throw new TaskNotJoinedError();
  }

  /** Знак меню: сколько наград можно забрать прямо сейчас (Р50). */
  async badge(accountId: string, at = new Date()): Promise<number> {
    const progress = await this.db(this.repository.progress(accountId, at));
    return progress.filter((row) => row.done && !row.claimed).length;
  }

  /** Весь каталог, и выключенное, с видами и сроками для формы — панели. */
  async catalog(actor: AccountRef): Promise<TaskCatalogView> {
    await this.roles.require(actor, "tasks.edit");
    const [tasks, completions] = await Promise.all([this.db(this.repository.catalog()), this.db(this.repository.completions())]);
    return { tasks, kinds: TASK_KIND_IDS, periods: TASK_PERIODS, completions: Object.fromEntries(completions) };
  }

  /**
   * Строка каталога из панели: новый id — новое задание, известный — правка
   * цели, награды, текста, места и включённости. Срок и вид после создания
   * не меняются. Каждое изменение — в аудит.
   */
  async save(actor: AccountRef, task: TaskDef, at = new Date()): Promise<TaskDef> {
    await this.roles.require(actor, "tasks.edit");
    const before = (await this.db(this.repository.catalog())).find((candidate) => candidate.taskId === task.taskId) ?? null;
    // Картинка — загруженная и того вида, что нужен строке задания: квадрат, а
    // не слайд. Прежнюю не перепроверяем — она уже у игроков.
    if (task.image !== null && task.image !== before?.image) await this.media.require(task.image, "task");
    if (before === null) {
      if (!(await this.db(this.repository.insert(task, actor.accountId, at)))) throw new TaskShapeLockedError();
      await this.roles.audit({ actorAccountId: actor.accountId, action: "tasks.create", target: task.taskId, after: task });
    } else {
      if (before.period !== task.period || before.kind !== task.kind) throw new TaskShapeLockedError();
      if (!(await this.db(this.repository.update(task, actor.accountId, at)))) throw new TaskNotFoundError();
      await this.roles.audit({ actorAccountId: actor.accountId, action: "tasks.update", target: task.taskId, before, after: task });
    }
    this.forgetCatalog();
    this.logger.log(JSON.stringify({ module: "tasks", event: before === null ? "task_created" : "task_updated", taskId: task.taskId, actor: actor.accountId }));
    return task;
  }

  /**
   * Записанный забег двигает цели. Слушатель работает после ответа игроку;
   * повтор события ничего не удваивает — забег засчитывается по `run_id`
   * однажды.
   */
  async onRun(run: RecordedRun): Promise<void> {
    if (!countsForTasks(run)) return;
    const deltas: TaskDelta[] = (await this.active()).flatMap((def) => {
      if (!isRunKind(def.kind)) return [];
      const kind = RUN_KINDS[def.kind];
      return [{ taskId: def.taskId, period: def.period, target: def.target, op: kind.op, amount: kind.measure(run) }];
    });
    if (deltas.every((delta) => delta.amount <= 0)) return;
    await this.db(this.repository.applyRun({ runId: run.runId, accountId: run.accountId, at: run.finishedAt, deltas }));
  }

  /** Правка каталога из панели видна сразу на этой реплике, на остальных — через полминуты. */
  forgetCatalog(): void {
    this.cache = null;
  }

  /** Включённые цели, которые игрок может выполнить: цель другой площадки ему не показывается, цель без площадки — всем. */
  private async visible(account: AccountRef): Promise<TaskDef[]> {
    return (await this.active()).filter((def) => visibleOn(def.params, account.platform));
  }

  private async active(): Promise<TaskDef[]> {
    const now = Date.now();
    if (this.cache === null || this.cache.until <= now) {
      const defs = await this.db(this.repository.catalog());
      this.cache = { defs: defs.filter((def) => def.active), until: now + CATALOG_TTL_MS };
    }
    return this.cache.defs;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "задания");
  }
}

/** Начало мягкого часа: переход раньше — место уже не держится. */
function graceSince(at: Date): Date {
  return new Date(at.getTime() - TASK_LIMIT_GRACE_MIN * 60_000);
}

/** Участие после выполнения: игрок занял место, и лимит его больше не касается. */
function withCompleted(participation: ReadonlyMap<string, TaskParticipation>, taskId: string, at: Date): Map<string, TaskParticipation> {
  const before = participation.get(taskId) ?? { completions: 0, openedAt: null, completedAt: null };
  return new Map(participation).set(taskId, { ...before, completedAt: before.completedAt ?? at });
}

/**
 * Цели в порядке каталога: срок, место, id. Не двигавшаяся цель — с нулём.
 * Цель с исчерпанным лимитом, к которой игрок не переходил, не показывается.
 */
export function viewOf(defs: readonly TaskDef[], progress: readonly TaskProgressRow[], participation: ReadonlyMap<string, TaskParticipation> = new Map(), at = new Date()): TaskView[] {
  const byTask = new Map(progress.map((row) => [row.taskId, row]));
  return defs.flatMap((def) => {
    const place = slotsFor(def.limit, participation.get(def.taskId) ?? null, at);
    if (!place.visible) return [];
    const row = byTask.get(def.taskId);
    const slots = place.slots === null ? null : { left: place.slots.left, total: place.slots.total, holdUntil: place.slots.holdUntil?.toISOString() ?? null };
    return {
      id: def.taskId,
      period: def.period,
      category: def.params === null ? def.period : "partner",
      kind: def.kind,
      title: def.title,
      target: def.target,
      value: Math.min(row?.value ?? 0, def.target),
      done: row?.done ?? false,
      claimed: row?.claimed ?? false,
      reward: { coins: def.coins, gems: def.gems, shards: def.shards },
      passPoints: def.passPoints,
      link: def.params?.url ?? null,
      slots,
      image: def.image === null ? null : imagePath(def.image),
    };
  });
}
