import type { ReactNode } from "react";
import { Heart, Pause, Wrench } from "lucide-react";
import type { HudSnapshot } from "@bh/core-game";
import { IconButton, ProgressBar } from "../../design-system/components";
import { formatDuration, t } from "../../i18n";
import "../../i18n/run";
import { ItemIcon } from "../item-icons";
import { BossBar } from "./BossBar";
import { HintBanner } from "./HintBanner";
import { Radar } from "./Radar";

/**
 * HUD забега. Единственная часть оболочки, которая живёт во время забега, —
 * и обновляется не чаще 10 раз в секунду: снимок приходит с этой частотой от
 * движка (docs/27-design-system-and-app-shell.md §3.3, правило 1).
 *
 * Слой не ловит касания: под ним канва с джойстиком, и палец должен попадать
 * в неё, а не в прозрачный прямоугольник HUD. Исключение — кнопка паузы.
 *
 * Оформление статичное: подложки без размытия и без анимаций поверх живой
 * канвы (§3.3, правила 2 и 4). Единственная анимация — пульс низкого здоровья,
 * и она на прозрачности.
 */
export interface RunHudProps {
  hud: HudSnapshot;
  onPause(): void;
  /** только у забега разработчика */
  onDev?: () => void;
}

/** Ниже этой доли здоровья полоса меняет цвет и начинает пульсировать. */
const LOW_HP_RATIO = 0.3;

export function RunHud(props: RunHudProps): ReactNode {
  const { hud } = props;
  const low = hud.maxHp > 0 && hud.hp / hud.maxHp <= LOW_HP_RATIO;

  return (
    <div
      className="pointer-events-none absolute inset-0 flex animate-fade-in flex-col"
      style={{ zIndex: "var(--z-hud)" }}
    >
      <div className="flex items-start gap-3 pt-[calc(0.5rem+var(--app-inset-top))] pr-[calc(1rem+var(--app-inset-right))] pl-[calc(1rem+var(--app-inset-left))]">
        {/* Полосы не растягиваются на всю ширину широкого окна: игра
            рассчитана на телефон, и HP во весь монитор читается хуже, а не
            лучше (docs/27-design-system-and-app-shell.md §5.3). */}
        <div className="flex min-w-0 max-w-[240px] flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            {/* Низкое здоровье передаётся не только цветом: сердце пульсирует
                (§4.4). */}
            <Heart
              size={18}
              aria-hidden="true"
              fill="currentColor"
              className={low ? "shrink-0 animate-pulse-soft text-hp-low" : "shrink-0 text-hp"}
            />
            <ProgressBar
              value={hud.hp}
              max={hud.maxHp}
              tone={low ? "hp-low" : "hp"}
              height="thick"
              label="HP"
            />
            {/* Число рядом с полосой: полоса говорит «сколько примерно», а
                решение «добежать до аптечки или нет» принимается по числу. */}
            <span
              className={[
                "shrink-0 font-display text-xs font-bold tabular-nums",
                low ? "text-hp-low" : "text-text",
              ].join(" ")}
            >
              {Math.ceil(hud.hp)}
              <span className="text-text-muted">/{Math.ceil(hud.maxHp)}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded-sm bg-xp/15 px-1.5 font-display text-xs font-bold tabular-nums text-xp">
              {t("run.level", { level: hud.level })}
            </span>
            <ProgressBar value={hud.xp} max={hud.xpToNext} tone="xp" height="thin" label="XP" />
          </div>
        </div>

        <span className="rounded-pill bg-bg/70 px-3 py-0.5 font-display text-xl font-bold tabular-nums text-text">
          {formatDuration(hud.survivalSec)}
        </span>

        {/* Режим разработчика — отдельной кнопкой рядом с паузой: лист
            открывается сразу, без лишнего шага через экран паузы. */}
        {props.onDev === undefined ? null : (
          <div className="pointer-events-auto rounded-full bg-bg/70">
            <IconButton label={t("dev.title")} onClick={props.onDev}>
              <Wrench size={20} />
            </IconButton>
          </div>
        )}
        <div className="pointer-events-auto rounded-full bg-bg/70">
          <IconButton label={t("run.pause")} onClick={props.onPause}>
            <Pause size={20} fill="currentColor" />
          </IconButton>
        </div>
      </div>

      {/* Полоса босса — под верхними полосами и по центру: она появляется
          редко и обязана быть замеченной, но не закрывать здоровье. */}
      {hud.boss === null ? null : <BossBar boss={hud.boss} />}

      <div className="mt-auto px-4 pb-3">
        <HintBanner hud={hud} />
      </div>

      <div className="flex items-end gap-3 pr-[calc(1rem+var(--app-inset-right))] pb-[calc(0.75rem+var(--app-inset-bottom))] pl-[calc(1rem+var(--app-inset-left))]">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {hud.weapons.map((slot) => (
            <Slot key={`w-${slot.id}`} id={slot.id} level={slot.level} kind="weapon" />
          ))}
          {hud.passives.map((slot) => (
            <Slot key={`p-${slot.id}`} id={slot.id} level={slot.level} kind="passive" />
          ))}
        </div>
        {/* Радар в нижнем правом углу: там его не закрывает палец, ведущий
            джойстик, и он не спорит с таймером за верх экрана. */}
        <Radar radar={hud.radar} />
      </div>
    </div>
  );
}

/** Слот набора: значок предмета и уровень — оружие отличается от пассивки цветом и рамкой. */
function Slot(props: { id: string; level: number; kind: "weapon" | "passive" }): ReactNode {
  const name = t(`${props.kind}.${props.id}.name`);

  return (
    <span
      title={`${name} · ${props.level}`}
      className={[
        "inline-flex items-center gap-1 rounded-sm border bg-bg/70 px-1.5 py-0.5",
        "font-display text-xs font-bold tabular-nums",
        props.kind === "weapon" ? "border-weapon/40 text-weapon" : "border-passive/40 text-passive",
      ].join(" ")}
    >
      <ItemIcon kind={props.kind} id={props.id} size={14} />
      <span className="text-text">{props.level}</span>
    </span>
  );
}
