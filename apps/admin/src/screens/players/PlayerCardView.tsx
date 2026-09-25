import { api } from "../../app";
import { fetchPlayerCard, FUNNEL_MILESTONES, resourceName, WALLET_RESOURCES, type PlayerCard } from "../../api/players";
import { formatDateTime, formatDelta, formatDuration, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Badge, Button, DataTable, ErrorNotice, KeyValue, Loading, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { BanPanel, WalletAdjustPanel } from "./PlayerActions";

/**
 * Карточка игрока (docs/29-admin-panel.md §2, «Игроки»). Что в ней видно,
 * решил сервер: без права на персональные данные нет ID и юзернейма, без
 * права на выручку — покупок. Панель честно пишет «скрыто», а не рисует пустоту.
 */
export function PlayerCardView({ accountId }: { accountId: string }) {
  const { state, reload } = useApi(() => fetchPlayerCard(api, accountId), [accountId]);
  const view = useSession((session) => session.view);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button onClick={() => navigate({ section: "players", id: null })}>← К поиску</Button>
      </div>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <>
          <Header card={state.data} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Funnel card={state.data} />
            <Acquisition card={state.data} />
            <Runs card={state.data} />
            <Wallet card={state.data} />
            {can(view, "players.ban") ? <BanPanel card={state.data} onChanged={reload} /> : null}
            {can(view, "players.wallet.adjust") ? <WalletAdjustPanel card={state.data} onChanged={reload} /> : null}
          </div>
          <Purchases card={state.data} />
        </>
      ) : null}
    </div>
  );
}

function Header({ card }: { card: PlayerCard }) {
  const { account, progress } = card;
  const share = progress.xpForNext === null || progress.xpForNext === 0 ? 1 : Math.min(1, progress.xpIntoLevel / progress.xpForNext);
  return (
    <Panel title={account.displayName} actions={account.banned === null ? null : <Badge tone="danger">заблокирован {formatDateTime(account.banned.at)}</Badge>}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <KeyValue
          items={[
            ["Аккаунт", <code className="text-xs">{account.accountId}</code>],
            ["Площадка", account.platform],
            ["ID на площадке", account.pii?.platformUserId ?? "скрыт — нет права на персональные данные"],
            ["Юзернейм", account.pii === null ? "скрыт" : account.pii.username === null ? "—" : `@${account.pii.username}`],
            ["С нами с", formatDateTime(account.createdAt)],
            ["Роли", card.roles.length === 0 ? "—" : card.roles.join(", ")],
          ]}
        />
        <div className="flex flex-col gap-2">
          <KeyValue
            items={[
              ["Уровень", `${progress.level}, опыт ${formatNumber(progress.xp)}`],
              ["Писать в бота", card.messaging === null ? "не знаем" : card.messaging.canMessage ? `можно (${card.messaging.reason})` : `нельзя (${card.messaging.reason})`],
            ]}
          />
          <div className="h-1.5 overflow-hidden rounded-pill bg-surface-sunken" title="Опыт внутри уровня">
            <div className="h-full bg-xp" style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Funnel({ card }: { card: PlayerCard }) {
  const { funnel } = card;
  return (
    <Panel title="Вехи воронки">
      {funnel === null ? (
        <p className="text-sm text-text-muted">Вех нет: игрок ни разу не входил.</p>
      ) : (
        <KeyValue items={[...FUNNEL_MILESTONES.map(([key, label]): [string, string] => [label, formatDateTime(funnel[key])]), ["Забегов записано", formatNumber(funnel.runsRecorded)]]} />
      )}
    </Panel>
  );
}

function Acquisition({ card }: { card: PlayerCard }) {
  const { acquisition } = card;
  const touch = (kind: string | null, ref: string | null) => (kind === null ? "—" : ref === null ? kind : `${kind}: ${ref}`);
  return (
    <Panel title="Откуда пришёл">
      {acquisition === null ? (
        <p className="text-sm text-text-muted">Касаний нет.</p>
      ) : (
        <KeyValue
          items={[
            ["Первое касание", `${formatDateTime(acquisition.firstAt)} — ${touch(acquisition.firstStartKind, acquisition.firstStartRef)}`],
            ["Последнее касание", acquisition.lastTouchAt === null ? "—" : `${formatDateTime(acquisition.lastTouchAt)} — ${touch(acquisition.lastStartKind, acquisition.lastStartRef)}`],
            ["Последний заход", formatDateTime(acquisition.lastSeenAt)],
          ]}
        />
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
              `Лучшее, ${difficulty}`,
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

function Purchases({ card }: { card: PlayerCard }) {
  return (
    <Panel title="Покупки">
      {card.purchases === null ? (
        <p className="text-sm text-text-muted">Скрыто: нет права на аналитику выручки.</p>
      ) : (
        <DataTable
          rows={card.purchases}
          rowKey={(purchase) => purchase.purchaseId}
          empty="Покупок нет"
          columns={[
            { title: "Счёт", render: (purchase) => formatDateTime(purchase.invoicedAt) },
            { title: "Статус", render: (purchase) => purchase.status },
            { title: "Режим", render: (purchase) => purchase.mode },
            { title: "Продолжение", render: (purchase) => purchase.continueNo, align: "right" },
            { title: "Цена, ⭐", render: (purchase) => formatNumber(purchase.priceStars), align: "right" },
            { title: "Списано, ⭐", render: (purchase) => formatNumber(purchase.chargedStars), align: "right" },
            { title: "Оплачен", render: (purchase) => formatDateTime(purchase.paidAt) },
            { title: "Возврат", render: (purchase) => (purchase.refundedAt === null ? "—" : `${formatDateTime(purchase.refundedAt)} (${purchase.refundReason ?? "—"})`) },
          ]}
        />
      )}
    </Panel>
  );
}
