import { useId } from "react";
import { CUSTOMER_MAX, HOLD_DAYS, HOLD_TITLES, NO_CUSTOMER_FIELDS, PAY_MODELS, PAY_MODEL_TITLES, PAY_RATE_MAX, rateLabel, type TaskDef } from "../../api/tasks";
import { Field, FieldRow, Input, Select } from "../../ui/kit";

/**
 * Блок «Заказчик» в редакторе партнёрской цели (docs/35-stage4-plan.md Р138,
 * Р139): кто платит за место в заданиях, по какой модели и сколько, и сколько
 * суток игрок должен продержаться в канале, чтобы выполнение оплачивалось.
 * Поля нужны команде и отчёту заказчику — игрок их не получает. Заказчик —
 * строка, подсказка берёт уже введённых из каталога.
 */
export function TaskCustomerFields({
  input,
  onChange,
  customers,
  channel,
}: {
  input: TaskDef;
  onChange: (next: TaskDef) => void;
  /** заказчики, уже введённые в каталоге, — подсказка к полю */
  customers: readonly string[];
  /** удержание проверяется только у подписки на канал */
  channel: boolean;
}) {
  const listId = useId();
  const sold = input.customer !== null;
  const rate = rateLabel(input.payModel, input.rate);
  const max = input.payModel === null ? PAY_RATE_MAX.cpa : PAY_RATE_MAX[input.payModel];

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
      <legend className="px-1 text-xs text-text-muted">Заказчик</legend>
      <FieldRow>
        <Field label="Заказчик" hint="пусто — задание своё, не продаётся">
          <Input
            value={input.customer ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              // Пустой заказчик снимает модель и ставку: без него они ничего не значат.
              onChange(value === "" ? { ...input, ...NO_CUSTOMER_FIELDS, holdDays: input.holdDays } : { ...input, customer: value });
            }}
            list={listId}
            maxLength={CUSTOMER_MAX}
            placeholder="Канал «Игровой угол»"
            className="w-56"
          />
          <datalist id={listId}>
            {customers.map((customer) => (
              <option key={customer} value={customer} />
            ))}
          </datalist>
        </Field>
        {sold ? (
          <Field label="Модель оплаты">
            <Select
              value={input.payModel ?? ""}
              onChange={(event) => {
                const payModel = PAY_MODELS.find((model) => model === event.target.value) ?? null;
                onChange({ ...input, payModel, rate: null });
              }}
            >
              <option value="">выберите</option>
              {PAY_MODELS.map((model) => (
                <option key={model} value={model}>
                  {PAY_MODEL_TITLES[model]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {sold && input.payModel !== null ? (
          <Field
            label={input.payModel === "cpa" ? "Ставка, центов" : "Ставка, сотых долей %"}
            hint={rate ?? (input.payModel === "cpa" ? "40 — это $0,40 за выполнение" : "1 250 — это 12,5% дохода")}
          >
            <Input
              value={input.rate === null ? "" : String(input.rate)}
              onChange={(event) => onChange({ ...input, rate: event.target.value.trim() === "" ? null : Number(event.target.value) })}
              type="number"
              min={1}
              max={max}
              step={1}
              className="w-32"
            />
          </Field>
        ) : null}
        {channel ? (
          <Field label="Удержание" hint="после скольких суток в канале выполнение оплачивается">
            <Select value={String(input.holdDays)} onChange={(event) => onChange({ ...input, holdDays: Number(event.target.value) })}>
              {HOLD_DAYS.map((days) => (
                <option key={days} value={days}>
                  {HOLD_TITLES[days]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </FieldRow>
      {channel ? null : <p className="text-xs text-text-muted">Удержание проверяется только у подписки на канал: у ссылки и бота оплата — сразу.</p>}
    </fieldset>
  );
}
