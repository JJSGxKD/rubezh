import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { MaterialInput, MaterialRow } from "./partner-materials.js";

/**
 * Материалы для партнёров в базе (`partner_material`, docs/35-stage4-plan.md Р136, tasks/T-0221). Выборка кабинета
 * делается здесь же запросом: общие и свои неархивные — остальное из базы не выходит вовсе.
 */

/** Виды материалов; список живёт здесь, чтобы правила (`partner-materials.ts`) и база не импортировали друг друга по кругу. */
export const MATERIAL_KINDS = ["banner", "post", "rules"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

/** Новая строка: всё, что решает команда, плюс кто и когда. Вид после заведения не меняется. */
export type NewMaterialRow = MaterialInput & { materialId: string; createdBy: string; createdAt: Date };

/** Что правка может поменять: вид и автор остаются прежними. */
export type MaterialPatch = Omit<MaterialInput, "kind">;

export const PARTNER_MATERIALS = Symbol("PARTNER_MATERIALS");

export interface PartnerMaterialsRepository {
  /** всё для команды, архивные тоже; по порядку кабинета */
  list(limit: number): Promise<MaterialRow[]>;
  /** то, что видит партнёр: общие и его неархивные; по порядку кабинета */
  listFor(partnerId: string): Promise<MaterialRow[]>;
  byId(materialId: string): Promise<MaterialRow | null>;
  insert(row: NewMaterialRow): Promise<MaterialRow>;
  /** `null` — такого материала нет */
  update(materialId: string, patch: MaterialPatch, at: Date): Promise<{ before: MaterialRow; after: MaterialRow } | null>;
  /** `archivedAt: null` возвращает из архива; уже архивный остаётся с прежним временем. `null` — материала нет */
  setArchived(materialId: string, archivedAt: Date | null, at: Date): Promise<{ before: MaterialRow; after: MaterialRow } | null>;
}

/** Картинка и имя партнёра приходят вместе со строкой: кабинету нужны размеры, команде — имя. */
const INCLUDE = { image: { select: { width: true, height: true } }, partner: { select: { name: true } } } as const;
const ORDER = [{ sort: "asc" }, { createdAt: "asc" }] as const;
/** Потолок выборки кабинета: материалов единицы, но запрос без предела — ошибка на будущее. */
const LIST_FOR_LIMIT = 200;
const kindSchema = z.enum(MATERIAL_KINDS);

interface StoredRow {
  materialId: string;
  kind: string;
  title: string;
  text: string | null;
  imageId: string | null;
  partnerId: string | null;
  sort: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  image: { width: number; height: number } | null;
  partner: { name: string } | null;
}

function rowOf(row: StoredRow): MaterialRow {
  const { image, partner, ...rest } = row;
  return { ...rest, kind: kindSchema.parse(row.kind), partnerName: partner?.name ?? null, imageWidth: image?.width ?? null, imageHeight: image?.height ?? null };
}

@Injectable()
export class PrismaPartnerMaterialsRepository implements PartnerMaterialsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(limit: number): Promise<MaterialRow[]> {
    return (await this.prisma.partnerMaterial.findMany({ orderBy: [...ORDER], take: limit, include: INCLUDE })).map(rowOf);
  }

  async listFor(partnerId: string): Promise<MaterialRow[]> {
    const rows = await this.prisma.partnerMaterial.findMany({
      where: { archivedAt: null, OR: [{ partnerId: null }, { partnerId }] },
      orderBy: [...ORDER],
      take: LIST_FOR_LIMIT,
      include: INCLUDE,
    });
    return rows.map(rowOf);
  }

  async byId(materialId: string): Promise<MaterialRow | null> {
    const row = await this.prisma.partnerMaterial.findUnique({ where: { materialId }, include: INCLUDE });
    return row === null ? null : rowOf(row);
  }

  async insert(row: NewMaterialRow): Promise<MaterialRow> {
    const created = await this.prisma.partnerMaterial.create({ data: { ...row, updatedAt: row.createdAt }, include: INCLUDE });
    return rowOf(created);
  }

  async update(materialId: string, patch: MaterialPatch, at: Date): Promise<{ before: MaterialRow; after: MaterialRow } | null> {
    return await this.change(materialId, () => ({ ...patch, updatedAt: at }));
  }

  async setArchived(materialId: string, archivedAt: Date | null, at: Date): Promise<{ before: MaterialRow; after: MaterialRow } | null> {
    return await this.change(materialId, (before) => (archivedAt !== null && before.archivedAt !== null ? {} : { archivedAt, updatedAt: at }));
  }

  /** Прочитать и записать одной транзакцией: «было» в журнале — ровно то, что заменила эта правка. */
  private async change(materialId: string, data: (before: StoredRow) => Prisma.PartnerMaterialUncheckedUpdateInput): Promise<{ before: MaterialRow; after: MaterialRow } | null> {
    return await this.prisma.$transaction(async (tx) => {
      const before = await tx.partnerMaterial.findUnique({ where: { materialId }, include: INCLUDE });
      if (before === null) return null;
      const patch = data(before);
      const after = Object.keys(patch).length === 0 ? before : await tx.partnerMaterial.update({ where: { materialId }, data: patch, include: INCLUDE });
      return { before: rowOf(before), after: rowOf(after) };
    });
  }
}
