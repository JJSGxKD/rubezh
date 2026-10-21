import { useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import {
  budgetTone,
  correctSourceUsed,
  fetchFxOverview,
  limitCaption,
  limitValueProblem,
  MANUAL_PURPOSES,
  manualRateProblem,
  parseCount,
  PLATFORM_CURRENCIES,
  QUOTE_CURRENCIES,
  resetSourceLimit,
  setManualRate,
  setSourceLimit,
  usageText,
  usedValueProblem,
  type ManualRateInput,
  type SourceRow,
} from "../../api/fx";
import { formatDateTime, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel, Select, type Column } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { useApi } from "../../ui/use-api";

/**
 * Курсы валют (docs/29-admin-panel.md §3.3, «Курсы валют»): смотрят многие,
 * заданный курс звёзд ставит только владелец — у него право `fx.rates.edit`.
 * Оно же правит лимит источника и его счётчик запросов.
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

/** Тон расхода лимита: цвет числа и полосы; обычный — без окраски числа. */
const USAGE_TONES = {
  neutral: { text: "", bar: "bg-accent" },
  warning: { text: "text-warning", bar: "bg-warning" },
  danger: { text: "text-danger", bar: "bg-danger" },
} as const;

/** «6 120 из 10 000», доля, полоса и откуда лимит; без лимита — без полосы. */
function UsageCell({ source }: { source: SourceRow }) {
  const tone = USAGE_TONES[budgetTone(source.usedShare)];
  const share = source.usedShare;
  return (
    <span className="flex min-w-36 flex-col gap-1">
      <span className="whitespace-nowrap">
        <span className={tone.text}>{usageText(source)}</span>
        {share === null ? null : <span className="text-text-muted">{` · ${String(Math.floor(share * 100))}%`}</span>}
      </span>
      {share === null ? null : (
        <span role="progressbar" aria-label="Израсходовано" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.floor(share * 100))} className="h-1 w-full overflow-hidden rounded-pill bg-surface-raised">
          <span className={`block h-full ${tone.bar}`} style={{ width: `${String(Math.min(100, Math.round(share * 100)))}%` }} />
        </span>
      )}
      <span className="text-xs text-text-muted">{limitCaption(source)}</span>
    </span>
  );
}

type SourceEdit = { kind: "limit" | "used"; source: SourceRow };

function SourcesPanel({ sources, canEdit, onChanged }: { sources: readonly SourceRow[]; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<SourceEdit | null>(null);
  const columns: Column<SourceRow>[] = [
    { title: "Источник", render: (source) => source.source },
    { title: "Тариф", render: (source) => source.tariff },
    { title: "Израсходовано", help: HELP.fx.limit, render: (source) => <UsageCell source={source} /> },
    { title: "Пауза до", render: (source) => formatDateTime(source.pausedUntil) },
    { title: "Следующий опрос", render: (source) => formatDateTime(source.nextPollAt) },
  ];
  if (canEdit) {
    columns.push({
      title: "",
      render: (source) => (
        <span className="flex flex-wrap justify-end gap-1.5">
          <Button onClick={() => setEditing({ kind: "limit", source })}>Изменить лимит…</Button>
          <Button onClick={() => setEditing({ kind: "used", source })}>Поправить счётчик…</Button>
        </span>
      ),
    });
  }
  const close = () => setEditing(null);

  return (
    <Panel title="Источники" help={HELP.fx.sourcesPanel}>
      <DataTable rows={sources} rowKey={(source) => source.source} empty="Источников нет" columns={columns} />
      {editing?.kind === "limit" ? <LimitDialog source={editing.source} onClose={close} onSaved={onChanged} /> : null}
      {editing?.kind === "used" ? <UsedDialog source={editing.source} onClose={close} onSaved={onChanged} /> : null}
    </Panel>
  );
}

interface SourceDialogProps {
  source: SourceRow;
  onClose: () => void;
  onSaved: () => void;
}

const limitText = (perMonth: number | null) => (perMonth === null ? "без лимита" : formatNumber(perMonth));

/**
 * Лимит запросов в месяц (Р89): число или «без лимита», причина в аудит,
 * «Сбросить к тарифу» возвращает лимит из кода. Лимит в минуту и интервал
 * опроса не правятся — это защита поставщика, а не тариф.
 */
function LimitDialog({ source, onClose, onSaved }: SourceDialogProps) {
  const [unlimited, setUnlimited] = useState(source.limit.perMonth === null);
  const [text, setText] = useState(source.limit.perMonth === null ? "" : String(source.limit.perMonth));
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const perMonth = unlimited ? null : parseCount(text);
  const problem = limitValueProblem(perMonth);

  const reset = async () => {
    setResetting(true);
    setResetError(null);
    const result = await resetSourceLimit(api, source.source);
    setResetting(false);
    if (!result.ok) return setResetError(result.error.message);
    onSaved();
    onClose();
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Лимит источника «${source.source}»`}
      subject={`Сейчас: ${limitText(source.limit.perMonth)}, ${limitCaption(source)}`}
      problem={problem}
      changes={problem === null ? [{ label: "Запросов в месяц", value: `${limitText(source.limit.perMonth)} → ${limitText(perMonth)}` }] : []}
      reason={{ min: 3, max: 200, hint: "Попадёт в аудит вместе с прежним лимитом." }}
      action="Сохранить лимит"
      onConfirm={async (reason) => {
        const result = await setSourceLimit(api, source.source, { perMonth, note: reason });
        if (!result.ok) return { ok: false, error: result.error.message };
        onSaved();
        return { ok: true };
      }}
    >
      <div className="flex flex-col gap-3">
        <Field label="Запросов в календарный месяц (по UTC)" hint="Опросы растянутся на месяц, чтобы лимита хватило.">
          <Input inputMode="numeric" value={text} disabled={unlimited} onChange={(event) => setText(event.target.value)} placeholder="10 000" className="w-40" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={unlimited} onChange={(event) => setUnlimited(event.target.checked)} />
          Без лимита
        </label>
        {source.limit.from === "panel" ? (
          <div className="flex flex-col items-start gap-1.5">
            <Button disabled={resetting} onClick={() => void reset()}>
              {resetting ? "Сбрасываем…" : `Сбросить к тарифу «${source.tariff}»`}
            </Button>
            {resetError === null ? null : <Notice>{resetError}</Notice>}
          </div>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

/** Счётчик запросов за текущий месяц: поправить, когда он разошёлся с кабинетом поставщика. */
function UsedDialog({ source, onClose, onSaved }: SourceDialogProps) {
  const [text, setText] = useState(String(source.used));
  const used = parseCount(text);
  const problem = usedValueProblem(used);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Счётчик источника «${source.source}»`}
      subject={`Сейчас в этом месяце: ${formatNumber(source.used)}`}
      problem={problem}
      changes={problem === null ? [{ label: "Запросов за месяц", value: `${formatNumber(source.used)} → ${formatNumber(used)}` }] : []}
      reason={{ min: 3, max: 200, hint: "Например, «сверились с кабинетом поставщика». Попадёт в аудит." }}
      action="Поправить счётчик"
      onConfirm={async (reason) => {
        const result = await correctSourceUsed(api, source.source, { used, note: reason });
        if (!result.ok) return { ok: false, error: result.error.message };
        onSaved();
        return { ok: true };
      }}
    >
      <Field label="Запросов за текущий месяц" hint="Если расходится с кабинетом поставщика. С новым месяцем счётчик начнётся с нуля.">
        <Input inputMode="numeric" value={text} onChange={(event) => setText(event.target.value)} className="w-40" />
      </Field>
    </ConfirmDialog>
  );
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
          <Panel title="Курсы" help={HELP.fx.rates} actions={<Button onClick={reload}>Обновить</Button>}>
            <DataTable
              rows={state.data.rates}
              rowKey={(rate) => rate.currency}
              empty="Курсов нет"
              columns={[
                { title: "Валюта", render: (rate) => rate.currency },
                { title: "Цена в $", help: HELP.fx.usdPerUnit, render: (rate) => <code>{rate.usdPerUnit}</code>, align: "right" },
                { title: "Единиц за $", help: HELP.fx.unitsPerUsd, render: (rate) => <code>{rate.unitsPerUsd}</code>, align: "right" },
                { title: "Источники", help: HELP.fx.sources, render: (rate) => rate.sources.join(", ") },
                { title: "Снят", render: (rate) => formatDateTime(rate.observedAt) },
                { title: "Свежесть", help: HELP.fx.freshness, render: (rate) => <FreshnessBadge value={rate.freshness} /> },
              ]}
            />
          </Panel>
          <Panel title="Заданные курсы" help={HELP.fx.manual}>
            <DataTable
              rows={state.data.manual}
              rowKey={(rate) => `${rate.currency}|${rate.purpose}`}
              empty="Заданных курсов нет"
              columns={[
                { title: "Валюта", render: (rate) => rate.currency },
                { title: "Назначение", help: HELP.fx.purpose, render: (rate) => MANUAL_PURPOSES.find(([id]) => id === rate.purpose)?.[1] ?? rate.purpose },
                { title: "Цена", render: (rate) => <code>{`${rate.price} ${rate.quote}`}</code>, align: "right" },
                { title: "В $", render: (rate) => <code>{rate.usdPerUnit ?? "—"}</code>, align: "right" },
                { title: "Действует до", render: (rate) => formatDateTime(rate.expiresAt) },
                { title: "Свежесть", help: HELP.fx.freshness, render: (rate) => <FreshnessBadge value={rate.freshness} /> },
                { title: "Причина", render: (rate) => rate.note },
              ]}
            />
          </Panel>
          {can(view, "fx.rates.edit") ? <ManualRateForm onSaved={reload} /> : null}
          <SourcesPanel sources={state.data.sources} canEdit={can(view, "fx.rates.edit")} onChanged={reload} />
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
          <Field label="Назначение" help={HELP.fx.purpose}>
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
