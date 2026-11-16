import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, Lock } from "lucide-react";
import { Card, ContentColumn, ErrorState, Modal, Screen, Toggle } from "../../design-system/components";
import { hasTranslation, t } from "../../i18n";
import "../../i18n/appearance";
import { appearanceFailure, createAppearanceApi, rememberOwnAppearance, type AppearanceChoice, type AppearanceItem, type AppearanceView } from "../../state/appearance-api";
import { useNavigation } from "../../state/navigation";
import { track } from "../../state/shell";
import { trackClick } from "../../state/ui-clicks";
import { uiFeedback } from "../../state/ui-feedback";
import { appearanceCardUrl } from "./appearance-art";
import { appearanceNameKey, cardState, gridColumns, sortAppearances, sourceText, type CardState } from "./appearance-rules";
import { RarityGlow, rarityName, toneOf } from "./arsenal-parts";

/**
 * Экран «Облик» (tasks/T-0238, docs/35-stage4-plan.md Р150, макет
 * `design/art/mockups/identity-v2.html`): десять обликов героя. Свои надеваются
 * одним нажатием, у закрытых — силуэт и «откуда взять»; внизу — переключатель
 * «Фото из Telegram в кружке». Экран открывают из арсенала и профиля, и только
 * зрителю с артом: облики — это арт (Р143).
 *
 * Выбор не рисуется оптимистично: ждём ответ сервера, на ошибке остаётся прежний
 * облик и появляется плашка; на 409 владение могло пропасть (кончился VIP) —
 * раздел перечитывается.
 */
type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; view: AppearanceView };

const api = createAppearanceApi();

export function AppearanceScreen(): ReactNode {
  const navigation = useNavigation();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [sheet, setSheet] = useState<AppearanceItem | null>(null);

  const load = async (quiet = false): Promise<void> => {
    if (!quiet) setState({ status: "loading" });
    const response = await api.load();
    if (response.ok) rememberOwnAppearance(response.data);
    setState((prev) => (response.ok ? { status: "ready", view: response.data } : quiet && prev.status === "ready" ? prev : { status: "failed" }));
  };

  useEffect(() => {
    void load();
  }, []);

  /** Отправить выбор и принять ответ сервера; общий путь для облика и кружка. */
  const choose = async (view: AppearanceView, change: { id?: string; avatarPhoto?: boolean }, key: string): Promise<void> => {
    if (busy !== null) return;
    setBusy(key);
    setFailed(false);
    const result = await api.choose(change);
    setBusy(null);
    if (!result.ok) {
      setFailed(true);
      if (appearanceFailure(result.code).reload) void load(true);
      return;
    }
    if (result.data.effective !== view.effective || result.data.avatarPhoto !== view.avatarPhoto) {
      track("appearance_changed", { appearance: result.data.effective, avatarPhoto: result.data.avatarPhoto });
    }
    rememberOwnAppearance(result.data);
    setState({ status: "ready", view: { ...view, ...pickChoice(result.data) } });
  };

  return (
    <Screen title={t("appearance.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        {state.status === "loading" ? <p className="text-sm text-text-muted">{t("appearance.loading")}</p> : null}
        {state.status === "failed" ? <ErrorState text={t("appearance.failed")} onRetry={() => void load()} /> : null}
        {state.status === "ready" ? (
          <AppearanceBody
            view={state.view}
            busy={busy}
            failed={failed}
            onWear={(item) => void choose(state.view, { id: item.id }, item.id)}
            onOpenLocked={setSheet}
            onAvatarPhoto={(checked) => void choose(state.view, { avatarPhoto: checked }, "avatarPhoto")}
          />
        ) : null}
      </ContentColumn>
      {sheet === null ? null : <LockedSheet item={sheet} onClose={() => setSheet(null)} />}
    </Screen>
  );
}

function pickChoice(choice: AppearanceChoice): AppearanceChoice {
  return { selected: choice.selected, effective: choice.effective, avatarPhoto: choice.avatarPhoto };
}

/** Содержимое экрана по готовому ответу: витрина компонентов рисует его без сети. */
export function AppearanceBody(props: {
  view: AppearanceView;
  /** что сейчас отправляется: id облика или `avatarPhoto` */
  busy: string | null;
  failed: boolean;
  onWear: (item: AppearanceItem) => void;
  onOpenLocked: (item: AppearanceItem) => void;
  onAvatarPhoto: (checked: boolean) => void;
}): ReactNode {
  const { view } = props;
  const [grid, columns] = useGridColumns();
  return (
    <>
      <div ref={grid}>
        <ul className={`grid gap-2 ${columns === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
          {sortAppearances(view.items).map((item) => (
            <li key={item.id} className="min-w-0">
              <AppearanceCard
                item={item}
                state={cardState(item, view.effective)}
                busy={props.busy === item.id}
                disabled={props.busy !== null}
                onWear={props.onWear}
                onOpenLocked={props.onOpenLocked}
              />
            </li>
          ))}
        </ul>
      </div>
      {props.failed ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger">
          {t("appearance.chooseFailed")}
        </p>
      ) : null}
      <div className="mt-4">
        <Card compact>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text">{t("appearance.avatarPhoto")}</p>
              <p className="text-xs text-text-muted">{t("appearance.avatarPhoto.hint")}</p>
            </div>
            <Toggle checked={view.avatarPhoto} disabled={props.busy !== null} label={t("appearance.avatarPhoto")} onChange={() => props.onAvatarPhoto(!view.avatarPhoto)} />
          </div>
        </Card>
      </div>
    </>
  );
}

/**
 * Колонки сетки по ширине самого блока, а не окна: в боковой колонке широкого
 * экрана окно широкое, а места мало. До первого замера — по ширине окна.
 */
function useGridColumns(): [RefObject<HTMLDivElement | null>, 2 | 3] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 390 : window.innerWidth));
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined && next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, gridColumns(width)];
}

/** Строка под названием: что делает карточка и откуда взять закрытый облик. */
function StateLine(props: { item: AppearanceItem; state: CardState }): ReactNode {
  if (props.state === "worn") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-accent">
        <Check size={12} aria-hidden="true" />
        {t("appearance.worn")}
      </span>
    );
  }
  if (props.state === "owned") return <span className="text-xs font-semibold text-text-muted">{t("appearance.wear")}</span>;
  const source = sourceText(props.item.source);
  return (
    <span className="flex flex-col items-center gap-0.5">
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-text-muted">
        <Lock size={12} aria-hidden="true" />
        {t("appearance.locked")}
      </span>
      {source === null ? null : <span className="text-xs text-text-muted">{t(source.key, source.params)}</span>}
    </span>
  );
}

/** Имя облика; незнакомый клиенту облик подписан своим id, а не пустотой. */
function nameOf(id: string): string {
  const key = appearanceNameKey(id);
  return key === null ? id : t(key);
}

function AppearanceCard(props: {
  item: AppearanceItem;
  state: CardState;
  busy: boolean;
  disabled: boolean;
  onWear: (item: AppearanceItem) => void;
  onOpenLocked: (item: AppearanceItem) => void;
}): ReactNode {
  const { item, state } = props;
  const locked = state === "locked";
  const tone = locked ? "bg-surface-raised ring-border-strong" : toneOf(item.rarity).tile;
  return (
    <button
      type="button"
      aria-pressed={state === "worn"}
      aria-busy={props.busy}
      disabled={props.disabled && state !== "worn" && !locked}
      onClick={() => {
        if (state === "worn") return;
        uiFeedback("tap");
        if (locked) {
          trackClick("appearance_open");
          props.onOpenLocked(item);
          return;
        }
        trackClick("appearance_wear");
        props.onWear(item);
      }}
      className={[
        "relative isolate flex h-full min-h-11 w-full flex-col items-center gap-1.5 rounded-lg px-2 pt-3 pb-2.5 text-center ring-2",
        "transition-transform duration-(--duration-fast) ease-base active:scale-[0.98] disabled:opacity-60",
        tone,
        state === "worn" ? "ring-accent" : "",
      ].join(" ")}
    >
      {locked ? null : <RarityGlow rarity={item.rarity} seed={item.id} />}
      {/* Закрытый — силуэт: тот же портрет, приглушённый и без тона редкости. */}
      <img src={appearanceCardUrl(item.id)} alt="" className={`h-28 w-auto max-w-full ${locked ? "opacity-35" : ""}`} />
      <span className="max-w-full font-display text-sm font-bold text-text">{nameOf(item.id)}</span>
      <StateLine item={item} state={state} />
    </button>
  );
}

/** Редкость облика (мужского рода, не «Легендарное» предметов); незнакомая — как у предметов. */
function rarityLabel(rarity: string): string {
  const key = `appearance.rarity.${rarity}`;
  return hasTranslation(key) ? t(key) : rarityName(rarity);
}

/** Лист закрытого облика: крупный портрет, редкость и откуда его взять. */
export function LockedSheet(props: { item: AppearanceItem; onClose: () => void }): ReactNode {
  const { item } = props;
  const source = sourceText(item.source);
  return (
    <Modal title={nameOf(item.id)} placement="bottom" onDismiss={props.onClose}>
      <div className="flex flex-col items-center gap-3 text-center">
        <div className={`relative isolate rounded-lg px-6 py-3 ring-2 ${toneOf(item.rarity).tile}`}>
          <img src={appearanceCardUrl(item.id)} alt="" className="h-44 w-auto max-w-full opacity-35 short:h-28" />
        </div>
        <p className="text-xs font-semibold text-text-muted">
          {rarityLabel(item.rarity)} · {t("appearance.locked")}
        </p>
        {source === null ? null : (
          <div>
            <p className="text-xs text-text-muted">{t("appearance.sheet.where")}</p>
            <p className="text-sm font-semibold text-text">{t(source.key, source.params)}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
