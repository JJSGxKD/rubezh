import { memo, useEffect, useState, type ReactNode } from "react";
import { Check, Lightbulb } from "lucide-react";
import { Emblem, ProgressBar } from "../../design-system/components";
import { DURATION } from "../../design-system/tokens";
import { t } from "../../i18n";
import type { RunLoadingStage } from "../../state/run";
import { ItemTile } from "../item-icons";

/**
 * Экран загрузки забега: от «В бой» до первого кадра.
 *
 * Этапы честные — чанк движка, затем мир до первого снимка HUD, — а не
 * полоса, которая ползёт сама по себе. Когда чанк предзагружен из лобби, первый
 * этап проходит мгновенно, и экран только проявляется и гаснет.
 *
 * Уходит проявлением, а не пропадает: иначе первый кадр мира появлялся бы
 * рывком поверх заставки.
 */

/** Сколько подсказок в словаре: `run.tip.1` … `run.tip.N`. */
const TIP_COUNT = 5;

const STAGES = ["engine", "world", "fight"] as const;
type ShownStage = (typeof STAGES)[number];

export interface RunLoadingProps {
  stage: RunLoadingStage | null;
  weaponId: string;
}

export const RunLoading = memo(function RunLoading(props: RunLoadingProps): ReactNode {
  const active = props.stage !== null;
  const [mounted, setMounted] = useState(active);
  // Подсказка выбирается один раз на показ, а не на каждый снимок HUD.
  const [tip] = useState(() => 1 + Math.floor(Math.random() * TIP_COUNT));

  useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), DURATION.slow);
    return () => clearTimeout(timer);
  }, [active]);

  if (!mounted) return null;

  const shown: ShownStage = props.stage ?? "fight";
  const done = STAGES.indexOf(shown);

  return (
    <div
      aria-live="polite"
      className={[
        "bg-app absolute inset-0 flex items-center justify-center px-6",
        "pt-[var(--app-inset-top)] pb-[var(--app-inset-bottom)]",
        "transition-opacity duration-(--duration-slow) ease-base",
        active ? "opacity-100" : "pointer-events-none opacity-0",
      ].join(" ")}
      style={{ zIndex: "var(--z-overlay)" }}
    >
      <div className="flex w-full max-w-[360px] flex-col items-center gap-4 text-center">
        <Emblem size={80} animated />
        <h2 className="font-display text-2xl font-bold text-text">{t("run.loading.title")}</h2>

        <div className="flex items-center gap-2 text-sm text-text-muted">
          <ItemTile kind="weapon" id={props.weaponId} />
          <span>{t("run.loading.weapon", { weapon: t(`weapon.${props.weaponId}.name`) })}</span>
        </div>

        <div className="w-full">
          <ProgressBar
            value={done + 1}
            max={STAGES.length}
            tone="accent"
            shimmer={active}
            label={t("run.loading.title")}
          />
          <ol className="mt-3 flex justify-between gap-2">
            {STAGES.map((stage, index) => (
              <StageMark key={stage} label={t(`run.loading.stage.${stage}`)} state={stateOf(index, done)} />
            ))}
          </ol>
        </div>

        <p className="surface-card flex items-start gap-2 rounded-lg p-3 text-left text-xs text-text-muted">
          <Lightbulb size={16} className="mt-px shrink-0 text-accent" aria-hidden="true" />
          {t(`run.tip.${tip}`)}
        </p>
      </div>
    </div>
  );
});

type StageState = "done" | "active" | "pending";

function stateOf(index: number, current: number): StageState {
  if (index < current) return "done";
  return index === current ? "active" : "pending";
}

/** Отметка этапа: галочка у пройденного, пульс у текущего — не только цветом (§4.4). */
function StageMark(props: { label: string; state: StageState }): ReactNode {
  return (
    <li
      className={[
        "flex items-center gap-1.5 font-display text-xs font-semibold",
        props.state === "pending" ? "text-text-disabled" : "text-text",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "inline-flex size-4 items-center justify-center rounded-full",
          props.state === "done" ? "bg-accent text-on-accent" : "",
          props.state === "active" ? "animate-pulse-soft bg-accent/30" : "",
          props.state === "pending" ? "bg-surface-raised" : "",
        ].join(" ")}
      >
        {props.state === "done" ? <Check size={11} strokeWidth={3} /> : null}
      </span>
      {props.label}
    </li>
  );
}
