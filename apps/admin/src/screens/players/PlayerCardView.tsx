import { api } from "../../services";
import { fetchPlayerCard, FUNNEL_MILESTONES, resourceName, WALLET_RESOURCES, type PlayerCard } from "../../api/players";
import { BAN_KIND, fetchRestrictions } from "../../api/restrictions";
import { difficultyTitle } from "../../api/review";
import { formatDateTime, formatDelta, formatDuration, formatNumber } from "../../format";
import { Button, DataTable, ErrorNotice, KeyValue, Loading, Panel } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { navigate, useHashRoute } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { CARD_TABS, cardTabOf, tabCounts, type CardTab } from "./card-rules";
import { PlayerHeader } from "./PlayerHeader";
import { PlayerSummary } from "./PlayerSummary";
import { PurchasesPanel } from "./PurchasesPanel";
import { RatingRunsPanel } from "./RatingRunsPanel";
import { RestrictionsPanel } from "./RestrictionsPanel";
import { SocialPanel } from "./SocialPanel";

/**
 * Карточка игрока вкладками (docs/29-admin-panel.md §2, «Игроки»): шапка с
 * действиями и «Сводка · Забеги · Покупки · Кошелёк · Друзья · Ограничения».
 * Что в ней видно, решил сервер: без права на персональные данные нет ID и
 * юзернейма, без права на выручку — покупок. Панель честно пишет «скрыто», а
 * не рисует пустоту. Вкладка — в адресе (`#/players/<id>/<вкладка>`): ссылка из
 * чата открывает нужную, «назад» возвращает прежнюю; смена вкладки карточку не
 * перечитывает.
 */
export function PlayerCardView({ accountId }: { accountId: string }) {
  const { state, reload } = useApi(() => fetchPlayerCard(api, accountId), [accountId]);
  const restrictions = useApi(() => fetchRestrictions(api, accountId), [accountId]);
  const tab = cardTabOf(useHashRoute()?.tab);
  // Блокировка — тоже ограничение: после наложения и снятия обновляются и шапка, и список.
  const changed = () => {
    reload();
    restrictions.reload();
  };
  const active = restrictions.state.status === "ok" ? restrictions.state.data.restrictions.filter((row) => row.state === "active") : [];
  // Блокировка закрывает и рейтинг — так же, как на сервере (`RATING_KINDS`).
  const ratingClosed = active.some((row) => row.kind === "leaderboard" || row.kind === BAN_KIND);
  const open = (next: CardTab) => navigate({ section: "players", id: accountId, ...(next === "summary" ? {} : { tab: next }) });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button onClick={() => navigate({ section: "players", id: null })}>← Игроки</Button>
      </div>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <>
          <PlayerHeader card={state.data} active={active} onChanged={changed} />
          <Tabs active={tab} counts={tabCounts(state.data, active)} onSelect={open} />
          {tab === "summary" ? <PlayerSummary card={state.data} onTab={open} /> : null}
          {tab === "runs" ? (
            <div className="flex flex-col gap-4">
              <Runs card={state.data} />
              {/* Таблица с действием в строке — на всю ширину. */}
              <RatingRunsPanel accountId={accountId} ratingClosed={ratingClosed} onChanged={reload} />
              <Funnel card={state.data} />
            </div>
          ) : null}
          {tab === "purchases" ? <PurchasesPanel card={state.data} onChanged={reload} /> : null}
          {tab === "wallet" ? <Wallet card={state.data} /> : null}
          {tab === "friends" ? <SocialPanel accountId={accountId} /> : null}
          {tab === "restrictions" ? <RestrictionsPanel accountId={accountId} playerName={state.data.account.displayName} restrictions={restrictions.state} onChanged={changed} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** Вкладки строкой под шапкой: активная — черта акцента снизу, число ожидающего — значком; на телефоне прокручивается строка, не страница. */
function Tabs({ active, counts, onSelect }: { active: CardTab; counts: Partial<Record<CardTab, number>>; onSelect: (tab: CardTab) => void }) {
  return (
    <div role="tablist" aria-label="Карточка игрока" className="flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]">
      {CARD_TABS.map((item) => {
        const selected = item.id === active;
        const count = counts[item.id];
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(item.id)}
            className={`-mb-px flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors ${selected ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text"}`}
          >
            {item.title}
            {count === undefined ? null : <span className="inline-flex min-w-5 justify-center rounded-pill bg-warning/15 px-1.5 text-xs font-semibold text-warning tabular-nums">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Funnel({ card }: { card: PlayerCard }) {
  const { funnel } = card;
  return (
    <Panel title="Вехи воронки" help={HELP.players.funnel}>
      {funnel === null ? (
        <p className="text-sm text-text-muted">Вех нет: игрок ни разу не входил.</p>
      ) : (
        <KeyValue items={[...FUNNEL_MILESTONES.map(([key, label]): [string, string] => [label, formatDateTime(funnel[key])]), ["Забегов записано", formatNumber(funnel.runsRecorded)]]} />
      )}
    </Panel>
  );
}

function Runs({ card }: { card: PlayerCard }) {
  const { runs } = card;
  return (
    <Panel title="Забеги">
      <div className="flex flex-col gap-3">
        <KeyValue
          items={[
            ["Всего", formatNumber(runs.runs)],
            ["Убийств", formatNumber(runs.totalKills)],
            ["Время в забегах", formatDuration(runs.totalSurvivalSec)],
            ...Object.entries(runs.best).map(([difficulty, best]): [string, string] => [
              `Лучшее, ${difficultyTitle(difficulty)}`,
              best === null ? "—" : `${formatDuration(best.survivalSec)}, место ${formatNumber(best.rank)}`,
            ]),
          ]}
        />
        <DataTable
          rows={runs.recent}
          rowKey={(run) => `${run.at}-${run.difficultyId}`}
          empty="Забегов нет"
          columns={[
            { title: "Когда", render: (run) => formatDateTime(run.at) },
            { title: "Сложность", render: (run) => run.difficultyId },
            { title: "Время", render: (run) => formatDuration(run.survivalSec), align: "right" },
            { title: "Уровень", render: (run) => run.level, align: "right" },
            { title: "Оружие", render: (run) => run.startingWeaponId },
          ]}
        />
      </div>
    </Panel>
  );
}

function Wallet({ card }: { card: PlayerCard }) {
  const { balances, entries } = card.wallet;
  const known = new Set(WALLET_RESOURCES.map(([id]) => id));
  const ids = [...WALLET_RESOURCES.map(([id]) => id), ...Object.keys(balances).filter((id) => !known.has(id))];
  return (
    <Panel title="Кошелёк">
      <div className="flex flex-col gap-3">
        <KeyValue items={ids.map((id): [string, string] => [resourceName(id), formatNumber(balances[id] ?? 0)])} />
        <DataTable
          rows={entries}
          rowKey={(entry) => entry.entryId}
          empty="Операций нет"
          columns={[
            { title: "Когда", render: (entry) => formatDateTime(entry.createdAt) },
            { title: "Ресурс", render: (entry) => resourceName(entry.resource) },
            { title: "Изменение", render: (entry) => formatDelta(entry.amount), align: "right" },
            { title: "Причина", render: (entry) => entry.reason },
            { title: "Источник", render: (entry) => entry.source ?? "—" },
          ]}
        />
      </div>
    </Panel>
  );
}
