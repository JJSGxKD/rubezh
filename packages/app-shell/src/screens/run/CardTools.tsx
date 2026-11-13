import type { ReactNode } from "react";
import { Ban, RefreshCw, SkipForward, Tv, type LucideIcon } from "lucide-react";
import { t } from "../../i18n";
import type { AdRerollNotice } from "../../state/ad-reroll";
import { uiFeedback } from "../../state/ui-feedback";
import "../../i18n/run";
import type { AdRerollButtonState, ToolButton, ToolId } from "./card-tools-rules";

/**
 * Ряд действий под карточками выбора улучшения (tasks/T-0101): переброс,
 * пропуск, изгнание. В режиме изгнания над рядом — подсказка и «Отмена».
 * Кнопка не меняет размера, когда отключается: счётчик в том же месте.
 *
 * Кнопка «Перебросить за рекламу» (tasks/T-0199) — под рядом; серая «Переброс ×0»
 * остаётся, чтобы ряд не прыгал. На невысоком экране кнопка встаёт в ряд вместо
 * серой «Переброс», подпись становится короткой, а «Один раз за забег» уходит:
 * окно не должно уходить в прокрутку.
 */

const ICONS: Readonly<Record<ToolId, LucideIcon>> = {
  reroll: RefreshCw,
  skip: SkipForward,
  banish: Ban,
};

/** Переброс за рекламу: состояние кнопки по правилам, заметка о прошлой попытке и нажатие. */
export interface AdRerollRowProps {
  state: AdRerollButtonState;
  notice: AdRerollNotice | null;
  onWatch(): void;
}

export interface CardToolsBarProps {
  buttons: readonly ToolButton[];
  /** режим изгнания включён: тап по карточке убирает предмет */
  banishing: boolean;
  onReroll(): void;
  onSkip(): void;
  /** включить или выключить режим изгнания */
  onToggleBanish(): void;
  /** переброс за рекламу; нет поля — кнопки нет и экран прежний */
  adReroll?: AdRerollRowProps;
}

export function CardToolsBar(props: CardToolsBarProps): ReactNode {
  const ad = props.adReroll;
  const adShown = ad !== undefined && ad.state.kind !== "hidden";
  const notice = ad?.notice ?? null;
  if (props.buttons.length === 0 && !adShown && notice === null) return null;
  const actions: Readonly<Record<ToolId, () => void>> = {
    reroll: props.onReroll,
    skip: props.onSkip,
    banish: props.onToggleBanish,
  };
  const hasRow = props.buttons.length > 0;

  return (
    <div className={notice === null ? "mt-3 short:mt-2" : "mt-3 short:mt-1"}>
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
        <>
          {hasRow ? (
            <div className="flex items-stretch justify-center gap-2">
              {/* На невысоком экране кнопка за рекламу стоит первой — там, где была «Переброс». */}
              {adShown ? <AdRerollButton state={ad.state} onWatch={ad.onWatch} layout="row" className="hidden min-w-0 flex-1 short:inline-flex" /> : null}
              {props.buttons.map((button) => {
                const Icon = ICONS[button.id];
                const active = button.id === "banish" && props.banishing;
                // На невысоком экране вместо серой «Переброс» в ряд встаёт кнопка за рекламу.
                const replaced = button.id === "reroll" && adShown;
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
                      replaced ? "short:hidden" : "",
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
          ) : null}
          {adShown ? (
            <>
              <AdRerollButton
                state={ad.state}
                onWatch={ad.onWatch}
                layout="wide"
                className={hasRow ? "mt-2 inline-flex w-full short:hidden" : "inline-flex w-full"}
              />
              <p className="mt-1 text-center text-xs text-text-muted short:hidden">{t("run.tools.rerollAd.once")}</p>
            </>
          ) : null}
          {/* Строка о прошлой попытке: «ролик закрыт», «не загрузилась», «ролик засчитан, сервер не ответил».
              На невысоком экране она мельче и теснее, а отступ ряда сверху меньше на ту же строку: у окна
              на 360 px высоты запаса около 13 px, и заметка не должна уводить его в прокрутку. */}
          {notice === null ? null : (
            <p role="status" className="mt-1 text-center text-sm font-semibold text-warning short:mt-0 short:text-xs short:leading-3.5">
              {t(`run.tools.rerollAd.notice.${notice}`)}
            </p>
          )}
        </>
      )}
    </div>
  );
}

interface AdRerollButtonProps {
  state: AdRerollButtonState;
  onWatch(): void;
  /**
   * `row` — в ряду действий, вместо серой «Переброс»: той же формы, что соседи (значок над
   * подписью, в ландшафте в строку) и с короткой подписью; `wide` — отдельная кнопка на
   * всю ширину под рядом или под карточками, с полной подписью.
   */
  layout: "row" | "wide";
  className: string;
}

/** Кнопка переброса за рекламу. Пока идёт ролик — отключена и `aria-busy`. */
function AdRerollButton(props: AdRerollButtonProps): ReactNode {
  if (props.state.kind === "hidden") return null;
  const busy = props.state.kind === "busy";
  const pass = props.state.kind === "ready" && props.state.pass;
  const label = t(pass ? "run.tools.rerollAd.pass" : "run.tools.rerollAd");
  const shortLabel = t(pass ? "run.tools.rerollAd.pass.short" : "run.tools.rerollAd.short");
  const inRow = props.layout === "row";

  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy}
      aria-label={`${label} — ${t("run.tools.rerollAd.once").toLowerCase()}`}
      onClick={() => {
        uiFeedback("tap");
        props.onWatch();
      }}
      className={[
        "btn-secondary min-h-11 items-center justify-center rounded-md font-display font-semibold",
        inRow ? "flex-col gap-0.5 px-1 py-1 landscape:flex-row landscape:gap-2 landscape:px-3" : "gap-2 px-3 py-1 text-sm",
        "transition-transform duration-(--duration-fast) ease-base",
        "active:translate-y-0.5 active:scale-[0.98] disabled:opacity-45 disabled:active:translate-y-0 disabled:active:scale-100",
        props.className,
      ].join(" ")}
    >
      <Tv size={18} aria-hidden="true" className="shrink-0" />
      <span className={inRow ? "max-w-full text-xs leading-tight landscape:text-sm" : "min-w-0 leading-tight"} aria-hidden="true">
        {inRow ? shortLabel : label}
      </span>
    </button>
  );
}
