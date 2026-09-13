import { useEffect, useState, type ReactNode } from "react";
import { Footprints, Gem, Shield } from "lucide-react";
import type { HudSnapshot } from "@bh/core-game";
import { t } from "../../i18n";
import { currentHint, isHintDone, useHints, type HintId } from "../../state/hints";

/**
 * Плашка подсказки первого забега поверх мира. Не ловит касания — под ней
 * джойстик. Появляется подъёмом один раз и дальше стоит неподвижно: над живой
 * канвой бесконечных анимаций нет (docs/27-design-system-and-app-shell.md §3.3).
 */
const ICONS: Record<HintId, ReactNode> = {
  move: <Footprints size={20} aria-hidden="true" />,
  gems: <Gem size={20} aria-hidden="true" />,
  dodge: <Shield size={20} aria-hidden="true" />,
};

export function HintBanner(props: { hud: HudSnapshot }): ReactNode {
  const seen = useHints((state) => state.seen);
  const hint = currentHint(seen);
  // С какой секунды забега висит текущая подсказка: у совета без действия
  // считается, сколько он провисел.
  const [since, setSince] = useState<{ id: HintId | null; sec: number }>(() => ({
    id: hint,
    sec: props.hud.survivalSec,
  }));

  const shownSinceSec = since.id === hint ? since.sec : props.hud.survivalSec;
  // Игрок мог сделать дело раньше, чем до подсказки дошла очередь: собрал
  // кристалл, ещё не сдвинувшись. Такая гаснет, не мелькнув.
  const done = hint !== null && isHintDone(hint, props.hud, shownSinceSec);

  useEffect(() => {
    if (hint === null) return;
    if (since.id !== hint) setSince({ id: hint, sec: shownSinceSec });
    if (done) useHints.getState().markSeen(hint);
  }, [hint, done, since.id, shownSinceSec]);

  if (hint === null || done) return null;

  return (
    <div
      key={hint}
      role="status"
      className="surface-panel mx-auto flex max-w-[320px] animate-rise-in items-center gap-3 rounded-lg px-4 py-3"
    >
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
        {ICONS[hint]}
      </span>
      <span className="text-sm text-text">{t(`run.hint.${hint}`)}</span>
    </div>
  );
}
