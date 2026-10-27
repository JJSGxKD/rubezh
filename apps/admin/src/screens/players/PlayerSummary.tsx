import type { PlayerCard } from "../../api/players";
import { purchaseLabel, purchaseState } from "../../api/players";
import { difficultyTitle } from "../../api/review";
import { formatDateTime, formatDuration, formatNumber } from "../../format";
import { HELP } from "../../ui/help";
import { Badge, KeyValue, Panel } from "../../ui/kit";
import { MILESTONE_CHAIN, summaryNumbers, type CardTab } from "./card-rules";

/** Дата вехи коротко — «21 сент.», в местном времени, как `formatDateTime`; полная — в `title`. */
const SHORT_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

/**
 * Вкладка «Сводка» (design/screens/admin-player.html): кто это и что с ним на
 * один взгляд — профиль, вехи цепочкой, откуда пришёл, шесть цифр и по три
 * последних покупки и забега. Без права на выручку покупок нет, забеги — на
 * всю ширину.
 */
export function PlayerSummary({ card, onTab }: { card: PlayerCard; onTab: (tab: CardTab) => void }) {
  const numbers = summaryNumbers(card);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Profile card={card} />
        <Milestones card={card} />
        <Acquisition card={card} />
      </div>
      <dl className="grid grid-cols-3 gap-2 lg:grid-cols-6">
        {numbers.map((item, index) => (
          <div key={item.label} className={`flex flex-col rounded-sm border border-border bg-surface-sunken px-3 py-2 ${index >= 3 ? "max-lg:hidden" : ""}`}>
            <dt className="order-2 text-xs text-text-muted">{item.label}</dt>
            <dd className="order-1 font-display text-lg tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
      <div className={`grid grid-cols-1 gap-4 ${card.purchases === null ? "" : "lg:grid-cols-2"}`}>
        {card.purchases === null ? null : <RecentPurchases card={card} onAll={() => onTab("purchases")} />}
        <RecentRuns card={card} onAll={() => onTab("runs")} />
      </div>
    </div>
  );
}

function Profile({ card }: { card: PlayerCard }) {
  const { progress } = card;
  const share = progress.xpForNext === null || progress.xpForNext === 0 ? 1 : Math.min(1, progress.xpIntoLevel / progress.xpForNext);
  return (
    <Panel title="Профиль">
      <div className="flex flex-col gap-2">
        <KeyValue
          items={[
            ["Уровень", `${progress.level}, опыт ${formatNumber(progress.xp)}`],
            ["Писать в бота", card.messaging === null ? "не знаем" : card.messaging.canMessage ? `можно (${card.messaging.reason})` : `нельзя (${card.messaging.reason})`],
            ["Предупреждение о тесте", testNoticeLabel(card.testNotice)],
            ["Роли", card.roles.length === 0 ? "—" : card.roles.join(", ")],
          ]}
        />
        <div className="h-1.5 overflow-hidden rounded-pill bg-surface-sunken" title="Опыт внутри уровня">
          <div className="h-full bg-xp" style={{ width: `${String(Math.round(share * 100))}%` }} />
        </div>
      </div>
    </Panel>
  );
}

/** Цепочка вех: пройденная — точка и линия цвета успеха с датой, непройденная — пустая точка. */
function Milestones({ card }: { card: PlayerCard }) {
  const { funnel } = card;
  return (
    <Panel title="Вехи воронки" help={HELP.players.funnel}>
      {funnel === null ? (
        <p className="text-sm text-text-muted">Вех нет: игрок ни разу не входил.</p>
      ) : (
        <ol className="grid grid-cols-6 gap-1">
          {MILESTONE_CHAIN.map(([key, title], index) => {
            const at = funnel[key];
            const next = MILESTONE_CHAIN[index + 1];
            const nextDone = next !== undefined && funnel[next[0]] !== null;
            return (
              <li key={key} className="flex min-w-0 flex-col items-center gap-1 text-center text-xs" title={at === null ? `${title}: ещё нет` : `${title}: ${formatDateTime(at)}`}>
                <span className="relative flex h-3 w-full items-center justify-center">
                  {index === MILESTONE_CHAIN.length - 1 ? null : <span aria-hidden="true" className={`absolute top-1/2 left-1/2 h-0.5 w-full -translate-y-1/2 ${at !== null && nextDone ? "bg-success" : "bg-border"}`} />}
                  <span aria-hidden="true" className={`relative size-3 rounded-full border-2 ${at === null ? "border-border-strong bg-surface" : "border-success bg-success"}`} />
                </span>
                <span className="w-full truncate">{title}</span>
                <span className="text-text-muted">{at === null ? "—" : SHORT_DATE.format(new Date(at))}</span>
              </li>
            );
          })}
        </ol>
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

function AllLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-sm text-accent hover:underline max-md:min-h-10">
      все →
    </button>
  );
}

function RecentPurchases({ card, onAll }: { card: PlayerCard; onAll: () => void }) {
  const rows = [...(card.purchases ?? [])].sort((a, b) => b.invoicedAt.localeCompare(a.invoicedAt)).slice(0, 3);
  return (
    <Panel title="Последние покупки" actions={<AllLink onClick={onAll} />}>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">Покупок нет</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((purchase) => {
            const state = purchaseState(purchase);
            return (
              <li key={purchase.purchaseId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="text-xs text-text-muted">{formatDateTime(purchase.invoicedAt)}</span>
                <span className="min-w-0 flex-1 truncate">{purchaseLabel(purchase)}</span>
                <span className="tabular-nums">{formatNumber(purchase.chargedStars)} ⭐</span>
                <Badge tone={state.tone}>{state.label}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function RecentRuns({ card, onAll }: { card: PlayerCard; onAll: () => void }) {
  const rows = card.runs.recent.slice(0, 3);
  return (
    <Panel title="Последние забеги" actions={<AllLink onClick={onAll} />}>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">Забегов нет</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((run) => (
            <li key={`${String(run.at)}-${run.difficultyId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="text-xs text-text-muted">{formatDateTime(run.at)}</span>
              <span>{difficultyTitle(run.difficultyId)}</span>
              <span className="tabular-nums">{formatDuration(run.survivalSec)}</span>
              <span className="text-text-muted">уровень {run.level}</span>
              <span className="min-w-0 flex-1 truncate text-right text-text-muted">{run.startingWeaponId}</span>
            </li>
          ))}
        </ul>
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
