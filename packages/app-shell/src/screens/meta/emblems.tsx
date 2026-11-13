import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Card, ContentColumn, ErrorState, Modal, Screen, SectionTitle } from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import "../../i18n/emblems";
import type { ApiResult } from "../../state/api-request";
import { createEmblemsApi, emblemFailure, type EmblemChoice, type EmblemItem, type EmblemsView } from "../../state/emblems-api";
import { useNavigation } from "../../state/navigation";
import { track } from "../../state/shell";
import { trackClick } from "../../state/ui-clicks";
import { uiFeedback } from "../../state/ui-feedback";
import { EmblemChip } from "./emblem-chip";
import { GROUP_ORDER, groupEmblems, type EmblemGroup } from "./emblem-rules";

/**
 * Раздел «Знаки» (tasks/T-0236, docs/35-stage4-plan.md Р149, макет
 * `design/art/mockups/identity-v2.html`): все знаки каталога — полученные цветом
 * редкости, закрытые силуэтом с условием и «есть у N%». Нажатие на полученный
 * знак открывает лист «Носить у имени»: выбрать знак или вернуть «по умолчанию».
 *
 * Выбор не рисуется оптимистично: ждём ответ сервера, на ошибке остаётся прежний
 * знак и появляется плашка.
 */
type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; view: EmblemsView };

const api = createEmblemsApi();

const GROUP_KEYS: Readonly<Record<EmblemGroup, string>> = {
  status: "emblems.group.status",
  season: "emblems.group.season",
  merit: "emblems.group.merit",
};

export function EmblemsScreen(): ReactNode {
  const navigation = useNavigation();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [sheet, setSheet] = useState(false);

  const load = async (quiet = false): Promise<void> => {
    if (!quiet) setState({ status: "loading" });
    const response = await api.load();
    setState((prev) => (response.ok ? { status: "ready", view: response.data } : quiet && prev.status === "ready" ? prev : { status: "failed" }));
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <Screen title={t("emblems.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        {state.status === "loading" ? <p className="text-sm text-text-muted">{t("emblems.loading")}</p> : null}
        {state.status === "failed" ? <ErrorState text={t("emblems.failed")} onRetry={() => void load()} /> : null}
        {state.status === "ready" ? <EmblemsBody view={state.view} onPick={() => setSheet(true)} /> : null}
      </ContentColumn>
      {state.status === "ready" && sheet ? (
        <EmblemWearSheet
          view={state.view}
          choose={(id) => api.choose(id)}
          onChosen={(choice) => setState({ status: "ready", view: { ...state.view, shown: choice.shown, auto: choice.auto } })}
          onStale={() => void load(true)}
          onClose={() => setSheet(false)}
        />
      ) : null}
    </Screen>
  );
}

/** Содержимое раздела по готовому ответу: витрина компонентов рисует его без сети. */
export function EmblemsBody(props: { view: EmblemsView; onPick: (item: EmblemItem) => void }): ReactNode {
  const { view } = props;
  const shown = view.items.find((item) => item.id === view.shown);
  return (
    <>
      {shown === undefined ? null : (
        <Card compact>
          <p className="mb-1.5 text-xs text-text-muted">{t("emblems.current")}</p>
          <EmblemChip emblem={shown} size="l" fit="full" />
        </Card>
      )}
      {groupEmblems(view.items).map((group) => (
        <section key={group.category}>
          <SectionTitle>{t(GROUP_KEYS[group.category])}</SectionTitle>
          <ul className="@container grid grid-cols-1 gap-2 @min-[32rem]:grid-cols-2">
            {group.items.map((item) => (
              <EmblemRow key={item.id} item={item} current={item.id === view.shown && !view.auto} onPick={props.onPick} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** «Есть у N% игроков»; процента нет — строки нет. */
function rarityLine(item: EmblemItem): string | null {
  return item.percent === null || item.percent === undefined ? null : t("emblems.rarity", { percent: formatNumber(item.percent) });
}

function EmblemRow(props: { item: EmblemItem; current: boolean; onPick: (item: EmblemItem) => void }): ReactNode {
  const { item } = props;
  const rarity = rarityLine(item);
  const hint = item.hint === null || item.hint === undefined || item.hint === "" ? null : item.hint;

  if (!item.held) {
    return (
      <li className="surface-sunken flex min-w-0 flex-col items-start gap-1 rounded-lg px-3 py-2.5">
        <EmblemChip emblem={item} size="l" fit="full" closed />
        {hint === null ? null : <p className="text-xs text-text-muted">{hint}</p>}
        {rarity === null ? null : <p className="text-xs text-text-muted">{rarity}</p>}
      </li>
    );
  }
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => {
          uiFeedback("tap");
          trackClick("emblem_open");
          props.onPick(item);
        }}
        className="surface-card flex min-h-11 w-full flex-col items-start gap-1 rounded-lg px-3 py-2.5 text-left transition-transform duration-(--duration-fast) ease-base active:scale-[0.98]"
      >
        <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <EmblemChip emblem={item} size="l" fit="full" />
          {props.current ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-accent">
              <Check size={12} aria-hidden="true" />
              {t("emblems.current")}
            </span>
          ) : null}
        </span>
        {hint === null ? null : <span className="text-xs text-text-muted">{hint}</span>}
        {rarity === null ? null : <span className="text-xs text-text-muted">{rarity}</span>}
      </button>
    </li>
  );
}

/**
 * Лист «Носить у имени»: «По умолчанию» и все полученные знаки. Помечен тот, что
 * сейчас у имени; при `auto` — строка «По умолчанию» с названием знака, который
 * сервер показывает сам.
 */
export function EmblemWearSheet(props: {
  view: EmblemsView;
  choose: (id: string | null) => Promise<ApiResult<EmblemChoice>>;
  onChosen: (choice: EmblemChoice) => void;
  /** сервер отказал так, что экран разошёлся с ним: раздел перечитать */
  onStale: () => void;
  onClose: () => void;
}): ReactNode {
  const { view } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const held = groupEmblems(view.items.filter((item) => item.held)).flatMap((group) => group.items);
  const shown = view.items.find((item) => item.id === view.shown);

  const pick = async (id: string | null): Promise<void> => {
    if (busy !== null) return;
    setBusy(id ?? "");
    setFailed(false);
    const result = await props.choose(id);
    setBusy(null);
    if (result.ok) {
      const changed = result.data.shown !== view.shown || result.data.auto !== view.auto;
      if (changed) {
        const category = view.items.find((item) => item.id === result.data.shown)?.category;
        track("emblem_shown_changed", { emblem: id ?? "auto", ...(category === undefined ? {} : { category: GROUP_ORDER.find((group) => group === category) ?? "merit" }) });
      }
      props.onChosen(result.data);
      props.onClose();
      return;
    }
    setFailed(true);
    if (emblemFailure(result.code).reload) props.onStale();
  };

  const autoLabel = !view.auto ? t("emblems.auto") : shown === undefined ? t("emblems.autoNone") : t("emblems.autoNow", { title: shown.title });

  return (
    <Modal title={t("emblems.wear")} placement="bottom" onDismiss={props.onClose}>
      <p className="mb-3 text-sm text-text-muted">{t("emblems.sheet.hint")}</p>
      <ul className="grid gap-2">
        <li>
          <WearOption current={view.auto} busy={busy === ""} disabled={busy !== null} onPick={() => void pick(null)}>
            <span className="text-sm font-semibold text-text">{autoLabel}</span>
          </WearOption>
        </li>
        {held.map((item) => (
          <li key={item.id}>
            <WearOption current={!view.auto && view.shown === item.id} busy={busy === item.id} disabled={busy !== null} onPick={() => void pick(item.id)}>
              <EmblemChip emblem={item} size="l" fit="full" />
            </WearOption>
          </li>
        ))}
      </ul>
      {failed ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger">
          {t(emblemFailure(undefined).textKey)}
        </p>
      ) : null}
    </Modal>
  );
}

function WearOption(props: { current: boolean; busy: boolean; disabled: boolean; onPick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={props.current}
      aria-busy={props.busy}
      disabled={props.disabled}
      onClick={() => {
        uiFeedback("tap");
        trackClick("emblem_pick");
        props.onPick();
      }}
      className={[
        "flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left",
        "transition-transform duration-(--duration-fast) ease-base active:scale-[0.98] disabled:opacity-60",
        props.current ? "surface-card-selected" : "surface-card",
      ].join(" ")}
    >
      <span className="flex min-w-0 flex-col items-start gap-1">{props.children}</span>
      {props.current ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent">
          <Check size={14} aria-hidden="true" />
          {t("emblems.current")}
        </span>
      ) : null}
    </button>
  );
}
