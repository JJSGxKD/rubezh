import { moscowDay, presetPeriod } from "../api/funnel";
import { Field, Input } from "./kit";

/**
 * Общий выбор периода (tasks/T-0053, аудит AD-02): чипы пресетов над полями
 * «Свой период», а выбранный период — подписью `22.09–22.10` в формате
 * `ДД.ММ` независимо от языка браузера: голые поля даты на английской локали
 * показывают `mm/dd/yyyy`. Пресеты — свойство компонента: этот же выбор берут
 * «Выгрузки», «Доля флага» и «Игроки».
 */
export const PERIOD_PRESETS = [7, 30, 90] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export const DEFAULT_PRESET: PeriodPreset = 30;

export type PeriodValue = { preset: PeriodPreset } | { preset: "custom"; from: string; to: string };

const YEAR_DAYS = 366;
const DAY_MS = 86_400_000;

/** Пресет — пара московских дат `YYYY-MM-DD`, сегодня включительно. */
export function presetDates(days: PeriodPreset, now: Date): { from: string; to: string } {
  return { from: moscowDay(new Date(presetPeriod(days, now).from)), to: moscowDay(now) };
}

/** Подпись периода: «22.09–22.10»; один день — «22.10»; через границу года — с годом. */
export function periodLabel(from: string, to: string): string {
  const [fromYear, fromMonth, fromDay] = from.split("-");
  const [toYear, toMonth, toDay] = to.split("-");
  if (from === to) return `${toDay ?? ""}.${toMonth ?? ""}`;
  if (fromYear !== toYear) return `${fromDay ?? ""}.${fromMonth ?? ""}.${fromYear ?? ""}–${toDay ?? ""}.${toMonth ?? ""}.${toYear ?? ""}`;
  return `${fromDay ?? ""}.${fromMonth ?? ""}–${toDay ?? ""}.${toMonth ?? ""}`;
}

/** Ошибка своего периода у поля; `null` — годен. */
export function customProblem(from: string, to: string): string | null {
  if (from === "" || to === "") return "Укажите обе даты";
  if (from > to) return "Дата «С» позже даты «По»";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
  return days >= YEAR_DAYS ? "Не длиннее года" : null;
}

/** Даты выбранного периода — для подписи и запроса; своего с ошибкой нет. */
export function valueDates(value: PeriodValue, now: Date): { from: string; to: string } | null {
  if (value.preset !== "custom") return presetDates(value.preset, now);
  return customProblem(value.from, value.to) === null ? { from: value.from, to: value.to } : null;
}

export function PeriodPicker({ value, now = new Date(), onChange }: { value: PeriodValue; now?: Date; onChange: (value: PeriodValue) => void }) {
  const dates = valueDates(value, now);
  const problem = value.preset === "custom" ? customProblem(value.from, value.to) : null;
  const chip = (selected: boolean) =>
    `min-h-8 rounded-sm px-2.5 text-xs font-semibold transition-colors max-md:min-h-10 ${selected ? "bg-surface-raised text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]" : "text-text-muted hover:text-text"}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex gap-0.5 rounded-sm border border-border bg-surface-sunken p-0.5" role="tablist" aria-label="Период">
          {PERIOD_PRESETS.map((days) => (
            <button key={days} type="button" role="tab" aria-selected={value.preset === days} onClick={() => onChange({ preset: days })} className={chip(value.preset === days)}>
              {days} дней
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={value.preset === "custom"}
            onClick={() => onChange(value.preset === "custom" ? value : { preset: "custom", ...presetDates(value.preset, now) })}
            className={chip(value.preset === "custom")}
          >
            Свой период
          </button>
        </span>
        {dates === null ? null : <span className="text-xs text-text-muted tabular-nums">{periodLabel(dates.from, dates.to)}</span>}
      </div>
      {value.preset === "custom" ? (
        <div className="flex flex-wrap items-start gap-2">
          <Field label="С">
            <Input type="date" value={value.from} onChange={(event) => onChange({ ...value, from: event.target.value })} />
          </Field>
          <Field label="По (включительно)" error={problem ?? undefined}>
            <Input type="date" value={value.to} onChange={(event) => onChange({ ...value, to: event.target.value })} />
          </Field>
        </div>
      ) : null}
    </div>
  );
}
