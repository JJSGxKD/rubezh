import type { ReactNode } from "react";
import { Ban, RefreshCw, SkipForward, type LucideIcon } from "lucide-react";
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
      {/* В режиме изгнания подсказка с «Отменой» занимает место ряда, а не добавляется
          к нему: на невысоком экране лишняя строка уводила окно в прокрутку. */}
      {props.banishing ? (
        <div className="flex min-h-11 items-center justify-between gap-3">
          <p
            className="min-w-0 text-sm font-semibold text-warning"
            role="status"
          >
            {t("run.tools.banish.hint")}
          </p>
          <button
            type="button"
            onClick={() => {
              uiFeedback("back");
              props.onToggleBanish();
            }}
            className="btn-secondary inline-flex min-h-11 shrink-0 items-center rounded-md px-3 font-display text-sm font-semibold active:translate-y-0.5"
          >
            {t("run.tools.banish.cancel")}
          </button>
        </div>
      ) : (
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
                  "inline-flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1.5 py-1 font-display font-semibold landscape:flex-row landscape:gap-2",
                  "transition-transform duration-(--duration-fast) ease-base",
                  "active:translate-y-0.5 active:scale-[0.98] disabled:opacity-45 disabled:active:translate-y-0 disabled:active:scale-100",
                  active ? "btn-primary" : "btn-secondary",
                ].join(" ")}
              >
                {/* Портрет: значок и счётчик над подписью — три подписи в ряд на 320 px
                  не помещаются; ландшафт: всё в одну строку. */}
                <span className="inline-flex items-center gap-1">
                  <Icon size={18} aria-hidden="true" className="shrink-0" />
                  <span className="tabular-nums" aria-hidden="true">
                    ×{button.left}
                  </span>
                </span>
                <span className="max-w-full text-xs leading-tight landscape:text-sm">
                  {t(`run.tools.${button.id}`)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
