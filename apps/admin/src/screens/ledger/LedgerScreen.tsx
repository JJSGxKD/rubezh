import { useEffect, useMemo, useState } from "react";
import { isFilterEmpty, loadBalances, loadJournal, mergeEntries, type Balances, type JournalEntry, type JournalFilter } from "../../api/ledger";
import { api } from "../../services";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Button, ErrorNotice, Field, FieldRow, Input, Loading, Select } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { TabBar } from "../../ui/tab-bar";
import { toastError } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { BalancesView } from "./BalancesView";
import { JournalView } from "./JournalView";

/**
 * Раздел «Бухгалтерия» (docs/29-admin-panel.md §6.7, Р219, tasks/T-0459): вкладки «Остатки» и «Журнал».
 * Адреса: `#/ledger`, `#/ledger/journal`. Только чтение (`ledger.view`): операции руками, бюджеты и отчёт — позже.
 */
const TABS = [
  { id: "balances", title: "Остатки" },
  { id: "journal", title: "Журнал" },
] as const;

type LedgerTab = (typeof TABS)[number]["id"];

export function LedgerScreen({ id }: { id: string | null }) {
  const tab: LedgerTab = id === "journal" ? "journal" : "balances";
  return (
    <div className="flex flex-col gap-4">
      <TabBar label="Бухгалтерия" tabs={TABS} active={tab} onSelect={(next) => navigate({ section: "ledger", id: next === "journal" ? "journal" : null })} />
      {tab === "balances" ? <BalancesTab /> : <JournalTab />}
    </div>
  );
}

function BalancesTab() {
  const { state, reload } = useApi(() => loadBalances(api), []);
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  return <BalancesView data={state.data} />;
}

/** Месяц с/по: подпись и поле; пустое значение — нет границы. */
function MonthField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field label={label}>
      <Input type="month" value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function Filters({ filter, accounts, onChange }: { filter: JournalFilter; accounts: Balances["accounts"]; onChange: (filter: JournalFilter) => void }) {
  const currencies = useMemo(() => [...new Set(accounts.map((account) => account.currency))], [accounts]);
  const set = (patch: JournalFilter) => onChange({ ...filter, ...patch });
  return (
    <FieldRow>
      <Field label="Счёт">
        <Select value={filter.account ?? ""} onChange={(event) => set({ account: event.target.value })}>
          <option value="">Все счета</option>
          {accounts.map((account) => (
            <option key={account.accountId} value={account.accountId}>
              {account.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Валюта">
        <Select value={filter.currency ?? ""} onChange={(event) => set({ currency: event.target.value })}>
          <option value="">Все валюты</option>
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
      </Field>
      <MonthField label="С месяца" value={filter.from ?? ""} onChange={(from) => set({ from })} />
      <MonthField label="По месяц" value={filter.to ?? ""} onChange={(to) => set({ to })} />
      {filter.source === undefined || filter.source === "" ? null : (
        <Field label="Ключ источника">
          <Button onClick={() => set({ source: "" })}>{`${filter.source} ✕`}</Button>
        </Field>
      )}
      {isFilterEmpty(filter) ? null : (
        <div className="pt-5">
          <Button onClick={() => onChange({})}>Сбросить</Button>
        </div>
      )}
    </FieldRow>
  );
}

function JournalTab() {
  const [filter, setFilter] = useState<JournalFilter>({});
  const filterKey = JSON.stringify(filter);
  const accounts = useApi(() => loadBalances(api), []);
  const first = useApi(() => loadJournal(api, filter, null), [filterKey]);
  const hasPayments = useSession((session) => can(session.view, "payments.view"));

  // Дописанные «Показать ещё» страницы; новый фильтр или перезагрузка первой страницы их сбрасывают.
  const [more, setMore] = useState<{ entries: JournalEntry[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setMore(null);
  }, [filterKey, first.state]);

  const accountList = accounts.state.status === "ok" ? accounts.state.data.accounts : [];

  let body;
  if (first.state.status === "loading") body = <Loading />;
  else if (first.state.status === "error") body = <ErrorNotice error={first.state.error} onRetry={first.reload} />;
  else {
    const page = first.state.data;
    const entries = more === null ? page.entries : mergeEntries(page.entries, more.entries);
    const next = more === null ? page.next : more.next;
    const loadMore = () => {
      if (next === null) return;
      setLoadingMore(true);
      void loadJournal(api, filter, next).then((result) => {
        setLoadingMore(false);
        if (!result.ok) {
          toastError(result.error, "Не удалось загрузить журнал");
          return;
        }
        setMore({ entries: mergeEntries(more?.entries ?? [], result.data.entries), next: result.data.next });
      });
    };
    body = <JournalView entries={entries} next={next} filter={filter} loading={loadingMore} hasPayments={hasPayments} onMore={loadMore} onSource={(source) => setFilter({ source })} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Filters filter={filter} accounts={accountList} onChange={setFilter} />
      {body}
    </div>
  );
}
