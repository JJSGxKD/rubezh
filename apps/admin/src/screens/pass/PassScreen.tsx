import { useState } from "react";
import type { ApiError } from "../../api/client";
import { PHASE_TITLES, createSeason, describeReward, fetchSeason, fetchSeasons, monthTitle, publishSeason, ribbonTotals, totalsLines, type PassSeason, type PassSeasonRow, type PassSeasons, type PassTier } from "../../api/pass";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Field, FieldRow, Loading, Notice, Panel, RowItem, Select } from "../../ui/kit";
import { useApi } from "../../ui/use-api";
import { PassPreview } from "./PassPreview";
import { TierDialog } from "./TierDialog";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

/**
 * Батл-пасс (docs/35-stage4-plan.md Р46, tasks/T-0313): ленты месяца — 30
 * ступеней двух лент. Месяц выбирается сверху; у месяца без своей ленты игроки
 * идут по ленте из кода — её можно завести как есть или копией другого месяца.
 * Новая лента — черновик: игрок её не видит, пока её не опубликовали.
 */
export function PassScreen() {
  const { state, reload } = useApi(() => fetchSeasons(api), []);
  const [chosen, setChosen] = useState<string | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const seasons = state.data;
  const month = chosen ?? seasons.currentMonth;
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Месяц" help={HELP.pass.months}>
        <FieldRow>
          <Field label="Месяц ленты">
            <Select value={month} onChange={(event) => setChosen(event.target.value)}>
              {seasons.months.map((row) => (
                <option key={row.monthKey} value={row.monthKey}>
                  {monthLabel(row)}
                </option>
              ))}
            </Select>
          </Field>
        </FieldRow>
      </Panel>
      <MonthView month={month} seasons={seasons} reloadSeasons={reload} />
    </div>
  );
}

function monthLabel(row: PassSeasonRow): string {
  const status = !row.saved ? "лента по умолчанию" : row.published ? "опубликована" : "черновик";
  return `${monthTitle(row.monthKey)} — ${PHASE_TITLES[row.phase] ?? row.phase}, ${status}`;
}

function MonthView({ month, seasons, reloadSeasons }: { month: string; seasons: PassSeasons; reloadSeasons: () => void }) {
  const { state, reload } = useApi(() => fetchSeason(api, month), [month]);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [source, setSource] = useState("");
  const [pending, setPending] = useState(false);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const season = state.data;
  const sources = seasons.months.filter((row) => row.saved && row.monthKey !== month);
  const refresh = () => {
    reload();
    reloadSeasons();
  };

  const create = async (from: string | null) => {
    setPending(true);
    setOutcome(null);
    const result = await createSeason(api, month, from);
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `Лента «${monthTitle(month)}» заведена черновиком${from === null ? "" : ` — копия «${monthTitle(from)}»`}. Игроки увидят её после публикации` });
    refresh();
  };

  const publish = async () => {
    setConfirmPublish(false);
    setPending(true);
    setOutcome(null);
    const result = await publishSeason(api, month);
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `Лента «${monthTitle(month)}» опубликована — игроки видят её с этого момента` });
    refresh();
  };

  const tierBlock = (tier: PassTier): string | null => {
    if (!season.saved) return "Сначала заведите ленту месяца";
    if (season.phase === "past") return "Прошлый месяц — только чтение";
    return tier.tier <= season.lockedTiers ? "Эту ступень уже прошли игроки" : null;
  };
  const editingTier = editing === null ? undefined : season.tiers.find((tier) => tier.tier === editing);

  return (
    <div className="flex flex-col gap-4">
      {outcome === null ? null : outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}

      <Panel
        title={monthTitle(month)}
        help={HELP.pass.state}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={season.phase === "current" ? "success" : season.phase === "future" ? "info" : "neutral"}>{PHASE_TITLES[season.phase] ?? season.phase}</Badge>
            <Badge tone={!season.saved ? "neutral" : season.published ? "success" : "warning"}>{!season.saved ? "лента по умолчанию" : season.published ? "опубликована" : "черновик"}</Badge>
            <Button onClick={() => setPreviewing(true)}>Предпросмотр</Button>
            {season.saved && !season.published && season.phase !== "past" ? (
              confirmPublish ? (
                <>
                  <Button tone="primary" disabled={pending} onClick={() => void publish()}>
                    Да, опубликовать
                  </Button>
                  <Button onClick={() => setConfirmPublish(false)}>Отмена</Button>
                </>
              ) : (
                <Button tone="primary" disabled={pending} onClick={() => setConfirmPublish(true)}>
                  Опубликовать
                </Button>
              )
            ) : null}
          </div>
        }
      >
        <Describe season={season} />
        {season.saved || season.phase === "past" ? null : (
          <div className="mt-3 flex flex-col gap-3">
            <FieldRow>
              <RowItem>
                <Button tone="primary" disabled={pending} onClick={() => void create(null)}>
                  Завести по умолчанию
                </Button>
              </RowItem>
              <Field label="…или скопировать месяц" help={HELP.pass.copy}>
                <Select value={source} onChange={(event) => setSource(event.target.value)} disabled={sources.length === 0}>
                  <option value="">{sources.length === 0 ? "нет заведённых месяцев" : "выберите месяц"}</option>
                  {sources.map((row) => (
                    <option key={row.monthKey} value={row.monthKey}>
                      {monthTitle(row.monthKey)}
                    </option>
                  ))}
                </Select>
              </Field>
              <RowItem>
                <Button disabled={source === "" || pending} onClick={() => void create(source)}>
                  Скопировать
                </Button>
              </RowItem>
            </FieldRow>
          </div>
        )}
      </Panel>

      <Totals tiers={season.tiers} />

      <Panel title="Ступени" help={HELP.pass.tiers}>
        <DataTable
          rows={season.tiers}
          rowKey={(tier) => String(tier.tier)}
          columns={[
            { title: "Ступень", align: "right", primary: true, render: (tier) => String(tier.tier) },
            { title: "Бесплатная", render: (tier) => describeReward(tier.free) },
            { title: "VIP", render: (tier) => describeReward(tier.vip) },
            {
              title: "",
              render: (tier) => {
                const block = tierBlock(tier);
                return (
                  <Button disabled={block !== null} title={block ?? undefined} onClick={() => setEditing(tier.tier)}>
                    Изменить
                  </Button>
                );
              },
            },
          ]}
        />
      </Panel>

      {editingTier === undefined ? null : (
        <TierDialog
          season={season}
          tier={editingTier}
          onClose={() => setEditing(null)}
          onSaved={(tier) => {
            setEditing(null);
            setOutcome({ tone: "success", text: `Ступень ${String(tier)} сохранена${season.published ? " — игроки видят правку сразу" : ""}` });
            refresh();
          }}
        />
      )}
      {previewing ? <PassPreview season={season} onClose={() => setPreviewing(false)} /> : null}
    </div>
  );
}

/** Строка состояния месяца: что видят игроки и что закрыто для правки. */
function Describe({ season }: { season: PassSeason }) {
  const points = `${formatNumber(season.pointsPerTier)} очков на ступень`;
  if (season.phase === "past") return <p className="text-sm text-text-muted">Месяц прошёл: ленту можно только смотреть. {points}.</p>;
  if (!season.saved) return <p className="text-sm text-text-muted">Своей ленты у месяца нет — игроки идут по ленте из кода. {points}.</p>;
  const locked = season.lockedTiers > 0 ? ` Ступени с 1-й по ${String(season.lockedTiers)}-ю уже прошли игроки — их не править.` : "";
  const shown = season.published ? `Опубликована ${formatDateTime(season.publishedAt)} — игроки видят эту ленту.` : "Черновик: игроки его не видят, пока его не опубликовали.";
  return (
    <p className="text-sm text-text-muted">
      {shown}
      {locked} {points}.
    </p>
  );
}

/** Сколько наград в ленте: уходит в экономику, если игрок заберёт всё. */
function Totals({ tiers }: { tiers: readonly PassTier[] }) {
  const totals = ribbonTotals(tiers);
  const amounts = (lines: ReturnType<typeof totalsLines>) => new Map(lines.map((line) => [line.key, line.amount]));
  const free = amounts(totalsLines(totals.free));
  const vip = amounts(totalsLines(totals.vip));
  const rows = totalsLines(totals.total).map((line) => ({ key: line.key, title: line.title, free: free.get(line.key) ?? 0, vip: vip.get(line.key) ?? 0, total: line.amount }));
  return (
    <Panel title="Сумма наград месяца" help={HELP.pass.totals}>
      <DataTable
        rows={rows}
        rowKey={(row) => row.key}
        empty="В ленте нет наград"
        columns={[
          { title: "Что", primary: true, render: (row) => row.title },
          { title: "Бесплатная", align: "right", render: (row) => formatNumber(row.free) },
          { title: "VIP", align: "right", render: (row) => formatNumber(row.vip) },
          { title: "Всего", align: "right", render: (row) => formatNumber(row.total) },
        ]}
      />
    </Panel>
  );
}
