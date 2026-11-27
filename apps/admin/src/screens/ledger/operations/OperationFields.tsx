import type { ReactNode } from "react";
import type { ArticleView } from "../../../api/ledger-operations";
import { Field, FieldRow, Input, Select, TextArea } from "../../../ui/kit";
import type { FormState, ReceiptPayer } from "./form-model";
import { ReceiptField } from "./ReceiptField";
import type { Chart, ChartPlace } from "./preview";

/**
 * Поля формы операции по видам (tasks/T-0464): место, статья, суммы, комиссия с подставленным шаблоном места и
 * возможностью поправить, у займа — кредитор, премия и ставка, у поступления — месяц, у зачисления в рубли — чек НПД.
 * Поля только собирают ввод: числа проверяет предпросмотр и сервер.
 */
export type SetForm = (patch: Partial<FormState>) => void;

const AMOUNT_PROPS = { inputMode: "decimal", autoComplete: "off" } as const;

function PlaceSelect({ label, value, places, onChange }: { label: string; value: string; places: readonly ChartPlace[]; onChange: (value: string) => void }) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Выберите место…</option>
        {places
          .filter((place) => !place.archived)
          .map((place) => (
            <option key={place.accountId} value={place.accountId}>
              {`${place.name} · ${place.currency}`}
            </option>
          ))}
      </Select>
    </Field>
  );
}

function ArticleSelect({ value, kind, articles, onChange }: { value: string; kind: "expense" | "income"; articles: readonly ArticleView[]; onChange: (value: string) => void }) {
  return (
    <Field label="Статья">
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Выберите статью…</option>
        {articles
          .filter((article) => article.kind === kind && !article.archived)
          .map((article) => (
            <option key={article.articleId} value={article.articleId}>
              {article.name}
            </option>
          ))}
      </Select>
    </Field>
  );
}

function Amount({ label, value, currency, onChange, hint }: { label: string; value: string; currency: string | undefined; onChange: (value: string) => void; hint?: string }) {
  return (
    <Field label={currency === undefined ? label : `${label}, ${currency}`} {...(hint === undefined ? {} : { hint })}>
      <Input {...AMOUNT_PROPS} value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

/** Шаблон комиссии места словами: «1 % + 0,05 GRAM». */
function templateText(place: ChartPlace | undefined): string | null {
  const fee = place?.fee ?? null;
  if (fee === null) return null;
  const parts: string[] = [];
  if (fee.percentBp !== null && fee.percentBp > 0) parts.push(`${String(fee.percentBp / 100).replace(".", ",")} %`);
  if (fee.fixed !== null && fee.fixedCurrency !== null) parts.push(`${fee.fixed} ${fee.fixedCurrency}`);
  return parts.length === 0 ? null : parts.join(" + ");
}

function FeeFields({ form, chart, set }: { form: FormState; chart: Chart; set: SetForm }) {
  const from = chart.places.find((place) => place.accountId === form.from);
  const template = templateText(from);
  const currencies = [...new Set(chart.places.filter((place) => !place.archived).map((place) => place.currency))];
  const payers = chart.places.filter((place) => !place.archived && place.currency === form.fixedCurrency);
  const edit = (patch: Partial<FormState>) => set({ ...patch, feeEdited: true });
  return (
    <fieldset className="flex flex-col gap-2 rounded-sm border border-border px-3 py-2">
      <legend className="px-1 text-xs text-text-muted">Комиссия</legend>
      <p className="text-xs text-text-muted">{template === null ? "У места списания нет шаблона комиссии — впишите вручную, если она была." : `Подставлено по шаблону места: ${template}. Поправьте, если было иначе.`}</p>
      <FieldRow>
        <Amount label="Процентная часть" currency={from?.currency} value={form.feePercent} onChange={(feePercent) => edit({ feePercent })} />
        <Amount label="Фикса" currency={undefined} value={form.fixedAmount} onChange={(fixedAmount) => edit({ fixedAmount })} />
        <Field label="Валюта фиксы">
          <Select value={form.fixedCurrency} onChange={(event) => edit({ fixedCurrency: event.target.value, fixedFrom: "" })}>
            <option value="">—</option>
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </Field>
        {payers.length > 1 && form.fixedCurrency !== from?.currency ? (
          <Field label="С какого места списать фиксу">
            <Select value={form.fixedFrom} onChange={(event) => edit({ fixedFrom: event.target.value })}>
              <option value="">Выберите место…</option>
              {payers.map((place) => (
                <option key={place.accountId} value={place.accountId}>
                  {place.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </FieldRow>
    </fieldset>
  );
}

const PAYERS: readonly { value: ReceiptPayer; title: string }[] = [
  { value: "none", title: "Без чека" },
  { value: "individual", title: "Физлицо" },
  { value: "legal", title: "Юрлицо или ИП" },
];

/** Чек НПД у зачисления в рубли (Р221): плательщик обязателен, номер или ссылка — как есть в чеке. */
function ReceiptFields({ form, set }: { form: FormState; set: SetForm }) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-sm border border-border px-3 py-2">
      <legend className="px-1 text-xs text-text-muted">Чек НПД</legend>
      <FieldRow>
        <Field label="Плательщик">
          <Select value={form.receiptPayer} onChange={(event) => set({ receiptPayer: event.target.value as ReceiptPayer })}>
            {PAYERS.map((payer) => (
              <option key={payer.value} value={payer.value}>
                {payer.title}
              </option>
            ))}
          </Select>
        </Field>
        {form.receiptPayer === "none" ? null : (
          <>
            <Field label="Номер чека">
              <Input maxLength={64} value={form.receiptNumber} onChange={(event) => set({ receiptNumber: event.target.value })} />
            </Field>
            <Field label="Ссылка на чек">
              <Input type="url" placeholder="https://" value={form.receiptLink} onChange={(event) => set({ receiptLink: event.target.value })} />
            </Field>
          </>
        )}
      </FieldRow>
    </fieldset>
  );
}

function KindFields({ form, chart, set }: { form: FormState; chart: Chart; set: SetForm }): ReactNode {
  const currencyOf = (accountId: string) => chart.places.find((place) => place.accountId === accountId)?.currency;
  const toRub = currencyOf(form.to) === "RUB";
  switch (form.kind) {
    case "transfer":
      return (
        <>
          <FieldRow>
            <PlaceSelect label="Откуда" value={form.from} places={chart.places} onChange={(from) => set({ from })} />
            <PlaceSelect label="Куда" value={form.to} places={chart.places} onChange={(to) => set({ to })} />
            <Amount label="Сумма" currency={currencyOf(form.from)} value={form.amount} onChange={(amount) => set({ amount })} />
          </FieldRow>
          <FeeFields form={form} chart={chart} set={set} />
        </>
      );
    case "exchange":
      return (
        <>
          <FieldRow>
            <PlaceSelect label="Откуда" value={form.from} places={chart.places} onChange={(from) => set({ from })} />
            <Amount label="Отдано" currency={currencyOf(form.from)} value={form.given} onChange={(given) => set({ given })} />
          </FieldRow>
          <FieldRow>
            <PlaceSelect label="Куда" value={form.to} places={chart.places} onChange={(to) => set({ to })} />
            <Amount label="Получено" currency={currencyOf(form.to)} value={form.received} onChange={(received) => set({ received })} />
          </FieldRow>
          <FeeFields form={form} chart={chart} set={set} />
          {toRub ? <ReceiptFields form={form} set={set} /> : null}
        </>
      );
    case "expense":
      return (
        <FieldRow>
          <PlaceSelect label="Откуда" value={form.from} places={chart.places} onChange={(from) => set({ from })} />
          <ArticleSelect value={form.article} kind="expense" articles={chart.articles} onChange={(article) => set({ article })} />
          <Amount label="Сумма" currency={currencyOf(form.from)} value={form.amount} onChange={(amount) => set({ amount })} />
        </FieldRow>
      );
    case "income":
      return (
        <>
          <FieldRow>
            <PlaceSelect label="Куда" value={form.to} places={chart.places} onChange={(to) => set({ to })} />
            <ArticleSelect value={form.article} kind="income" articles={chart.articles} onChange={(article) => set({ article })} />
            <Amount label="Сумма" currency={currencyOf(form.to)} value={form.amount} onChange={(amount) => set({ amount })} />
            <Field label="За какой месяц" hint="Не позже месяца даты: выручка сети приходит после её месяца">
              <Input type="month" value={form.forMonth} onChange={(event) => set({ forMonth: event.target.value })} />
            </Field>
          </FieldRow>
          {toRub ? <ReceiptFields form={form} set={set} /> : null}
        </>
      );
    case "loan":
      return (
        <FieldRow>
          <PlaceSelect label="Куда" value={form.to} places={chart.places} onChange={(to) => set({ to })} />
          <Field label="Кредитор">
            <Input maxLength={100} value={form.lender} onChange={(event) => set({ lender: event.target.value })} />
          </Field>
          <Amount label="Сумма займа" currency={currencyOf(form.to)} value={form.amount} onChange={(amount) => set({ amount })} />
          <Amount label="Премия сверх тела" currency={currencyOf(form.to)} value={form.premium} onChange={(premium) => set({ premium })} hint="Без премии — пусто" />
          <Field label="Ставка погашения, %" hint="Доля чистой прибыли месяца, от 0 до 100">
            <Input {...AMOUNT_PROPS} value={form.repaymentPercent} onChange={(event) => set({ repaymentPercent: event.target.value })} />
          </Field>
        </FieldRow>
      );
    case "reversal":
      return (
        <Field label="Исправляемая проводка">
          <Input readOnly value={form.sourceKey} className="font-mono" />
        </Field>
      );
  }
}

/** Все поля формы: поля вида, затем общие — дата, причина, ссылка, снимок чека. */
export function OperationFields({ form, chart, set }: { form: FormState; chart: Chart; set: SetForm }) {
  return (
    <div className="flex flex-col gap-3">
      <KindFields form={form} chart={chart} set={set} />
      <FieldRow>
        <Field label="Дата события">
          <Input type="date" value={form.at} onChange={(event) => set({ at: event.target.value })} />
        </Field>
        <Field label="Ссылка на подтверждение" hint="Только https">
          <Input type="url" placeholder="https://" value={form.link} onChange={(event) => set({ link: event.target.value })} />
        </Field>
      </FieldRow>
      <Field label={form.kind === "reversal" ? "Причина исправления" : "Причина или описание"} hint="От 3 до 500 знаков">
        <TextArea rows={2} maxLength={500} value={form.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      <ReceiptField value={form.receiptImage} onChange={(receiptImage) => set({ receiptImage })} />
    </div>
  );
}
