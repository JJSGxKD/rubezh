import { z } from "zod/mini";

/**
 * Предпросмотр для панели (docs/35-stage4-plan.md WP32, Р83): панель шлёт
 * черновик в страницу клиента сообщением `postMessage`, страница рисует его
 * тем же компонентом, что игрок. Панель знает те же имена своей копией
 * (`apps/admin/src/api/preview.ts`): импортировать оболочку ей нельзя, а
 * совпадение проверяет `scripts/test/preview-protocol.test.ts`.
 */

/** Черновик из панели. Имя — своё: чужие сообщения на странице (расширения браузера) на него не похожи. */
export const PREVIEW_DRAFT = "rubezh:preview-draft";
/** Страница готова принять черновик — панель шлёт его в ответ, а не наугад до загрузки. */
export const PREVIEW_READY = "rubezh:preview-ready";

/** Что умеет показать страница: новый вид — строка в реестре (`registry.tsx`) и здесь. */
export const PREVIEW_KINDS = ["home-slide"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

/** Слайд главной: то, что видит игрок, — без цели, аудитории и срока. */
export const homeSlideDraftSchema = z.object({
  title: z.string().check(z.maxLength(64)),
  text: z.string().check(z.maxLength(80)),
  imageId: z.nullable(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
  icon: z.string().check(z.maxLength(16)),
});
export type HomeSlideDraft = z.infer<typeof homeSlideDraftSchema>;

export const draftMessageSchema = z.object({
  type: z.literal(PREVIEW_DRAFT),
  kind: z.enum(PREVIEW_KINDS),
  draft: z.unknown(),
});
