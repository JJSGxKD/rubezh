import { useState, type ReactNode } from "react";
import { MODES, PLATFORMS, fetchPaymentCard, titleOf, type FeedPurchase, type PaymentCard } from "../../api/payments";
import { purchaseLabel } from "../../api/players";
import { formatDateTime, formatNumber } from "../../format";
import { hrefOf } from "../../routes";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Button, ErrorNotice, KeyValue, Loading, Notice, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { filtersFromAccount } from "./feed-filters";
import { PaymentActionDialog, type PaymentAction } from "./PaymentActionDialog";
import { MarkBadges, StateBadges, showAccountFeed } from "./PaymentsFeed";

/** Скопировать в буфер: успех и отказ браузера — уведомлением, а не молчанием. */
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Скопировано");
  } catch {
    toast.error("Не удалось скопировать");
  }
}

const BUTTONS: readonly { action: PaymentAction; title: string; tone: "secondary" | "danger" }[] = [
  { action: "fulfill", title: "Выдать…", tone: "secondary" },
  { action: "retry", title: "Повторить учёт…", tone: "secondary" },
  { action: "refund", title: "Вернуть звёзды…", tone: "danger" },
];

const toPayments = () => navigate({ section: "payments", id: null });

/**
 * Карточка платежа (tasks/T-0437, docs/29-admin-panel.md §2, «Платежи»):
 * поля покупки, игрок, хронология и кнопки. Какие кнопки показать, решает
 * сервер — список `actions` карточки; своей логики «можно ли» панель не
 * заводит. Действие — только окном с причиной; после него карточка
 * перечитывается.
 */
export function PaymentCardView({ purchaseId }: { purchaseId: string }) {
  const { state, reload } = useApi(() => fetchPaymentCard(api, purchaseId), [purchaseId]);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button onClick={toPayments}>← Платежи</Button>
      </div>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" && state.error.kind === "not_found" ? <Notice tone="warning">Покупка не найдена</Notice> : null}
      {state.status === "error" && state.error.kind !== "not_found" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? <Card card={state.data} onChanged={reload} /> : null}
    </div>
  );
}

function Card({ card, onChanged }: { card: PaymentCard; onChanged: () => void }) {
  const { purchase, account } = card;
  const [acting, setActing] = useState<PaymentAction | null>(null);
  // Только известные панели действия: `compensate` рисует T-0438, незнакомое — не наша забота.
  const buttons = BUTTONS.filter((button) => card.actions.includes(button.action));
  const timeline = [...card.timeline].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return (
    <>
      <Panel title={purchaseLabel(purchase)}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold tabular-nums">{formatNumber(purchase.chargedStars)} ⭐</span>
          <StateBadges purchase={purchase} />
          <MarkBadges marks={card.marks} />
        </div>
        <KeyValue
          items={[
            ["Покупка", <Copyable key="id" text={purchase.purchaseId} />],
            ["Оплата", purchase.telegramChargeId === null ? "—" : <Copyable key="charge" text={purchase.telegramChargeId} />],
            [
              "Игрок",
              <span key="player" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <a href={hrefOf({ section: "players", id: account.accountId, tab: "purchases" })} title={account.displayName} className="block max-w-full truncate text-accent underline-offset-2 hover:underline">
                  {account.displayName}
                </a>
                <button type="button" className="text-xs text-text-muted underline hover:text-text" onClick={() => showAccountFeed(filtersFromAccount(account.accountId, account.displayName))}>
                  все платежи игрока
                </button>
              </span>,
            ],
            ...(account.pii === null
              ? []
              : ([
                  ["ID на площадке", <span key="uid" className="break-all">{account.pii.platformUserId}</span>],
                  ["Юзернейм", account.pii.username === null ? "—" : <span key="uname" className="break-all">@{account.pii.username}</span>],
                ] as [string, ReactNode][])),
            ["Площадка", titleOf(PLATFORMS, account.platform)],
            ["Режим", titleOf(MODES, purchase.mode)],
            ["Счёт", formatDateTime(purchase.invoicedAt)],
            ["Оплачен", formatDateTime(purchase.paidAt)],
            ["Выдан", formatDateTime(purchase.fulfilledAt)],
            ["Возврат заказан", formatDateTime(purchase.refundRequestedAt)],
            ["Звёзды возвращены", formatDateTime(purchase.refundedAt)],
            ...(card.renewalOf === null ? [] : ([["Продление подписки", <PurchaseLink key="first" purchase={card.renewalOf} text="первая покупка →" />]] as [string, ReactNode][])),
            ...(card.renewals.length === 0
              ? []
              : ([
                  [
                    "Продления",
                    <span key="renewals" className="flex flex-col gap-0.5">
                      {card.renewals.map((renewal) => (
                        <PurchaseLink key={renewal.purchaseId} purchase={renewal} text={formatDateTime(renewal.invoicedAt)} />
                      ))}
                    </span>,
                  ],
                ] as [string, ReactNode][])),
          ]}
        />
      </Panel>

      <Panel title="Действия" help={HELP.payments.actions}>
        {buttons.length === 0 ? (
          <p className="text-sm text-text-muted">Сейчас с платежом ничего сделать нельзя.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {buttons.map((button) => (
              <Button key={button.action} tone={button.tone} className="whitespace-nowrap" onClick={() => setActing(button.action)}>
                {button.title}
              </Button>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Хронология" help={HELP.payments.timeline}>
        {timeline.length === 0 ? (
          <p className="text-sm text-text-muted">Записей пока нет</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {timeline.map((entry, index) => (
              <li key={`${entry.at}-${String(index)}`} className="grid grid-cols-[max-content_1fr] gap-x-3 text-sm">
                <time dateTime={entry.at} className="text-xs text-text-muted tabular-nums">
                  {formatDateTime(entry.at)}
                </time>
                <span className="min-w-0 break-words">
                  {entry.text}
                  {entry.actorName === null ? null : <span className="text-text-muted"> · {entry.actorName}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <PaymentActionDialog purchase={purchase} action={acting} onClose={() => setActing(null)} onDone={onChanged} />
    </>
  );
}

/** Значение с кнопкой «копировать»; длинное переносится в любом месте и не раздвигает карточку. */
function Copyable({ text }: { text: string }) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="min-w-0 break-all font-mono text-xs">{text}</span>
      <button type="button" className="shrink-0 text-xs text-text-muted underline hover:text-text" onClick={() => void copy(text)}>
        копировать
      </button>
    </span>
  );
}

function PurchaseLink({ purchase, text }: { purchase: FeedPurchase; text: string }) {
  return (
    <a href={hrefOf({ section: "payments", id: purchase.purchaseId })} className="text-accent underline-offset-2 hover:underline">
      {text}
    </a>
  );
}
