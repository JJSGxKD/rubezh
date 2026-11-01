import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { funnelMarked, type FunnelMarked } from "../funnel/funnel-report.js";
import { markedAccountIds } from "../restrictions/board-mark.js";

/**
 * Чтение метки «Отдельная доска» для отчётов панели (T-0115). Отдельный порт,
 * а не метод воронки или забегов: метку знают только отчёты, и остальные
 * репозитории не должны получить к ней доступ даже случайно.
 */

export const BOARD_MARK_READER = Symbol("BOARD_MARK_READER");

export interface BoardMarkReader {
  /** помеченные аккаунты окна */
  ids(from: Date, to: Date): Promise<string[]>;
  /** сводная строка воронки по помеченным */
  funnel(from: Date, to: Date): Promise<FunnelMarked>;
}

@Injectable()
export class PrismaBoardMarkReader implements BoardMarkReader {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async ids(from: Date, to: Date): Promise<string[]> {
    return await markedAccountIds(this.prisma, from, to);
  }

  async funnel(from: Date, to: Date): Promise<FunnelMarked> {
    return await funnelMarked(this.prisma, from, to);
  }
}
