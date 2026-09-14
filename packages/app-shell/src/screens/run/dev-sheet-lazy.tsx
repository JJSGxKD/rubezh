import { lazy, Suspense, type ReactNode } from "react";

/**
 * Лист разработчика — отдельным чанком: он нужен администраторам, а весит
 * как пол-экрана выбора улучшения, и в первую загрузку игроку не идёт
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
const DevSheet = lazy(async () => ({ default: (await import("./DevSheet")).DevSheet }));

export function DevSheetLazy(props: { inRun: boolean; onClose(): void }): ReactNode {
  return (
    <Suspense fallback={null}>
      <DevSheet inRun={props.inRun} onClose={props.onClose} />
    </Suspense>
  );
}
