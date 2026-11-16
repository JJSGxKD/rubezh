import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { DomainError, ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { IMAGE_ID } from "../media/image-rules.js";
import { MediaService } from "../media/media.service.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PartnerNotFoundError } from "./partner-errors.js";
import { MATERIAL_KINDS, PARTNER_MATERIALS, type MaterialKind, type PartnerMaterialsRepository } from "./partner-materials.repository.js";
import { PARTNERS_REPOSITORY, type PartnersRepository } from "./partners.repository.js";

/**
 * Материалы для партнёров (docs/35-stage4-plan.md Р136, tasks/T-0221): команда выкладывает баннеры, тексты постов и
 * правила программы — для всех партнёров или для одного; партнёр забирает их во вкладке «Материалы» кабинета.
 * Подставлять ссылку партнёра в текст здесь не умеют: он копирует её со вкладки «Ссылки».
 *
 * Права: смотреть список команды — `partners.view`, выкладывать, править и убирать в архив — `partners.edit`,
 * картинку баннера грузит тот же `partners.edit` (профиль `partner_material` модуля `media`). Кабинет читает
 * материалы через `PartnerCabinet.partnerOf`: чей кабинет открыт, решает она, а не запрос.
 */

export { MATERIAL_KINDS, type MaterialKind };

export const MATERIAL_LIMITS = { titleMax: 80, textMax: 2_000, sortMax: 9_999 } as const;

/** Строка материала так, как её хранит база. */
export interface MaterialRow {
  materialId: string;
  kind: MaterialKind;
  title: string;
  /** у поста и правил обязателен, у баннера — подпись, может быть пустой */
  text: string | null;
  /** у баннера обязателен, у текста пуст */
  imageId: string | null;
  /** кому: `null` — всем партнёрам */
  partnerId: string | null;
  partnerName: string | null;
  sort: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

/** Текст: без пробелов по краям, пустой — это «нет текста». */
const textSchema = z
  .string()
  .trim()
  .max(MATERIAL_LIMITS.textMax, `Текст — не длиннее ${String(MATERIAL_LIMITS.textMax)} знаков`)
  .nullish()
  .transform((value) => (value === undefined || value === null || value === "" ? null : value));

/**
 * Что команда задаёт у материала. Баннеру нужна картинка, посту и правилам — текст, и картинки у текста нет:
 * материал, который в кабинете нечем показать или нечего скопировать, не заводится. Те же правила держит `CHECK` в базе.
 */
export const materialInputSchema = z
  .object({
    kind: z.enum(MATERIAL_KINDS),
    title: z.string().trim().min(1, "Название обязательно").max(MATERIAL_LIMITS.titleMax, `Название — не длиннее ${String(MATERIAL_LIMITS.titleMax)} знаков`),
    text: textSchema,
    imageId: z.string().regex(IMAGE_ID, "Некорректная картинка").nullish().transform((value) => value ?? null),
    partnerId: z.uuid("Некорректный партнёр").nullish().transform((value) => value ?? null),
    sort: z.number().int("Порядок — целое число").min(0, "Порядок — от 0").max(MATERIAL_LIMITS.sortMax, `Порядок — до ${String(MATERIAL_LIMITS.sortMax)}`).default(0),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "banner" && value.imageId === null) context.addIssue({ code: "custom", path: ["imageId"], message: "У баннера должна быть картинка" });
    if (value.kind !== "banner" && value.imageId !== null) context.addIssue({ code: "custom", path: ["imageId"], message: "У текста картинки нет" });
    if (value.kind !== "banner" && value.text === null) context.addIssue({ code: "custom", path: ["text"], message: "Нужен текст" });
  });

export type MaterialInput = z.output<typeof materialInputSchema>;

/** Материала с таким id нет. */
export class PartnerMaterialNotFoundError extends DomainError {
  constructor() {
    super("partner_material_not_found", "Материала нет", 404);
  }
}

/**
 * Что из материалов видит партнёр: общие и свои неархивные, по порядку кабинета. Хранилище и так отдаёт только их;
 * проверка здесь — последняя линия: лишняя строка из любого хранилища до партнёра не дойдёт.
 */
export function materialsVisibleTo(rows: readonly MaterialRow[], partnerId: string): MaterialRow[] {
  return rows
    .filter((row) => row.archivedAt === null && (row.partnerId === null || row.partnerId === partnerId))
    .sort((a, b) => a.sort - b.sort || a.createdAt.getTime() - b.createdAt.getTime() || a.materialId.localeCompare(b.materialId));
}

/** Материал глазами партнёра: сам материал и метка «общий»; кто выложил, кому ещё и когда в архив — не его дело. */
export interface CabinetMaterial {
  materialId: string;
  kind: MaterialKind;
  title: string;
  text: string | null;
  imageId: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  /** выложен для всех партнёров, а не лично ему */
  shared: boolean;
}

export interface CabinetMaterials {
  materials: CabinetMaterial[];
  viewOnly: boolean;
}

/** Материалы кабинета партнёра `scope.partnerId`: выбирает хранилище, а проверяет `materialsVisibleTo`. */
export async function cabinetMaterials(store: PartnerMaterialsRepository, scope: { partnerId: string; viewOnly: boolean }): Promise<CabinetMaterials> {
  const rows = materialsVisibleTo(await store.listFor(scope.partnerId), scope.partnerId);
  return {
    materials: rows.map(({ materialId, kind, title, text, imageId, imageWidth, imageHeight, partnerId }) => ({ materialId, kind, title, text, imageId, imageWidth, imageHeight, shared: partnerId === null })),
    viewOnly: scope.viewOnly,
  };
}

const DB_TIMEOUT_MS = 3_000;
const LIST_LIMIT = 500;

/** В журнал аудита — поля материала целиком: правка читается как «было → стало». */
function auditView(row: Pick<MaterialRow, "kind" | "title" | "text" | "imageId" | "partnerId" | "sort">) {
  const { kind, title, text, imageId, partnerId, sort } = row;
  return { kind, title, text, imageId, partnerId, sort };
}

@Injectable()
export class PartnerMaterialsService {
  constructor(
    @Inject(PARTNER_MATERIALS) private readonly store: PartnerMaterialsRepository,
    private readonly roles: RolesService,
    @Inject(PARTNERS_REPOSITORY) private readonly partners: PartnersRepository,
    private readonly media: MediaService,
  ) {}

  /** Все материалы для вкладки команды, архивные тоже. */
  async list(actor: AccountRef): Promise<{ materials: MaterialRow[] }> {
    await this.roles.require(actor, "partners.view");
    return { materials: await this.db(this.store.list(LIST_LIMIT)) };
  }

  async create(actor: AccountRef, input: MaterialInput, at = new Date()): Promise<MaterialRow> {
    await this.roles.require(actor, "partners.edit");
    await this.checkTargets(input, null, at);
    const row = await this.db(this.store.insert({ ...input, materialId: randomUUID(), createdBy: actor.accountId, createdAt: at }));
    await this.roles.audit({ actorAccountId: actor.accountId, action: "partner_material.create", target: row.materialId, after: auditView(row) });
    return row;
  }

  /** Заменить поля материала. Вид не меняется: баннер не станет постом — заведите новый. */
  async update(actor: AccountRef, materialId: string, input: MaterialInput, at = new Date()): Promise<MaterialRow> {
    await this.roles.require(actor, "partners.edit");
    const current = await this.db(this.store.byId(materialId));
    if (current === null) throw new PartnerMaterialNotFoundError();
    if (input.kind !== current.kind) throw new ValidationError("Вид материала не меняется: нужен новый материал");
    await this.checkTargets(input, current, at);
    const patch = { title: input.title, text: input.text, imageId: input.imageId, partnerId: input.partnerId, sort: input.sort };
    const changed = await this.db(this.store.update(materialId, patch, at));
    if (changed === null) throw new PartnerMaterialNotFoundError();
    const [before, after] = [auditView(changed.before), auditView(changed.after)];
    if (JSON.stringify(before) !== JSON.stringify(after)) await this.roles.audit({ actorAccountId: actor.accountId, action: "partner_material.update", target: materialId, before, after });
    return changed.after;
  }

  /** В архив — или обратно. Повтор безвреден: время архивации остаётся первым, журнал не дублируется. */
  async setArchived(actor: AccountRef, materialId: string, archived: boolean, at = new Date()): Promise<MaterialRow> {
    await this.roles.require(actor, "partners.edit");
    const current = await this.db(this.store.byId(materialId));
    if (current === null) throw new PartnerMaterialNotFoundError();
    if ((current.archivedAt !== null) === archived) return current;
    const changed = await this.db(this.store.setArchived(materialId, archived ? at : null, at));
    if (changed === null) throw new PartnerMaterialNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: archived ? "partner_material.archive" : "partner_material.restore", target: materialId, after: { title: changed.after.title } });
    return changed.after;
  }

  /** Партнёр существует, картинка годится баннеру; у правки проверяется только то, что она меняет. */
  private async checkTargets(input: MaterialInput, current: MaterialRow | null, at: Date): Promise<void> {
    if (input.partnerId !== null && input.partnerId !== current?.partnerId && (await this.db(this.partners.byId(input.partnerId, at))) === null) throw new PartnerNotFoundError();
    if (input.imageId !== null && input.imageId !== current?.imageId) await this.media.require(input.imageId, "partner_material");
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "материалы партнёров");
  }
}
