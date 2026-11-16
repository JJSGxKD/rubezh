import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { publicIdSchema } from "../../common/public-identity.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { CARD_LIMIT, type PlayerCard } from "./player-card-rules.js";
import { PlayersService } from "./players.service.js";

/**
 * Карточка игрока (`/api/v1/players`, docs/35-stage4-plan.md Р48, tasks/T-0247): её открывает
 * любой игрок тапом по строке рейтинга, сезона или друзей. Игрока называет публичный id — внутренний
 * `accountId` в ответах нет. Всё под токеном сессии; лимит — на смотрящего, а не на адрес: за
 * адресом оператора стоят сотни игроков.
 */
@Controller("players")
@UseGuards(AuthGuard)
export class PlayersController {
  constructor(
    private readonly players: PlayersService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get(":publicId")
  async card(@Req() request: unknown, @Param("publicId") publicId: string): Promise<{ data: PlayerCard }> {
    const { accountId } = accountOf(request);
    const parsed = publicIdSchema.safeParse(publicId);
    if (!parsed.success) throw new ValidationError("Некорректный идентификатор игрока");
    if (!(await this.limiter.consume(CARD_LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
    return { data: await this.players.card(accountId, parsed.data) };
  }
}
