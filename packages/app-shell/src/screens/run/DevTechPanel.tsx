import type { ReactNode } from "react";
import type { RunDevInfo } from "@bh/core-game";
import { formatDecimal, formatNumber, t } from "../../i18n";
import "../../i18n/run";
import "../../i18n/team";

/**
 * Техническая сводка поверх забега. Разработчику — полная, тестировщику с
 * оверлеем FPS — одна строка: частота кадров и шаги симуляции за кадр.
 *
 * Слой не ловит касания и не анимируется: он лежит над живой канвой, и
 * обновление четыре раза в секунду — всё, что он себе позволяет
 * (docs/27-design-system-and-app-shell.md §3.3).
 */
export function DevTechPanel(props: { info: RunDevInfo; compact: boolean }): ReactNode {
  const { info } = props;
  const slow = info.fps < 50;

  if (props.compact) {
    return (
      <Layer>
        <span className={["rounded-pill bg-bg/75 px-2.5 py-0.5 font-display text-xs font-bold tabular-nums", slow ? "text-warning" : "text-text"].join(" ")}>
          {t("dev.tech.fps", { fps: Math.round(info.fps) })}
        </span>
      </Layer>
    );
  }

  const rows: readonly (readonly [string, string])[] = [
    [t("dev.tech.frame"), t("dev.tech.frameValue", { frame: formatDecimal(info.frameMs, 1), step: formatDecimal(info.simMs, 2) })],
    [t("dev.tech.steps"), formatDecimal(info.stepsPerFrame, 2)],
    [t("dev.tech.enemies"), `${formatNumber(info.enemies)} / ${formatNumber(info.maxAlive)}`],
    [t("dev.tech.projectiles"), formatNumber(info.projectiles)],
    [t("dev.tech.loot"), `${formatNumber(info.gems)} · ${formatNumber(info.pickups)}`],
    [t("dev.tech.segment"), t("dev.tech.segmentValue", { segment: info.segment, hp: formatDecimal(info.hpMul, 2), damage: formatDecimal(info.damageMul, 2) })],
    [t("dev.tech.tick"), `${formatNumber(info.tick)} · ${formatDecimal(info.elapsedSec, 1)} ${t("dev.tech.sec")}`],
    [t("dev.tech.position"), `${Math.round(info.playerX)}, ${Math.round(info.playerY)} · ×${formatDecimal(info.zoom, 2)}`],
    [t("dev.tech.seed"), String(info.seed)],
  ];

  return (
    <Layer>
      <div className="w-[232px] rounded-md bg-bg/80 px-2.5 py-2 text-xs leading-tight">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className={["font-display text-base font-bold tabular-nums", slow ? "text-warning" : "text-text"].join(" ")}>
            {t("dev.tech.fps", { fps: Math.round(info.fps) })}
          </span>
          <span className="font-display font-semibold tabular-nums text-text-muted">
            {info.timeScale === 1 ? "" : `×${info.timeScale} `}
            {info.cheats ? <span className="text-warning">{t("dev.tech.cheats")}</span> : null}
          </span>
        </div>
        <dl className="grid gap-0.5">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2">
              <dt className="shrink-0 text-text-muted">{label}</dt>
              <dd className="truncate text-right font-display tabular-nums text-text">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Layer>
  );
}

/** Под верхней строкой HUD справа: слева полосы здоровья и опыта, их закрывать нельзя. */
function Layer(props: { children: ReactNode }): ReactNode {
  return (
    <div
      className="pointer-events-none absolute top-[calc(3.75rem+var(--app-inset-top))] right-[calc(1rem+var(--app-inset-right))] flex flex-col items-end"
      style={{ zIndex: "var(--z-hud)" }}
    >
      {props.children}
    </div>
  );
}
