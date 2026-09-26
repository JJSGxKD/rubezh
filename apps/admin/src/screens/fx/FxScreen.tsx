import { useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { fetchFxOverview, MANUAL_PURPOSES, manualRateProblem, PLATFORM_CURRENCIES, QUOTE_CURRENCIES, setManualRate, type ManualRateInput } from "../../api/fx";
import { formatDateTime, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel, Select } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

/**
 * Курсы валют (docs/29-admin-panel.md §3.3, «Курсы валют»): смотрят многие,
 * заданный курс звёзд ставит только владелец — у него право `fx.rates.edit`.
 */
const FRESHNESS: Record<string, { tone: "success" | "warning" | "danger"; text: string }> = {
  fresh: { tone: "success", text: "свежий" },
  stale: { tone: "warning", text: "устаревает" },
  expired: { tone: "danger", text: "просрочен" },
};

function FreshnessBadge({ value }: { value: string }) {
  const known = FRESHNESS[value];
  return known === undefined ? <Badge>{value}</Badge> : <Badge tone={known.tone}>{known.text}</Badge>;
}

export function FxScreen() {
  const { state, reload } = useApi(() => fetchFxOverview(api), []);
  const view = useSession((session) => session.view);

  return (
    <div className="flex flex-col gap-4">
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <>
          {state.data.enabled ? null : <Notice tone="info">Сбор курсов на сервере выключен — ниже последние сохранённые.</Notice>}
          {state.data.missing.length === 0 ? null : <Notice>Нет курса: {state.data.missing.join(", ")}</Notice>}
          <Panel title="Курсы" actions={<Button onClick={reload}>Обновить</Button>}>
            <DataTable
              rows={state.data.rates}
              rowKey={(rate) => rate.currency}
              empty="Курсов нет"
              columns={[
                { title: "Валюта", render: (rate) => rate.currency },
                { title: "Цена в $", render: (rate) => <code>{rate.usdPerUnit}</code>, align: "right" },
                { title: "Единиц за $", render: (rate) => <code>{rate.unitsPerUsd}</code>, align: "right" },
                { title: "Источники", render: (rate) => rate.sources.join(", ") },
                { title: "Снят", render: (rate) => formatDateTime(rate.observedAt) },
                { title: "Свежесть", render: (rate) => <FreshnessBadge value={rate.freshness} /> },
              ]}
            />
          </Panel>
          <Panel title="Заданные курсы">
            <DataTable
              rows={state.data.manual}
              rowKey={(rate) => `${rate.currency}|${rate.purpose}`}
              empty="Заданных курсов нет"
              columns={[
                { title: "Валюта", render: (rate) => rate.currency },
                { title: "Назначение", render: (rate) => MANUAL_PURPOSES.find(([id]) => id === rate.purpose)?.[1] ?? rate.purpose },
                { title: "Цена", render: (rate) => <code>{`${rate.price} ${rate.quote}`}</code>, align: "right" },
                { title: "В $", render: (rate) => <code>{rate.usdPerUnit ?? "—"}</code>, align: "right" },
                { title: "Действует до", render: (rate) => formatDateTime(rate.expiresAt) },
                { title: "Свежесть", render: (rate) => <FreshnessBadge value={rate.freshness} /> },
                { title: "Причина", render: (rate) => rate.note },
              ]}
            />
          </Panel>
          {can(view, "fx.rates.edit") ? <ManualRateForm onSaved={reload} /> : null}
          <Panel title="Источники">
            <DataTable
              rows={state.data.sources}
              rowKey={(source) => source.source}
              empty="Источников нет"
              columns={[
                { title: "Источник", render: (source) => source.source },
                { title: "Тариф", render: (source) => source.tariff },
                { title: "Запросов за месяц", render: (source) => formatNumber(source.used), align: "right" },
                { title: "Пауза до", render: (source) => formatDateTime(source.pausedUntil) },
                { title: "Следующий опрос", render: (source) => formatDateTime(source.nextPollAt) },
              ]}
            />
          </Panel>
        </>
      ) : null}
    </div>
  );
}

function ManualRateForm({ onSaved }: { onSaved: () => void }) {
  const [input, setInput] = useState<ManualRateInput>({ currency: PLATFORM_CURRENCIES[0], purpose: "price", price: "", quote: "USD", expiresInDays: 30, note: "" });
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null>(null);
  const problem = input.price === "" ? "Укажите цену" : manualRateProblem(input);
  const patch = (next: Partial<ManualRateInput>) => {
    setInput((current) => ({ ...current, ...next }));
    setConfirming(false);
  };

  const save = async () => {
    setPending(true);
    const result = await setManualRate(api, { ...input, note: input.note.trim() });
    setPending(false);
    setConfirming(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `Курс ${result.data.currency} задан до ${formatDateTime(result.data.expiresAt)}` });
    onSaved();
  };

  return (
    <Panel title="Задать курс">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Валюта">
            <Select value={input.currency} onChange={(event) => patch({ currency: event.target.value })}>
              {PLATFORM_CURRENCIES.map((code) => (
                <option key={code}>{code}</option>
              ))}
            </Select>
          </Field>
          <Field label="Назначение">
            <Select value={input.purpose} onChange={(event) => patch({ purpose: event.target.value })}>
              {MANUAL_PURPOSES.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Цена единицы">
            <Input value={input.price} onChange={(event) => patch({ price: event.target.value.trim().replace(",", ".") })} placeholder="0.013" className="w-32" />
          </Field>
          <Field label="В валюте">
            <Select value={input.quote} onChange={(event) => patch({ quote: event.target.value })}>
              {QUOTE_CURRENCIES.map((code) => (
                <option key={code}>{code}</option>
              ))}
            </Select>
          </Field>
          <Field label="Дней">
            <Input type="number" min={1} max={90} value={input.expiresInDays} onChange={(event) => patch({ expiresInDays: Number(event.target.value) })} className="w-20" />
          </Field>
        </div>
        <Field label="Причина" hint="Попадёт в аудит вместе с прежним курсом.">
          <Input value={input.note} onChange={(event) => patch({ note: event.target.value })} maxLength={200} />
        </Field>
        <div className="flex items-center gap-2">
          {confirming && problem === null ? (
            <>
              <Button tone="danger" disabled={pending} onClick={() => void save()}>
                Да: 1 {input.currency} = {input.price} {input.quote} на {input.expiresInDays} дн.
              </Button>
              <Button onClick={() => setConfirming(false)}>Отмена</Button>
            </>
          ) : (
            <Button tone="primary" disabled={problem !== null} onClick={() => setConfirming(true)}>
              Задать
            </Button>
          )}
          {problem !== null && input.price !== "" ? <span className="text-xs text-text-muted">{problem}</span> : null}
        </div>
        {outcome === null ? null : outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}
      </div>
    </Panel>
  );
}
