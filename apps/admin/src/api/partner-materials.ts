import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import { encodeWithin } from "../ui/image-crop";
import { IMAGE_MAX_BYTES, toBase64 } from "./media";

/**
 * Материалы для партнёров (`/admin/partner-materials` и `/admin/cabinet/materials`, docs/35-stage4-plan.md Р136,
 * tasks/T-0221): баннеры, тексты постов и правила программы выкладывает команда, партнёр забирает их во вкладке
 * «Материалы» кабинета. Пределы — те же, что держит сервер (`partners/partner-materials.ts`, `media/image-rules.ts`).
 */

export const MATERIAL_KINDS = ["banner", "post", "rules"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const KIND_TITLES: Record<MaterialKind, string> = { banner: "Баннер", post: "Текст поста", rules: "Правила" };

export const MATERIAL_LIMITS = { titleMax: 80, textMax: 2_000, sortMax: 9_999 } as const;

/** Стороны баннера: профиль `partner_material` модуля картинок. */
export const BANNER_SIDES = { min: 200, max: 2_048 } as const;

/** Тексты вкладок и подсказки — рядом с данными: словарь подсказок панели (`ui/help.ts`) вне зон T-0221. */
export const MATERIAL_TEXTS = {
  teamIntro: "Что партнёры забирают в своём кабинете: баннеры, тексты постов и правила программы. Общий материал видят все партнёры, адресный — только тот, кому он выложен.",
  teamEmpty: "Материалов ещё нет — выложите первый кнопкой «Новый материал»",
  teamEmptyReadOnly: "Материалов ещё нет",
  cabinetEmpty: "Команда ещё не выложила материалы",
  cabinetEmptyView: "Для этого партнёра материалов пока нет",
  cabinetIntro: "Баннеры, тексты постов и правила программы от команды. Ссылку для поста копируйте на вкладке «Ссылки».",
  archiveHelp: "Архивный материал партнёры не видят, но запись остаётся: из архива его можно вернуть.",
  sortHelp: "Порядок в кабинете партнёра: меньше — выше. Материалы с одним числом идут по времени заведения.",
  audienceHelp: "Кому виден материал: всем партнёрам или только одному. Получателя можно сменить, а вид материала после заведения не меняется.",
  bannerHelp: `PNG, JPEG или WebP: панель сама сожмёт картинку в WebP до ${String(IMAGE_MAX_BYTES / 1024)} КБ. Стороны от ${String(BANNER_SIDES.min)} до ${String(BANNER_SIDES.max)} px, не обязательно квадрат; партнёр скачает файл как он сохранён.`,
  copied: "Текст скопирован",
  copyFailed: "Браузер не дал скопировать — выделите текст вручную",
} as const;

const imageSchema = z.object({ imageId: z.string(), width: z.number(), height: z.number(), sizeBytes: z.number() });

const kindSchema = z.enum(MATERIAL_KINDS);

const teamMaterialSchema = z.object({
  materialId: z.string(),
  kind: kindSchema,
  title: z.string(),
  text: z.string().nullable(),
  imageId: z.string().nullable(),
  partnerId: z.string().nullable(),
  partnerName: z.string().nullable(),
  sort: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  imageWidth: z.number().nullable(),
  imageHeight: z.number().nullable(),
});
export type TeamMaterial = z.infer<typeof teamMaterialSchema>;

const teamListSchema = z.object({ materials: z.array(teamMaterialSchema) });

const cabinetMaterialSchema = z.object({
  materialId: z.string(),
  kind: kindSchema,
  title: z.string(),
  text: z.string().nullable(),
  imageId: z.string().nullable(),
  imageWidth: z.number().nullable(),
  imageHeight: z.number().nullable(),
  shared: z.boolean(),
});
export type CabinetMaterial = z.infer<typeof cabinetMaterialSchema>;

const cabinetListSchema = z.object({ materials: z.array(cabinetMaterialSchema), viewOnly: z.boolean() });
export type CabinetMaterials = z.infer<typeof cabinetListSchema>;

export function fetchTeamMaterials(api: AdminApi): Promise<ApiResult<{ materials: TeamMaterial[] }>> {
  return api.request("/partner-materials", { schema: teamListSchema });
}

/** Материалы кабинета: без `partnerId` — свои, с ним — глазами партнёра (только чтение). */
export function fetchCabinetMaterials(api: AdminApi, partnerId: string | null): Promise<ApiResult<CabinetMaterials>> {
  return api.request("/cabinet/materials", { query: partnerId === null ? {} : { partnerId }, schema: cabinetListSchema });
}

/** Форма материала: всё строками, как в полях; в тело запроса уходит через `materialBody`. */
export interface MaterialForm {
  kind: MaterialKind;
  title: string;
  text: string;
  imageId: string | null;
  /** пусто — всем партнёрам */
  partnerId: string;
  sort: string;
}

export function emptyMaterialForm(kind: MaterialKind = "banner"): MaterialForm {
  return { kind, title: "", text: "", imageId: null, partnerId: "", sort: "0" };
}

export function materialFormOf(material: TeamMaterial): MaterialForm {
  return { kind: material.kind, title: material.title, text: material.text ?? "", imageId: material.imageId, partnerId: material.partnerId ?? "", sort: String(material.sort) };
}

export type MaterialProblems = Partial<Record<"title" | "text" | "imageId" | "sort", string>>;

/** Что не так с формой — теми же словами и по тем же правилам, что у сервера; пусто — можно отправлять. */
export function materialProblems(form: MaterialForm): MaterialProblems {
  const problems: MaterialProblems = {};
  const title = form.title.trim();
  if (title === "") problems.title = "Название обязательно";
  else if (title.length > MATERIAL_LIMITS.titleMax) problems.title = `Название — не длиннее ${String(MATERIAL_LIMITS.titleMax)} знаков`;
  const text = form.text.trim();
  if (text.length > MATERIAL_LIMITS.textMax) problems.text = `Текст — не длиннее ${String(MATERIAL_LIMITS.textMax)} знаков`;
  else if (form.kind !== "banner" && text === "") problems.text = "Нужен текст";
  if (form.kind === "banner" && form.imageId === null) problems.imageId = "Загрузите картинку баннера";
  if (!/^\d{1,4}$/.test(form.sort.trim()) || Number(form.sort) > MATERIAL_LIMITS.sortMax) problems.sort = `Порядок — число от 0 до ${String(MATERIAL_LIMITS.sortMax)}`;
  return problems;
}

/** Тело запроса: у текста картинки нет, у баннера подпись может быть пустой. */
export function materialBody(form: MaterialForm): Record<string, unknown> {
  const text = form.text.trim();
  return {
    kind: form.kind,
    title: form.title.trim(),
    text: text === "" ? null : text,
    imageId: form.kind === "banner" ? form.imageId : null,
    partnerId: form.partnerId === "" ? null : form.partnerId,
    sort: Number(form.sort),
  };
}

export function createMaterial(api: AdminApi, form: MaterialForm): Promise<ApiResult<TeamMaterial>> {
  return api.request("/partner-materials", { method: "POST", body: materialBody(form), schema: teamMaterialSchema });
}

export function updateMaterial(api: AdminApi, materialId: string, form: MaterialForm): Promise<ApiResult<TeamMaterial>> {
  return api.request(`/partner-materials/${encodeURIComponent(materialId)}`, { method: "POST", body: materialBody(form), schema: teamMaterialSchema });
}

/** «В архив» (`archived: true`) или обратно. */
export function archiveMaterial(api: AdminApi, materialId: string, archived: boolean): Promise<ApiResult<TeamMaterial>> {
  return api.request(`/partner-materials/${encodeURIComponent(materialId)}/archive`, { method: "PUT", body: { archived }, schema: teamMaterialSchema });
}

/** Для кого материал — словами таблицы. */
export function audienceTitle(material: Pick<TeamMaterial, "partnerId" | "partnerName">): string {
  if (material.partnerId === null) return "Все партнёры";
  return material.partnerName ?? "Один партнёр";
}

/** Порядок таблицы команды: живые по порядку кабинета, архивные — в конце. */
export function teamOrder(materials: readonly TeamMaterial[]): TeamMaterial[] {
  return [...materials].sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.sort - b.sort || a.createdAt.localeCompare(b.createdAt));
}

/** Размер баннера словами карточки: «1080×1080»; размеров нет — пусто. */
export function bannerSize(material: Pick<CabinetMaterial, "imageWidth" | "imageHeight">): string | null {
  return material.imageWidth === null || material.imageHeight === null ? null : `${String(material.imageWidth)}×${String(material.imageHeight)}`;
}

/** Имя скачиваемого файла: название латиницей не нужно — хватает безопасного имени из названия и вида. */
export function bannerFileName(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base === "" ? "banner" : base}.webp`;
}

/**
 * Во что превратить исходник баннера: стороны не меньше `min` и не больше `max`. Больше — уменьшается пропорционально,
 * меньше — отказ (растягивать мыло нельзя): `null` вместе с причиной словами.
 */
export function fitBanner(width: number, height: number): { ok: true; width: number; height: number } | { ok: false; problem: string } {
  if (Math.min(width, height) < BANNER_SIDES.min) return { ok: false, problem: `Картинка мельче ${String(BANNER_SIDES.min)} px по короткой стороне — возьмите крупнее` };
  const scale = Math.min(1, BANNER_SIDES.max / Math.max(width, height));
  const fitted = { width: Math.round(width * scale), height: Math.round(height * scale) };
  // Очень вытянутая картинка при уменьшении может потерять короткую сторону: такой баннер не годится.
  if (Math.min(fitted.width, fitted.height) < BANNER_SIDES.min) return { ok: false, problem: `Картинка слишком вытянута: после уменьшения до ${String(BANNER_SIDES.max)} px короткая сторона меньше ${String(BANNER_SIDES.min)} px` };
  return { ok: true, ...fitted };
}

/** Шаги уменьшения, если WebP на полном размере тяжелее предела: стороны не опускаются ниже минимума. */
export const BANNER_SCALE_STEPS = [1, 0.8, 0.6, 0.45] as const;

/** Файл → WebP не тяжелее предела: размер, сжатие и повтор на меньших сторонах, пока не поместится. */
export async function prepareBanner(file: Blob): Promise<{ ok: true; blob: Blob } | { ok: false; problem: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, problem: "Не получилось открыть файл — он повреждён или это не PNG, JPEG и не WebP" };
  }
  try {
    const fitted = fitBanner(bitmap.width, bitmap.height);
    if (!fitted.ok) return fitted;
    let last = `Даже сильно сжатая картинка тяжелее ${String(Math.round(IMAGE_MAX_BYTES / 1024))} КБ — возьмите попроще`;
    for (const step of BANNER_SCALE_STEPS) {
      const width = Math.round(fitted.width * step);
      const height = Math.round(fitted.height * step);
      if (Math.min(width, height) < BANNER_SIDES.min) break;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) return { ok: false, problem: "Браузер не смог сжать картинку — попробуйте другой файл" };
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);
      const encoded = await encodeWithin((quality) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality)), IMAGE_MAX_BYTES);
      if (encoded.ok) return encoded;
      last = encoded.problem;
    }
    return { ok: false, problem: last };
  } finally {
    bitmap.close();
  }
}

/** Загрузка баннера: профиль `partner_material` (право `partners.edit`). */
export async function uploadBannerImage(api: AdminApi, blob: Blob): Promise<ApiResult<z.infer<typeof imageSchema>>> {
  return await api.request("/media/images", { method: "POST", body: { profile: "partner_material", data: await toBase64(blob) }, schema: imageSchema, timeoutMs: 30_000 });
}
