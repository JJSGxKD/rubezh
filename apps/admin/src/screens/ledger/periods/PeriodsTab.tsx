import { useState, type ReactNode } from "react";
import { loadPeriods } from "../../../api/ledger-periods";
import { api } from "../../../services";
import { can } from "../../../state/session";
import { useSession } from "../../../state/use-session";
import { ErrorNotice, Loading } from "../../../ui/kit";
import { useApi } from "../../../ui/use-api";
import { MonthCard } from "./MonthCard";

/**
 * Вкладка «Месяцы» раздела «Бухгалтерия» (tasks/T-0470, Р222, docs/29-admin-panel.md §6.9): месяцы учёта сверху вниз,
 * у каждого — статус и сумма к разделу; раскрытый показывает сверку, отчёт, закрытие и выплаты. Месяцы и отчёт видит
 * `ledger.view`; ставить на сверку, закрывать и снимать закрытие — `finance.period.close` (владелец); выплаты вносит
 * `finance.entry.create`. Скрытая кнопка — удобство, решает сервер.
 */
export function PeriodsTab(): ReactNode {
  const canClose = useSession((session) => can(session.view, "finance.period.close"));
  const canPay = useSession((session) => can(session.view, "finance.entry.create"));
  const list = useApi(() => loadPeriods(api), []);
  // `undefined` — человек ещё не выбирал: раскрыт первый месяц на сверке; `null` — всё свёрнуто.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);

  if (list.state.status === "loading") return <Loading />;
  if (list.state.status === "error") return <ErrorNotice error={list.state.error} onRetry={list.reload} />;

  const periods = list.state.data;
  if (periods.length === 0) return <p className="text-sm text-text-muted">Месяцев пока нет — они появятся вместе с первой проводкой</p>;

  const expanded = chosen === undefined ? (periods.find((item) => item.status === "review")?.period ?? null) : chosen;
  return (
    <ul className="flex flex-col gap-3">
      {periods.map((item) => (
        <MonthCard
          key={item.period}
          item={item}
          expanded={expanded === item.period}
          canClose={canClose}
          canPay={canPay}
          onToggle={() => setChosen(expanded === item.period ? null : item.period)}
          onChanged={list.reload}
        />
      ))}
    </ul>
  );
}
