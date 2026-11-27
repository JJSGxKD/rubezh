import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";

/**
 * Живые карточки бота в базе (`bot_card`, docs/35-stage4-plan.md Р199, tasks/T-0395).
 * Запросы живут здесь, а не в сервисе (docs/15-engineering-standards.md §2.3);
 * каждый — с таймаутом. Живая карточка вида у игрока одна: её держит частичный
 * уникальный индекс `bot_card_live_key` (`account_id, kind` при `closed_at IS NULL`),
 * а не проверка перед вставкой.
 */

const TIMEOUT_MS = 3_000;

export interface BotCardRow {
  id: string;
  accountId: string;
  platform: PlatformId;
  kind: string;
  chatId: string;
  messageId: number;
  version: string;
  periodKey: string | null;
  /** последнее отправленное состояние: JSON ≤ 1024 байт */
  state: string;
  stateHash: string;
  createdAt: Date;
  /** последняя правка (или отправка): от неё считается пауза до следующей */
  updatedAt: Date;
  closedAt: Date | null;
}

export interface NewBotCard {
  accountId: string;
  platform: PlatformId;
  kind: string;
  chatId: string;
  messageId: number;
  version: string;
  periodKey: string | null;
  state: string;
  stateHash: string;
  /** время отправки: и создание, и первая правка */
  at: Date;
}

/**
 * `raced` — вставка проиграла гонку индексу: живая карточка вида уже есть. Строка всё равно записана,
 * но закрытой, чтобы запрос из этого сообщения находил её и получал «закрыта», а не молчание.
 */
export type OpenResult = { status: "opened"; id: string; replacedId: string | null } | { status: "raced"; id: string };

export const BOT_CARDS_REPOSITORY = Symbol("BOT_CARDS_REPOSITORY");

export interface BotCardsRepository {
  /** живая карточка вида у игрока */
  live(accountId: string, kind: string): Promise<BotCardRow | null>;
  byId(id: string): Promise<BotCardRow | null>;
  /** карточка по сообщению у площадки; закрытые тоже — запрос из них получает «закрыта» */
  byMessage(platform: string, chatId: string, messageId: number): Promise<BotCardRow | null>;
  /** в одной транзакции закрывает прежнюю живую и вставляет новую */
  openReplacing(card: NewBotCard): Promise<OpenResult>;
  /** запомнить отправленную правку; `false` — карточку тем временем закрыли, и правка её не воскрешает */
  touched(id: string, state: string, stateHash: string, at: Date): Promise<boolean>;
  /** закрыть; `false` — уже была закрыта (кем-то другим) */
  close(id: string, at: Date): Promise<boolean>;
  /** живые карточки вида с другим периодом, старые первыми */
  dueForFinal(kind: string, currentPeriodKey: string, limit: number): Promise<BotCardRow[]>;
}

/** Площадка из базы — граница: значение не из списка — ошибка, а не приведение. */
const platformSchema = z.enum(PLATFORM_IDS);

type Row = Awaited<ReturnType<PrismaClient["botCard"]["findFirstOrThrow"]>>;

function toRow(row: Row): BotCardRow {
  return {
    id: row.id,
    accountId: row.accountId,
    platform: platformSchema.parse(row.platform),
    kind: row.kind,
    chatId: row.chatId,
    messageId: row.messageId,
    version: row.version,
    periodKey: row.periodKey,
    state: row.state,
    stateHash: row.stateHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  };
}

/** Нарушение уникальности: код Postgres 23505 приходит то как P2002, то в `meta` сырого запроса. */
function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2002" || JSON.stringify(error.meta ?? {}).includes("23505");
  }
  return error instanceof Error && /23505|duplicate key/i.test(error.message);
}

@Injectable()
export class PrismaBotCardsRepository implements BotCardsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async live(accountId: string, kind: string): Promise<BotCardRow | null> {
    const row = await withTimeout(this.prisma.botCard.findFirst({ where: { accountId, kind, closedAt: null } }), TIMEOUT_MS, "живая карточка бота");
    return row === null ? null : toRow(row);
  }

  async byId(id: string): Promise<BotCardRow | null> {
    const row = await withTimeout(this.prisma.botCard.findUnique({ where: { id } }), TIMEOUT_MS, "карточка бота");
    return row === null ? null : toRow(row);
  }

  async byMessage(platform: string, chatId: string, messageId: number): Promise<BotCardRow | null> {
    const row = await withTimeout(
      this.prisma.botCard.findFirst({ where: { platform, chatId, messageId }, orderBy: { createdAt: "desc" } }),
      TIMEOUT_MS,
      "карточка бота по сообщению",
    );
    return row === null ? null : toRow(row);
  }

  async openReplacing(card: NewBotCard): Promise<OpenResult> {
    const id = randomUUID();
    const data = {
      id,
      accountId: card.accountId,
      platform: card.platform,
      kind: card.kind,
      chatId: card.chatId,
      messageId: card.messageId,
      version: card.version,
      periodKey: card.periodKey,
      state: card.state,
      stateHash: card.stateHash,
      createdAt: card.at,
      updatedAt: card.at,
    };
    try {
      const replacedId = await withTimeout(
        this.prisma.$transaction(
          async (tx) => {
            // `closed_at IS NULL` литералом: так планировщик находит частичный индекс.
            const closed = await tx.$queryRaw<{ id: string }[]>`
              UPDATE bot_card SET closed_at = ${card.at}
              WHERE account_id = ${card.accountId}::uuid AND kind = ${card.kind} AND closed_at IS NULL
              RETURNING id::text AS id`;
            await tx.botCard.create({ data });
            return closed[0]?.id ?? null;
          },
          { timeout: TIMEOUT_MS, maxWait: TIMEOUT_MS },
        ),
        TIMEOUT_MS + 1_000,
        "отправка карточки бота: запись",
      );
      return { status: "opened", id, replacedId };
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      // Транзакция откатилась целиком: живую карточку, которую вставка не обогнала, мы не закрыли.
      await withTimeout(this.prisma.botCard.create({ data: { ...data, closedAt: card.at } }), TIMEOUT_MS, "карточка бота: проигранная гонка");
      return { status: "raced", id };
    }
  }

  async touched(id: string, state: string, stateHash: string, at: Date): Promise<boolean> {
    const updated = await withTimeout(this.prisma.botCard.updateMany({ where: { id, closedAt: null }, data: { state, stateHash, updatedAt: at } }), TIMEOUT_MS, "правка карточки бота");
    return updated.count > 0;
  }

  async close(id: string, at: Date): Promise<boolean> {
    const closed = await withTimeout(this.prisma.botCard.updateMany({ where: { id, closedAt: null }, data: { closedAt: at } }), TIMEOUT_MS, "закрытие карточки бота");
    return closed.count > 0;
  }

  async dueForFinal(kind: string, currentPeriodKey: string, limit: number): Promise<BotCardRow[]> {
    // Карточка без периода тоже не текущего: `not` один её пропустил бы (в SQL `<>` с NULL неизвестно).
    const rows = await withTimeout(
      this.prisma.botCard.findMany({
        where: { kind, closedAt: null, OR: [{ periodKey: null }, { periodKey: { not: currentPeriodKey } }] },
        orderBy: { createdAt: "asc" },
        take: limit,
      }),
      TIMEOUT_MS,
      "карточки бота к финалу",
    );
    return rows.map(toRow);
  }
}
