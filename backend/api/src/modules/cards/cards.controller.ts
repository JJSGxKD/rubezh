import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../common/access.js";
import { CARD_HASH, CARD_STORE, type CardStore } from "../../common/card/card-store.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { CardNotFoundError } from "./card-errors.js";

/**
 * `/api/v1/cards/<хэш>.png` — публичный адрес картинки бота (docs/35-stage4-plan.md
 * Р156): Telegram берёт её сам, когда «Поделиться» несёт картинку крупным
 * предпросмотром над текстом.
 *
 * Открыта по сути: в картинке нет ничего, чего не видит получатель сообщения, а
 * адрес — SHA-256 самого PNG, перебором его не найти. От перебора и потока
 * запросов в Redis держит лимит по адресу клиента — тем же приёмом, что у
 * картинок из панели (`modules/media`).
 */
export const CARD_LOOKUP_LIMIT: RateLimit = { scope: "cards:lookup", limit: 300, windowSec: 60 };

/** Имя файла в адресе: хэш и расширение, ничего больше. */
const CARD_FILE = /^([0-9a-f]{64})\.png$/;

/** Ровно то, что нужно от ответа Fastify, — без его типов. */
interface CardReply {
  status(code: number): CardReply;
  header(name: string, value: string): CardReply;
  send(payload?: Uint8Array): unknown;
}

const requestSchema = z
  .object({
    ip: z.string().max(64).optional().catch(undefined),
    headers: z.object({ "if-none-match": z.string().max(256).optional().catch(undefined) }).catch({}),
  })
  .catch({ headers: {} });

@Controller("cards")
export class CardsController {
  constructor(
    @Inject(CARD_STORE) private readonly store: CardStore,
    private readonly limiter: RateLimiter,
  ) {}

  @Public()
  @Get(":file")
  async card(@Param("file") file: string, @Req() request: unknown, @Res() reply: CardReply): Promise<void> {
    const hash = CARD_FILE.exec(file)?.[1];
    if (hash === undefined || !CARD_HASH.test(hash)) throw new CardNotFoundError();
    const asked = requestSchema.parse(request);
    if (!(await this.limiter.consume(CARD_LOOKUP_LIMIT, asked.ip ?? "unknown"))) throw new RateLimitedError("Слишком много запросов — попробуй позже");
    const png = await this.store.read(hash);
    if (png === null) throw new CardNotFoundError();

    // Адрес — хэш содержимого, поэтому кэш вечный и неизменяемый: Telegram и
    // CDN не спрашивают картинку второй раз. Повторный вопрос с тем же ETag — 304 без тела.
    const etag = `"${hash}"`;
    reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("etag", etag)
      // Картинка не превращается в страницу, даже если клиент решит угадать тип.
      .header("x-content-type-options", "nosniff");
    const matches = asked.headers["if-none-match"]?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag) === true;
    if (matches) {
      reply.status(304).send();
      return;
    }
    reply.status(200).header("content-type", "image/png").send(png);
  }
}
