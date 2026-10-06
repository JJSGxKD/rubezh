import { Inject, Injectable } from "@nestjs/common";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { CONVERSIONS_REPOSITORY, type ConversionRow, type ConversionSummary, type ConversionsRepository, type JournalCursor } from "./conversions.repository.js";

/**
 * Журнал конверсий для панели (WP43): что ушло в сеть по каждой ссылке. Его
 * видят те же, кто заводит ссылки (`links.manage`), — по журналу команда и
 * владелец ссылки проверяют, что закупка реально что-то даёт. Игрок в
 * журнале — идентификатором аккаунта: имя и Telegram ID — по праву на
 * карточку игрока, в ней.
 */

export const JOURNAL_PAGE = 50;

/** Курсор страницы для адреса: `<время ISO>_<идентификатор>`. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_([0-9a-f-]{36})$/;

export function cursorOf(row: Pick<ConversionRow, "createdAt" | "conversionId">): string {
  return `${row.createdAt.toISOString()}_${row.conversionId}`;
}

/** Разобранный курсор; `null` — строка не курсор. */
export function parseCursor(value: string): JournalCursor | null {
  const match = CURSOR.exec(value);
  if (match === null) return null;
  const createdAt = new Date(match[1] ?? "");
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, conversionId: match[2] ?? "" };
}

@Injectable()
export class ConversionsJournal {
  constructor(
    @Inject(CONVERSIONS_REPOSITORY) private readonly repository: ConversionsRepository,
    private readonly roles: RolesService,
  ) {}

  /** Счёт по ссылкам без проверки прав: его зовёт список ссылок, который права уже проверил. */
  async summaries(linkCodes: readonly string[]): Promise<Map<string, ConversionSummary>> {
    return await this.repository.summaries(linkCodes);
  }

  async page(actor: AccountRef, linkCode: string, before: JournalCursor | null): Promise<{ conversions: ConversionRow[]; next: string | null }> {
    await this.roles.require(actor, "links.manage");
    const conversions = await this.repository.journal(linkCode, before, JOURNAL_PAGE);
    const last = conversions.at(-1);
    return { conversions, next: conversions.length === JOURNAL_PAGE && last !== undefined ? cursorOf(last) : null };
  }

  /** Отправить снова — неотправленную или пропущенную как аккаунт команды (проверка кабинета). `null` — нечего отправлять. */
  async requeue(actor: AccountRef, linkCode: string, conversionId: string, now = new Date()): Promise<ConversionRow | null> {
    await this.roles.require(actor, "links.manage");
    const row = await this.repository.requeue(linkCode, conversionId, now);
    if (row !== null) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "links.conversion.send", target: linkCode, after: { conversionId, goal: row.goal } });
    }
    return row;
  }
}
