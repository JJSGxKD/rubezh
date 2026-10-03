import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { clientLanguageSchema, requesterOf } from "../ads/ad-creatives.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { NetworkTasksService, type NetworkFeedCheck, type NetworkFeedItem, type NetworkTaskView } from "./network-tasks.service.js";
import { TasksService, type TaskClaimResult, type TaskView } from "./tasks.service.js";

/**
 * Задания и достижения (`/api/v1/tasks`, docs/35-stage4-plan.md WP13): цели
 * с прогрессом и забор награды. Только своё — аккаунт из токена; что
 * выполнено, решает сервер по записанным забегам, а у партнёрских целей —
 * по переходу через сервер и проверке площадкой. Задания рекламных сетей —
 * отдельным списком `networks`: их рисует SDK сети или наша строка по ленте
 * сети, а выполнение подтверждает сама сеть.
 */
const LIMIT: RateLimit = { scope: "tasks", limit: 300, windowSec: 3600 };
/**
 * Лента и проверка задания сети — запросы к сети, своими лимитами: экран
 * заданий открывают десятки раз в час, а «Проверить» жмут по нескольку раз
 * на задание. Сверх лимита сеть не дёргаем вовсе.
 */
const FEED_LIMIT: RateLimit = { scope: "tasks_network_item", limit: 60, windowSec: 3600 };
const CHECK_LIMIT: RateLimit = { scope: "tasks_network_check", limit: 60, windowSec: 3600 };
const TASK_ID = /^[a-z][a-z0-9_]{1,47}$/;
const NETWORK_KEY = /^[a-z][a-z0-9_-]{1,31}$/;

/** Язык и премиум — со слов клиента площадки, для подбора ленты сетью: солгать о них — получить чужие задания. */
const feedItemSchema = z.object({ language: clientLanguageSchema.optional(), premium: z.boolean().optional() }).strict();

/** Сессия — 12 случайных байт в base64url, как у показов рекламы. */
const feedCheckSchema = feedItemSchema.extend({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{16}$/) }).strict();

@Controller("tasks")
@UseGuards(AuthGuard)
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly networks: NetworkTasksService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: { tasks: TaskView[]; networks: NetworkTaskView[] } }> {
    const account = accountOf(request);
    await this.limit(account.accountId);
    const [tasks, networks] = await Promise.all([this.tasks.view(account), this.networks.view(account)]);
    return { data: { tasks, networks } };
  }

  @Post(":taskId/claim")
  @HttpCode(200)
  async claim(@Req() request: unknown, @Param("taskId") taskId: string): Promise<{ data: TaskClaimResult }> {
    const account = accountOf(request);
    if (!TASK_ID.test(taskId)) throw new ValidationError("Неверный id задания");
    await this.limit(account.accountId);
    return { data: await this.tasks.claim(account, taskId) };
  }

  /** Переход по ссылке партнёрской цели: ссылка и бот этим и выполнены. */
  @Post(":taskId/open")
  @HttpCode(200)
  async open(@Req() request: unknown, @Param("taskId") taskId: string): Promise<{ data: { url: string; tasks: TaskView[] } }> {
    const account = accountOf(request);
    if (!TASK_ID.test(taskId)) throw new ValidationError("Неверный id задания");
    await this.limit(account.accountId);
    return { data: await this.tasks.open(account, taskId) };
  }

  /** Задание ленты сети для строки во вкладке «Партнёры». */
  @Post("networks/:network/item")
  @HttpCode(200)
  async networkItem(@Req() request: unknown, @Param("network") network: string, @Body() body: unknown): Promise<{ data: NetworkFeedItem }> {
    const account = accountOf(request);
    const parsed = feedItemSchema.safeParse(body ?? {});
    if (!NETWORK_KEY.test(network) || !parsed.success) throw new ValidationError("Неверная сеть или данные клиента");
    await this.limit(account.accountId, FEED_LIMIT);
    const requester = requesterOf(request, account.platformUserId, parsed.data.language ?? null, parsed.data.premium ?? null);
    return { data: await this.networks.item(account, network, requester) };
  }

  /** «Проверить» у задания ленты: выполнение подтверждает сеть, награду — сервер. */
  @Post("networks/:network/check")
  @HttpCode(200)
  async networkCheck(@Req() request: unknown, @Param("network") network: string, @Body() body: unknown): Promise<{ data: NetworkFeedCheck }> {
    const account = accountOf(request);
    const parsed = feedCheckSchema.safeParse(body);
    if (!NETWORK_KEY.test(network) || !parsed.success) throw new ValidationError("Неверная сеть или задание");
    await this.limit(account.accountId, CHECK_LIMIT);
    const requester = requesterOf(request, account.platformUserId, parsed.data.language ?? null, parsed.data.premium ?? null);
    return { data: await this.networks.check(account, network, parsed.data.sessionId, requester) };
  }

  private async limit(accountId: string, limit: RateLimit = LIMIT): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
