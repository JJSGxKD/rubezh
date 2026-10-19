import type { ReactNode } from "react";
import { Ban, RefreshCw, SkipForward, type LucideIcon } from "lucide-react";
import { Button } from "../../design-system/components";
import { t } from "../../i18n";
import { uiFeedback } from "../../state/ui-feedback";
import "../../i18n/run";
import type { ToolButton, ToolId } from "./card-tools-rules";

/**
 * Ряд действий под карточками выбора улучшения (tasks/T-0101): переброс,
 * пропуск, изгнание. В режиме изгнания над рядом — подсказка и «Отмена».
 * Кнопка не меняет размера, когда отключается: счётчик в том же месте.
 */

const ICONS: Readonly<Record<ToolId, LucideIcon>> = {
  reroll: RefreshCw,
  skip: SkipForward,
  banish: Ban,
};

export interface CardToolsBarProps {
  buttons: readonly ToolButton[];
  /** режим изгнания включён: тап по карточке убирает предмет */
  banishing: boolean;
  onReroll(): void;
  onSkip(): void;
  /** включить или выключить режим изгнания */
  onToggleBanish(): void;
}

export function CardToolsBar(props: CardToolsBarProps): ReactNode {
  if (props.buttons.length === 0) return null;
  const actions: Readonly<Record<ToolId, () => void>> = {
    reroll: props.onReroll,
    skip: props.onSkip,
    banish: props.onToggleBanish,
  };

  return (
    <div className="mt-3 short:mt-2">
      {props.banishing ? (
        <div className="mb-2 flex items-center justify-between gap-2 short:mb-1">
          <p className="min-w-0 text-sm text-warning" role="status">
            {t("run.tools.banish.hint")}
          </p>
          <Button size="s" variant="ghost" onClick={props.onToggleBanish}>
            {t("run.tools.banish.cancel")}
          </Button>
        </div>
      ) : null}
      <div className="flex items-stretch justify-center gap-2">
        {props.buttons.map((button) => {
          const Icon = ICONS[button.id];
          const active = button.id === "banish" && props.banishing;
          return (
            // Своя кнопка, а не `Button`: нужны `aria-pressed` и ровная
            // ширина трёх кнопок в ряд, а общая кнопка ни того ни другого не даёт.
            <button
              key={button.id}
              type="button"
              disabled={button.disabled}
              aria-pressed={button.id === "banish" ? active : undefined}
              aria-label={`${t(`run.tools.${button.id}`)}. ${t("run.tools.left", { count: button.left })}`}
              onClick={() => {
                uiFeedback("tap");
                actions[button.id]();
              }}
              className={[
                "inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 font-display text-sm font-semibold",
                "transition-transform duration-(--duration-fast) ease-base",
                "active:translate-y-0.5 active:scale-[0.98] disabled:opacity-45 disabled:active:translate-y-0 disabled:active:scale-100",
                active ? "btn-primary" : "btn-secondary",
              ].join(" ")}
            >
              <Icon size={18} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 truncate">{t(`run.tools.${button.id}`)}</span>
              <span className="tabular-nums" aria-hidden="true">
                {button.left}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
