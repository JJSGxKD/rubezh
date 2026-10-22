import type { ReactNode } from "react";
import type { StatusElement } from "@bh/shared-types";
import { ELEMENT_TONE, STATUS_TONE_COLORS, type PlayerStatusSnapshot } from "@bh/core-game";
import { t } from "../../i18n";
import { ELEMENT_GLYPHS, GameGlyph } from "../game-glyphs";
import "../../i18n/run";

/**
 * Состояния на игроке под полосами здоровья и опыта (docs/35-stage4-plan.md,
 * WP6): без них непонятно, почему здоровье тает без попаданий и почему
 * персонаж бежит медленнее. Значок — формой и цветом стихии: тем же цветом
 * мерцает персонаж на канве, той же формой стоит знак над спрайтом, и форма
 * не даёт спутать огонь с ядом тому, кто плохо различает цвета.
 */

export function toneColor(element: StatusElement): string {
  const color = STATUS_TONE_COLORS[ELEMENT_TONE[element]] ?? 0xffffff;
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function PlayerStatuses(props: { statuses: readonly PlayerStatusSnapshot[] }): ReactNode {
  if (props.statuses.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label={t("run.status.title")}>
      {props.statuses.map((status) => {
        return (
          <li
            key={status.element}
            className="flex items-center gap-0.5 rounded-pill bg-bg/70 px-1.5 py-0.5 font-display text-xs font-bold tabular-nums text-text"
            aria-label={t(`run.status.${status.element}`, { stacks: status.stacks })}
          >
            <span className="inline-flex" style={{ color: toneColor(status.element) }}>
              <GameGlyph glyph={ELEMENT_GLYPHS[status.element]} size={12} />
            </span>
            {/* Слои яда важнее секунд: от них зависит, сколько он снимает. */}
            {status.element === "poison" && status.stacks > 1 ? `×${String(status.stacks)}` : Math.ceil(status.sec)}
          </li>
        );
      })}
    </ul>
  );
}
