import type { ReactNode } from "react";
import { fetchAllTime, platformLine, reachableShare, recordDate, starsLine, type AllTime, type AudienceRecord } from "../../api/all-time";
import { formatNumber, formatTime } from "../../format";
import { api } from "../../services";
import { Button, ErrorNotice, Help, Loading, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

/**
 * Тексты подсказок «?» панели «Чего достигли» (tasks/T-0203). Лежат здесь, а
 * не в `ui/help.ts`: тот файл правят чужие задачи, и тесты сверяют эти тексты
 * дословно со спецификацией.
 */
export const ALL_TIME_HELP = {
  panel: "Итоги за всё время из базы. Цифры кешируются на пять минут, поэтому могут отставать от сводки выше. Рекламные выплаты сетей в них не входят: денег от сетей в базе нет.",
  accounts: "Все аккаунты, в том числе команды и заблокированные: так же считает ежедневный отчёт в чат. Аккаунты на разных площадках — разные, одного человека на двух площадках мы не склеиваем.",
  reachable: "Аккаунты, которым бот может написать: игрок вошёл в канал площадки или разрешил сообщения и не заблокировал бота. Это аудитория рассылок.",
  played: "Игроки хотя бы с одним законченным забегом без читов. Забеги стирает вайп, поэтому и игроки, и забеги считаются с последнего вайпа.",
  revenue: "Звёзды живых оплат за всё время минус возвраты, тестовые оплаты не считаются. В рубли и доллары не пересчитываем: курс на дату оплаты не хранится.",
  records:
    "Лучшие сутки по числу разных игроков, запускавших игру: за сутки (DAU), за 7 суток (WAU) и за 30 суток (MAU), считая сутки по Москве. История — по сессиям запуска, вайп её не стирает. Сегодняшние сутки учитываются сразу, пока не закончились.",
} as const;

/** Колонки на широком экране: плитка дохода — только с правом, и сетка перестраивается. */
const TILE_COLUMNS = { 3: "lg:grid-cols-3", 4: "lg:grid-cols-4" } as const;

/**
 * Панель «Чего достигли» на экране «Сводка», ниже двух недель по суткам. Живёт
 * своим запросом: сводка обновляется раз в минуту, а эти итоги сервер держит в
 * кеше пять минут, поэтому панель грузится при открытии экрана и по кнопке
 * «Обновить» — само не обновляется. Сбой панели соседние не трогает.
 */
export function AllTimePanel() {
  const { state, reload } = useApi(() => fetchAllTime(api), []);
  return (
    <Panel
      title="Чего достигли"
      help={ALL_TIME_HELP.panel}
      actions={
        <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {state.status === "ok" ? <span className="text-xs text-text-muted">{`посчитано в ${formatTime(state.data.at)}`}</span> : null}
          <Button onClick={reload}>Обновить</Button>
        </span>
      }
    >
      {state.status === "loading" ? <Loading /> : state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : <AllTimeView data={state.data} />}
    </Panel>
  );
}

/** Плитки итогов и ряд рекордов; без загрузки и состояний — чистое отображение ответа. */
export function AllTimeView({ data }: { data: AllTime }) {
  const { accounts, reachable, played, revenue, records, at } = data;
  const accountLines = [platformLine(accounts.byPlatform), ...(accounts.banned > 0 ? [`заблокировано ${formatNumber(accounts.banned)}`] : [])];
  const columns = revenue === null ? 3 : 4;
  return (
    <div className="flex flex-col gap-4">
      <div className={`grid grid-cols-2 gap-2 ${TILE_COLUMNS[columns]}`}>
        <Tile title="Аккаунтов всего" help={ALL_TIME_HELP.accounts} value={accounts.total} lines={accountLines} />
        <Tile
          title="Можно писать в бота"
          help={ALL_TIME_HELP.reachable}
          value={reachable.total}
          lines={[platformLine(reachable.byPlatform), `${String(reachableShare(reachable.total, accounts.total))}% от всех`]}
        />
        {/* Без дохода плиток три: третья занимает ширину двух колонок телефона, а не висит в углу. */}
        <Tile
          title="Играло людей"
          help={ALL_TIME_HELP.played}
          value={played.players}
          lines={[`забегов ${formatNumber(played.runs)}`]}
          className={revenue === null ? "col-span-2 lg:col-span-1" : ""}
        />
        {revenue === null ? null : <Tile title="Доход, звёзд" help={ALL_TIME_HELP.revenue} value={revenue.stars} lines={[starsLine(revenue)]} />}
      </div>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Рекорды аудитории</h3>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          <RecordTile title="Рекорд DAU" record={records.dau} at={at} />
          <RecordTile title="Рекорд WAU" record={records.wau} at={at} />
          <RecordTile title="Рекорд MAU" record={records.mau} at={at} className="col-span-2 lg:col-span-1" />
        </div>
      </section>
    </div>
  );
}

/**
 * Плитка итога: число крупно, под ним строки пояснений. Подписи переносятся, а
 * не режутся: на телефоне горизонтальной прокрутки нет. Плитка — контейнер, и
 * размер числа берётся от её ширины (`cqw`), а не от окна: семь знаков
 * «1 234 567» в две колонки на 320 px вылезали бы за рамку, а на широком экране
 * число остаётся крупным (потолок — `--text-2xl`, как у плиток соседних панелей).
 */
function Tile({ title, help, value, lines, className = "" }: { title: string; help: string; value: number; lines: readonly ReactNode[]; className?: string }) {
  return (
    <div className={`@container flex min-w-0 flex-col gap-0.5 rounded-sm border border-border bg-surface-sunken px-3 py-2.5 ${className}`}>
      <span className="flex items-center gap-1 text-xs text-text-muted">
        {title}
        <Help text={help} />
      </span>
      <span className="font-display text-[length:clamp(var(--text-base),20cqw,var(--text-2xl))] leading-tight font-semibold tabular-nums">{formatNumber(value)}</span>
      {lines.map((line, index) => (
        <span key={index} className="break-words text-xs text-text-muted">
          {line}
        </span>
      ))}
    </div>
  );
}

/** Рекорд: значение, когда был, и сколько сейчас. Рекорда нет — нуль и «рекордов пока нет» вместо даты. */
function RecordTile({ title, record, at, className = "" }: { title: string; record: AudienceRecord | null; at: string; className?: string }) {
  const lines = record === null ? ["рекордов пока нет"] : [recordDate(record.day, at), `сейчас ${formatNumber(record.now)}`];
  return <Tile title={title} help={ALL_TIME_HELP.records} value={record?.value ?? 0} lines={lines} className={className} />;
}
