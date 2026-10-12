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
export const PREVIEW_KINDS = ["home-slide", "changelog-version", "task"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

/** Слайд главной: то, что видит игрок, — без цели, аудитории и срока. */
export const homeSlideDraftSchema = z.object({
  title: z.string().check(z.maxLength(64)),
  text: z.string().check(z.maxLength(80)),
  imageId: z.nullable(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
  icon: z.string().check(z.maxLength(16)),
});
export type HomeSlideDraft = z.infer<typeof homeSlideDraftSchema>;

/**
 * Версия журнала обновлений: номер и строки — как в «Что нового», только без
 * отбора по площадке: команда видит версию целиком. Пределы — с запасом над
 * пределами панели: страница не решает, что можно сохранить.
 */
export const changelogDraftSchema = z.object({
  version: z.string().check(z.maxLength(32)),
  entries: z.array(z.object({ kind: z.string().check(z.maxLength(16)), text: z.string().check(z.maxLength(1000)) })).check(z.maxLength(100)),
});
export type ChangelogDraft = z.infer<typeof changelogDraftSchema>;

/** Задание: то, из чего игрок видит строку, — без лимита, порядка и включения. */
export const taskDraftSchema = z.object({
  title: z.nullable(z.string().check(z.maxLength(240))),
  kind: z.string().check(z.maxLength(32)),
  period: z.enum(["daily", "weekly", "achievement"]),
  /** партнёрская цель — своя вкладка и кнопки вместо полосы прогресса */
  partner: z.boolean(),
  target: z.number().check(z.nonnegative()),
  reward: z.object({ coins: z.number().check(z.nonnegative()), gems: z.number().check(z.nonnegative()), shards: z.number().check(z.nonnegative()) }),
  imageId: z.nullable(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
  link: z.nullable(z.string().check(z.maxLength(1024))),
});
export type TaskDraft = z.infer<typeof taskDraftSchema>;

export const draftMessageSchema = z.object({
  type: z.literal(PREVIEW_DRAFT),
  kind: z.enum(PREVIEW_KINDS),
  draft: z.unknown(),
});
