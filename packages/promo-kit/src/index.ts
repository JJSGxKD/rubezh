/**
 * Модель промо-материала (docs/35-stage4-plan.md, Р159): форматы, документ из
 * слоёв, подстановка промокода, ссылки и QR, правила правки партнёром и
 * предупреждения редактора. Ничего из монорепо, Nest, Prisma и Fabric — пакет
 * берут панель, кабинет партнёра, сервер и другие проекты. Перевод документа в
 * холст — дело редактора.
 */
export {
  colorSchema,
  FONTS,
  imageSourceSchema,
  layerSchema,
  MAX_LAYERS,
  MAX_PALETTE,
  MAX_TEXT_LENGTH,
  PARTNER_RIGHTS,
  promoDocSchema,
  type ImageSource,
  type PartnerRight,
  type PromoDoc,
  type PromoLayer,
  type TextLayer,
} from "./doc.js";
export { FORMAT_IDS, FORMATS, formatSize, type FormatId, type PromoFormat } from "./formats.js";
export { applyPartnerEdits, PartnerEditError, partnerEditsSchema, type PartnerEdits } from "./partner.js";
export { docProblems, MIN_QR_SIDE, MIN_STORY_TEXT_SIZE } from "./problems.js";
export { resolveDoc, usedVars, VAR_NAMES, type PromoVars, type VarName } from "./vars.js";
