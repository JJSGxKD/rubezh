import type { ReactNode } from "react";
import type { ParticipantStatus, PayoutStatusView } from "../../../api/ledger-periods";
import { Badge, Button } from "../../../ui/kit";
import { confirmationLabel, formatRub, payoutTargets, type PayoutTarget } from "./model";

/**
 * Закрытый месяц: кому сколько должны, кто что решил по отчёту и кому можно платить (tasks/T-0470, Р222). Долги,
 * выплаченное, остатки и «можно ли платить» — как их вернул сервер; кнопка «Выплатить» есть там, где сервер разрешил
 * (подтвердил, молчит дольше срока или оспорил — тогда форма потребует причину). Налог, транши займов и доля
 * владельца — отдельными строками ниже.
 */

function toneOf(participant: ParticipantStatus): "success" | "danger" | "neutral" {
  return participant.confirmation?.status === "confirmed" ? "success" : participant.confirmation?.status === "disputed" ? "danger" : "neutral";
}

function money(label: string, value: string): ReactNode {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-sm tabular-nums">{value}</span>
    </div>
  );
}

function payeeLabel(status: PayoutStatusView, payee: string): string {
  if (payee === "owner") return "Владелец";
  if (payee === "tax") return "Налог НПД";
  if (payee.startsWith("loan:")) return `Заём: ${status.loans.find((loan) => `loan:${loan.loanId}` === payee)?.lender ?? payee.slice(5, 13)}`;
  const accountId = payee.replace(/^stakeholder:/u, "");
  return status.participants.find((participant) => participant.accountId === accountId)?.name ?? payee;
}

export function ParticipantsView({ status, canPay, now, onPay }: { status: PayoutStatusView; canPay: boolean; now: Date; onPay: (target: PayoutTarget) => void }): ReactNode {
  const targets = payoutTargets(status);
  const closedAt = new Date(status.closedAt);
  const targetOf = (payee: string): PayoutTarget | undefined => targets.find((target) => target.payee === payee);
  const payButton = (target: PayoutTarget | undefined): ReactNode =>
    canPay && target !== undefined ? <Button tone="primary" onClick={() => onPay(target)}>{target.action}</Button> : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">{`Участник подтверждает отчёт в кабинете «Мой проект»; молчит дольше ${String(status.confirmDays)} дн. — платить можно по вашему решению с причиной.`}</p>

      {status.participants.length === 0 ? (
        <p className="text-sm text-text-muted">Участникам в этом месяце ничего не причитается</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {status.participants.map((participant) => (
            <li key={participant.accountId} className="flex flex-col gap-2 rounded-sm border border-border bg-surface-sunken p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{participant.name}</span>
                  <Badge tone={toneOf(participant)}>{confirmationLabel(participant, closedAt, now)}</Badge>
                </div>
                {payButton(targetOf(`stakeholder:${participant.accountId}`))}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {money("Долг", formatRub(participant.owedRub))}
                {money("Выплачено", formatRub(participant.paidRub))}
                {money("Остаток", formatRub(participant.remainingRub))}
              </div>
              {participant.reason === null ? null : <p className="text-xs text-text-muted">{participant.reason}</p>}
            </li>
          ))}
        </ul>
      )}

      {status.tax === null && status.loans.length === 0 && status.owner === null ? null : (
        <ul className="flex flex-col gap-2">
          {status.tax === null ? null : (
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-surface-sunken p-3">
              <div>
                <p className="text-sm font-medium">Налог НПД</p>
                <p className="text-xs text-text-muted">{`${formatRub(status.tax.owedRub)} к уплате · выплачено ${formatRub(status.tax.paidRub)} · осталось ${formatRub(status.tax.remainingRub)}`}</p>
              </div>
              {payButton(targetOf("tax"))}
            </li>
          )}
          {status.loans.map((loan) => (
            <li key={loan.loanId} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-surface-sunken p-3">
              <div>
                <p className="text-sm font-medium">{`Заём: ${loan.lender}`}</p>
                <p className="text-xs text-text-muted">{`транш ${loan.owed} ${loan.currency} · выплачено ${loan.paid} · осталось ${loan.remaining}`}</p>
              </div>
              {payButton(targetOf(`loan:${loan.loanId}`))}
            </li>
          ))}
          {status.owner === null ? null : (
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-surface-sunken p-3">
              <div>
                <p className="text-sm font-medium">Доля владельца</p>
                <p className="text-xs text-text-muted">{`$${status.owner.shareUsd} по отчёту; забрать можно любую часть, остальное остаётся в бюджете проекта`}</p>
              </div>
              {payButton(targetOf("owner"))}
            </li>
          )}
        </ul>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Выплаты месяца</h3>
        {status.payouts.length === 0 ? (
          <p className="text-sm text-text-muted">Выплат пока не было — пока их нет, закрытие можно снять</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {status.payouts.map((payout) => (
              <li key={payout.operationId} className="flex flex-col gap-0.5 text-sm">
                <span className="flex flex-wrap justify-between gap-2">
                  <span>{payeeLabel(status, payout.payee)}</span>
                  <span className="tabular-nums">{`${payout.amount} ${payout.currency} · ${payout.at.slice(0, 10)}`}</span>
                </span>
                {payout.overrideReason === null ? null : <span className="text-xs text-text-muted">{`Причина решения владельца: ${payout.overrideReason}`}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
