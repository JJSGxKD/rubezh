import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, ExternalLink, Heart, Info } from "lucide-react";
import { Button, Modal } from "../../design-system/components";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/donate";
import { createDonationsApi, markSupporter, openTribute, purchasePoller, type DonatePlace, type DonationStars, type DonationView } from "../../state/donations-api";
import { buy, type BuyOutcome } from "../../state/shop-purchase";
import { useShell } from "../../state/shell";
import { useWide } from "../../state/wide";
import { defaultAmount, parseAmount, visibleWays, type VisibleWays } from "./donate-rules";
import { SupporterBadge } from "./supporter-badge";

/**
 * Лист доната (docs/35-stage4-plan.md, Р109, T-0158; макет
 * design/art/mockups/donate-v2.html): готовые суммы, своя сумма целым числом
 * в пределах сервера, «Поддержать на N ⭐», окно оплаты площадки и «Спасибо!»
 * в этом же листе. Оплата — готовая `buy()` магазина: счёт на сервере, окно
 * оплаты, ожидание подтверждения; **знак выдаёт сервер**, а не окно оплаты.
 *
 * Лист закрыли посреди оплаты — окно площадки не трогаем, а ожидание
 * подтверждения идёт дальше: подтвердилось — знак встанет в сессию сам.
 */

const api = createDonationsApi();

/** Выбрана готовая сумма или «Своя». */
export type DonateChoice = number | "custom";

export interface DonateNotice {
  /** `error` — плашка опасности, `info` — долгое подтверждение, повторять не нужно */
  tone: "error" | "info";
  text: string;
}

/** Исход покупки — в плашку над кнопкой; отмена окна оплаты ничего не говорит. */
export function donateNotice(outcome: BuyOutcome): DonateNotice | null {
  switch (outcome.kind) {
    case "done":
    case "cancelled":
      return null;
    case "retry":
      return { tone: outcome.reason === "slow_confirmation" ? "info" : "error", text: t(`donate.retry.${outcome.reason}`) };
    case "refused": {
      const key = `donate.refused.${outcome.code}`;
      return { tone: "error", text: hasTranslation(key) ? t(key) : t("donate.refused") };
    }
  }
}

export interface DonateSheetProps {
  /** `null` — оплата звёздами выключена: на листе остаётся только Tribute */
  stars: DonationStars | null;
  tribute: VisibleWays["tribute"];
  place: DonatePlace;
  onClose: () => void;
  /** донат дошёл и знак стоит в сессии — экран-хозяин обновляет свой вид */
  onDone?: () => void;
}

export function DonateSheet(props: DonateSheetProps): ReactNode {
  const { stars } = props;
  const [selected, setSelected] = useState<DonateChoice>(() => (stars === null ? "custom" : (defaultAmount(stars.presets) ?? "custom")));
  const [customText, setCustomText] = useState("");
  const [paying, setPaying] = useState(false);
  const [notice, setNotice] = useState<DonateNotice | null>(null);
  const [thanks, setThanks] = useState(false);
  // Лист могли закрыть посреди оплаты: ожидание идёт дальше, а состояние закрытого листа не трогаем.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const amount = stars === null ? null : amountOf(selected, customText, stars);

  const pay = async (): Promise<void> => {
    if (paying || stars === null || amount === null) return;
    setPaying(true);
    setNotice(null);
    const outcome = await buy(
      {
        product: "donation",
        sku: "donation",
        priceStars: amount,
        chargedStars: stars.mode === "test" ? 1 : amount,
        mode: stars.mode,
        order: () => api.order(amount),
      },
      {
        api: purchasePoller(),
        openInvoice: useShell.getState().adapter.openInvoice,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
      },
    );
    if (outcome.kind === "done") {
      markSupporter();
      props.onDone?.();
    }
    if (!mounted.current) return;
    setPaying(false);
    if (outcome.kind === "done") setThanks(true);
    else setNotice(donateNotice(outcome));
  };

  const { tribute } = props;
  return (
    <DonateSheetView
      stars={stars}
      selected={selected}
      customText={customText}
      paying={paying}
      notice={notice}
      thanks={thanks}
      tribute={tribute}
      onTribute={tribute === null ? undefined : () => openTribute(tribute, props.place)}
      onSelect={(choice) => {
        setSelected(choice);
        setNotice(null);
      }}
      onCustomText={(text) => {
        setCustomText(text);
        setNotice(null);
      }}
      onPay={() => void pay()}
      onClose={props.onClose}
    />
  );
}

/**
 * Лист со слайда главной: слайд приходит без подробностей, поэтому суммы и
 * ссылку лист спрашивает сам. Ответ не разобрался — лист закрывается, а не
 * висит пустой.
 */
export function HomeDonateSheet(props: { onClose: () => void }): ReactNode {
  const [view, setView] = useState<DonationView | null>(null);
  const { onClose } = props;

  useEffect(() => {
    let alive = true;
    void api.view().then((response) => {
      if (!alive) return;
      const ready = response.ok && (response.data.stars !== null || visibleWays(response.data).tribute !== null);
      if (ready) setView(response.data);
      else onClose();
    });
    return () => {
      alive = false;
    };
  }, [onClose]);

  if (view === null) return null;
  return <DonateSheet stars={view.stars} tribute={visibleWays(view).tribute} place="home" onClose={onClose} />;
}

/** Сумма выбранной плитки или своя — только если проходит пределы сервера; иначе `null`. */
function amountOf(selected: DonateChoice, customText: string, stars: DonationStars): number | null {
  const parsed = parseAmount(selected === "custom" ? customText : String(selected), stars.min, stars.max);
  return parsed.ok ? parsed.amount : null;
}

export interface DonateSheetViewProps {
  stars: DonationStars | null;
  selected: DonateChoice;
  customText: string;
  paying: boolean;
  notice: DonateNotice | null;
  thanks: boolean;
  tribute?: VisibleWays["tribute"] | undefined;
  onTribute?: (() => void) | undefined;
  onSelect: (choice: DonateChoice) => void;
  onCustomText: (text: string) => void;
  onPay: () => void;
  onClose: () => void;
}

const HEADING_ID = "donate-sheet-title";

/** Лист без состояния и сети: то, что нарисовано при данных пропсах. */
export function DonateSheetView(props: DonateSheetViewProps): ReactNode {
  const { thanks } = props;
  // На wide лист — панель сбоку во всю высоту: места хватает, и «низкого ландшафта» там нет.
  const wide = useWide((state) => state.wide);
  return (
    // Кнопки закреплены под прокручиваемым телом: в ландшафте и с клавиатурой «Поддержать» не уезжает за край.
    <Modal labelledBy={HEADING_ID} placement="bottom" pinFooter footer={thanks ? <ThanksFooter onClose={props.onClose} /> : <ChoiceFooter {...props} />} onDismiss={props.onClose}>
      {/* pt-1: кольцо сердца — тень снаружи круга, и без поля её верх срезает прокручиваемое тело листа. */}
      <div className="flex flex-col items-center pt-1 text-center">
        {/* На узком экране и в ландшафте сердца нет: клавиатура и так съедает полэкрана. */}
        <span
          aria-hidden="true"
          className={[
            "mb-2.5 inline-flex size-[72px] items-center justify-center rounded-full bg-surface-sunken text-hp ring-2 ring-hp/70 max-[359px]:hidden",
            wide ? "" : "short:hidden landscape:hidden",
          ].join(" ")}
        >
          <Heart size={34} fill="currentColor" />
        </span>
        <h2 id={HEADING_ID} className="font-display text-xl font-bold text-text">
          {thanks ? t("donate.thanks.title") : t("donate.sheet.title")}
        </h2>
      </div>
      {thanks ? <Thanks /> : <Choice {...props} />}
    </Modal>
  );
}

function Thanks(): ReactNode {
  return (
    <div className="mt-2 flex flex-col items-center gap-3 text-center">
      <p className="text-sm text-text-muted">{t("donate.thanks.text")}</p>
      <SupporterBadge size="l" />
      <p className="text-xs text-text-muted">{t("donate.thanks.badge")}</p>
    </div>
  );
}

function ThanksFooter(props: { onClose: () => void }): ReactNode {
  return (
    <Button track="donate_close" block variant="secondary" onClick={props.onClose}>
      {t("donate.close")}
    </Button>
  );
}

/** Кнопки листа: оплата выбранной суммы и Tribute; пока ждём оплату — «Ждём оплату…» вместо суммы. */
function ChoiceFooter(props: DonateSheetViewProps): ReactNode {
  const { stars, paying } = props;
  if (stars === null) return <TributeAction {...props} />;
  const amount = amountOf(props.selected, props.customText, stars);
  return (
    <>
      {/* Плашка — над кнопкой, а не в прокручиваемом теле: в ландшафте она иначе уезжала бы за край. */}
      {props.notice === null ? null : <Notice notice={props.notice} />}
      {paying ? (
        <Button track="donate_pay" block variant="secondary" disabled>
          <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {t("donate.paying")}
        </Button>
      ) : (
        <Button track="donate_pay" block disabled={amount === null} onClick={props.onPay}>
          {amount === null ? t("donate.pay.idle") : t("donate.pay", { n: formatNumber(amount) })}
        </Button>
      )}
      <TributeAction {...props} />
    </>
  );
}

function Choice(props: DonateSheetViewProps): ReactNode {
  const { stars, paying } = props;
  if (stars === null) {
    // Оплаты звёздами нет — остаётся ссылка Tribute, если она есть.
    return <p className="mt-2 text-center text-sm text-text-muted">{t("donate.text")}</p>;
  }

  const custom = props.selected === "custom";
  const amount = amountOf(props.selected, props.customText, stars);
  const invalid = custom && props.customText !== "" && amount === null;
  const digits = String(stars.max).length;

  return (
    <div className="mt-2">
      <p className="mb-3.5 text-center text-sm text-text-muted">
        {t("donate.sheet.hint", { min: formatNumber(stars.min), max: formatNumber(stars.max) })}
      </p>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("donate.sheet.title")}>
        {stars.presets.map((preset) => (
          <AmountTile key={preset} selected={props.selected === preset} disabled={paying} onClick={() => props.onSelect(preset)}>
            <StarsIcon size={16} />
            {formatNumber(preset)}
          </AmountTile>
        ))}
        <AmountTile selected={custom} disabled={paying} onClick={() => props.onSelect("custom")}>
          {t("donate.custom")}
        </AmountTile>
      </div>

      {custom ? (
        <div className="mt-3">
          <label className="mb-1 block text-xs text-text-muted" htmlFor="donate-custom">
            {t("donate.custom.label")}
          </label>
          <input
            id="donate-custom"
            value={props.customText}
            inputMode="numeric"
            maxLength={digits}
            disabled={paying}
            autoComplete="off"
            ref={focusField}
            enterKeyHint="go"
            aria-invalid={invalid}
            aria-describedby={invalid ? "donate-custom-error" : undefined}
            className={[
              "surface-sunken min-h-12 w-full rounded-md px-3 font-display text-lg font-bold text-text ring-2",
              invalid ? "ring-danger focus-visible:outline-danger" : "ring-border-strong",
            ].join(" ")}
            onChange={(event) => props.onCustomText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && amount !== null) props.onPay();
            }}
          />
          {invalid ? (
            <p id="donate-custom-error" role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-danger">
              <CircleAlert size={14} aria-hidden="true" className="mt-px shrink-0" />
              {t("donate.custom.invalid", { min: formatNumber(stars.min), max: formatNumber(stars.max) })}
            </p>
          ) : null}
        </div>
      ) : null}

      {stars.mode === "test" ? <p className="mt-3 text-xs text-info">{t("donate.test")}</p> : null}
    </div>
  );
}

function TributeAction(props: DonateSheetViewProps): ReactNode {
  if (props.tribute === undefined || props.tribute === null || props.onTribute === undefined) return null;
  return (
    <Button track="donate_tribute" block variant="ghost" disabled={props.paying} onClick={props.onTribute}>
      <span className="text-sm min-[360px]:text-base">{t("donate.tribute")}</span>
      <ExternalLink size={16} aria-hidden="true" className="max-[359px]:hidden" />
    </Button>
  );
}

/** Поле «Своя сумма» ловит фокус при появлении: игрок нажал «Своя», чтобы набрать число. */
function focusField(node: HTMLInputElement | null): void {
  node?.focus();
}

function AmountTile(props: { selected: boolean; disabled: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      data-amount=""
      aria-pressed={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
      className={[
        "inline-flex min-h-11 items-center justify-center gap-1 rounded-md px-1 font-display text-base font-bold text-text tabular-nums",
        "transition-transform duration-(--duration-fast) ease-base active:scale-[0.98] disabled:opacity-55",
        props.selected ? "surface-card-selected" : "surface-sunken",
      ].join(" ")}
    >
      {props.children}
    </button>
  );
}

function Notice(props: { notice: DonateNotice }): ReactNode {
  const error = props.notice.tone === "error";
  const Icon = error ? CircleAlert : Info;
  return (
    <div
      role={error ? "alert" : "status"}
      className={["surface-sunken flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm text-text ring-1", error ? "ring-danger/40" : "ring-info/40"].join(" ")}
    >
      <Icon size={16} aria-hidden="true" className={`mt-px shrink-0 ${error ? "text-danger" : "text-info"}`} />
      <p className="min-w-0 flex-1">{props.notice.text}</p>
    </div>
  );
}
