import { formatNumber, plural } from "../format";

const DAY_MS = 86_400_000;

/**
 * Столбики по игровым суткам за `days` дней (по умолчанию 30): пустые дни —
 * тоже, иначе всплеск после поста не отличить от ровного потока. `what` —
 * что считаем, в родительном падеже множественного числа: «активаций»,
 * «привязок».
 */
export function DailyBars({ daily, what, days: length = 30 }: { daily: readonly { day: string; count: number }[]; what: string; days?: number }) {
  const counts = new Map(daily.map((row) => [row.day, row.count]));
  const today = Date.now();
  const days = Array.from({ length }, (_, index) => {
    // Сутки — московские, как на сервере: сдвиг на три часа от UTC.
    const day = new Date(today - (length - 1 - index) * DAY_MS + 3 * 3_600_000).toISOString().slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
  const max = Math.max(1, ...days.map((row) => row.count));
  const total = days.reduce((sum, row) => sum + row.count, 0);
  const span = `${String(length)} ${plural(length, ["день", "дня", "дней"])}`;
  if (total === 0) return <p className="text-sm text-text-muted">За {span} {what} не было</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-20 items-end gap-0.5" role="img" aria-label={`${what[0]?.toUpperCase() ?? ""}${what.slice(1)} за ${span}: ${String(total)}`}>
        {days.map((row) => (
          <span
            key={row.day}
            title={`${row.day.split("-").reverse().join(".")}: ${String(row.count)}`}
            className={`flex-1 rounded-t-sm ${row.count === 0 ? "bg-surface-raised" : "bg-accent"}`}
            style={{ height: `${String(Math.max(4, Math.round((row.count / max) * 100)))}%` }}
          />
        ))}
      </div>
      <p className="flex justify-between text-xs text-text-muted">
        <span>{span} назад</span>
        <span>
          всего {formatNumber(total)}, максимум за день {formatNumber(max)}
        </span>
        <span>сегодня</span>
      </p>
    </div>
  );
}
