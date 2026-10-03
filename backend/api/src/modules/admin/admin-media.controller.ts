import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { IMAGE_FILE, IMAGE_MAX_BYTES, IMAGE_PROFILE_IDS } from "../media/image-rules.js";
import { ImageNotFoundError } from "../media/media-errors.js";
import { sendImage, type ImageReply } from "../media/media-reply.js";
import type { ImageMeta } from "../media/media.repository.js";
import { MediaService } from "../media/media.service.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Картинки в панели (docs/35-stage4-plan.md О42): загрузка уже обрезанного и
 * сжатого панелью WebP и показ сохранённого. Право — того, к чему картинка
 * (профиль), его проверяет сервис: картинку задания грузит тот, кто правит
 * задания.
 *
 * Показ — своим путём под сессией панели: у панели свой домен, и наружу из
 * него ходит только `/api/v1/admin`.
 */

/** Файл приходит base64 в JSON: 200 КБ — это 274 тысячи знаков, тело API вмещает и больше. */
const BASE64_MAX = Math.ceil(IMAGE_MAX_BYTES / 3) * 4;

const uploadSchema = z
  .object({
    profile: z.enum(IMAGE_PROFILE_IDS),
    data: z
      .string()
      .min(4)
      .max(BASE64_MAX)
      .regex(/^[A-Za-z0-9+\/]+={0,2}$/)
      .refine((value) => value.length % 4 === 0),
  })
  .strict();

@Controller("admin/media")
@UseGuards(AdminSessionGuard)
export class AdminMediaController {
  constructor(
    private readonly media: MediaService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post("images")
  async upload(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ImageMeta }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.imageUpload, actor.accountId))) throw new RateLimitedError("Слишком много загрузок — подождите несколько минут");
    const { profile, data } = parse(() => uploadSchema.parse(body), "Некорректная картинка — загрузите файл заново");
    return { data: await this.media.upload(actor, profile, Buffer.from(data, "base64")) };
  }

  @Get(":file")
  async image(@Param("file") file: string, @Req() request: unknown, @Res() reply: ImageReply): Promise<void> {
    const imageId = IMAGE_FILE.exec(file)?.[1];
    const image = imageId === undefined ? null : await this.media.read(imageId);
    if (image === null) throw new ImageNotFoundError();
    sendImage(reply, image, request);
  }
}
