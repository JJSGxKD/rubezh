import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import "../../i18n/run-card";
import "../../i18n/season";
import { openRunCard } from "../../state/navigation";
import { styleAxis } from "./rating-rules";

/**
 * Входы в карточку забега из чужих экранов (tasks/T-0297): строка «Очки
 * {points} · {style}» на экране итогов и кнопка «Карточка забега» в листе
 * забега. Лежат отдельным файлом без самой карточки: окно итогов — свой чанк,
 * и тащить в него «паутину» и сборку ни к чему — карточку открывает навигация,
 * она грузится ленивым экраном.
 */

/** «Очки 2 140 · Тень»: тап открывает карточку своего забега. Незнакомый стиль (сервер новее клиента) — только очки. */
export function RunScoreLink(props: { runId: string; points: number; style: string }): ReactNode {
  const axis = styleAxis(props.style);
  const points = formatNumber(props.points);
  const label = axis === null ? t("runCard.scoreOnly", { points }) : t("runCard.scoreStyle", { points, style: t(`rating.style.${axis}`) });

  return (
    <button
      type="button"
      onClick={() => openRunCard(props.runId, "results")}
      className="surface-sunken hit-tall flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left transition-transform active:scale-[0.98]"
    >
      <span className="font-display text-sm font-bold text-text">{label}</span>
      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
    </button>
  );
}

/**
 * Ключ лучшего забега строки рейтинга. Сервер до карточки поля не отдавал, а тип
 * строки общий с досками других экранов, поэтому поле читается сужением, а не
 * приведением: нет ключа — строка не нажимается.
 */
export function entryRunId(entry: object): string | null {
  const value: unknown = "runId" in entry ? entry.runId : null;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Нажатие на строку или ступень пьедестала. Кнопка лежит поверх своей строки
 * (родитель — `relative`): разметка строки не меняется, а касание по всей
 * ширине открывает карточку. Метки внутри строки не нажимаются сами.
 */
export function RowOpener(props: { runId: string; name: string }): ReactNode {
  return (
    <button
      type="button"
      aria-label={t("runCard.open", { name: props.name })}
      onClick={() => openRunCard(props.runId, "rating")}
      className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-accent active:bg-text/5"
    />
  );
}

/** Кнопка в листе забега из истории: открывает карточку этого забега. */
export function RunCardButton(props: { runId: string; onBeforeOpen?: () => void }): ReactNode {
  return (
    <Button
      track="run_card"
      variant="secondary"
      block
      onClick={() => {
        props.onBeforeOpen?.();
        openRunCard(props.runId, "history");
      }}
    >
      {t("runCard.history")}
    </Button>
  );
}
