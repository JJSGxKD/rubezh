import { api } from "../../services";
import { fetchPlayerCard, FUNNEL_MILESTONES, purchaseLabel, resourceName, WALLET_RESOURCES, type PlayerCard } from "../../api/players";
import { fetchRestrictions, type Restriction } from "../../api/restrictions";
import { formatDateTime, formatDelta, formatDuration, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Badge, Button, DataTable, ErrorNotice, KeyValue, Loading, Panel } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { MessagePanel, WalletAdjustPanel } from "./PlayerActions";
import { RestrictionsPanel } from "./RestrictionsPanel";
import { SocialPanel } from "./SocialPanel";

/**
 * Карточка игрока (docs/29-admin-panel.md §2, «Игроки»). Что в ней видно,
 * решил сервер: без права на персональные данные нет ID и юзернейма, без
 * права на выручку — покупок. Панель честно пишет «скрыто», а не рисует пустоту.
 */
export function PlayerCardView({ accountId }: { accountId: string }) {
  const { state, reload } = useApi(() => fetchPlayerCard(api, accountId), [accountId]);
  const restrictions = useApi(() => fetchRestrictions(api, accountId), [accountId]);
  const view = useSession((session) => session.view);
  // Блокировка — тоже ограничение: после наложения и снятия обновляются и шапка, и список.
  const changed = () => {
    reload();
    restrictions.reload();
  };
  const active = restrictions.state.status === "ok" ? restrictions.state.data.restrictions.filter((row) => row.state === "active") : [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button onClick={() => navigate({ section: "players", id: null })}>← К поиску</Button>
      </div>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <>
          <Header card={state.data} active={active} />
          <RestrictionsPanel accountId={accountId} playerName={state.data.account.displayName} restrictions={restrictions.state} onChanged={changed} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Funnel card={state.data} />
            <Acquisition card={state.data} />
            <Runs card={state.data} />
            <Wallet card={state.data} />
            <SocialPanel accountId={accountId} />
            {can(view, "players.message") ? <MessagePanel card={state.data} /> : null}
            {can(view, "players.wallet.adjust") ? <WalletAdjustPanel card={state.data} onChanged={reload} /> : null}
          </div>
          <Purchases card={state.data} />
        </>
      ) : null}
    </div>
  );
}

function Header({ card, active }: { card: PlayerCard; active: readonly Restriction[] }) {
  const { account, progress } = card;
  const share = progress.xpForNext === null || progress.xpForNext === 0 ? 1 : Math.min(1, progress.xpIntoLevel / progress.xpForNext);
  // Блокировку шапка знает из аккаунта, остальное — из списка ограничений: модератор видит их, не листая карточку.
  const limited = active.filter((row) => row.kind !== "all");
  return (
    <Panel
      title={account.displayName}
      actions={
        <span className="flex flex-wrap gap-1.5">
          {limited.length === 0 ? null : <Badge tone="warning">закрыто: {limited.map((row) => (row.notify ? row.title : `${row.title} (молча)`)).join(", ")}</Badge>}
          {account.banned === null ? null : <Badge tone="danger">заблокирован {formatDateTime(account.banned.at)}</Badge>}
        </span>
      }
    >
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
              ["Предупреждение о тесте", testNoticeLabel(card.testNotice)],
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
    <Panel title="Вехи воронки" help={HELP.players.funnel}>
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
    <Panel title="Откуда пришёл" help={HELP.players.origin}>
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
            { title: "Что", render: (purchase) => purchaseLabel(purchase) },
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

/** Видел ли игрок предупреждение об открытом тесте и когда впервые — к спору о вайпе и покупках (WP33). */
function testNoticeLabel(notice: PlayerCard["testNotice"]): string {
  if (notice === undefined) return "не знаем";
  if (notice === null) return "не принимал";
  const first = formatDateTime(notice.firstAcceptedAt);
  return notice.version > 1 ? `принял ${first}, текст версии ${String(notice.version)} — ${formatDateTime(notice.acceptedAt)}` : `принял ${first}`;
}
