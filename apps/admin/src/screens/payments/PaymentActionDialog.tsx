import { useState } from "react";
import type { ApiError, ApiResult } from "../../api/client";
import { retryPayment, type FeedPurchase } from "../../api/payments";
import { fulfillPurchase, PURCHASE_NOTE_MAX, purchaseLabel, purchaseNoteProblem, refundPurchase } from "../../api/players";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { Button, Field, Notice, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { DIALOG_TEXT } from "../players/PurchasesPanel";

/** Что можно сделать с платежом из карточки; компенсация — T-0438. */
export type PaymentAction = "fulfill" | "retry" | "refund";

const TEXT: Record<PaymentAction, { title: string; body: string }> = {
  fulfill: DIALOG_TEXT.fulfill,
  retry: {
    title: "Повторить учёт",
    body: "Сервер повторит брошенное задание оплаты или запишет оплату по выписке площадки. Дважды ничего не начислится: оплата пишется по её идентификатору один раз, выдача — по ключу покупки.",
  },
  refund: DIALOG_TEXT.refund,
};

function call(action: PaymentAction, purchase: FeedPurchase, note: string): Promise<ApiResult<unknown>> {
  if (action === "retry") return retryPayment(api, purchase.purchaseId, note);
  // «Вернуть звёзды» и «Выдать» — те же ручки, что в карточке игрока: адрес с аккаунтом из карточки платежа.
  return (action === "refund" ? refundPurchase : fulfillPurchase)(api, purchase.accountId, purchase.purchaseId, note);
}

function toastDone(action: PaymentAction): void {
  if (action === "refund") toast.success("Возврат заказан", { description: "Звёзды вернутся в течение минуты" });
  else if (action === "retry") toast.success("Учёт повторён", { description: "Задание в очереди — карточка обновится через минуту" });
  else toast.success("Покупка выдана");
}

/**
 * Действие над платежом — окном с причиной (3–200 знаков), по образцу окна
 * карточки игрока. Пока запрос летит, окно не закрывается и кнопка выключена:
 * иначе двойное нажатие отправило бы действие дважды, а исход не увидеть.
 * `409` — действие стало недоступно (платёж изменил проход довыдачи или другой
 * человек): карточка перечитывается, а текст сервера остаётся в окне.
 */
export function PaymentActionDialog({ purchase, action, onClose, onDone }: { purchase: FeedPurchase; action: PaymentAction | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const close = () => {
    if (pending) return;
    setNote("");
    setError(null);
    onClose();
  };

  const shown = action ?? "fulfill";
  const text = TEXT[shown];

  const submit = async () => {
    if (action === null || pending) return;
    setPending(true);
    setError(null);
    const result = await call(action, purchase, note.trim());
    setPending(false);
    if (!result.ok) {
      if (result.error.status === 409) onDone();
      return setError(result.error);
    }
    toastDone(action);
    close();
    onDone();
  };

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => (open ? undefined : close())}
      title={text.title}
      description={`${purchaseLabel(purchase)} · ${formatNumber(purchase.chargedStars)} ⭐ · оплачен ${formatDateTime(purchase.paidAt)}`}
      footer={
        <>
          <Button disabled={pending} onClick={close}>
            Отмена
          </Button>
          <Button tone={shown === "refund" ? "danger" : "primary"} disabled={purchaseNoteProblem(note) !== null || pending} onClick={() => void submit()}>
            {pending ? "Отправляем…" : shown === "refund" ? `Вернуть ${formatNumber(purchase.chargedStars)} ⭐` : shown === "retry" ? "Повторить" : "Выдать"}
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
