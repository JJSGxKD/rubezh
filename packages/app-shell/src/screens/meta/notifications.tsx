import { useEffect, useState, type ReactNode } from "react";
import { Gift, Megaphone, PackageOpen, Sparkles, UserPlus } from "lucide-react";
import { Button, Card, ContentColumn, ErrorState, Screen, StubNotice } from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import "../../i18n/account";
import type { ApiFailure } from "../../state/api-request";
import { useNavigation, type ScreenId } from "../../state/navigation";
import { formatWhen, loadFeed, markRead, type NotificationItem } from "../../state/notifications-api";
import { track } from "../../state/shell";

/**
 * Лента уведомлений (docs/35-stage4-plan.md Р51, §3.17): всё, что случилось с
 * игроком, — заявка и подарок друга, редкая добыча, возврат бустов,
 * сообщение команды. Открыл
 * ленту — увиденное прочитано; пришедшее, пока лента открыта, останется
 * новым. Вид, которого экран не знает, не показывается: сервер новее клиента.
 */

type Loaded = { status: "loading" } | { status: "failed"; failure: ApiFailure } | { status: "ready"; items: NotificationItem[]; cursor: string | null };

export function NotificationsScreen(): ReactNode {
  const navigation = useNavigation();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [more, setMore] = useState(false);

  const first = async (): Promise<void> => {
    setState({ status: "loading" });
    const response = await loadFeed(null);
    if (!response.ok) {
      setState({ status: "failed", failure: response.failure });
      return;
    }
    setState({ status: "ready", items: response.data.items, cursor: response.data.nextCursor });
    const newest = response.data.items[0];
    if (newest !== undefined && response.data.unread > 0) void markRead(newest.id);
  };

  useEffect(() => {
    void first();
  }, []);

  const next = async (): Promise<void> => {
    if (state.status !== "ready" || state.cursor === null) return;
    setMore(true);
    const response = await loadFeed(state.cursor);
    setMore(false);
    if (response.ok) setState({ status: "ready", items: [...state.items, ...response.data.items], cursor: response.data.nextCursor });
  };

  return (
    <Screen title={t("notifications.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        {state.status === "loading" ? <p className="text-sm text-text-muted">{t("notifications.loading")}</p> : null}
        {state.status === "failed" ? <ErrorState text={t("notifications.failed")} onRetry={() => void first()} /> : null}
        {state.status === "ready" && state.items.length === 0 ? <StubNotice text={t("notifications.empty")} /> : null}
        {state.status === "ready" ? (
          <div className="grid gap-2">
            {state.items.map((item, index) => (
              <NotificationRow key={item.id} item={item} index={index} />
            ))}
            {state.cursor === null ? null : (
              <Button variant="secondary" block loading={more} onClick={() => void next()}>
                {t("notifications.more")}
              </Button>
            )}
          </div>
        ) : null}
      </ContentColumn>
    </Screen>
  );
}

interface Described {
  icon: ReactNode;
  /** заголовок над текстом — у сообщения команды, чтобы было видно, от кого оно */
  title?: string;
  text: string;
  /** куда ведёт касание; `null` — это просто новость */
  target: ScreenId | null;
}

function describe(item: NotificationItem): Described | null {
  const name = typeof item.data.fromName === "string" ? item.data.fromName : t("notifications.someone");
  switch (item.kind) {
    case "friend_request":
      return { icon: <UserPlus size={20} />, text: t("notification.friend_request", { name }), target: "friends" };
    case "friend_gift":
      return { icon: <Gift size={20} />, text: t("notification.friend_gift", { name }), target: "friends" };
    case "rare_loot":
      return {
        icon: <Sparkles size={20} />,
        text: item.data.salvaged === true ? t("notification.rare_loot.salvaged") : t("notification.rare_loot"),
        target: item.data.salvaged === true ? null : "arsenal",
      };
    case "boosts_refunded":
      return { icon: <PackageOpen size={20} />, text: refundText(item.data), target: null };
    case "team_message":
      return typeof item.data.text === "string" ? { icon: <Megaphone size={20} />, title: t("notification.team_message"), text: item.data.text, target: null } : null;
    default:
      return null;
  }
}

function refundText(data: Record<string, unknown>): string {
  const coins = typeof data.coins === "number" ? data.coins : 0;
  const gems = typeof data.gems === "number" ? data.gems : 0;
  const returned = [
    coins > 0 ? t("notification.boosts_refunded.coins", { amount: formatNumber(coins), n: coins }) : null,
    gems > 0 ? t("notification.boosts_refunded.gems", { amount: formatNumber(gems), n: gems }) : null,
  ].filter((part): part is string => part !== null);
  return returned.length === 0 ? t("notification.boosts_refunded") : t("notification.boosts_refunded.with", { returned: returned.join(t("notification.and")) });
}

function NotificationRow(props: { item: NotificationItem; index: number }): ReactNode {
  const described = describe(props.item);
  if (described === null) return null;
  const { target } = described;
  const open =
    target === null
      ? undefined
      : () => {
          track("notification_opened", { kind: props.item.kind });
          useNavigation.getState().resetTo(target);
        };
  return (
    <Card appearIndex={Math.min(props.index, 6)} {...(open === undefined ? {} : { onClick: open })}>
      <div className="flex items-start gap-3">
        <span className={`inline-flex size-10 shrink-0 items-center justify-center rounded-md ${props.item.read ? "surface-sunken text-text-muted" : "bg-accent/15 text-accent"}`}>
          {described.icon}
        </span>
        <div className="min-w-0 flex-1">
          {described.title === undefined ? null : <p className="text-xs font-semibold text-accent">{described.title}</p>}
          {/* Переносы строк сообщения команды — как их набрали в панели. */}
          <p className={`whitespace-pre-line break-words text-sm ${props.item.read ? "text-text-muted" : "text-text"}`}>{described.text}</p>
          <p className="mt-0.5 text-xs text-text-muted">{formatWhen(props.item.createdAt, Date.now())}</p>
        </div>
      </div>
    </Card>
  );
}
