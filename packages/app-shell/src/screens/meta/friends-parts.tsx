import { useState, type ReactNode } from "react";
import type { InviteResult } from "@bh/shared-types";
import { Check, Copy, Gift, Send, Trophy, UserPlus } from "lucide-react";
import { Avatar, Button, Card, IconEmblem, SectionTitle } from "../../design-system/components";
import { CoinIcon } from "../../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../../i18n";
import { copyText } from "../../state/clipboard";
import { friendInviteUrl, type FriendsApi, type FriendsView } from "../../state/friends-api";
import { track, useShell } from "../../state/shell";
import { bonusTrack } from "./friends-rules";

/**
 * Части экрана друзей (docs/35-stage4-plan.md §3.8, tasks/T-0048): приглашение
 * в двух видах, полоса бонуса, подарки и строка друга. Тон раздела — тон
 * виджета друзей на главной (`widget-friends`), чтобы экран читался продолжением
 * плитки, с которой на него пришли.
 */

/** `sent` — сообщение от бота ушло; `shared` — открыт выбор чата со ссылкой, отправил ли игрок, неизвестно. */
type InviteState = "idle" | "sent" | "shared" | "copied" | "unavailable";

/** Полоса бонуса, нужная приглашению: данные и действие «Забрать» живут на экране. */
export interface BonusProps {
  bonus: FriendsView["bonus"];
  busy: boolean;
  closed: boolean;
  onClaim: () => void;
}

/**
 * Полоса шагов бонуса за число друзей: шаги равными промежутками, на шаге —
 * число друзей, под ним — монеты. Пройденный шаг — заливка тона друзей и
 * галочка, готовый к забору — акцент со свечением. Заливка анимируется только
 * `transform`.
 */
export function BonusTrack(props: BonusProps): ReactNode {
  const { bonus } = props;
  if (bonus.steps.length === 0) return null;
  const last = bonus.steps.length - 1;
  const { fill } = bonusTrack(bonus.qualified, bonus.steps);
  const at = (index: number): string => `${last === 0 ? 0 : (index / last) * 100}%`;
  return (
    <div className="mt-3">
      <div className="relative mx-2.5 mt-3">
        <div className="h-1.5 overflow-hidden rounded-sm bg-surface-sunken">
          <div className="h-full origin-left bg-(--widget-friends-tone) transition-transform duration-(--duration-base) ease-base" style={{ transform: `scaleX(${fill})` }} />
        </div>
        {bonus.steps.map((step, index) => (
          <span
            key={step.friends}
            style={{ left: at(index) }}
            className={[
              "absolute top-1/2 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border font-display text-[10px] leading-none",
              step.state === "claimed"
                ? "border-(--widget-friends-tone) bg-(--widget-friends-tone) text-on-accent"
                : step.state === "ready"
                  ? "border-accent bg-accent text-on-accent shadow-[0_0_14px_-2px_var(--color-accent)]"
                  : "border-border-strong bg-surface-raised text-text-muted",
            ].join(" ")}
          >
            {step.state === "claimed" ? <Check size={11} strokeWidth={3} aria-label={t("friends.bonus.claimed")} /> : step.friends}
          </span>
        ))}
      </div>
      {/* Первая подпись прижата влево, последняя — вправо: иначе они выходят за край экрана.
          На узкой полосе значки монет не умещаются рядом с четырёхзначными числами и налезают на соседей —
          там остаются одни числа: что это монеты, говорит кнопка «Забрать N монет». */}
      <div className="@container relative mx-2.5 mt-3.5 h-4">
        {bonus.steps.map((step, index) => (
          <span
            key={step.friends}
            style={index === 0 || index === last ? undefined : { left: at(index) }}
            className={`absolute flex items-center gap-0.5 text-[10.5px] leading-tight font-semibold whitespace-nowrap text-text ${
              index === 0 ? "left-0" : index === last ? "right-0" : "-translate-x-1/2"
            }`}
          >
            <span className="hidden @min-[19rem]:inline-flex">
              <CoinIcon size={12} />
            </span>
            {formatNumber(step.coins)}
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-text-muted">{t("friends.bonus.counted", { qualified: bonus.qualified })}</p>
      {bonus.readyCoins > 0 ? (
        <div className="mt-2.5">
          <Button block loading={props.busy} disabled={props.closed} onClick={props.onClaim}>
            {t("friends.bonus.claim", { coins: formatNumber(bonus.readyCoins) })}
          </Button>
        </div>
      ) : null}
    </div>
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
 *
 * `full` — крупное, пока друзей нет; `card` — компактная карточка с полосой
 * бонуса, когда друзья есть.
 */
export function Invite(props: { api: FriendsApi; withAccount: boolean; variant: "full" | "card"; bonus?: BonusProps }): ReactNode {
  const { api } = props;
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

  const status = (
    <p role="status" className="min-h-5 text-center text-xs text-text-muted">
      {botUrl === "" ? t("friends.invite.noBot") : state === "idle" ? "" : t(`friends.invite.${state}`)}
    </p>
  );

  if (props.variant === "card") {
    const next = props.bonus === undefined ? null : bonusTrack(props.bonus.bonus.qualified, props.bonus.bonus.steps);
    return (
      <div className="widget-friends widget-surface mt-4 rounded-lg p-3">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-(--widget-tone)/15 text-(--widget-tone)">
            <UserPlus size={22} />
          </span>
          <div className="min-w-0">
            <p className="font-display text-base leading-tight text-text">{t("friends.invite.more")}</p>
            {next?.left == null ? null : <p className="text-xs text-text-muted">{t("friends.invite.next", { left: next.left })}</p>}
          </div>
        </div>
        {props.bonus === undefined ? null : <BonusTrack {...props.bonus} />}
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <Button block disabled={botUrl === "" || busy === "copy"} loading={busy === "send"} onClick={() => void send()}>
            <Send size={18} aria-hidden="true" />
            {t("friends.invite.action")}
          </Button>
          <Button variant="secondary" block disabled={botUrl === "" || busy === "send"} loading={busy === "copy"} onClick={() => void copy()}>
            <Copy size={18} aria-hidden="true" />
            {t("friends.invite.copyShort")}
          </Button>
        </div>
        <div className="mt-1">{status}</div>
      </div>
    );
  }

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
        {status}
      </div>
      {props.bonus === undefined || props.bonus.bonus.steps.length === 0 ? null : (
        <div className="widget-friends mb-3">
          <SectionTitle>{t("friends.bonus.title")}</SectionTitle>
          <BonusTrack {...props.bonus} />
        </div>
      )}
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

export function Gifts(props: { view: FriendsView; busy: boolean; closed: boolean; onClaim: () => void }): ReactNode {
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

/**
 * «Подарить всем» над списком: сколько друзей получат подарок сейчас и по
 * сколько монет. Всем уже подарено — строка говорит об этом и о завтрашнем дне.
 */
export function GiftAll(props: { count: number; coins: number; busy: boolean; closed: boolean; onGift: () => void }): ReactNode {
  if (props.count === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border bg-surface px-3 py-2.5 opacity-75">
        <Check size={18} aria-hidden="true" className="shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text">{t("friends.giftAll.done")}</p>
          <p className="text-xs text-text-muted">{t("friends.giftAll.tomorrow")}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="widget-friends flex items-center gap-2.5 rounded-lg border border-dashed border-[color-mix(in_oklab,var(--widget-tone)_50%,var(--color-border))] bg-surface px-3 py-2.5">
      <Gift size={18} aria-hidden="true" className="shrink-0 text-(--widget-tone)" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">{t("friends.giftAll.title", { count: props.count })}</p>
        <p className="text-xs text-text-muted">{t("friends.giftAll.hint", { coins: formatNumber(props.coins) })}</p>
      </div>
      <Button loading={props.busy} disabled={props.closed} onClick={props.onGift}>
        {t("friends.giftAll.action")}
      </Button>
    </div>
  );
}

/**
 * Строка другого игрока: имя и аватар — то же, что и так видно в рейтинге.
 * После имени — место под знак (`badge`): знак «Тестер» рисует T-0043.
 */
export function PeerRow(props: { name: string; photoUrl: string | null; children: ReactNode; onPress?: () => void; badge?: ReactNode }): ReactNode {
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
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-medium text-text">{props.name}</span>
            {props.badge}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">{props.children}</div>
      </div>
    </Card>
  );
}
