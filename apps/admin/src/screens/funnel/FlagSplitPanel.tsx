import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../services";
import { flagReach } from "../../api/flags";
import { VERDICT_TITLES, fetchFlagSplit, splitMetrics, type SplitMetric, type SplitVerdict } from "../../api/flag-split";
import { periodFromDates, type Period } from "../../api/funnel";
import { formatDateTime } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel, Select, type Column } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { useApi } from "../../ui/use-api";

/** Якорь блока: «Флаги» ведут прямо к сравнению — `#/funnel/ads.interstitial`. */
export const FLAG_SPLIT_ANCHOR = "flag-split";

const VERDICT_TONES: Record<SplitVerdict, "success" | "neutral" | "warning"> = { reliable: "success", noise: "neutral", few: "warning" };

/**
 * Доля флага против остальных (docs/35-stage4-plan.md WP12, часть 10b):
 * решение «оставить» — по удержанию, деньгам и вовлечённости доли. Период
 * по умолчанию — с последнего изменения флага: до него доля была другой.
 */
export function FlagSplitPanel({ focus }: { focus: string | null }) {
  const [flag, setFlag] = useState<string | null>(focus);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [period, setPeriod] = useState<Period>({});
  const { state, reload } = useApi(() => fetchFlagSplit(api, flag, period), [flag, period.from, period.to]);

  useEffect(() => {
    if (focus !== null) document.getElementById(FLAG_SPLIT_ANCHOR)?.scrollIntoView({ block: "start" });
  }, [focus]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPeriod(periodFromDates(fromDate, toDate));
  };

  const selected = state.status === "ok" ? state.data.flags.find((item) => item.key === state.data.flag) : undefined;
  const columns: Column<SplitMetric>[] = [
    {
      title: "Показатель",
      render: (row) => (
        <span className="flex max-w-80 flex-col">
          <span>{row.title}</span>
          <span className="text-xs text-text-muted">{row.hint}</span>
        </span>
      ),
    },
    { title: "В доле флага", align: "right", render: (row) => <ValueCell value={row.share.value} detail={row.share.detail} /> },
    { title: "Остальные", align: "right", render: (row) => <ValueCell value={row.rest.value} detail={row.rest.detail} /> },
    { title: "Разница", align: "right", render: (row) => <span className="whitespace-nowrap">{row.diff ?? "—"}</span> },
    { title: "Вывод", help: HELP.funnel.verdict, render: (row) => (row.verdict === null ? null : <Badge tone={VERDICT_TONES[row.verdict]}>{VERDICT_TITLES[row.verdict]}</Badge>) },
  ];

  return (
    <div id={FLAG_SPLIT_ANCHOR}>
      <Panel title="Доля флага против остальных" help={HELP.funnel.split} actions={<Button onClick={reload}>Обновить</Button>}>
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === "ok" && state.data.flags.length === 0 ? <p className="text-sm text-text-muted">Флагов нет — сравнивать нечего. Флаги заводят в разделе «Флаги».</p> : null}
        {state.status === "ok" && state.data.flags.length > 0 ? (
          <div className="flex flex-col gap-3">
            <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
              <Field label="Флаг">
                <Select value={state.data.flag ?? ""} onChange={(event) => setFlag(event.target.value)} className="w-64">
                  {state.data.flags.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.key}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="С">
                <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
              </Field>
              <Field label="По (включительно)">
                <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
              </Field>
              <Button tone="primary" type="submit">
                Показать
              </Button>
              <span className="pb-2 text-xs text-text-muted">Пусто — с последнего изменения флага; не длиннее года.</span>
            </form>
            {selected === undefined ? null : (
              <p className="text-sm text-text-muted">
                <code className="text-xs">{selected.key}</code> — {selected.enabled ? `получают: ${flagReach(selected)}` : `выключен; доля — ${selected.percent}%`}
                {selected.note === null ? null : ` · ${selected.note}`}. Изменён {formatDateTime(selected.updatedAt)} — до этого доля была другой.
              </p>
            )}
            {selected !== undefined && !selected.enabled ? (
              <Notice tone="warning">Флаг выключен: доля сейчас ничего не получает, и разница покажет только случайность. Сравнивайте период, когда он был включён.</Notice>
            ) : null}
            {state.data.split === null || state.data.from === null || state.data.to === null ? null : (
              <>
                <p className="text-xs text-text-muted">
                  Пришли с {formatDateTime(state.data.from)} по {formatDateTime(state.data.to)}. Доля считается по нынешним настройкам флага. Решают строки с надёжной
                  разницей; «не отличить от случайности» — ждите больше игроков.
                </p>
                <DataTable rows={splitMetrics(state.data.split.share, state.data.split.rest)} rowKey={(row) => row.key} columns={columns} />
              </>
            )}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function ValueCell({ value, detail }: { value: string; detail: string | null }) {
  return (
    <span className="flex flex-col items-end whitespace-nowrap">
      <span>{value}</span>
      {detail === null ? null : <span className="text-xs text-text-muted">{detail}</span>}
    </span>
  );
}
