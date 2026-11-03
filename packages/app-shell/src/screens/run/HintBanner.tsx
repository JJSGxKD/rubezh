import { useEffect, useState, type ReactNode } from "react";
import { Footprints, Gem, Shield, ShieldCheck } from "lucide-react";
import { RADAR_BLIP, type HudSnapshot, type RadarSnapshot } from "@bh/core-game";
import { t } from "../../i18n";
import "../../i18n/run";
import { hintsSeenFor, isHintDone, nextHint, useHints, type HintId, type HintSignals } from "../../state/hints";
import { hintSignalsOf, usePrologue } from "../../state/prologue";
import { useRun } from "../../state/run";

/**
 * Плашка подсказки первого забега поверх мира. Не ловит касания — под ней
 * джойстик. Появляется подъёмом один раз и дальше стоит неподвижно: над живой
 * канвой бесконечных анимаций нет (docs/27-design-system-and-app-shell.md §3.3).
 *
 * Подсказки идут по одной и по событию (T-0280): про движение — на старте, про
 * кристаллы — с первым кристаллом на поле, про элиту — с первой элитой. Про
 * выбор улучшения говорит само окно выбора (`overlays.tsx`). В прологе
 * считается только то, что показано в этом забеге: виденное на устройстве не в счёт.
 */
const ICONS: Record<HintId | "ward", ReactNode> = {
  move: <Footprints size={20} aria-hidden="true" />,
  gems: <Gem size={20} aria-hidden="true" />,
  choose: <Gem size={20} aria-hidden="true" />,
  dodge: <Shield size={20} aria-hidden="true" />,
  ward: <ShieldCheck size={20} aria-hidden="true" />,
};

/** Сколько секунд забега висит подсказка про оберег. */
const WARD_SHOW_SEC = 5;

export function HintBanner(props: { hud: HudSnapshot }): ReactNode {
  const prologue = useRun((state) => state.mode === "prologue");
  const device = useHints((state) => state.seen);
  const run = usePrologue((state) => state.run);
  const seen = hintsSeenFor({ prologue, device, session: run.hintsDone });
  const signals: HintSignals = prologue ? hintSignalsOf(run.steps) : signalsFromHud(props.hud);
  // Оберег только что спас — об этом и говорим, раньше очереди подсказок.
  const ward = prologue && run.ward === "showing" && props.hud.survivalSec - run.wardSinceSec < WARD_SHOW_SEC;
  const next = nextHint({ seen, signals });
  // «Выбери улучшение» живёт в окне выбора, на плашке его нет.
  const hint: HintId | "ward" | null = ward ? "ward" : next === "choose" ? null : next;
  // С какой секунды забега висит текущая подсказка: у совета без действия
  // считается, сколько он провисел.
  const [since, setSince] = useState<{ id: HintId | "ward" | null; sec: number }>(() => ({
    id: hint,
    sec: props.hud.survivalSec,
  }));

  const shownSinceSec = since.id === hint ? since.sec : props.hud.survivalSec;
  // Игрок мог сделать дело раньше, чем до подсказки дошла очередь: собрал
  // кристалл, ещё не сдвинувшись. Такая гаснет, не мелькнув.
  const doneHint: HintId | null = hint !== null && hint !== "ward" && isHintDone(hint, props.hud, shownSinceSec) ? hint : null;
  const done = doneHint !== null;
  const wardOver = prologue && run.ward === "showing" && !ward;

  useEffect(() => {
    if (wardOver) usePrologue.getState().wardDone();
    if (hint === null) return;
    if (since.id !== hint) setSince({ id: hint, sec: shownSinceSec });
    if (doneHint !== null) {
      useHints.getState().markSeen(doneHint);
      usePrologue.getState().hintDone(doneHint);
    }
  }, [hint, doneHint, wardOver, since.id, shownSinceSec]);

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
      <span className="text-sm text-text">{t(hintTextKey(hint, prologue))}</span>
    </div>
  );
}

/** Ключ текста: про элиту в прологе — свой, про золотую кайму; остальное общее. */
function hintTextKey(hint: HintId | "ward", prologue: boolean): string {
  if (hint === "dodge" && prologue) return "run.hint.dodge.prologue";
  return `run.hint.${hint}`;
}

/** Вне пролога событий пролога нет: кристалл — после первого убитого, элита — по радару. */
function signalsFromHud(hud: HudSnapshot): HintSignals {
  return { gem: hud.enemiesKilled > 0, levelUp: false, elite: hasElite(hud.radar) };
}

function hasElite(radar: RadarSnapshot): boolean {
  for (let i = 0; i < radar.count; i++) {
    if (radar.blips[i * 3 + 2] === RADAR_BLIP.elite) return true;
  }
  return false;
}

/** Время показа строки в начале пролога, секунды забега. */
const INTRO_SEC = 3;

/**
 * «Навь идёт к рубежу. Держи его» — строка поверх поля на первые секунды
 * пролога вместо листа «Перед забегом». Не ловит касания и гаснет сама.
 */
export function PrologueIntro(props: { survivalSec: number }): ReactNode {
  if (props.survivalSec >= INTRO_SEC) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-x-0 animate-rise-in px-6 py-3 text-center font-display text-2xl leading-tight text-text [text-shadow:0_3px_10px_rgb(0_0_0/0.8)]"
      style={{
        zIndex: "var(--z-hud)",
        top: "calc(30% + var(--app-inset-top))",
        background: "linear-gradient(90deg, transparent, color-mix(in oklab, var(--color-bg) 82%, transparent) 18%, color-mix(in oklab, var(--color-bg) 82%, transparent) 82%, transparent)",
      }}
    >
      {t("run.prologue.intro")}
    </div>
  );
}
