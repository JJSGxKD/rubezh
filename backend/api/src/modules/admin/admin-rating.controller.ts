import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { boardsQuerySchema, seasonQuerySchema, seasonsQuerySchema, type BoardsView, type PlayerSeasons, type SeasonsPage, type SeasonView } from "../seasons/dto/seasons-admin.dto.js";
import { seasonKeyParamSchema } from "../seasons/dto/seasons.dto.js";
import { SeasonsAdminService } from "../seasons/seasons-admin.service.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { accountIdSchema } from "./dto/admin.dto.js";

/**
 * Рейтинг в панели (docs/35-stage4-plan.md Р189, tasks/T-0380): текущие доски,
 * архив недельных сезонов и места игрока. Логики нет — разбор границы и форма
 * ответа; все ручки только читают, под правом «Игроки: смотреть», потому что
 * доски и итоги — это игроки и их места. Отдельную доску сервис отдаёт лишь
 * держателю `players.board.restrict`.
 */
@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminRatingController {
  constructor(private readonly rating: SeasonsAdminService) {}

  @Get("rating/boards")
  @RequirePermission("players.view")
  async boards(@Req() request: unknown, @Query() query: unknown): Promise<{ data: BoardsView }> {
    const parsed = parse(() => boardsQuerySchema.parse(query), "Некорректная сложность, период или доска");
    return { data: await this.rating.boards(accountOf(request), parsed) };
  }

  @Get("rating/seasons")
  @RequirePermission("players.view")
  async seasons(@Query() query: unknown): Promise<{ data: SeasonsPage }> {
    const parsed = parse(() => seasonsQuerySchema.parse(query), "Некорректный сезон");
    return { data: await this.rating.seasons(parsed) };
  }

  @Get("rating/seasons/:key")
  @RequirePermission("players.view")
  async season(@Req() request: unknown, @Param("key") key: string, @Query() query: unknown): Promise<{ data: SeasonView }> {
    const seasonKey = parse(() => seasonKeyParamSchema.parse(key), "Некорректный сезон");
    const parsed = parse(() => seasonQuerySchema.parse(query), "Некорректная сложность, период или доска");
    return { data: await this.rating.season(accountOf(request), seasonKey, parsed) };
  }

  @Get("players/:accountId/seasons")
  @RequirePermission("players.view")
  async playerSeasons(@Req() request: unknown, @Param("accountId") accountId: string): Promise<{ data: PlayerSeasons }> {
    const id = parse(() => accountIdSchema.parse(accountId), "Некорректный идентификатор аккаунта");
    return { data: await this.rating.playerSeasons(accountOf(request), id) };
  }
}
