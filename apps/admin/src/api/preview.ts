/**
 * Предпросмотр тем же компонентом, что у игрока (docs/35-stage4-plan.md WP32,
 * Р83): панель встраивает страницу клиента `preview/` и шлёт ей черновик.
 * Имена сообщений — копия `packages/app-shell/src/preview/protocol.ts`:
 * оболочку панели импортировать нельзя, а совпадение проверяет
 * `scripts/test/preview-protocol.test.ts`.
 */

export const PREVIEW_DRAFT = "rubezh:preview-draft";
export const PREVIEW_READY = "rubezh:preview-ready";

/** Что умеет показать страница — копия `PREVIEW_KINDS` клиента, совпадение проверяет тест протокола. */
export const PREVIEW_KINDS = ["home-slide", "changelog-version", "task"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

/**
 * Где страница предпросмотра; пусто — не настроен (`VITE_PREVIEW_URL`).
 * Константу подставляет сборка; в тестах её нет — там предпросмотр не настроен.
 */
export const PREVIEW_URL: string = typeof __PREVIEW_URL__ === "string" ? __PREVIEW_URL__ : "";

/** Источник страницы предпросмотра — кому слать черновик и от кого ждать «готова». */
export function previewOrigin(url: string = PREVIEW_URL): string | null {
  return url !== "" && URL.canParse(url) ? new URL(url).origin : null;
}

/** Ширины телефонов: узкий Android, iPhone SE и mini, обычный iPhone, большой. */
export const PREVIEW_WIDTHS = [320, 375, 390, 430] as const;
export type PreviewWidth = (typeof PREVIEW_WIDTHS)[number];

/** Высота экрана в портрете для ширины — у ландшафта стороны меняются местами. */
export const PREVIEW_HEIGHTS: Record<PreviewWidth, number> = { 320: 568, 375: 667, 390: 844, 430: 932 };

/** Сообщение с черновиком: то, что примет страница. */
export function draftMessage(kind: PreviewKind, draft: unknown): { type: typeof PREVIEW_DRAFT; kind: PreviewKind; draft: unknown } {
  return { type: PREVIEW_DRAFT, kind, draft };
}

/** «Готова» от страницы — только со своего источника. */
export function isReady(event: Pick<MessageEvent, "origin" | "data">, origin: string | null): boolean {
  if (origin === null || event.origin !== origin) return false;
  const data: unknown = event.data;
  return typeof data === "object" && data !== null && "type" in data && data.type === PREVIEW_READY;
}
