import { entryNote, formatLine, isFilterEmpty, lineTone, paymentIdOf, type JournalEntry, type JournalFilter, type LineTone } from "../../api/ledger";
import { formatDateTime } from "../../format";
import { hrefOf } from "../../routes";
import { Badge, Button } from "../../ui/kit";

/**
 * Список проводок «Журнала» (tasks/T-0459): новые сверху — дата, описание, ключ источника, строки «счёт — сумма»
 * с цветом дебета и кредита, метка «сторно» со ссылкой на исходную проводку. Ключ оплаты ведёт на карточку
 * платежа, если у человека есть раздел «Платежи».
 */
const TONES: Record<LineTone, string> = {
  debit: "text-success",
  credit: "text-danger",
  zero: "text-text-muted",
};

function SourceKey({ entry, hasPayments }: { entry: JournalEntry; hasPayments: boolean }) {
  const paymentId = hasPayments ? paymentIdOf(entry.sourceKey) : null;
  if (paymentId === null) return <span className="break-all font-mono text-xs text-text-muted">{entry.sourceKey}</span>;
  return (
    <a className="break-all font-mono text-xs underline hover:text-accent" href={hrefOf({ section: "payments", id: paymentId })}>
      {entry.sourceKey}
    </a>
  );
}

function EntryCard({ entry, hasPayments, onSource }: { entry: JournalEntry; hasPayments: boolean; onSource: (key: string) => void }) {
  const note = entryNote(entry);
  return (
    <li className="flex flex-col gap-2 rounded-sm border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-text-muted tabular-nums">{formatDateTime(entry.at)}</span>
        <span className="min-w-24 flex-1 font-medium">{entry.memo}</span>
        {note === null ? null : <Badge tone="warning">{note.label}</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SourceKey entry={entry} hasPayments={hasPayments} />
        {note === null ? null : (
          <button type="button" className="text-xs underline hover:text-accent" onClick={() => onSource(note.original)}>
            {`исходная: ${note.original}`}
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-0.5 text-sm tabular-nums">
        {entry.lines.map((line) => (
          <li key={`${line.accountId}|${line.amount}`} className="flex flex-wrap justify-between gap-x-3">
            <span className="min-w-0">{line.accountName}</span>
            <span className={`font-medium ${TONES[lineTone(line.amount)]}`}>{formatLine(line.amount, line.currency)}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function JournalView({
  entries,
  next,
  filter,
  loading,
  hasPayments,
  onMore,
  onSource,
}: {
  entries: readonly JournalEntry[];
  /** курсор следующей страницы; `null` — это последняя */
  next: string | null;
  filter: JournalFilter;
  /** идёт загрузка следующей страницы */
  loading: boolean;
  hasPayments: boolean;
  onMore: () => void;
  /** показать проводки по ключу источника — для ссылки «исходная» у сторно */
  onSource: (key: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <p className="rounded-sm border border-border bg-surface-sunken px-3 py-4 text-sm text-text-muted">
        {isFilterEmpty(filter) ? "Проводок пока нет: оплаты появятся здесь после первого прохода сверки (раз в 10 минут)" : "По фильтру проводок нет"}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <EntryCard key={entry.entryId} entry={entry} hasPayments={hasPayments} onSource={onSource} />
        ))}
      </ul>
      {next === null ? null : (
        <div>
          <Button disabled={loading} onClick={onMore}>
            {loading ? "Загрузка…" : "Показать ещё"}
          </Button>
        </div>
      )}
    </div>
  );
}
