import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { accountOf } from "../auth/auth.guard.js";
import { PartnerCabinet, type CabinetOverview } from "../partners/partner-cabinet.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Чужой кабинет для поддержки — по `partnerId`; ничего другого в запросе нет. */
const cabinetQuerySchema = z.object({ partnerId: z.uuid().optional() }).strict();

/**
 * Кабинет партнёра в панели (docs/35-stage4-plan.md Р136, tasks/T-0217): внешний человек с ролью `partner`
 * видит здесь только своё. Охранник сессии пускает любого с ролью, а **право проверяет `PartnerCabinet`**,
 * а не маршрут: своё — `partner.cabinet`, чужое глазами партнёра (`?partnerId=`, только чтение) —
 * `partners.view`. Одно право на маршруте не выразило бы «или то, или другое», а разделы кабинета следующих
 * задач берут партнёра той же точкой — `PartnerCabinet.partnerOf`.
 */
@Controller("admin/cabinet")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminCabinetController {
  constructor(private readonly cabinet: PartnerCabinet) {}

  /** Карточка партнёра без контактов и заметок команды. */
  @Get()
  async overview(@Req() request: unknown, @Query() query: unknown): Promise<{ data: CabinetOverview }> {
    const parsed = parse(() => cabinetQuerySchema.parse(query), "Некорректный запрос кабинета");
    return { data: await this.cabinet.overview(accountOf(request), parsed) };
  }
}
