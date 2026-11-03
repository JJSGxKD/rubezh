/**
 * Форматы промо-материала (docs/35-stage4-plan.md, Р159). Размеры — в точках
 * холста: слои документа заданы в тех же единицах, а во что их растянуть при
 * выгрузке, решает редактор.
 */
export const FORMAT_IDS = ["story", "square", "portrait", "wide", "link_preview"] as const;

export type FormatId = (typeof FORMAT_IDS)[number];

export interface PromoFormat {
  id: FormatId;
  /** подпись для выбора формата в редакторе */
  label: string;
  width: number;
  height: number;
}

export const FORMATS: Record<FormatId, PromoFormat> = {
  story: { id: "story", label: "Сторис", width: 1080, height: 1920 },
  square: { id: "square", label: "Пост 1:1", width: 1080, height: 1080 },
  portrait: { id: "portrait", label: "Пост 4:5", width: 1080, height: 1350 },
  wide: { id: "wide", label: "Баннер 16:9", width: 1280, height: 720 },
  link_preview: { id: "link_preview", label: "Превью ссылки", width: 1200, height: 630 },
};

export function formatSize(id: FormatId): { width: number; height: number } {
  const { width, height } = FORMATS[id];
  return { width, height };
}
