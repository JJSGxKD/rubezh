import { lazy, Suspense } from "react";
import { Loading } from "../ui/kit";
import type { PromoEditorProps } from "./types";

/**
 * Редактор для экранов панели (T-0275–T-0277): Fabric.js весит сотни
 * килобайт, и в первую загрузку панели он не входит — холст подгружается
 * отдельным чанком, когда экран с редактором открыт.
 */
const Loaded = lazy(() => import("./PromoEditor").then((module) => ({ default: module.PromoEditor })));

export function LazyPromoEditor(props: PromoEditorProps) {
  return (
    <Suspense fallback={<Loading />}>
      <Loaded {...props} />
    </Suspense>
  );
}
