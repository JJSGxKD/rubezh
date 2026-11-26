/**
 * Редактор промо на Fabric.js (docs/35-stage4-plan.md Р159, tasks/T-0274).
 * Экраны подключают `LazyPromoEditor`: сам редактор и Fabric грузятся
 * отдельным чанком. Статически импортировать `PromoEditor.tsx` из экранов
 * нельзя — Fabric попадёт в первую загрузку панели.
 */
export { LazyPromoEditor } from "./lazy";
export { exportFileName, exportImage, type ExportType } from "./export";
export type { PromoAsset, PromoAssets, PromoEditorProps } from "./types";
