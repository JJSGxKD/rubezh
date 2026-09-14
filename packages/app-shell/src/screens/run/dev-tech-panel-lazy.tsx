import { lazy, Suspense, type ReactNode } from "react";
import type { RunDevInfo } from "@bh/core-game";

/**
 * Техническая сводка — отдельным чанком: она нужна разработчику и тестеру с
 * оверлеем FPS, а игрок её не видит никогда (docs/27-design-system-and-app-shell.md §3.4).
 */
const DevTechPanel = lazy(async () => ({ default: (await import("./DevTechPanel")).DevTechPanel }));

export function DevTechPanelLazy(props: { info: RunDevInfo; compact: boolean }): ReactNode {
  return (
    <Suspense fallback={null}>
      <DevTechPanel info={props.info} compact={props.compact} />
    </Suspense>
  );
}
