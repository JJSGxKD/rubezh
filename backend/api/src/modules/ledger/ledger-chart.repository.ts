import { Inject, Injectable } from "@nestjs/common";
import type { AccountType } from "@bh/ledger";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { ArticleKind, FeeTemplate } from "./ledger-chart.js";

/**
 * Места хранения и статьи учёта в базе (`ledger_account.place`, шаблон комиссии, `ledger_article`; Р220,
 * tasks/T-0460). Журнал проводок здесь не трогается — только справочник; остатки читаются суммой строк.
 */

/** Счёт места хранения: актив с группой, шаблоном комиссии и остатком. */
export interface StoredPlaceAccount {
  accountId: string;
  name: string;
  currency: string;
  /** группа места: «stars.bot» у обоих состояний звёзд, у прочих — их собственный id */
  place: string;
  archivedAt: Date | null;
  fee: FeeTemplate;
  /** сумма строк журнала по счёту: у актива это остаток */
  balance: bigint;
}

export interface StoredArticle {
  articleId: string;
  kind: ArticleKind;
  name: string;
  system: boolean;
  archivedAt: Date | null;
}

export interface NewPlaceAccount {
  accountId: string;
  name: string;
  currency: string;
  fee: FeeTemplate;
}

export interface NewArticleAccount {
  accountId: string;
  type: AccountType;
  currency: string;
  name: string;
  articleId: string;
}

/** Что вышло с архивом места: заархивировано, уже было в архиве, остаток не нулевой, такого места нет. */
export type ArchiveResult = "archived" | "already" | "not_empty" | "missing";

export const LEDGER_CHART_REPOSITORY = Symbol("LEDGER_CHART_REPOSITORY");

export interface LedgerChartRepository {
  /** Все счета мест хранения, в том числе архивные, в порядке заведения. */
  placeAccounts(): Promise<StoredPlaceAccount[]>;
  placeAccountsOf(placeId: string): Promise<StoredPlaceAccount[]>;
  /** `false` — счёт с таким идентификатором уже есть (его заняли раньше), ничего не записано. */
  insertPlaceAccount(account: NewPlaceAccount): Promise<boolean>;
  /** Название и шаблон — всем счетам места, кроме архивных. Что менять, решает сервис. */
  updatePlace(placeId: string, patch: { name?: string; fee?: FeeTemplate }): Promise<void>;
  /** Остаток проверяется под блокировкой счетов места: проводка по ним в это время ждёт. */
  archivePlace(placeId: string, at: Date): Promise<ArchiveResult>;

  articles(): Promise<StoredArticle[]>;
  articleById(articleId: string): Promise<StoredArticle | null>;
  /** `false` — статья с таким идентификатором уже есть. */
  insertArticle(article: { articleId: string; kind: ArticleKind; name: string }): Promise<boolean>;
  /** Название статьи и названия её счетов в валютах — одной транзакцией. `false` — статьи нет. */
  renameArticle(articleId: string, name: string): Promise<boolean>;
  /** `true` — архивирована сейчас; `false` — уже была в архиве. Служебную и несуществующую проверяет сервис. */
  archiveArticle(articleId: string, at: Date): Promise<boolean>;
  /** `INSERT … ON CONFLICT DO NOTHING`: параллельные вызовы создают счёт один раз. `true` — создан этим вызовом. */
  insertArticleAccount(account: NewArticleAccount): Promise<boolean>;
}

/** Нарушение уникальности — код Prisma; внешний ключ и прочее — настоящая ошибка и идёт наверх. */
const UNIQUE_VIOLATION = "P2002";

const lockedRowsSchema = z.array(z.object({ account_id: z.string(), archived_at: z.date().nullable() }));

function toFee(row: { feePercentBp: number | null; feeFixed: bigint | null; feeFixedCurrency: string | null }): FeeTemplate {
  return { percentBp: row.feePercentBp, fixed: row.feeFixed, fixedCurrency: row.feeFixedCurrency };
}

@Injectable()
export class PrismaLedgerChartRepository implements LedgerChartRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async placeAccounts(): Promise<StoredPlaceAccount[]> {
    return await this.placeAccountsWhere({ place: { not: null } });
  }

  async placeAccountsOf(placeId: string): Promise<StoredPlaceAccount[]> {
    return await this.placeAccountsWhere({ place: placeId });
  }

  async insertPlaceAccount(account: NewPlaceAccount): Promise<boolean> {
    try {
      await this.prisma.ledgerAccount.create({
        data: {
          accountId: account.accountId,
          type: "asset",
          currency: account.currency,
          name: account.name,
          place: account.accountId,
          feePercentBp: account.fee.percentBp,
          feeFixed: account.fee.fixed,
          feeFixedCurrency: account.fee.fixedCurrency,
        },
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) return false;
      throw error;
    }
  }

  async updatePlace(placeId: string, patch: { name?: string; fee?: FeeTemplate }): Promise<void> {
    await this.prisma.ledgerAccount.updateMany({
      where: { place: placeId, archivedAt: null },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.fee === undefined ? {} : { feePercentBp: patch.fee.percentBp, feeFixed: patch.fee.fixed, feeFixedCurrency: patch.fee.fixedCurrency }),
      },
    });
  }

  async archivePlace(placeId: string, at: Date): Promise<ArchiveResult> {
    return await this.prisma.$transaction(async (tx) => {
      // FOR UPDATE конфликтует с блокировкой FOR KEY SHARE, которую внешний ключ строки журнала берёт на счёт:
      // проводка по месту, ещё не записанная, дождётся конца архива, а записанная уже видна в сумме ниже.
      const rows = lockedRowsSchema.parse(await tx.$queryRaw`SELECT account_id, archived_at FROM ledger_account WHERE place = ${placeId} FOR UPDATE`);
      if (rows.length === 0) return "missing";
      if (rows.every((row) => row.archived_at !== null)) return "already";
      const sums = await tx.ledgerLine.groupBy({ by: ["accountId"], where: { accountId: { in: rows.map((row) => row.account_id) } }, _sum: { amount: true } });
      if (sums.some((sum) => (sum._sum.amount ?? 0n) !== 0n)) return "not_empty";
      await tx.ledgerAccount.updateMany({ where: { place: placeId, archivedAt: null }, data: { archivedAt: at } });
      return "archived";
    });
  }

  async articles(): Promise<StoredArticle[]> {
    const rows = await this.prisma.ledgerArticle.findMany({ orderBy: [{ kind: "asc" }, { createdAt: "asc" }, { articleId: "asc" }] });
    return rows.map((row) => ({ articleId: row.articleId, kind: row.kind, name: row.name, system: row.system, archivedAt: row.archivedAt }));
  }

  async articleById(articleId: string): Promise<StoredArticle | null> {
    const row = await this.prisma.ledgerArticle.findUnique({ where: { articleId } });
    return row === null ? null : { articleId: row.articleId, kind: row.kind, name: row.name, system: row.system, archivedAt: row.archivedAt };
  }

  async insertArticle(article: { articleId: string; kind: ArticleKind; name: string }): Promise<boolean> {
    try {
      await this.prisma.ledgerArticle.create({ data: { articleId: article.articleId, kind: article.kind, name: article.name } });
      return true;
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) return false;
      throw error;
    }
  }

  async renameArticle(articleId: string, name: string): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      const renamed = await tx.ledgerArticle.updateMany({ where: { articleId }, data: { name } });
      if (renamed.count === 0) return false;
      // Название счёта статьи — «<статья>, <валюта>»: журнал показывает его в строках проводок.
      await tx.$executeRaw`UPDATE ledger_account SET name = ${name}::text || ', ' || currency WHERE article_id = ${articleId}`;
      return true;
    });
  }

  async archiveArticle(articleId: string, at: Date): Promise<boolean> {
    const result = await this.prisma.ledgerArticle.updateMany({ where: { articleId, archivedAt: null }, data: { archivedAt: at } });
    return result.count > 0;
  }

  async insertArticleAccount(account: NewArticleAccount): Promise<boolean> {
    const result = await this.prisma.ledgerAccount.createMany({
      data: [{ accountId: account.accountId, type: account.type, currency: account.currency, name: account.name, articleId: account.articleId }],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  private async placeAccountsWhere(where: Prisma.LedgerAccountWhereInput): Promise<StoredPlaceAccount[]> {
    const rows = await this.prisma.ledgerAccount.findMany({ where: { AND: [{ type: "asset" }, where] }, orderBy: [{ createdAt: "asc" }, { accountId: "asc" }] });
    if (rows.length === 0) return [];
    const sums = await this.prisma.ledgerLine.groupBy({ by: ["accountId"], where: { accountId: { in: rows.map((row) => row.accountId) } }, _sum: { amount: true } });
    const balances = new Map(sums.map((sum) => [sum.accountId, sum._sum.amount ?? 0n]));
    return rows.flatMap((row) =>
      row.place === null ? [] : [{ accountId: row.accountId, name: row.name, currency: row.currency, place: row.place, archivedAt: row.archivedAt, fee: toFee(row), balance: balances.get(row.accountId) ?? 0n }],
    );
  }
}
