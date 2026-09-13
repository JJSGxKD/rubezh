import type { ReactNode } from "react";
import { Pause } from "lucide-react";
import type { HudSnapshot } from "@bh/core-game";
import { IconButton, ProgressBar } from "../../design-system/components";
import { formatDuration, t } from "../../i18n";

/**
 * HUD забега. Единственная часть оболочки, которая живёт во время забега, —
 * и обновляется не чаще 10 раз в секунду: снимок приходит с этой частотой от
 * движка (docs/27-design-system-and-app-shell.md §3.3, правило 1).
 *
 * Слой не ловит касания: под ним канва с джойстиком, и палец должен попадать
 * в неё, а не в прозрачный прямоугольник HUD. Исключение — кнопка паузы.
 */
export interface RunHudProps {
  hud: HudSnapshot;
  onPause(): void;
}

/** Ниже этой доли здоровья полоса меняет цвет и начинает пульсировать. */
const LOW_HP_RATIO = 0.3;

export function RunHud(props: RunHudProps): ReactNode {
  const { hud } = props;
  const low = hud.maxHp > 0 && hud.hp / hud.maxHp <= LOW_HP_RATIO;

  return (
    <div
      className="pointer-events-none absolute inset-0 flex flex-col"
      style={{ zIndex: "var(--z-hud)" }}
    >
      <div className="flex items-start gap-3 px-4 pt-[calc(0.5rem+var(--app-inset-top))]">
        {/* Полосы не растягиваются на всю ширину широкого окна: игра
            рассчитана на телефон, и HP во весь монитор читается хуже, а не
            лучше (docs/27-design-system-and-app-shell.md §5.3). */}
        <div className="flex min-w-0 max-w-[240px] flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <ProgressBar
              value={hud.hp}
              max={hud.maxHp}
              tone={low ? "hp-low" : "hp"}
              label="HP"
            />
            {/* Низкое здоровье передаётся не только цветом: часть игроков
                различает оттенки хуже (§4.4). */}
            {low ? (
              <span className="animate-pulse font-display text-xs text-hp-low">!</span>
            ) : null}
          </div>
          <span className="font-display text-xs tabular-nums text-text-muted">
            {t("run.level", { level: hud.level })}
          </span>
          <ProgressBar value={hud.xp} max={hud.xpToNext} tone="xp" height="thin" label="XP" />
        </div>

        <span className="font-display text-xl tabular-nums text-text">
          {formatDuration(hud.survivalSec)}
        </span>

        <div className="pointer-events-auto">
          <IconButton label={t("run.pause")} onClick={props.onPause}>
            <Pause size={20} />
          </IconButton>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap gap-1 px-4 pb-[calc(0.75rem+var(--app-inset-bottom))]">
        {hud.weapons.map((slot) => (
          <Slot key={`w-${slot.id}`} id={slot.id} level={slot.level} tone="weapon" />
        ))}
        {hud.passives.map((slot) => (
          <Slot key={`p-${slot.id}`} id={slot.id} level={slot.level} tone="passive" />
        ))}
      </div>
    </div>
  );
}

/**
 * Слот набора. Пока нет иконок, показывается короткое имя: пустой квадрат
 * игроку ничего не говорит, а сокращение хотя бы отличает оружие от оружия.
 */
function Slot(props: { id: string; level: number; tone: "weapon" | "passive" }): ReactNode {
  const name = t(`${props.tone === "weapon" ? "weapon" : "passive"}.${props.id}.name`);
  const short = name.slice(0, 3);

  return (
    <span
      title={`${name} · ${props.level}`}
      className={[
        "inline-flex items-center gap-1 rounded-sm bg-bg/70 px-1.5 py-0.5 text-xs tabular-nums",
        props.tone === "weapon" ? "text-weapon" : "text-passive",
      ].join(" ")}
    >
      {short}
      <span className="text-text-muted">{props.level}</span>
    </span>
  );
}
