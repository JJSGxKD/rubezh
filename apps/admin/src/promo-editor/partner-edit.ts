import { PartnerEditError, applyPartnerEdits, type PartnerEdits, type PromoDoc } from "@bh/promo-kit";

/**
 * Режим партнёра (tasks/T-0274): каждое изменение — не правка документа, а
 * запись в правках партнёра, и документ каждый раз собирается заново из
 * шаблона через `applyPartnerEdits` (T-0272). Так редактор физически не может
 * сохранить то, что партнёру нельзя: положение, размер, шрифт, порядок.
 */
export interface PartnerChange {
  layerId: string;
  /** `text`, `src` или `color`; любое другое поле `applyPartnerEdits` отклонит */
  field: string;
  value: unknown;
}

export type PartnerChangeResult = { ok: true; doc: PromoDoc; edits: PartnerEdits } | { ok: false; message: string };

export function applyPartnerChange(template: PromoDoc, edits: PartnerEdits | null, change: PartnerChange): PartnerChangeResult {
  const layers: Record<string, Record<string, unknown>> = {};
  for (const [id, fields] of Object.entries(edits?.layers ?? {})) layers[id] = { ...fields };
  layers[change.layerId] = { ...layers[change.layerId], [change.field]: change.value };
  const next: PartnerEdits = { layers };
  try {
    return { ok: true, doc: applyPartnerEdits(template, next), edits: next };
  } catch (error) {
    if (error instanceof PartnerEditError) return { ok: false, message: error.message };
    throw error;
  }
}
