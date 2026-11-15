import type { ReactNode } from "react";
import { balanceCards, formatAmount, formatMoney, revenueRows, type BalanceAccount, type Balances } from "../../api/ledger";
import { formatDateTime } from "../../format";
import { Notice, Panel } from "../../ui/kit";

/**
 * «Остатки» (docs/37-accounting.md §9, Р219, tasks/T-0459): где деньги проекта сейчас. Сверху итог активов в
 * долларах (крупно) и рублях, ниже — места хранения карточками, затем выручка по статьям за всё время. Сумма в
 * родной валюте стоит всегда, оценка «≈ $» — только когда для валюты есть курс: без курсов экран не пустеет.
 */
const USD = " $";
const RUB = " ₽";

/** «≈ 795,60 $» — оценка счёта; нет курса — ничего. */
function Estimate({ account }: { account: BalanceAccount }) {
  if (account.value === null) return null;
  return <span className="text-sm text-text-muted tabular-nums">{`≈ ${formatMoney(account.value.usd)}${USD}`}</span>;
}

function StarRow({ title, account }: { title: string; account: BalanceAccount | null }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="text-sm text-text-muted">{title}</span>
      <span className="flex flex-wrap items-baseline justify-end gap-x-2 tabular-nums">
        <b className="text-lg">{account === null ? "—" : formatAmount(account.balance, account.currency)}</b>
        {account === null ? null : <Estimate account={account} />}
      </span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-4">
      <h3 className="text-xs font-semibold uppercase text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Total({ data }: { data: Balances }) {
  if (data.totalUsd !== null && data.totalRub !== null) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 tabular-nums">
        <b className="text-3xl">{`${formatMoney(data.totalUsd)}${USD}`}</b>
        <span className="text-lg">{`${formatMoney(data.totalRub)}${RUB}`}</span>
      </p>
    );
  }
  return (
    <p className="text-sm text-text-muted">
      {data.rates === null ? "Курсов нет — суммы только в родной валюте. Задайте курсы в разделе «Курсы»." : "Итог не посчитан: для части валют нет курса, суммы — в родной валюте."}
    </p>
  );
}

function RateLine({ data }: { data: Balances }) {
  if (data.rates === null) return <Notice tone="warning">Курсов нет — оценка в долларах и рублях появится, когда они будут. Звёзды считаются по курсу выплаты, остальные валюты — по рыночному.</Notice>;
  return <p className="text-xs text-text-muted">{`Оценка по текущим курсам на ${formatDateTime(data.rates.at)}: звёзды — по курсу выплаты, остальные валюты — по рыночному. Вниз до цента.`}</p>;
}

export function BalancesView({ data }: { data: Balances }) {
  const cards = balanceCards(data.accounts);
  const revenue = revenueRows(data.accounts);
  const hasStars = cards.stars.hold !== null || cards.stars.available !== null;
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Всего на счетах" help="Сумма всех мест хранения по текущим курсам">
        <Total data={data} />
      </Panel>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {hasStars ? (
          <Card title="Звёзды бота">
            <StarRow title="в холде" account={cards.stars.hold} />
            <StarRow title="доступно" account={cards.stars.available} />
          </Card>
        ) : null}
        {cards.others.map((account) => (
          <Card key={account.accountId} title={account.name}>
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 tabular-nums">
              <b className="text-lg">{formatAmount(account.balance, account.currency)}</b>
              <Estimate account={account} />
            </p>
          </Card>
        ))}
      </div>

      <Panel title="Выручка по статьям" help="Накопленная выручка за всё время; по периодам — в отчёте закрытого месяца">
        {revenue.length === 0 ? (
          <p className="text-sm text-text-muted">Выручки пока нет</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-text-muted">за всё время</p>
            <ul className="flex flex-col gap-1.5 text-sm tabular-nums">
              {revenue.map((account) => (
                <li key={account.accountId} className="flex flex-wrap justify-between gap-x-3">
                  <span>{account.name}</span>
                  <span className="flex gap-2">
                    <span>{formatAmount(account.balance, account.currency)}</span>
                    <Estimate account={account} />
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <RateLine data={data} />
    </div>
  );
}
