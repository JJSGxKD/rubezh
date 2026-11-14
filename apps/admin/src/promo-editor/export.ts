import type { FormatId, PromoDoc, PromoVars } from "@bh/promo-kit";
import type { UrlResolver } from "./fabric-objects";

/**
 * Выгрузка готовой картинки (docs/35-stage4-plan.md Р159, tasks/T-0274):
 * PNG или JPEG в полном размере формата. Холст и Fabric подгружаются только
 * при выгрузке (`export-render.ts`), а имя файла считается без них.
 */
export type ExportType = "png" | "jpeg";

/** Качество JPEG: 0,92 — заметной разницы с исходником нет, файл втрое легче PNG. */
export const JPEG_QUALITY = 0.92;

const EXTENSIONS: Record<ExportType, string> = { png: "png", jpeg: "jpg" };

/** Часть имени из кода: буквы любого алфавита, цифры, «-» и «_»; пробелы — дефисами, остальное убирается. */
function slug(code: string | undefined): string {
  const text = (code ?? "")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return text === "" ? "pres" : text;
}

/** `rubezh-<формат>-<код или pres>.<png|jpg>`; в имя не попадают разделители пути и служебные знаки. */
export function exportFileName(format: FormatId, code: string | undefined, type: ExportType): string {
  return `rubezh-${format}-${slug(code)}.${EXTENSIONS[type]}`;
}

export async function exportImage(doc: PromoDoc, vars: PromoVars, type: ExportType, urls: UrlResolver): Promise<Blob> {
  const { renderDoc } = await import("./export-render");
  return renderDoc(doc, vars, type, JPEG_QUALITY, urls);
}
