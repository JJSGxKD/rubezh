import { useEffect, useState, type KeyboardEvent } from "react";
import type { DraftChange } from "../../api/content";
import { toast } from "../../ui/toast";
import { commitValue, formatValue, type CellError } from "./balance-rules";
import type { CellModel, GroupItem, SelectOption } from "./balance-tables";

/**
 * Ячейки таблиц баланса (tasks/T-0304). Число правится прямо в ячейке и
 * уходит на сервер по Enter или при уходе из поля, Esc возвращает прежнее.
 * Изменённая ячейка — жёлтая, рядом мелко «было»; отказ сервера — красная,
 * введённое остаётся в поле, а текст отказа стоит под записью (его рисует
 * таблица): тост про то, на что человек смотрит, не нужен.
 */

export interface CellContext {
  changes: ReadonlyMap<string, DraftChange>;
  errors: Readonly<Record<string, CellError>>;
  /** без права правки, на телефоне и без черновика ячейки только читаются */
  readOnly: boolean;
  /** что правит ячейка, словами — для диктора */
  label: (path: string) => string;
  onNumber: (path: string, value: number, typed: string, wasText: string) => void;
  onSelect: (path: string, value: string | number, wasText: string) => void;
  onDismiss: (path: string) => void;
}

/** Число в поле: десятичная запятая, без разделителя тысяч — его не разобрать обратно. */
function inputText(value: number): string {
  return String(value).replace(".", ",");
}

const TONE_EDITED = "bg-warning/10 ring-1 ring-warning/40";
const TONE_ERROR = "bg-danger/10 ring-1 ring-danger text-danger";

function WasNote({ change }: { change: DraftChange | undefined }) {
  if (change === undefined) return null;
  return <span className="whitespace-nowrap text-xs text-text-muted">было {formatValue(change.from)}</span>;
}

function NumberCell({ path, value, ctx }: { path: string; value: number; ctx: CellContext }) {
  const change = ctx.changes.get(path);
  const error = ctx.errors[path];
  const [text, setText] = useState(inputText(value));

  // Число сменилось не от набора (принято, возвращено из списка правок) — поле показывает его.
  useEffect(() => {
    setText(inputText(value));
  }, [value]);

  if (ctx.readOnly) {
    return (
      <span className="inline-flex items-center gap-1.5 tabular-nums">
        <span className={change === undefined ? "" : `rounded-sm px-1.5 ${TONE_EDITED}`}>{formatValue(value)}</span>
        <WasNote change={change} />
      </span>
    );
  }

  const commit = (): void => {
    const typed = text.trim();
    if (typed === inputText(value)) return;
    // Тот же отказ повторять незачем: уход из поля без правки не должен слать запрос заново.
    if (error?.typed === typed) return;
    const parsed = commitValue(typed);
    if (parsed === null) {
      toast.error("Нужно число, например 9 или 0,5");
      setText(inputText(value));
      return;
    }
    if (parsed === value) {
      setText(inputText(value));
      return;
    }
    ctx.onNumber(path, parsed, typed, formatValue(value));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setText(inputText(value));
      ctx.onDismiss(path);
      event.currentTarget.blur();
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        inputMode="decimal"
        aria-label={ctx.label(path)}
        aria-invalid={error === undefined ? undefined : true}
        className={`w-[4.5rem] rounded-sm border border-transparent px-1.5 py-1 text-right text-sm tabular-nums text-text hover:border-border focus:border-accent focus:outline-none ${error === undefined ? (change === undefined ? "bg-transparent" : TONE_EDITED) : TONE_ERROR}`}
      />
      <WasNote change={change} />
    </span>
  );
}

function SelectCell({ path, value, options, ctx }: { path: string; value: string | number; options: readonly SelectOption[]; ctx: CellContext }) {
  const change = ctx.changes.get(path);
  const error = ctx.errors[path];
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const current = options[index]?.label ?? String(value);

  if (ctx.readOnly) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={`rounded-pill bg-surface-raised px-2 py-0.5 text-xs ${change === undefined ? "text-text-muted" : `${TONE_EDITED} text-text`}`}>{current}</span>
        <WasNote change={change} />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        value={String(index)}
        aria-label={ctx.label(path)}
        onChange={(event) => {
          const picked = options[Number(event.target.value)];
          if (picked !== undefined && picked.value !== value) ctx.onSelect(path, picked.value, current);
        }}
        className={`rounded-sm border border-border px-1.5 py-1 text-sm focus:border-accent focus:outline-none ${error === undefined ? (change === undefined ? "bg-surface-sunken text-text" : `${TONE_EDITED} text-text`) : TONE_ERROR}`}
      >
        {options.map((option, optionIndex) => (
          <option key={String(option.value)} value={String(optionIndex)}>
            {option.label}
          </option>
        ))}
      </select>
      <WasNote change={change} />
    </span>
  );
}

function GroupCell({ items, ctx }: { items: readonly GroupItem[]; ctx: CellContext }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((item, index) => (
        <span key={index} className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="text-xs text-text-muted">
            {item.label}
            {item.note === undefined || item.note === "" ? "" : ` (${item.note})`}
          </span>
          <Cell cell={item.cell} ctx={ctx} />
        </span>
      ))}
    </span>
  );
}

export function Cell({ cell, ctx }: { cell: CellModel; ctx: CellContext }) {
  switch (cell.kind) {
    case "number":
      return <NumberCell path={cell.path} value={cell.value} ctx={ctx} />;
    case "select":
      return <SelectCell path={cell.path} value={cell.value} options={cell.options} ctx={ctx} />;
    case "group":
      return <GroupCell items={cell.items} ctx={ctx} />;
    case "text":
      return <span className={cell.muted === true ? "text-text-muted" : ""}>{cell.text}</span>;
  }
}
