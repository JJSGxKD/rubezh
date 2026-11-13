import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { PRISMA } from "../../../infra/database.js";

/**
 * Замок закрытого месяца (Р222, tasks/T-0468): журнал спрашивает, закрыт ли месяц проводки. Порт, а не прямой
 * вызов сервиса месяцев: сервису нужен сам журнал (`LedgerService.post`), и зависимость в обе стороны была бы
 * кольцом. Читает статус по первичному ключу, без кэша: закрытие обязано действовать со следующей же проводки.
 */
export interface PeriodLock {
  isClosed(period: string): Promise<boolean>;
}

export const PERIOD_LOCK = Symbol("PERIOD_LOCK");

@Injectable()
export class PrismaPeriodLock implements PeriodLock {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async isClosed(period: string): Promise<boolean> {
    const row = await this.prisma.ledgerPeriod.findUnique({ where: { period }, select: { status: true } });
    return row?.status === "closed";
  }
}
