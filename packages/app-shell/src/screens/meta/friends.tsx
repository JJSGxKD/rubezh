import { useEffect, useState, type ReactNode } from "react";
import { Button, ContentColumn, ErrorState, Modal, PageTitle, Screen, SectionTitle, InfoNotice } from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import "../../i18n/friends";
import type { ApiResult } from "../../state/api-request";
import { loadBadges } from "../../state/badges-api";
import { createFriendsApi, friendsAvailable, type FriendEntry, type FriendsView } from "../../state/friends-api";
import { restrictionRefusal, useRestricted } from "../../state/restrictions";
import { loadWallet } from "../../state/wallet-api";
import { friendsLayout, giftAllCount } from "./friends-rules";
import { GiftAll, Gifts, Invite, PeerAction, PeerRow } from "./friends-parts";
import { TesterBadge } from "./tester-badge";
import { RestrictedPlaque } from "./restricted-plaque";

/**
 * Раздел «Друзья» (docs/35-stage4-plan.md §3.8, WP14; О5 в
 * docs/36-parallel-work.md): приглашение ссылкой дружбы, заявки, подарки раз
 * в день и бонус за число друзей. Правила и числа — у сервера: экран
 * показывает, что можно сделать сейчас, и перечитывает раздел после каждого
 * действия. Без входа — только приглашение: дружба бывает лишь между
 * аккаунтами.
 *
 * Порядок зависит от друзей (`friendsLayout`): пока их нет — крупное
 * приглашение сверху; когда есть — подарки, заявки и список, а приглашение
 * компактной карточкой с полосой бонуса за число друзей. Пока сервер не
 * ответил, экран показывает только «Загружаем друзей…»: приглашение, которое
 * уступает место списку, мелькало бы у тех, у кого друзья есть.
 */

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

  const view = state.status === "ready" ? state.view : null;
  const layout = friendsLayout({ withAccount, status: state.status, friendsCount: view?.friends.length ?? 0 });
  const bonus =
    view === null
      ? undefined
      : { bonus: view.bonus, busy: busy === "bonus", closed: rewardsClosed, onClaim: () => void act("bonus", () => api.claimBonus(), () => void loadWallet()) };

  const incoming =
    view === null || view.incoming.length === 0 ? null : (
      <>
        <SectionTitle>{t("friends.incoming")}</SectionTitle>
        <div className="grid gap-2">
          {view.incoming.map((request) => (
            <PeerRow key={request.accountId} name={request.displayName} photoUrl={request.photoUrl} badge={request.tester === true ? <TesterBadge /> : undefined}>
              <PeerAction kind="accept" variant="secondary" loading={busy === `accept:${request.accountId}`} onClick={() => void act(`accept:${request.accountId}`, () => api.accept(request.accountId))} />
              <PeerAction kind="decline" variant="ghost" loading={busy === `decline:${request.accountId}`} onClick={() => void act(`decline:${request.accountId}`, () => api.decline(request.accountId))} />
            </PeerRow>
          ))}
        </div>
      </>
    );

  const outgoing =
    view === null || view.outgoing.length === 0 ? null : (
      <>
        <SectionTitle>{t("friends.outgoing")}</SectionTitle>
        <div className="grid gap-2">
          {view.outgoing.map((request) => (
            <PeerRow key={request.accountId} name={request.displayName} photoUrl={request.photoUrl} badge={request.tester === true ? <TesterBadge /> : undefined}>
              <Button variant="ghost" loading={busy === `cancel:${request.accountId}`} onClick={() => void act(`cancel:${request.accountId}`, () => api.cancel(request.accountId))}>
                {t("friends.cancel")}
              </Button>
            </PeerRow>
          ))}
        </div>
      </>
    );

  const gifts =
    view === null ? null : (
      <Gifts
        view={view}
        busy={busy === "gifts"}
        closed={giftsClosed}
        onClaim={() =>
          void act("gifts", () => api.claimGifts(), (claim) => {
            // Монет меньше обещанного — упёрлись в суточный потолок кошелька.
            const promised = claim.claimed * view.gifts.coins;
            setNotice(claim.coins < promised ? t("friends.gifts.capped") : t("friends.gifts.claimed", { count: claim.claimed, coins: formatNumber(claim.coins) }));
            void loadWallet();
          })
        }
      />
    );

  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("friends.title")}</PageTitle>
        {withAccount ? <RestrictedPlaque kinds={RESTRICTIONS} className="mt-4" /> : null}
        {layout === "invite-first" ? <Invite api={api} withAccount={withAccount} variant="full" {...(bonus === undefined ? {} : { bonus })} /> : layout === "list-first" ? gifts : null}

        {!withAccount ? <InfoNotice text={t("friends.guest")} /> : null}
        {withAccount && state.status === "loading" ? <p className="mt-4 text-sm text-text-muted">{t("friends.loading")}</p> : null}
        {withAccount && state.status === "failed" ? <ErrorState text={t("friends.failed")} onRetry={() => void load()} /> : null}
        {notice === null ? null : (
          <p role="status" className="mt-3 text-center text-sm text-text">
            {notice}
          </p>
        )}

        {view === null ? null : layout === "invite-first" ? (
          <>
            {incoming}
            {outgoing}
            {/* Подарки не сгорают, даже если друг ушёл: забрать их можно и без списка. */}
            {gifts}
          </>
        ) : (
          <>
            {incoming}
            <SectionTitle>{t("friends.list", { count: view.friends.length, max: view.limits.maxFriends })}</SectionTitle>
            <GiftAll
              count={giftAllCount(
                view.friends.map((friend) => friend.accountId),
                view.gifts.sentToday,
              )}
              coins={view.gifts.coins}
              busy={busy === "giftAll"}
              closed={giftsClosed}
              onGift={() => void act("giftAll", () => api.giftAll(), (result) => setNotice(t("friends.giftAll.sent", { sent: result.sent })))}
            />
            <div className="mt-2 grid gap-2">
              {view.friends.map((friend) => {
                const gifted = view.gifts.sentToday.includes(friend.accountId);
                return (
                  <PeerRow
                    key={friend.accountId}
                    name={friend.displayName}
                    photoUrl={friend.photoUrl}
                    badge={friend.tester === true ? <TesterBadge /> : undefined}
                    onPress={() => setRemoving(friend)}
                  >
                    <PeerAction
                      kind={gifted ? "gifted" : "gift"}
                      variant="secondary"
                      disabled={gifted || giftsClosed}
                      loading={busy === `gift:${friend.accountId}`}
                      onClick={() => void act(`gift:${friend.accountId}`, () => api.gift(friend.accountId))}
                    />
                  </PeerRow>
                );
              })}
            </div>
            <Invite api={api} withAccount={withAccount} variant="card" {...(bonus === undefined ? {} : { bonus })} />
            {outgoing}
          </>
        )}
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
