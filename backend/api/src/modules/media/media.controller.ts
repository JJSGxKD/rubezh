import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { IMAGE_FILE } from "./image-rules.js";
import { ImageNotFoundError } from "./media-errors.js";
import { sendImage, type ImageReply } from "./media-reply.js";
import { MediaService } from "./media.service.js";

/**
 * `/api/v1/media/<id>.webp` — картинки из панели у игрока (docs/35-stage4-plan.md
 * О42): задания, дальше слайды главной.
 *
 * Открыта по сути: картинку видит каждый, кому показано задание, и секрета в
 * ней нет, а адрес — хэш содержимого, перебором его не найти. В базу ходит
 * только то, чего нет в памяти реплики, — это и ограничено по адресу:
 * перебор случайных имён упрётся в лимит, а не в базу.
 */
const LOOKUPS: RateLimit = { scope: "media:lookup", limit: 120, windowSec: 60 };

const ipSchema = z.object({ ip: z.string().max(64).optional().catch(undefined) }).catch({});

@Controller("media")
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly limiter: RateLimiter,
  ) {}

  @Public()
  @Get(":file")
  async image(@Param("file") file: string, @Req() request: unknown, @Res() reply: ImageReply): Promise<void> {
    const imageId = IMAGE_FILE.exec(file)?.[1];
    if (imageId === undefined) throw new ImageNotFoundError();
    const cached = this.media.peek(imageId);
    if (cached !== undefined) return sendImage(reply, cached, request);
    if (!(await this.limiter.consume(LOOKUPS, ipSchema.parse(request).ip ?? "unknown"))) throw new RateLimitedError("Слишком много запросов — попробуйте позже");
    const image = await this.media.read(imageId);
    if (image === null) throw new ImageNotFoundError();
    sendImage(reply, image, request);
  }
}
