import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { PRISMA } from "../../../infra/database.js";
import type { TemplateSchedule } from "./schedule.js";

/**
 * Шаблоны повторяющихся расходов в базе (`ledger_template`; Р220, tasks/T-0463). Операции и проводки здесь не
 * трогаются: черновик по шаблону создают `OperationsService` и его уникальный ключ `(template_id, template_period)`.
 */

export interface StoredTemplate {
  templateId: string;
  name: string;
  articleId: string;
  placeAccountId: string;
  /** минимальные единицы валюты места */
  amount: bigint;
  schedule: TemplateSchedule;
  month: number | null;
  note: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface NewTemplate {
  templateId: string;
  name: string;
  articleId: string;
  placeAccountId: string;
  amount: bigint;
  schedule: TemplateSchedule;
  month: number | null;
  note: string | null;
  createdBy: string;
}

/** Что менять: не заданное остаётся как было; `null` у месяца и заметки — снять. */
export interface TemplatePatch {
  name?: string;
  articleId?: string;
  placeAccountId?: string;
  amount?: bigint;
  schedule?: TemplateSchedule;
  month?: number | null;
  note?: string | null;
}

export const TEMPLATES_REPOSITORY = Symbol("TEMPLATES_REPOSITORY");

export interface TemplatesRepository {
  /** Все шаблоны, в том числе архивные, в порядке заведения. */
  list(): Promise<StoredTemplate[]>;
  byId(templateId: string): Promise<StoredTemplate | null>;
  /** `false` — идентификатор уже занят, ничего не записано. */
  insert(template: NewTemplate): Promise<boolean>;
  /** `false` — шаблона нет или он в архиве: архивный не правится. */
  update(templateId: string, patch: TemplatePatch): Promise<boolean>;
  /** `true` — архивирован сейчас; `false` — уже был в архиве или его нет. */
  archive(templateId: string, at: Date): Promise<boolean>;
  /** Шаблоны, по которым на период уже есть операция (черновик или проведённая). */
  draftedTemplateIds(period: string): Promise<Set<string>>;
}

/** Нарушение уникальности — код Prisma; внешний ключ и проверки — настоящая ошибка и идут наверх. */
const UNIQUE_VIOLATION = "P2002";

function toStored(row: {
  templateId: string;
  name: string;
  articleId: string;
  placeAccountId: string;
  amount: bigint;
  schedule: TemplateSchedule;
  month: number | null;
  note: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}): StoredTemplate {
  return {
    templateId: row.templateId,
    name: row.name,
    articleId: row.articleId,
    placeAccountId: row.placeAccountId,
    amount: row.amount,
    schedule: row.schedule,
    month: row.month,
    note: row.note,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaTemplatesRepository implements TemplatesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(): Promise<StoredTemplate[]> {
    const rows = await this.prisma.ledgerTemplate.findMany({ orderBy: [{ createdAt: "asc" }, { templateId: "asc" }] });
    return rows.map(toStored);
  }

  async byId(templateId: string): Promise<StoredTemplate | null> {
    const row = await this.prisma.ledgerTemplate.findUnique({ where: { templateId } });
    return row === null ? null : toStored(row);
  }

  async insert(template: NewTemplate): Promise<boolean> {
    try {
      await this.prisma.ledgerTemplate.create({ data: template });
      return true;
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) return false;
      throw error;
    }
  }

  async update(templateId: string, patch: TemplatePatch): Promise<boolean> {
    // Условие «не в архиве» — в самом запросе: между чтением и записью шаблон могли заархивировать.
    const result = await this.prisma.ledgerTemplate.updateMany({ where: { templateId, archivedAt: null }, data: patch });
    return result.count > 0;
  }

  async archive(templateId: string, at: Date): Promise<boolean> {
    const result = await this.prisma.ledgerTemplate.updateMany({ where: { templateId, archivedAt: null }, data: { archivedAt: at } });
    return result.count > 0;
  }

  async draftedTemplateIds(period: string): Promise<Set<string>> {
    const rows = await this.prisma.ledgerOperation.findMany({ where: { templatePeriod: period, templateId: { not: null } }, select: { templateId: true } });
    return new Set(rows.flatMap((row) => (row.templateId === null ? [] : [row.templateId])));
  }
}
