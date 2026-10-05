import { useEffect, useState, type ReactNode } from "react";
import type { InviteResult } from "@bh/shared-types";
import { Check, Copy, Gift, Send, Trophy, UserPlus } from "lucide-react";
import {
  Avatar,
  Button,
  Card,
  ContentColumn,
  ErrorState,
  IconEmblem,
  Modal,
  PageTitle,
  Screen,
  SectionTitle,
  InfoNotice,
} from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import "../../i18n/friends";
import type { ApiResult } from "../../state/api-request";
import { loadBadges } from "../../state/badges-api";
import {
  createFriendsApi,
  friendInviteUrl,
  friendsAvailable,
  type FriendEntry,
  type FriendsView,
} from "../../state/friends-api";
import { copyText } from "../../state/clipboard";
import { restrictionRefusal, useRestricted } from "../../state/restrictions";
import { track, useShell } from "../../state/shell";
import { loadWallet } from "../../state/wallet-api";
import { RestrictedPlaque } from "./restricted-plaque";

/**
 * Раздел «Друзья» (docs/35-stage4-plan.md §3.8, WP14; О5 в
 * docs/36-parallel-work.md): приглашение ссылкой дружбы, заявки, подарки раз
 * в день и бонус за число друзей. Правила и числа — у сервера: экран
 * показывает, что можно сделать сейчас, и перечитывает раздел после каждого
 * действия. Без входа — только приглашение: дружба бывает лишь между
 * аккаунтами.
 */

/** `sent` — сообщение от бота ушло; `shared` — открыт выбор чата со ссылкой, отправил ли игрок, неизвестно. */
type InviteState = "idle" | "sent" | "shared" | "copied" | "unavailable";
type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; view: FriendsView };

const api = createFriendsApi();

/**
 * Что здесь закрывают ограничения (WP44): подарки — дарить и забирать,
 * награды за друзей — за приглашённых и бонус за их число. Дружить и звать
 * друзей можно и под ними.
 */
const GIFTS = ["friend_gifts"];
const REWARDS = ["referral_rewards"];
const RESTRICTIONS = [...GIFTS, ...REWARDS];

export function FriendsScreen(): ReactNode {
  const withAccount = friendsAvailable();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FriendEntry | null>(null);
  const giftsClosed = useRestricted(GIFTS);
  const rewardsClosed = useRestricted(REWARDS);

  const load = async (): Promise<void> => {
    const response = await api.view();
    setState(response.ok ? { status: "ready", view: response.data } : { status: "failed" });
  };

  useEffect(() => {
    if (withAccount) void load();
  }, [withAccount]);

  /** Одно действие за раз: повторное нажатие не шлёт второй запрос. */
  const act = async <T,>(key: string, action: () => Promise<ApiResult<T>>, done?: (data: T) => void): Promise<void> => {
    if (busy !== null) return;
    setBusy(key);
    setNotice(null);
    const result = await action();
    if (result.ok) done?.(result.data);
    else {
      // Закрыто ограничением — скажет плашка вверху, а не «не получилось».
      const refusal = await restrictionRefusal(result, RESTRICTIONS);
      if (refusal !== "restricted") setNotice(t(refusal === "lifted" ? "restricted.lifted" : "friends.action.failed"));
    }
    await load();
    // Знак на вкладке гаснет вместе с тем, что его зажгло.
    void loadBadges();
    setBusy(null);
  };

  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("friends.title")}</PageTitle>
        {withAccount ? <RestrictedPlaque kinds={RESTRICTIONS} className="mt-4" /> : null}
        <Invite withAccount={withAccount} />

        {!withAccount ? <InfoNotice text={t("friends.guest")} /> : null}
        {withAccount && state.status === "loading" ? <p className="mt-4 text-sm text-text-muted">{t("friends.loading")}</p> : null}
        {withAccount && state.status === "failed" ? <ErrorState text={t("friends.failed")} onRetry={() => void load()} /> : null}
        {notice === null ? null : (
          <p role="status" className="mt-3 text-center text-sm text-text">
            {notice}
          </p>
        )}

        {state.status === "ready" ? (
          <>
            <Gifts
              view={state.view}
              busy={busy === "gifts"}
              closed={giftsClosed}
              onClaim={() =>
                void act("gifts", () => api.claimGifts(), (claim) => {
                  // Монет меньше обещанного — упёрлись в суточный потолок кошелька.
                  const promised = claim.claimed * state.view.gifts.coins;
                  setNotice(claim.coins < promised ? t("friends.gifts.capped") : t("friends.gifts.claimed", { count: claim.claimed, coins: formatNumber(claim.coins) }));
                  void loadWallet();
                })
              }
            />

            {state.view.incoming.length === 0 ? null : (
              <>
                <SectionTitle>{t("friends.incoming")}</SectionTitle>
                <div className="grid gap-2">
                  {state.view.incoming.map((request) => (
                    <PeerRow key={request.accountId} name={request.displayName} photoUrl={request.photoUrl}>
                      <Button variant="secondary" loading={busy === `accept:${request.accountId}`} onClick={() => void act(`accept:${request.accountId}`, () => api.accept(request.accountId))}>
                        {t("friends.accept")}
                      </Button>
                      <Button variant="ghost" loading={busy === `decline:${request.accountId}`} onClick={() => void act(`decline:${request.accountId}`, () => api.decline(request.accountId))}>
                        {t("friends.decline")}
                      </Button>
                    </PeerRow>
                  ))}
                </div>
              </>
            )}

            <SectionTitle>{t("friends.list", { count: state.view.friends.length, max: state.view.limits.maxFriends })}</SectionTitle>
            {state.view.friends.length === 0 ? (
              <InfoNotice text={t("friends.empty")} />
            ) : (
              <div className="grid gap-2">
                {state.view.friends.map((friend) => {
                  const gifted = state.view.gifts.sentToday.includes(friend.accountId);
                  return (
                    <PeerRow key={friend.accountId} name={friend.displayName} photoUrl={friend.photoUrl} onPress={() => setRemoving(friend)}>
                      <Button
                        variant="secondary"
                        disabled={gifted || giftsClosed}
                        loading={busy === `gift:${friend.accountId}`}
                        onClick={() => void act(`gift:${friend.accountId}`, () => api.gift(friend.accountId))}
                      >
                        {gifted ? <Check size={16} aria-hidden="true" /> : <Gift size={16} aria-hidden="true" />}
                        {gifted ? t("friends.gift.sent") : t("friends.gift")}
                      </Button>
                    </PeerRow>
                  );
                })}
              </div>
            )}

            {state.view.outgoing.length === 0 ? null : (
              <>
                <SectionTitle>{t("friends.outgoing")}</SectionTitle>
                <div className="grid gap-2">
                  {state.view.outgoing.map((request) => (
                    <PeerRow key={request.accountId} name={request.displayName} photoUrl={request.photoUrl}>
                      <Button variant="ghost" loading={busy === `cancel:${request.accountId}`} onClick={() => void act(`cancel:${request.accountId}`, () => api.cancel(request.accountId))}>
                        {t("friends.cancel")}
                      </Button>
                    </PeerRow>
                  ))}
                </div>
              </>
            )}

            <Bonus
              view={state.view}
              busy={busy === "bonus"}
              closed={rewardsClosed}
              onClaim={() => void act("bonus", () => api.claimBonus(), () => void loadWallet())}
            />
          </>
        ) : null}
      </ContentColumn>

      {removing === null ? null : (
        <Modal
          title={t("friends.remove.title", { name: removing.displayName })}
          placement="bottom"
          onDismiss={() => setRemoving(null)}
          footer={
            <>
              <Button
                variant="danger"
                block
                onClick={() => {
                  const friend = removing;
                  setRemoving(null);
                  void act(`remove:${friend.accountId}`, () => api.remove(friend.accountId));
                }}
              >
                {t("friends.remove.confirm")}
              </Button>
              <Button variant="ghost" block onClick={() => setRemoving(null)}>
                {t("friends.remove.cancel")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">{t("friends.remove.body")}</p>
        </Modal>
      )}
    </Screen>
  );
}

/**
 * Приглашение — ссылка дружбы (WP14): открывший её становится другом
 * позвавшего. Без входа ссылки дружбы нет — зовём просто поиграть.
 *
 * Способы (docs/35-stage4-plan.md Р63) — по возможностям площадки, а не по её
 * имени: сообщение с кнопкой в игру, которое готовит бот, где клиент это
 * умеет; иначе — выбор чата со ссылкой; и всегда — копия ссылки. Сообщение не
 * подготовилось — молча зовём прежним путём, а не показываем ошибку.
 */
function Invite(props: { withAccount: boolean }): ReactNode {
  const botUrl = useShell((state) => state.capabilities.botUrl);
  const [state, setState] = useState<InviteState>("idle");
  const [busy, setBusy] = useState<"send" | "copy" | null>(null);
  const adapter = useShell.getState().adapter;
  const withMessage = props.withAccount && adapter.inviteMethods?.().preparedMessage === true;

  const inviteUrl = async (): Promise<string> => {
    if (!props.withAccount) return botUrl;
    const link = await api.link();
    return link.ok ? friendInviteUrl(botUrl, link.data.startParam) : botUrl;
  };

  const send = async (): Promise<void> => {
    if (botUrl === "" || busy !== null) return;
    setBusy("send");
    let method = withMessage ? "message" : "link";
    track("share_offered", { context: "friends_invite", method });
    let result: InviteResult | "sent" = "unavailable";
    if (withMessage) {
      const prepared = await api.inviteMessage();
      const shared = prepared.ok ? await adapter.sharePreparedMessage?.(prepared.data.messageId) : undefined;
      if (shared === "shared") result = "sent";
      else if (shared === "cancelled") result = "cancelled";
    }
    if (result === "unavailable") {
      method = "link";
      result = await adapter.invite({ url: await inviteUrl(), text: t("friends.invite.text") });
    }
    track("share_completed", { context: "friends_invite", method, result });
    setState(result === "cancelled" ? "idle" : result);
    setBusy(null);
  };

  const copy = async (): Promise<void> => {
    if (botUrl === "" || busy !== null) return;
    setBusy("copy");
    track("share_offered", { context: "friends_invite", method: "copy" });
    const copied = await copyText(await inviteUrl());
    track("share_completed", { context: "friends_invite", method: "copy", result: copied ? "copied" : "unavailable" });
    setState(copied ? "copied" : "unavailable");
    setBusy(null);
  };

  return (
    <>
      <div className="mt-4 flex flex-col items-center gap-3 text-center">
        <IconEmblem size="l">
          <UserPlus size={36} />
        </IconEmblem>
        <h2 className="font-display text-xl font-bold text-text">{t("friends.invite.title")}</h2>
        <p className="max-w-[320px] text-sm text-text-muted">{t("friends.invite.body")}</p>
      </div>
      <div className="mt-5 grid gap-2">
        <Button size="l" block glow disabled={botUrl === "" || busy === "copy"} loading={busy === "send"} onClick={() => void send()}>
          <Send size={20} aria-hidden="true" />
          {t("friends.invite.action")}
        </Button>
        <Button variant="secondary" block disabled={botUrl === "" || busy === "send"} loading={busy === "copy"} onClick={() => void copy()}>
          <Copy size={18} aria-hidden="true" />
          {t("friends.invite.copy")}
        </Button>
        <p role="status" className="min-h-5 text-center text-xs text-text-muted">
          {botUrl === "" ? t("friends.invite.noBot") : state === "idle" ? "" : t(`friends.invite.${state}`)}
        </p>
      </div>
      <Card>
        <ul className="grid gap-2 text-sm text-text-muted">
          <li className="flex items-start gap-2">
            <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
            {t("friends.invite.point.free")}
          </li>
          <li className="flex items-start gap-2">
            <Trophy size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
            {t("friends.invite.point.reward")}
          </li>
          <li className="flex items-start gap-2">
            <Gift size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-info" />
            {t("friends.invite.point.gifts")}
          </li>
        </ul>
      </Card>
    </>
  );
}

function Gifts(props: { view: FriendsView; busy: boolean; closed: boolean; onClaim: () => void }): ReactNode {
  const { gifts } = props.view;
  if (gifts.pending === 0) return null;
  return (
    <>
      <SectionTitle>{t("friends.gifts.title")}</SectionTitle>
      <Card>
        <div className="flex items-center gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
            <Gift size={20} />
          </span>
          <p className="min-w-0 flex-1 text-sm text-text">
            {gifts.claimableToday > 0 ? t("friends.gifts.ready", { count: gifts.claimableToday, coins: formatNumber(gifts.coins) }) : t("friends.gifts.pendingOnly")}
          </p>
          {gifts.claimableToday > 0 ? (
            <Button loading={props.busy} disabled={props.closed} onClick={props.onClaim}>
              {t("friends.gifts.claim")}
            </Button>
          ) : null}
        </div>
      </Card>
    </>
  );
}

function Bonus(props: { view: FriendsView; busy: boolean; closed: boolean; onClaim: () => void }): ReactNode {
  const { bonus } = props.view;
  if (bonus.steps.length === 0) return null;
  return (
    <>
      <SectionTitle>{t("friends.bonus.title")}</SectionTitle>
      <Card>
        <p className="text-sm text-text-muted">{t("friends.bonus.body", { qualified: bonus.qualified })}</p>
        <ul className="mt-2 grid gap-1">
          {bonus.steps.map((step) => (
            <li key={step.friends} className={`flex items-center justify-between gap-2 text-sm ${step.state === "locked" ? "text-text-muted" : "text-text"}`}>
              <span>{t("friends.bonus.step", { friends: step.friends, coins: formatNumber(step.coins) })}</span>
              {step.state === "claimed" ? <span className="text-xs text-success">{t("friends.bonus.claimed")}</span> : null}
            </li>
          ))}
        </ul>
        {bonus.readyCoins > 0 ? (
          <div className="mt-3">
            <Button block loading={props.busy} disabled={props.closed} onClick={props.onClaim}>
              {t("friends.bonus.claim", { coins: formatNumber(bonus.readyCoins) })}
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  );
}

/** Строка другого игрока: имя и аватар — то же, что и так видно в рейтинге. */
function PeerRow(props: { name: string; photoUrl: string | null; children: ReactNode; onPress?: () => void }): ReactNode {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={props.onPress === undefined}
          onClick={props.onPress}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-label={props.onPress === undefined ? props.name : t("friends.remove.title", { name: props.name })}
        >
          <Avatar name={props.name} url={props.photoUrl} size={36} />
          <span className="min-w-0 truncate text-sm font-medium text-text">{props.name}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">{props.children}</div>
      </div>
    </Card>
  );
}
