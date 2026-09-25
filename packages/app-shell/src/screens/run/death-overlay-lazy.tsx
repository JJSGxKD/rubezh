import { lazy, Suspense, type ReactNode } from "react";
import type { DeathOverlayProps } from "./DeathOverlay";

/**
 * Экран смерти — отдельным чанком (docs/27-design-system-and-app-shell.md
 * §3.4): до первой смерти он не нужен, а первая загрузка у оболочки на
 * пределе бюджета. Чтобы смерть не ждала сети, чанк подтягивается заранее,
 * когда забег начался (`prefetchDeathOverlay`).
 */
const load = (): Promise<typeof import("./DeathOverlay")> => import("./DeathOverlay");

const DeathOverlay = lazy(async () => ({ default: (await load()).DeathOverlay }));

export function prefetchDeathOverlay(): void {
  // Не догрузилось — не беда: `lazy` попробует снова, когда игрок умрёт.
  load().catch(() => undefined);
}

export function DeathOverlayLazy(props: DeathOverlayProps): ReactNode {
  return (
    <Suspense fallback={null}>
      <DeathOverlay {...props} />
    </Suspense>
  );
}
