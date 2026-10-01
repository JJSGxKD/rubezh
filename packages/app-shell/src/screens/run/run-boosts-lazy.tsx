import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

/**
 * Бусты забега — отдельным чанком (`RunBoosts.tsx`): забегу без бустов он не
 * грузится вовсе. Не догрузился — плашек нет, а забег идёт: ради значков
 * HUD падать не должен.
 */
function lazyPart<Props extends object>(pick: (module: typeof import("./RunBoosts")) => ComponentType<Props>): ComponentType<Props> {
  const nothing: ComponentType<Props> = () => null;
  return lazy(() =>
    import("./RunBoosts").then(
      (module) => ({ default: pick(module) }),
      () => ({ default: nothing }),
    ),
  );
}

const Slots = lazyPart((module) => module.BoostSlots);
const List = lazyPart((module) => module.BoostList);

/** Секунды забега, пока у плашек видны имена. */
const NAMED_SEC = 6;

export function RunBoostSlots(props: { ids: readonly string[]; survivalSec: number }): ReactNode {
  if (props.ids.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <Slots ids={props.ids} named={props.survivalSec < NAMED_SEC} />
    </Suspense>
  );
}

export function RunBoostList(props: { ids: readonly string[] }): ReactNode {
  if (props.ids.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <List ids={props.ids} />
    </Suspense>
  );
}
