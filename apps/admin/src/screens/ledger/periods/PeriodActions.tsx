import type { ReactNode } from "react";
import type { PayoutStatusView, PeriodReportView } from "../../../api/ledger-periods";
import { Button } from "../../../ui/kit";
import { closeControl, reopenControl, reviewControl } from "./model";

/**
 * Действия над месяцем (tasks/T-0470): «Начать сверку», «Закрыть месяц», «Снять закрытие». Видны владельцу
 * (`finance.period.close`) и только в своём состоянии месяца; «Закрыть месяц» неактивна, пока есть блокеры, и называет
 * причину рядом. Решает сервер: скрытая кнопка — удобство, а не защита.
 */
export function PeriodActions({
  view,
  payouts,
  now,
  canClose,
  onReview,
  onClose,
  onReopen,
}: {
  view: PeriodReportView;
  /** статус выплат закрытого месяца; `null` — не загружен или месяц не закрыт */
  payouts: PayoutStatusView | null;
  now: Date;
  canClose: boolean;
  onReview: () => void;
  onClose: () => void;
  onReopen: () => void;
}): ReactNode {
  const review = reviewControl({ period: view.period, status: view.status, now, allowed: canClose });
  const close = closeControl({ view, allowed: canClose });
  // Пока выплаты не загрузились, число выплат неизвестно — снять закрытие предлагать рано.
  const reopen = payouts !== null && reopenControl({ status: view.status, payoutsCount: payouts.payouts.length, allowed: canClose });
  if (!review && !close.visible && !reopen) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {review ? (
        <Button tone="primary" onClick={onReview}>
          Начать сверку
        </Button>
      ) : null}
      {close.visible ? (
        <Button tone="primary" disabled={close.disabled} blockedBy={close.blockedBy} onClick={onClose}>
          Закрыть месяц
        </Button>
      ) : null}
      {reopen ? (
        <Button tone="danger" onClick={onReopen}>
          Снять закрытие
        </Button>
      ) : null}
    </div>
  );
}
