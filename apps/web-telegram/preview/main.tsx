import { mountPreview } from "@bh/app-shell/preview";

/**
 * Предпросмотр для панели (docs/35-stage4-plan.md WP32, Р83): адреса панели
 * подставляет сборка (`scripts/vite/preview-origins.ts`), адрес API — тот же,
 * что у игры: картинки из панели лежат там.
 */
const container = document.getElementById("preview");
if (container === null) throw new Error("Нет контейнера #preview в разметке");

mountPreview({
  container,
  allowedOrigins: __ADMIN_ORIGINS__,
  apiBaseUrl: import.meta.env.DEV ? "" : (import.meta.env.VITE_API_URL ?? ""),
});
