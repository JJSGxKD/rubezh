import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { BattlePassService } from "../battle-pass/battle-pass.service.js";
import { ChannelMemberships, MembershipRejectedError, MembershipUnavailableError } from "../../platforms/ports/channel-membership.js";
import { ExternalLinkStarters } from "../../platforms/ports/external-link.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { LinkUnavailableError } from "../external-identity/external-identity-errors.js";
import { LINK_PLATFORMS } from "../external-identity/external-identity-rules.js";
import { ExternalIdentityService } from "../external-identity/external-identity.service.js";
import { imagePath } from "../media/image-rules.js";
import { MediaService } from "../media/media.service.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PrologueService } from "../runs/prologue.service.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { WalletService } from "../wallet/wallet.service.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import { WATCH_MS } from "./channel-watch-rules.js";
import { ChannelWatchService } from "./channel-watch.service.js";
import {
  TaskCheckUnavailableError,
  TaskEmblemFixedError,
  TaskLimitReachedError,
  TaskLinkRequiredError,
  TaskNotDoneError,
  TaskNotFoundError,
  TaskNotJoinedError,
  TaskNotOpenedError,
  TaskOrderMismatchError,
  TaskShapeLockedError,
} from "./tasks-errors.js";
import {
  OPEN_KINDS,
  RUN_KINDS,
  STATE_KINDS,
  TASK_KIND_IDS,
  TASK_LIMIT_GRACE_MIN,
  TASK_PERIODS,
  NO_LINKABLE,
  TASK_SORT_MAX,
  channelLinkMode,
  countsForTasks,
  isCheckedKind,
  isEmblemKind,
  isRunKind,
  masterIdsOf,
  rewardReason,
  slotsFor,
  taskGroup,
  visibleOn,
  withDynamicTargets,
  type AchievementCategory,
  type ChannelLinkMode,
  type PoolTier,
  type RunFilter,
  type TaskCategory,
  type TaskDef,
  type TaskGroup,
  type TaskKind,
  type TaskParticipation,
  type TaskPeriod,
  type TaskRun,
} from "./task-rules.js";
import { inPlay, rotationAt } from "./task-pool.js";
import { readyCount, type PointsPeriod, type PointsView } from "./task-points.js";
import { TaskPointsService, type PointsClaimResult } from "./task-points.service.js";
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
 * площадки в момент забора и ещё 7 суток после него (Р115, T-0178: окно
 * перепроверки — `ChannelWatchService`) — через порт, без знания о Telegram;
 * переход по ссылке и запуск бота засчитывает сам переход через сервер (`open`).
 *
 * Лимит выполнений партнёрской цели (Р82, WP13, часть 7) — сколько игроков
 * получат награду. Игрок видит остаток; исчерпан — цель пропадает у тех, кто
 * к ней не переходил, а перешедшим в последний час место держится: иначе
 * они подписались бы зря.
 */

const DB_TIMEOUT_MS = 3_000;
const CATALOG_TTL_MS = 30_000;
/** Код, которым спрашивается, настроен ли бот площадки: `startUrl` — чистая функция, ничего не выдаёт. */
const PROBE_CODE = "0".repeat(16);

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
  /**
   * Как игрока проверяют в канале (Р188): `own` — канал его площадки, `external` — другой
   * площадки, и первой кнопкой идёт бот; у остальных целей пусто. Не `link`: так уже назван адрес.
   */
  linkMode: ChannelLinkMode | null;
  /** площадка канала; у остальных целей пусто — по ней клиент подписывает кнопку бота */
  channelPlatform: PlatformId | null;
  /** места в цели с лимитом; без лимита и у выполнившего — пусто */
  slots: { left: number; total: number; holdUntil: string | null } | null;
  /** картинка 1:1 партнёрской цели — путь от адреса API; нет — значок вида */
  image: string | null;
  /** ступень пула ротации; `null` — задание в игре всегда */
  tier: PoolTier | null;
  /** оружие, стихия или сложность цели — по ним клиент строит текст */
  filter: RunFilter | null;
  /**
   * Категория достижения (бой, коллекция, мастерство, друзья); у заданий — `null`. Не
   * `category`: так уже названа вкладка игрока.
   */
  achievementCategory: AchievementCategory | null;
  /** лестница достижений и номер ступени с единицы; у остальных — `null` */
  ladder: string | null;
  rung: number | null;
  /** очки престижа за выполненное; у заданий — ноль */
  prestige: number;
  /** скрытое достижение — в список попадает уже открытым */
  hidden: boolean;
  /**
   * Сутки окна перепроверки подписки (Р115, T-0183) у заданий, за которыми сервер наблюдает;
   * у остальных `null` — клиент не угадывает правило, а берёт его отсюда.
   */
  recheckDays: number | null;
}

/** Наблюдаемые задания игрока и срок окна в сутках — то, что нужно `viewOf`, чтобы заполнить `recheckDays`. */
export interface WatchInfo {
  taskIds: ReadonlySet<string>;
  days: number;
}

const DAY_MS = 86_400_000;

/**
 * Берёт ли задание под наблюдение забор награды: то же условие, что в `ChannelWatchService.start`
 * (канал с площадкой и чатом, у площадки есть проверка подписки).
 */
export function isWatchedDef(def: TaskDef, hasMembership: (platform: PlatformId) => boolean): boolean {
  const params = def.params;
  if (def.kind !== "channel" || params === null || params.chat === undefined || params.platform === undefined) return false;
  return hasMembership(params.platform);
}

export interface TaskCatalogView {
  tasks: TaskDef[];
  kinds: readonly TaskKind[];
  periods: readonly TaskPeriod[];
  /** сколько игроков выполнили цель — у выполненных хоть раз */
  completions: Record<string, number>;
  /** что сейчас в ротации: id набора дня и недели */
  rotation: { daily: string[]; weekly: string[] };
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
    private readonly restrictions: AccountRestrictions,
    @Optional() private readonly points?: TaskPointsService,
    @Optional() private readonly pass?: BattlePassService,
    @Optional() private readonly prologue?: PrologueService,
    @Optional() private readonly external?: ExternalIdentityService,
    @Optional() private readonly starters?: ExternalLinkStarters,
    @Optional() private readonly watch?: ChannelWatchService,
  ) {}

  onModuleInit(): void {
    this.runs.onRecorded("tasks", (run) => this.onRun(run));
  }

  async view(account: AccountRef, at = new Date()): Promise<TaskView[]> {
    const { defs, progress, participation } = await this.state(account, at);
    return viewOf(defs, progress, participation, at, account.platform, this.watchInfo(defs));
  }

  /** Полоса очков дня и недели; `null` — сервис очков не подключён (старый состав модуля). */
  async pointsView(accountId: string, at = new Date()): Promise<PointsView | null> {
    return this.points === undefined ? null : await this.points.view(accountId, at);
  }

  /** Забор награды за ступень очков — отдельный сервис, здесь только вход для ручки. */
  async claimPoints(account: AccountRef, period: PointsPeriod, points: number, at = new Date()): Promise<PointsClaimResult> {
    if (this.points === undefined) throw new Error("очки заданий не подключены");
    await this.prologue?.requireOpen(account.accountId);
    return await this.points.claim(account, period, points, at);
  }

  /**
   * Забрать награду. За подписку на канал её ещё 7 суток перепроверяют: отписался —
   * награда списывается (Р115, T-0178); окно заводится после выдачи, и только тому
   * запросу, чья отметка «забрано» встала первой.
   */
  async claim(account: AccountRef, taskId: string, at = new Date()): Promise<TaskClaimResult> {
    const { accountId } = account;
    // Закрыто до победы в прологе (Р151); список заданий отдаётся как обычно — оболочка его просто не показывает.
    await this.prologue?.requireOpen(accountId);
    const { defs, progress, participation } = await this.state(account, at);
    const def = defs.find((candidate) => candidate.taskId === taskId);
    if (def === undefined) throw new TaskNotFoundError();
    // Партнёрские задания закрыты ограничением (WP44); цели забега и состояния игрока — нет.
    if (isCheckedKind(def.kind)) await this.restrictions.ensure(accountId, "partner_tasks", at);
    // Мест нет, а игрок к цели не переходил — бота спрашивать незачем.
    if (!slotsFor(def.limit, participation.get(taskId) ?? null, at).visible) throw this.limitReached(accountId, taskId);
    let row = progress.find((candidate) => candidate.taskId === taskId);
    if (row === undefined || !row.done) {
      // Забег и состояние игрока засчитывает сервер сам: нажатием их не выполнить.
      if (!isCheckedKind(def.kind)) throw new TaskNotDoneError();
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
    if (done.claimed) return { claimed: false, credited: none, tasks: viewOf(defs, [...others, done], joined, at, account.platform, this.watchInfo(defs)) };

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
    if (claimed) {
      this.logger.log(JSON.stringify({ module: "tasks", event: "task_claimed", accountId, taskId, period: def.period, ...credited }));
      await this.startWatch(account, def, done.periodStart, at);
      await this.awardPassPoints(accountId, taskId, def.passPoints, at);
    }
    return { claimed, credited, tasks: viewOf(defs, [...others, { ...done, claimed: true }], joined, at, account.platform, this.watchInfo(defs)) };
  }

  /**
   * Окно перепроверки подписки на выданную награду (Р115, T-0178). Сбой не отменяет
   * забор: награда уже выдана и отмечена, а не взятую под наблюдение команда видит по
   * строке `channel_watch_not_started`.
   */
  private async startWatch(account: AccountRef, def: TaskDef, periodStart: string, at: Date): Promise<void> {
    if (this.watch === undefined || def.kind !== "channel") return;
    try {
      await this.watch.start(account, def, periodStart, at);
    } catch (error: unknown) {
      this.logger.error(JSON.stringify({ module: "tasks", event: "channel_watch_not_started", accountId: account.accountId, taskId: def.taskId, periodStart, reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * Очки пасса за забранное задание (T-0311). Только тому, чья отметка «забрано» встала первой, —
   * поэтому повтор и гонка очков не удваивают. Сбой очков не отменяет забор: награда уже выдана
   * и отмечена, а упавшую прибавку команда видит по строке `pass_points_failed`.
   */
  private async awardPassPoints(accountId: string, taskId: string, points: number, at: Date): Promise<void> {
    if (this.pass === undefined || points <= 0) return;
    try {
      await this.pass.addTaskPoints(accountId, points, at);
    } catch (error: unknown) {
      this.logger.error(JSON.stringify({ module: "tasks", event: "pass_points_failed", accountId, taskId, points, reason: error instanceof Error ? error.message : String(error) }));
    }
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
    await this.restrictions.ensure(accountId, "partner_tasks", at);
    const mine = participation.get(taskId) ?? null;
    const place = slotsFor(def.limit, mine, at);
    if (!place.visible) throw this.limitReached(accountId, taskId);
    this.logger.log(JSON.stringify({ module: "tasks", event: "task_opened", accountId, taskId, kind: def.kind }));
    if (!OPEN_KINDS.has(def.kind)) {
      // Переход до исчерпания — начало мягкого часа. После исчерпания час не
      // продлевается: иначе игрок держал бы место переходами бесконечно.
      if ((mine === null || mine.completedAt === null) && (place.slots === null || place.slots.left > 0)) await this.db(this.repository.markOpened(accountId, taskId, at));
      return { url: def.params.url, tasks: viewOf(defs, progress, participation, at, account.platform, this.watchInfo(defs)) };
    }
    const done = await this.db(this.repository.complete(accountId, def, at, graceSince(at)));
    if (done === null) throw this.limitReached(accountId, taskId);
    const others = progress.filter((candidate) => candidate.taskId !== taskId);
    return { url: def.params.url, tasks: viewOf(defs, [...others, done], withCompleted(participation, taskId, at), at, account.platform, this.watchInfo(defs)) };
  }

  /**
   * Ссылка на бота площадки для задания-канала другой площадки (Р188, T-0377): игрок
   * открывает бота, тот связывает его id с игровым аккаунтом, и только после этого
   * «Проверить» может спросить подписку. Для канала своей площадки и целей без канала
   * бот не нужен — 400. Площадка не подключена — задание игроку не видно, и ссылки на
   * него тоже нет. Выдача ссылки — переход к цели: от него идёт мягкий час лимита (Р82).
   */
  async startExternalLink(account: AccountRef, taskId: string, at = new Date()): Promise<{ url: string }> {
    const { accountId } = account;
    const [defs, participation] = await Promise.all([this.visible(account, at), this.db(this.repository.participation(accountId))]);
    const def = defs.find((candidate) => candidate.taskId === taskId);
    if (def === undefined || def.params === null) throw new TaskNotFoundError();
    await this.restrictions.ensure(accountId, "partner_tasks", at);
    const platform = def.params.platform;
    if (def.kind !== "channel" || platform === undefined || platform === account.platform) throw new ValidationError("Для этого задания бот не нужен");
    const mine = participation.get(taskId) ?? null;
    const place = slotsFor(def.limit, mine, at);
    if (!place.visible) throw this.limitReached(accountId, taskId);
    if (this.external === undefined) throw new LinkUnavailableError();
    const { url } = await this.external.startLink(account, platform);
    this.logger.log(JSON.stringify({ module: "tasks", event: "task_link_started", accountId, taskId, platform }));
    if ((mine === null || mine.completedAt === null) && (place.slots === null || place.slots.left > 0)) await this.db(this.repository.markOpened(accountId, taskId, at));
    return { url };
  }

  /** Наблюдаемые задания среди видимых: окно ставит только забор канала с проверкой площадки (T-0183). */
  private watchInfo(defs: readonly TaskDef[]): WatchInfo | undefined {
    if (this.watch === undefined) return undefined;
    const taskIds = new Set(defs.filter((def) => isWatchedDef(def, (platform) => this.memberships.for(platform) !== null)).map((def) => def.taskId));
    return { taskIds, days: Math.round(WATCH_MS / DAY_MS) };
  }

  /** Каталог, прогресс и участие игрока — разом: экран заданий ждёт самого долгого из трёх. */
  private async state(account: AccountRef, at: Date): Promise<{ defs: TaskDef[]; progress: TaskProgressRow[]; participation: Map<string, TaskParticipation> }> {
    const [defs, progress, participation] = await Promise.all([
      this.visible(account, at),
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
   * Подписка — у площадки канала, ботом. Канал площадки игрока спрашивается по его
   * id; канал другой площадки — по id, который бот связал с аккаунтом (Р188), а
   * связи нет — «сначала открой бота». Не подписан — отказ, который клиент
   * показывает как «подпишитесь и нажмите ещё раз». Площадка проверить не может —
   * это настройка задания: игроку «позже», команде — ошибка в лог с заданием.
   */
  private async checkJoined(account: AccountRef, def: TaskDef): Promise<void> {
    const params = def.params;
    const chat = params?.chat;
    const platform = params?.platform;
    const membership = platform === undefined ? null : this.memberships.for(platform);
    if (params === null || chat === undefined || platform === undefined || membership === null) throw new TaskCheckUnavailableError();
    const who = platform === account.platform ? account.platformUserId : await this.linkedUserId(account, platform);
    let joined: boolean;
    try {
      joined = await membership.isMember(chat, who);
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

  /** id игрока на другой площадке, связанный с аккаунтом; связи нет — отказ с просьбой открыть бота. */
  private async linkedUserId(account: AccountRef, platform: PlatformId): Promise<string> {
    if (this.external === undefined) throw new TaskCheckUnavailableError();
    const id = await this.external.externalId(account.accountId, platform);
    if (id === null) throw new TaskLinkRequiredError();
    return id;
  }

  /**
   * Площадки, каналы которых видны чужим игрокам (Р188): у площадки есть и проверка
   * подписки, и бот со ссылкой для связи аккаунтов. Пока бот не подключён, множество
   * пусто, и каналы видны только игрокам самой площадки.
   */
  private linkable(): ReadonlySet<PlatformId> {
    const starters = this.starters;
    if (this.external === undefined || starters === undefined) return NO_LINKABLE;
    return new Set(LINK_PLATFORMS.filter((platform) => this.memberships.for(platform) !== null && typeof starters.for(platform)?.startUrl(PROBE_CODE) === "string"));
  }

  /**
   * Знак меню: сколько наград можно забрать прямо сейчас (Р50) — выполненные
   * задания и готовые ступени очков (T-0105): игрок видит «есть что забрать»
   * и там, где задания уже забраны.
   */
  async badge(accountId: string, at = new Date()): Promise<number> {
    const [progress, active, points] = await Promise.all([this.db(this.repository.progress(accountId, at)), this.active(), this.pointsView(accountId, at)]);
    // Невыбранное из пула забрать нельзя, значит и знак его не считает.
    const playing = new Set(inPlay(active, at).map((def) => def.taskId));
    const tasks = progress.filter((row) => row.done && !row.claimed && playing.has(row.taskId)).length;
    return tasks + (points === null ? 0 : readyCount(points));
  }

  /** Весь каталог, и выключенное, с видами и сроками для формы — панели. */
  async catalog(actor: AccountRef, at = new Date()): Promise<TaskCatalogView> {
    await this.roles.require(actor, "tasks.edit");
    const [tasks, completions] = await Promise.all([this.db(this.repository.catalog()), this.db(this.repository.completions())]);
    return { tasks, kinds: TASK_KIND_IDS, periods: TASK_PERIODS, completions: Object.fromEntries(completions), rotation: rotationAt(tasks, at) };
  }

  /**
   * Строка каталога из панели: новый id — новое задание, известный — правка
   * цели, награды, текста и включённости. Срок и вид после создания не
   * меняются. Место в списке правкой не задаётся: новое задание встаёт в конец
   * своего списка, у существующего остаётся прежнее — его меняет только
   * `reorder`. Каждое изменение — в аудит.
   */
  async save(actor: AccountRef, input: TaskDef, at = new Date()): Promise<TaskDef> {
    await this.roles.require(actor, "tasks.edit");
    const catalog = await this.db(this.repository.catalog());
    const before = catalog.find((candidate) => candidate.taskId === input.taskId) ?? null;
    const task: TaskDef = { ...input, sort: before === null ? endOfList(catalog, input) : before.sort };
    // Картинка — загруженная и того вида, что нужен строке задания: квадрат, а
    // не слайд. Прежнюю не перепроверяем — она уже у игроков.
    if (task.image !== null && task.image !== before?.image) await this.media.require(task.image, "task");
    if (before === null) {
      // Знаки статусов и сезонов заводит миграция: правило, кто их держит, живёт в коде, а строка без него мертва.
      if (isEmblemKind(task.kind)) throw new TaskEmblemFixedError();
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
   * Новый порядок списка из панели (Р52, T-0167): `ids` — ровно члены группы в
   * нужном порядке. Одной транзакцией, повтор того же порядка ничего не пишет и
   * в аудит не идёт. Состав не совпал — список изменился у другого администратора,
   * и панель просят обновиться, а не молча перезаписывают.
   */
  async reorder(actor: AccountRef, group: TaskGroup, ids: readonly string[], at = new Date()): Promise<{ order: string[] }> {
    await this.roles.require(actor, "tasks.edit");
    const result = await this.db(this.repository.reorder(group, ids, actor.accountId, at));
    if (result.status === "mismatch") throw new TaskOrderMismatchError();
    if (result.changed) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "tasks.reorder", target: group, before: { order: result.before }, after: { order: result.after } });
      this.forgetCatalog();
      this.logger.log(JSON.stringify({ module: "tasks", event: "tasks_reordered", group, actor: actor.accountId }));
    }
    return { order: result.after };
  }

  /**
   * Состояние игрока (число друзей, уровень аккаунта) — прогресс «максимум» без записи
   * забега. Дельты строит витрина достижений, которая и знает, какие числа прочитаны.
   */
  async applyState(accountId: string, deltas: readonly TaskDelta[], at = new Date()): Promise<void> {
    if (deltas.every((delta) => delta.amount <= 0)) return;
    await this.db(this.repository.applyState(accountId, deltas, at));
  }

  /** Включённые достижения с категорией — то, что показывает витрина; из того же кеша, что и цели забега. */
  async achievementDefs(): Promise<TaskDef[]> {
    return (await this.active()).filter((def) => def.period === "achievement" && def.category !== null && !isCheckedKind(def.kind));
  }

  /** Прогресс игрока по включённым целям — достижения лежат в нём с общим днём срока. */
  async progressRows(accountId: string, at = new Date()): Promise<TaskProgressRow[]> {
    return await this.db(this.repository.progress(accountId, at));
  }

  /**
   * Записанный забег двигает цели. Слушатель работает после ответа игроку;
   * повтор события ничего не удваивает — забег засчитывается по `run_id`
   * однажды.
   */
  async onRun(run: RecordedRun): Promise<void> {
    if (!countsForTasks(run)) return;
    // Забег двигает только то, что было в игре на его момент: невыбранное из
    // пула прогресса не копит.
    const deltas: TaskDelta[] = inPlay(await this.active(), run.finishedAt).flatMap((def) => {
      if (!isRunKind(def.kind)) return [];
      const kind = RUN_KINDS[def.kind];
      const measure: (run: TaskRun, filter: RunFilter | null) => number = kind.measure;
      return [{ taskId: def.taskId, period: def.period, target: def.target, op: kind.op, amount: measure(run, def.filter) }];
    });
    if (deltas.every((delta) => delta.amount <= 0)) return;
    const fresh = await this.db(this.repository.applyRun({ runId: run.runId, accountId: run.accountId, at: run.finishedAt, deltas }));
    if (!fresh) return;
    // «Коллекционер» (T-0322): только забег, сдвинувший «Мастера оружия», мог выполнить нового «Мастера».
    const masters = new Set(masterIdsOf(await this.active()));
    if (deltas.some((delta) => delta.amount > 0 && masters.has(delta.taskId))) {
      try {
        await this.syncMasters(run.accountId, run.finishedAt);
      } catch (error: unknown) {
        // Забег уже засчитан и повторно не придёт: следующее открытие витрины допишет «Коллекционера».
        this.logger.warn(JSON.stringify({ module: "tasks", event: "masters_sync_failed", accountId: run.accountId, reason: error instanceof Error ? error.message : "unknown" }));
      }
    }
  }

  /**
   * «Коллекционер» (T-0322): прогресс — сколько «Мастеров оружия» игрок выполнил, «максимум»,
   * поэтому новый «Мастер» цель поднимает, а выполненное выполненным и остаётся. Зовут витрина
   * достижений и записанный забег; одним запросом с `count`.
   */
  async syncMasters(accountId: string, at = new Date()): Promise<void> {
    const defs = await this.active();
    const collectors = defs.filter((def) => def.kind === "weapon_masters");
    const masters = masterIdsOf(defs);
    if (collectors.length === 0 || masters.length === 0) return;
    const done = await this.db(this.repository.completedCount(accountId, masters));
    await this.applyState(
      accountId,
      collectors.map((def) => ({ taskId: def.taskId, period: def.period, target: def.target, op: STATE_KINDS.weapon_masters.op, amount: done })),
      at,
    );
  }

  /** Правка каталога из панели видна сразу на этой реплике, на остальных — через полминуты. */
  forgetCatalog(): void {
    this.cache = null;
  }

  /**
   * Включённые цели, которые игрок может выполнить: цель другой площадки ему
   * не показывается, цель без площадки — всем; из пула — только набор дня и
   * недели на `at`. Строки знаков статуса и сезона сюда не входят.
   */
  private async visible(account: AccountRef, at: Date): Promise<TaskDef[]> {
    const linkable = this.linkable();
    // Знаки статусов и сезонов — строки того же каталога, но не задания: их нет в списке и забрать их нельзя.
    return inPlay(await this.active(), at).filter((def) => !isEmblemKind(def.kind) && visibleOn(def.params, account.platform, linkable));
  }

  private async active(): Promise<TaskDef[]> {
    const now = Date.now();
    if (this.cache === null || this.cache.until <= now) {
      const defs = await this.db(this.repository.catalog());
      // Цель «Коллекционера» считается по включённым «Мастерам», а не читается из строки (T-0322).
      this.cache = { defs: withDynamicTargets(defs.filter((def) => def.active)), until: now + CATALOG_TTL_MS };
    }
    return this.cache.defs;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "задания");
  }
}

/** Место нового задания: после последнего в своём списке, не выше потолка схемы; в пустом — ноль. */
function endOfList(catalog: readonly TaskDef[], task: Pick<TaskDef, "kind" | "period">): number {
  const group = taskGroup(task);
  const sorts = catalog.filter((candidate) => taskGroup(candidate) === group).map((candidate) => candidate.sort);
  return sorts.length === 0 ? 0 : Math.min(TASK_SORT_MAX, Math.max(...sorts) + 1);
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
 * Цели в порядке панели: место (`sort`), при равном — id. Каталог отдаёт их
 * по сроку, а порядок задаёт геймдизайнер перетаскиванием, в том числе
 * на вкладке «Партнёры», где лежат задания разных сроков (Р118). Не
 * двигавшаяся цель — с нулём.
 * Цель с исчерпанным лимитом, к которой игрок не переходил, не показывается.
 */
export function viewOf(
  defs: readonly TaskDef[],
  progress: readonly TaskProgressRow[],
  participation: ReadonlyMap<string, TaskParticipation> = new Map(),
  at = new Date(),
  platform?: PlatformId,
  watch?: WatchInfo,
): TaskView[] {
  const byTask = new Map(progress.map((row) => [row.taskId, row]));
  // Сравнение строк, а не `localeCompare`: порядок не должен зависеть от локали сервера.
  const ordered = [...defs].sort((a, b) => a.sort - b.sort || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return ordered.flatMap((def) => {
    const place = slotsFor(def.limit, participation.get(def.taskId) ?? null, at);
    if (!place.visible) return [];
    const row = byTask.get(def.taskId);
    // Закрытое скрытое достижение не показывается вовсе: его название и цель игрок не должен узнать раньше времени.
    if (def.hidden && !(row?.done ?? false)) return [];
    const slots = place.slots === null ? null : { left: place.slots.left, total: place.slots.total, holdUntil: place.slots.holdUntil?.toISOString() ?? null };
    return {
      id: def.taskId,
      period: def.period,
      category: isCheckedKind(def.kind) ? "partner" : def.period,
      kind: def.kind,
      title: def.title,
      target: def.target,
      value: Math.min(row?.value ?? 0, def.target),
      done: row?.done ?? false,
      claimed: row?.claimed ?? false,
      reward: { coins: def.coins, gems: def.gems, shards: def.shards },
      passPoints: def.passPoints,
      link: def.params?.url ?? null,
      linkMode: platform === undefined ? null : channelLinkMode(def, platform),
      channelPlatform: def.kind === "channel" ? (def.params?.platform ?? null) : null,
      slots,
      image: def.image === null ? null : imagePath(def.image),
      tier: def.tier,
      filter: def.filter,
      achievementCategory: def.category,
      ladder: def.ladder,
      rung: def.rung,
      prestige: def.prestige,
      hidden: def.hidden,
      recheckDays: watch?.taskIds.has(def.taskId) === true ? watch.days : null,
    };
  });
}
