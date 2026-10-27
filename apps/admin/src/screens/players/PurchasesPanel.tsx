import { useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import {
  fulfillPurchase,
  PURCHASE_NOTE_MAX,
  purchaseLabel,
  purchaseNoteProblem,
  purchaseState,
  refundPurchase,
  refundReasonLabel,
  type PlayerCard,
  type PlayerPurchase,
} from "../../api/players";
import { formatDateTime, formatNumber } from "../../format";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, Field, Notice, Panel, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";

type SupportAction = "refund" | "fulfill";

const NOT_FULFILLED_HINT = "Выдача ещё не прошла: задание оплаты повторяет её около 35 минут, потом раз в 5 минут — проход довыдачи";

/**
 * Покупки игрока и что с ними сейчас (docs/29-admin-panel.md, «Игроки»).
 * Какие кнопки показать, решает сервер: у покупки `actions` — свою логику
 * «можно ли» панель не заводит. Действие — только окном с причиной.
 */
export function PurchasesPanel({ card, onChanged }: { card: PlayerCard; onChanged: () => void }) {
  const [acting, setActing] = useState<{ purchase: PlayerPurchase; action: SupportAction } | null>(null);
  const purchases = card.purchases;
  // Пустую колонку кнопок не рисуем: у геймдизайнера и маркетолога действий нет.
  const withActions = purchases?.some((purchase) => purchase.actions.length > 0) === true;

  return (
    <Panel title="Покупки" help={HELP.players.purchases}>
      {purchases === null ? (
        <p className="text-sm text-text-muted">Скрыто: нет права на аналитику выручки.</p>
      ) : (
        <DataTable
          rows={purchases}
          rowKey={(purchase) => purchase.purchaseId}
          empty="Покупок нет"
          columns={[
            { title: "Счёт", render: (purchase) => formatDateTime(purchase.invoicedAt) },
            { title: "Что", render: (purchase) => purchaseLabel(purchase) },
            { title: "Режим", render: (purchase) => purchase.mode },
            { title: "Списано, ⭐", render: (purchase) => formatNumber(purchase.chargedStars), align: "right" },
            { title: "Оплачен", render: (purchase) => formatDateTime(purchase.paidAt) },
            { title: "Состояние", render: (purchase) => <PurchaseState purchase={purchase} /> },
            ...(withActions
              ? [
                  {
                    title: "",
                    align: "right" as const,
                    render: (purchase: PlayerPurchase) => (
                      <span className="inline-flex gap-1.5">
                        {purchase.actions.includes("fulfill") ? (
                          <Button className="whitespace-nowrap" onClick={() => setActing({ purchase, action: "fulfill" })}>
                            Выдать…
                          </Button>
                        ) : null}
                        {purchase.actions.includes("refund") ? (
                          <Button tone="danger" className="whitespace-nowrap" onClick={() => setActing({ purchase, action: "refund" })}>
                            Вернуть звёзды…
                          </Button>
                        ) : null}
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      <SupportDialog accountId={card.account.accountId} acting={acting} onClose={() => setActing(null)} onDone={onChanged} />
    </Panel>
  );
}

function PurchaseState({ purchase }: { purchase: PlayerPurchase }) {
  const state = purchaseState(purchase);
  return (
    <span className="flex flex-col items-start gap-0.5 whitespace-nowrap">
      <span title={state.label === "не выдан" ? NOT_FULFILLED_HINT : undefined}>
        <Badge tone={state.tone}>{state.label}</Badge>
      </span>
      {purchase.refundedAt === null ? null : (
        <span className="text-xs text-text-muted">
          {formatDateTime(purchase.refundedAt)} · {refundReasonLabel(purchase.refundReason)}
        </span>
      )}
      {purchase.refundedAt === null && purchase.refundRequestedAt !== undefined && purchase.refundRequestedAt !== null ? (
        <span className="text-xs text-text-muted">с {formatDateTime(purchase.refundRequestedAt)}</span>
      ) : null}
    </span>
  );
}

const DIALOG_TEXT: Record<SupportAction, { title: string; body: string }> = {
  refund: {
    title: "Вернуть звёзды",
    body: "Звёзды вернутся игроку в течение минуты. Если покупка уже выдана, после возврата у игрока заберём остаток: самоцветы и другие ресурсы покупки — до того, что есть на счёте, у VIP — неиспользованную часть, продление выключится. Отменить возврат нельзя.",
  },
  fulfill: {
    title: "Выдать покупку",
    body: "Выдача запустится сейчас. Дважды ничего не начислится: у выдачи свой ключ.",
  },
};

/** Возврат или повторная выдача — с причиной: она остаётся в журнале действий и в потоке «Покупки». */
function SupportDialog({
  accountId,
  acting,
  onClose,
  onDone,
}: {
  accountId: string;
  acting: { purchase: PlayerPurchase; action: SupportAction } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const close = () => {
    setNote("");
    setError(null);
    onClose();
  };

  const action = acting?.action ?? "refund";
  const text = DIALOG_TEXT[action];

  const submit = async () => {
    if (acting === null) return;
    setPending(true);
    setError(null);
    const call = acting.action === "refund" ? refundPurchase : fulfillPurchase;
    const result = await call(api, accountId, acting.purchase.purchaseId, note.trim());
    setPending(false);
    if (!result.ok) {
      // Покупку мог изменить проход довыдачи или другой человек — таблица покажет, что с ней сейчас.
      if (result.error.status === 409) onDone();
      return setError(result.error);
    }
    if (acting.action === "refund") toast.success("Возврат заказан", { description: "Звёзды вернутся в течение минуты" });
    else toast.success("Покупка выдана");
    close();
    onDone();
  };

  const purchase = acting?.purchase ?? null;
  return (
    <Dialog
      open={acting !== null}
      onOpenChange={(open) => (open ? undefined : close())}
      title={text.title}
      description={purchase === null ? "" : `${purchaseLabel(purchase)} · ${formatNumber(purchase.chargedStars)} ⭐ · оплачен ${formatDateTime(purchase.paidAt)}`}
      footer={
        <>
          <Button onClick={close}>Отмена</Button>
          <Button tone={action === "refund" ? "danger" : "primary"} disabled={purchaseNoteProblem(note) !== null || pending} onClick={() => void submit()}>
            {pending ? "Отправляем…" : action === "refund" ? `Вернуть ${formatNumber(purchase?.chargedStars ?? 0)} ⭐` : "Выдать"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm">{text.body}</p>
        <Field label="Причина" hint="Попадёт в журнал действий и в сообщение команде в поток «Покупки».">
          <TextArea rows={3} maxLength={PURCHASE_NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <p className="text-right text-xs text-text-muted">
          {note.trim().length} / {PURCHASE_NOTE_MAX}
        </p>
        {error === null ? null : <Notice>{error.message}</Notice>}
      </div>
    </Dialog>
  );
}
