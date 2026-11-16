import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Avatar, Badge, Button, Modal, SectionTitle } from "../../design-system/components";
import { formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/appearance";
import "../../i18n/player-card";
import { createFriendsApi, friendsAvailable } from "../../state/friends-api";
import { createPlayerCardApi, type PlayerCardView } from "../../state/player-card-api";
import { useViewerArt } from "../../state/viewer-art";
import { achievementTitle, CategoryIcon } from "./achievement-card";
import { appearanceCardUrl } from "./appearance-art";
import { appearanceNameKey } from "./appearance-rules";
import { RarityGlow, rarityName, toneOf } from "./arsenal-parts";
import { EmblemChip } from "./emblem-chip";
import {
  actionFor,
  appearanceRarity,
  failureTextKey,
  favoritesShown,
  moreEmblems,
  relationAfterRequest,
  requestFailureKey,
  statCells,
  type CardFailureReason,
  type CardFrom,
} from "./player-card-rules";

/**
 * Карточка игрока — лист снизу (tasks/T-0248, docs/35-stage4-plan.md Р48, макет
 * `design/art/mockups/identity-v2.html`): сцена с обликом тоном его редкости,
 * под ней имя, знак и уровень, четыре числа, знаки и витрина, а внизу, под
 * прокруткой, — действие с заявкой в друзья. Открывается тапом по игроку в
 * рейтинге, таблице сезона и списке друзей; свою карточку игрок видит из
 * профиля — «Как меня видят».
 *
 * Игрока называет публичный id; всё, что показано, решает сервер (скрытая доска
 * и блокировка для него — один «не найден»). Клиент рисует ответ и предлагает
 * позвать в друзья: исход заявки принимает по ответу сервера, а не по умолчанию.
 * Облик — арт, поэтому портрет только зрителю с артом (T-0238, Р143): остальным
 * вместо него крупный аватар.
 */

type Loaded = { status: "loading" } | { status: "failed"; reason: CardFailureReason } | { status: "ready"; card: PlayerCardView };

const cardApi = createPlayerCardApi();
const friendsApi = createFriendsApi();

/** Отказы, которые можно повторить: связь, сервер, «слишком часто» (через минуту). */
const RETRYABLE: ReadonlySet<CardFailureReason> = new Set(["offline", "unavailable", "too_often", "disabled"]);

export function PlayerCardSheet(props: {
  publicId: string;
  from: CardFrom;
  onClose: () => void;
  /** у экрана друзей: убрать друга из списка — лист закрывается, экран спрашивает подтверждение */
  onRemove?: (() => void) | undefined;
  /** заявка ушла или принята: экран перечитывает свой список */
  onChanged?: (() => void) | undefined;
}): ReactNode {
  const viewerArt = useViewerArt();
  const signedIn = friendsAvailable();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [requesting, setRequesting] = useState(false);
  const [requestFailure, setRequestFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    void cardApi.load(props.publicId).then((answer) => {
      if (alive) setState(answer.ok ? { status: "ready", card: answer.data } : { status: "failed", reason: answer.reason });
    });
    return () => {
      alive = false;
    };
  }, [props.publicId, attempt]);

  const { onChanged, onClose, onRemove } = props;
  const card = state.status === "ready" ? state.card : null;

  /** Одно действие за раз; исход — по ответу сервера, а не оптимистично. */
  const act = useCallback(async (): Promise<void> => {
    if (card === null || requesting) return;
    setRequesting(true);
    setRequestFailure(null);
    const answer = await friendsApi.request(card.publicId);
    setRequesting(false);
    if (!answer.ok) {
      setRequestFailure(requestFailureKey(answer.code));
      return;
    }
    setState({ status: "ready", card: { ...card, relation: relationAfterRequest(answer.data.status) } });
    onChanged?.();
  }, [card, requesting, onChanged]);

  const remove = onRemove === undefined ? undefined : () => {
    onClose();
    onRemove();
  };
  const actions =
    card !== null && hasActions(card, signedIn, remove !== undefined) ? (
      <PlayerCardActions card={card} signedIn={signedIn} requesting={requesting} requestFailure={requestFailure} onAction={() => void act()} {...(remove === undefined ? {} : { onRemove: remove })} />
    ) : null;

  return (
    <Modal title={t(props.from === "profile" ? "playerCard.self" : "playerCard.title")} placement="bottom" onDismiss={onClose} {...(actions === null ? {} : { pinFooter: true, footer: actions })}>
      {state.status === "loading" ? <CardSkeleton /> : null}
      {state.status === "failed" ? <CardFailure reason={state.reason} onRetry={RETRYABLE.has(state.reason) ? () => setAttempt((value) => value + 1) : undefined} /> : null}
      {card === null ? null : <PlayerCardBody card={card} viewerArt={viewerArt} />}
    </Modal>
  );
}

/** Есть ли у карточки что показать внизу: кнопка заявки, метка дружбы или «Убрать из друзей». */
function hasActions(card: PlayerCardView, signedIn: boolean, canRemove: boolean): boolean {
  return (signedIn && actionFor(card.relation) !== null) || (canRemove && card.relation === "friend");
}

/** Скелет: сцена и четыре числа на месте, пока сервер думает — лист не прыгает, когда ответ пришёл. */
function CardSkeleton(): ReactNode {
  return (
    <div role="status" aria-busy="true" className="grid gap-3">
      <span className="sr-only">{t("playerCard.loading")}</span>
      <div aria-hidden="true" className="surface-card h-44 animate-pulse rounded-lg short:h-28 landscape:h-28" />
      <div aria-hidden="true" className="grid grid-cols-4 gap-1.5">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="surface-card h-14 animate-pulse rounded-md" />
        ))}
      </div>
    </div>
  );
}

/** Отказ загрузки: игрока нет, слишком часто или нет связи — своими словами, лист при этом закрывается обычным жестом. */
function CardFailure(props: { reason: CardFailureReason; onRetry: (() => void) | undefined }): ReactNode {
  return (
    <div role="status" className="surface-sunken flex flex-col items-center gap-3 rounded-lg p-4 text-center">
      <p className="text-sm text-text-muted">{t(failureTextKey(props.reason))}</p>
      {props.onRetry === undefined ? null : (
        <Button track="retry" variant="secondary" onClick={props.onRetry}>
          {t("app.retry")}
        </Button>
      )}
    </div>
  );
}

/** Имя облика для подписи под сценой; облик, которого клиент не знает, подписан своим id. */
function appearanceName(id: string): string {
  const key = appearanceNameKey(id);
  return key !== null && hasTranslation(key) ? t(key) : id;
}

/** Редкость облика мужского рода, не «Легендарное» предметов (как в разделе «Облик»); незнакомая — как у предметов. */
function appearanceRarityLabel(rarity: string): string {
  const key = `appearance.rarity.${rarity}`;
  return hasTranslation(key) ? t(key) : rarityName(rarity);
}

/**
 * Сцена: портрет облика на тоне его редкости; рамка и свет — тот же тон, что у
 * карточки облика в разделе «Облик». Без арта у зрителя — крупный аватар.
 * Редкость называется словами под сценой: одним цветом она не передаётся.
 */
function Scene(props: { card: PlayerCardView; viewerArt: boolean }): ReactNode {
  const { card } = props;
  const rarity = appearanceRarity(card.appearance);
  return (
    <div>
      <div className={`relative isolate flex justify-center overflow-hidden rounded-lg px-6 ring-2 ${toneOf(rarity).tile}`}>
        <RarityGlow rarity={rarity} seed={card.publicId} />
        {props.viewerArt ? (
          <img src={appearanceCardUrl(card.appearance)} alt="" className="h-44 w-auto max-w-full py-2 short:h-28 landscape:h-28" />
        ) : (
          <div className="py-5 short:py-3 landscape:py-3">
            <Avatar name={card.name} url={card.photoUrl ?? null} size={96} appearance={card.appearance} avatarPhoto={card.avatarPhoto} />
          </div>
        )}
      </div>
      {props.viewerArt ? (
        <p className="mt-1.5 text-center text-xs font-semibold text-text-muted">
          {appearanceRarityLabel(rarity)} · {appearanceName(card.appearance)}
        </p>
      ) : null}
    </div>
  );
}

/** Содержимое листа по готовому ответу: витрина компонентов рисует его без сети. */
export function PlayerCardBody(props: { card: PlayerCardView; viewerArt: boolean }): ReactNode {
  const { card } = props;
  const more = moreEmblems(card.emblems.held, card.emblems.top.length);
  const favorites = favoritesShown(card.favorites);
  return (
    <div className="grid gap-3">
      <Scene card={card} viewerArt={props.viewerArt} />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-lg font-bold text-text">{card.name}</h3>
          {card.emblem === undefined ? null : (
            <div className="mt-1 flex min-w-0">
              <EmblemChip emblem={card.emblem} size="l" fit="full" />
            </div>
          )}
        </div>
        <Badge tone="accent">{t("playerCard.level", { level: card.level })}</Badge>
      </div>
      <dl className="grid grid-cols-4 gap-1.5">
        {statCells(card).map((cell) => (
          <div key={cell.id} className="surface-sunken flex min-w-0 flex-col items-center justify-between gap-1 rounded-md px-1 py-2 text-center">
            <dd className="order-2 font-display text-base font-bold tabular-nums text-text">{cell.text}</dd>
            <dt className="order-1 text-xs leading-tight text-text-muted">{t(cell.labelKey)}</dt>
          </div>
        ))}
      </dl>
      {card.emblems.top.length === 0 ? null : (
        <section>
          <SectionTitle as="h3" spacing="mt-1 mb-2">
            {t("playerCard.emblems", { count: card.emblems.held })}
          </SectionTitle>
          <ul className="flex flex-wrap items-center gap-1.5">
            {card.emblems.top.map((emblem) => (
              <li key={emblem.id} className="flex min-w-0 max-w-full">
                <EmblemChip emblem={emblem} fit="full" />
              </li>
            ))}
            {more === null ? null : (
              <li>
                <span className="surface-sunken inline-flex items-center rounded-sm px-2 py-0.5 font-display text-xs font-semibold text-text-muted">
                  <span aria-hidden="true">{t("playerCard.moreEmblems", { count: more })}</span>
                  <span className="sr-only">{t("playerCard.moreEmblems.sr", { count: more })}</span>
                </span>
              </li>
            )}
          </ul>
        </section>
      )}
      {favorites.length === 0 && card.prestige <= 0 ? null : (
        <section>
          <SectionTitle as="h3" spacing="mt-1 mb-2" {...(card.prestige > 0 ? { end: t("playerCard.prestige", { points: formatNumber(card.prestige) }) } : {})}>
            {t("playerCard.showcase")}
          </SectionTitle>
          {favorites.length === 0 ? null : (
            <ul className="grid gap-2">
              {favorites.map((item) => (
                <li key={item.id} className="surface-sunken flex items-center gap-2 rounded-lg px-3 py-2 text-accent">
                  <CategoryIcon category={item.category} size={18} />
                  <span className="min-w-0 truncate text-sm text-text">{achievementTitle(item)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Низ листа: действие с заявкой по отношению (`actionFor`), строка ошибки и
 * «Убрать из друзей» у экрана друзей. Лежит в закреплённом подвале листа, чтобы
 * кнопка была на виду без прокрутки и в ландшафте. Гостю действий нет: дружба
 * бывает лишь между аккаунтами.
 */
export function PlayerCardActions(props: {
  card: PlayerCardView;
  signedIn: boolean;
  requesting: boolean;
  /** ключ текста отказа заявки; `null` — отказа нет */
  requestFailure: string | null;
  onAction: () => void;
  onRemove?: () => void;
}): ReactNode {
  const action = props.signedIn ? actionFor(props.card.relation) : null;
  return (
    <>
      {props.requestFailure === null ? null : (
        <p role="alert" className="text-center text-sm font-semibold text-danger">
          {t(props.requestFailure)}
        </p>
      )}
      {action === null ? null : action.mode === "label" ? (
        <p className="surface-sunken flex min-h-12 items-center justify-center gap-2 rounded-md text-sm font-semibold text-text-muted">
          <Check size={16} aria-hidden="true" className="text-success" />
          {t(action.labelKey)}
        </p>
      ) : (
        <Button track="friend_request" block loading={props.requesting} disabled={action.mode === "disabled"} onClick={props.onAction}>
          {t(action.labelKey)}
        </Button>
      )}
      {props.onRemove === undefined || props.card.relation !== "friend" ? null : (
        <Button track="friend_remove" variant="ghost" block onClick={props.onRemove}>
          {t("playerCard.remove")}
        </Button>
      )}
    </>
  );
}
