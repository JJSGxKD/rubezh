import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { DomainError, RateLimitedError } from "../../common/domain-error.js";
import { SourceAvatarRejectedError, SourceAvatarUnavailableError, SourceAvatars, type SourceImage, type SourceRef } from "../../platforms/ports/source-avatar.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import type { ImageReply } from "../media/media-reply.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { networkTaskSchema } from "../tasks/network-task-rules.js";
import { NetworkTasksService, type NetworkTaskAdminView } from "../tasks/network-tasks.service.js";
import { CHANNEL_PLATFORMS, taskDefSchema, taskOrderSchema, type TaskDef } from "../tasks/task-rules.js";
import { TasksService, type TaskCatalogView } from "../tasks/tasks.service.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Каталог заданий и достижений в панели (docs/35-stage4-plan.md Р52, WP13):
 * цели, награды, текст и включённость без релиза — под `tasks.edit`, каждое
 * изменение — в аудит. Удаления нет: задание выключают, на него ссылается
 * прогресс игроков.
 *
 * Задания рекламных сетей (WP13, часть 6) — строкой на сеть рядом с
 * каталогом: потолок в сутки, пауза, награда, включено — и что ещё нужно,
 * чтобы игроки их увидели.
 *
 * Картинка источника (Р158): аватарка канала, бота или Mini App отдаётся панели
 * байтами как есть — квадрат и WebP делает панель, как у загруженной руками.
 */

/** Сколько ждём площадку целиком: у адаптера свои сроки на каждый запрос, это потолок на все. */
const SOURCE_AVATAR_TIMEOUT_MS = 15_000;

const sourceAvatarSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel"), platform: z.enum(CHANNEL_PLATFORMS), chat: z.string().trim().min(2).max(64) }).strict(),
  z.object({ kind: z.literal("bot"), platform: z.enum(CHANNEL_PLATFORMS), url: z.url({ protocol: /^https$/ }).max(256) }).strict(),
]);

@Controller("admin/tasks")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminTasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly networks: NetworkTasksService,
    private readonly limiter: RateLimiter,
    private readonly avatars: SourceAvatars,
  ) {}

  @Get()
  @RequirePermission("tasks.edit")
  async list(@Req() request: unknown): Promise<{ data: TaskCatalogView & { networks: NetworkTaskAdminView[] } }> {
    const actor = accountOf(request);
    const [catalog, networks] = await Promise.all([this.tasks.catalog(actor), this.networks.catalog(actor)]);
    return { data: { ...catalog, networks } };
  }

  @Post()
  @RequirePermission("tasks.edit")
  async save(@Req() request: unknown, @Body() body: unknown): Promise<{ data: TaskDef }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const task = parse(() => taskDefSchema.parse(body), "Некорректное задание");
    return { data: await this.tasks.save(actor, task) };
  }

  /** Новый порядок списка: id группы в нужном порядке, одной транзакцией. */
  @Post("order")
  @RequirePermission("tasks.edit")
  async order(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { order: string[] } }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const { group, ids } = parse(() => taskOrderSchema.parse(body), "Некорректный порядок заданий");
    return { data: await this.tasks.reorder(actor, group, ids) };
  }

  /**
   * Аватарка источника задания: ответ — сами байты с типом источника. Нет
   * картинки или площадка её не отдаёт — 404, источник не разобран — 422,
   * площадка не ответила — 503.
   */
  @Post("source-avatar")
  @RequirePermission("tasks.edit")
  async sourceAvatar(@Req() request: unknown, @Body() body: unknown, @Res() reply: ImageReply): Promise<void> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.sourceAvatar, actor.accountId))) throw new RateLimitedError("Слишком много запросов картинки — подождите несколько минут");
    const input = parse(() => sourceAvatarSchema.parse(body), "Некорректный источник картинки");
    const adapter = this.avatars.for(input.platform);
    if (adapter === null) throw new DomainError("source_avatar_missing", "Эта площадка картинку не отдаёт — загрузите свою", 404);
    const source: SourceRef = input.kind === "channel" ? { kind: "channel", chat: input.chat } : { kind: "bot", url: input.url };
    let image: SourceImage | null;
    try {
      image = await adapter.fetch(source, AbortSignal.timeout(SOURCE_AVATAR_TIMEOUT_MS));
    } catch (error: unknown) {
      if (error instanceof SourceAvatarRejectedError) throw new DomainError("source_avatar_invalid", error.message, 422);
      if (error instanceof SourceAvatarUnavailableError) throw new DomainError("source_avatar_unavailable", "Площадка не ответила — попробуйте ещё раз", 503);
      throw error;
    }
    if (image === null) throw new DomainError("source_avatar_missing", "У источника нет картинки — загрузите свою", 404);
    // Чужой файл: тип назван явно и угадывать его браузеру запрещено, а кеша у ответа нет — источник могли сменить.
    reply
      .status(200)
      .header("content-type", image.contentType)
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .send(Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength));
  }

  /** Строка заданий сети: ключ сети — из адреса, числа — из тела. */
  @Post("networks/:networkKey")
  @RequirePermission("tasks.edit")
  async saveNetwork(@Req() request: unknown, @Param("networkKey") networkKey: string, @Body() body: unknown): Promise<{ data: NetworkTaskAdminView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const def = parse(() => networkTaskSchema.parse({ ...z.record(z.string(), z.unknown()).parse(body), networkKey }), "Некорректная строка заданий сети");
    return { data: await this.networks.save(actor, def) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
