import { lazy, Suspense, type ReactNode } from "react";
import type { BoostPickerProps } from "./boost-picker";

/**
 * Выбор бустов — отдельным чанком: каталог с сервера, тексты и значки
 * нужны только на экране «Перед забегом» и только с входом
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
const BoostPicker = lazy(async () => ({ default: (await import("./boost-picker")).BoostPicker }));

export function BoostPickerLazy(props: BoostPickerProps): ReactNode {
  return (
    <Suspense fallback={null}>
      <BoostPicker {...props} />
    </Suspense>
  );
}
