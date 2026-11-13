import { useState, type ReactNode } from "react";
import { api } from "../../services";
import { loadMyProject, monthTitle, moneyLine, type MyProject } from "../../api/my-project";
import { monthFrom } from "../../api/stakeholders";
import { formatNumber, plural } from "../../format";
import { Button, ErrorNotice, Notice, Panel, Select } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

/**
 * Кабинет «Мой проект» (docs/29-admin-panel.md §6.6, Р218): доля, выручка месяца, холд и черновик своей
 * части. Доллар — основная валюта, рубль и звёзды — рядом: выручка в Telegram приходит звёздами.
 * Суммы части — черновик до расходов, налога и займа: плашка стоит над суммой, а не мелко внизу.
 */
const PLATFORM_TITLES = { telegram: "Telegram", vk: "VK", max: "MAX", web: "Веб" } as const;
const SOURCE_TITLES = { shop: "Магазин", continue: "Второй шанс", vip: "VIP", donation: "Донаты" } as const;

const RATE = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RATE_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

function stars(value: number): string {
  return `${formatNumber(value)} ⭐`;
}

function Amounts({ usd, rub, starsValue, big = false }: { usd: string | null; rub: string | null; starsValue: number; big?: boolean }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 tabular-nums">
      {usd === null ? null : <b className={big ? "text-2xl" : "text-lg"}>{moneyLine(usd, "$")}</b>}
      {rub === null ? null : <span>{moneyLine(rub, "₽")}</span>}
      {usd === null ? <b className={big ? "text-2xl" : "text-lg"}>{stars(starsValue)}</b> : <span className="text-text-muted">{stars(starsValue)}</span>}
    </p>
  );
}

function Breakdown({ title, rows, total }: { title: string; rows: { key: string; title: string; net: number }[]; total: number }) {
  return (
    <div className="min-w-0 flex-1 basis-56">
      <h3 className="mb-1 text-xs font-semibold uppercase text-text-muted">{title}</h3>
      <ul className="flex flex-col gap-1 text-sm tabular-nums">
        {rows.map((row) => (
          <li key={row.key} className="flex justify-between gap-3">
            <span>{row.title}</span>
            <span>
              {stars(row.net)} <span className="text-text-muted">· {total > 0 ? Math.round((row.net / total) * 100) : 0} %</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShareBlock({ data }: { data: MyProject }) {
  const { viewer } = data;
  if (viewer.role === "finance") return null;
  let body: ReactNode;
  if (viewer.role === "owner") {
    body = <>Остаток после участников — {formatNumber(data.ownerSharePercent)} %</>;
  } else if (viewer.sharePercent === null || viewer.sharePercent <= 0) {
    body = "Доля ещё не назначена";
  } else {
    body = `${formatNumber(viewer.sharePercent)} %${viewer.shareFrom === null ? "" : ` с ${monthFrom(viewer.shareFrom)}`}`;
  }
  return (
    <Panel title="Моя доля">
      <p className="text-lg font-semibold tabular-nums">{body}</p>
    </Panel>
  );
}

function RevenueBlock({ data }: { data: MyProject }) {
  const { revenue } = data.project;
  const empty = revenue.stars.paid === 0;
  return (
    <Panel title="Выручка месяца">
      {empty ? (
        <p className="text-sm text-text-muted">В этом месяце оплат не было</p>
      ) : (
        <div className="flex flex-col gap-4">
          <Amounts usd={revenue.usd} rub={revenue.rub} starsValue={revenue.stars.net} big />
          <div className="flex flex-wrap gap-x-8 gap-y-4">
            <Breakdown title="По площадкам" rows={revenue.byPlatform.map((row) => ({ key: row.platform, title: PLATFORM_TITLES[row.platform], net: row.net }))} total={revenue.stars.net} />
            <Breakdown title="По источникам" rows={revenue.bySource.map((row) => ({ key: row.source, title: SOURCE_TITLES[row.source], net: row.net }))} total={revenue.stars.net} />
          </div>
          <p className="text-sm text-text-muted tabular-nums">Возвращено — {stars(revenue.stars.refunded)}</p>
        </div>
      )}
    </Panel>
  );
}

function HoldBlock({ data }: { data: MyProject }) {
  const { hold } = data.project;
  const next = hold.nextReleaseAt === null ? null : new Date(hold.nextReleaseAt);
  const nextText = next === null || Number.isNaN(next.getTime()) ? null : RATE_DATE.format(next);
  return (
    <Panel title="Холд">
      <p className="text-sm tabular-nums">
        В холде — {stars(hold.inHoldStars)}, вышло — {stars(hold.releasedStars)}
        {nextText === null ? "" : `, ближайший выход — ${nextText}`}
      </p>
      <p className="mt-1 text-xs text-text-muted">
        Звёзды становятся доступны к выводу через {hold.days} {plural(hold.days, ["день", "дня", "дней"])} после оплаты
      </p>
    </Panel>
  );
}

function DraftBlock({ data }: { data: MyProject }) {
  const { draft } = data.project;
  if (draft === null || data.viewer.role === "finance") return null;
  return (
    <Panel title="Черновик моей части">
      <div className="flex flex-col gap-2">
        <Notice tone="warning">Черновик: до расходов, налога и займа. Итог будет в отчёте закрытого месяца.</Notice>
        <Amounts usd={draft.usd} rub={draft.rub} starsValue={draft.stars} big />
      </div>
    </Panel>
  );
}

function ParticipantsBlock({ data }: { data: MyProject }) {
  return (
    <Panel title="Участники">
      <ul className="flex flex-col gap-1 text-sm tabular-nums">
        {data.participants.map((participant) => (
          <li key={`${participant.name}|${String(participant.sharePercent)}`} className="flex justify-between gap-3">
            <span>
              {participant.name}
              {participant.me ? <span className="text-text-muted"> · вы</span> : null}
            </span>
            <span>{formatNumber(participant.sharePercent)} %</span>
          </li>
        ))}
        <li className="border-t border-border pt-1 font-medium">Владелец — {formatNumber(data.ownerSharePercent)} %</li>
      </ul>
    </Panel>
  );
}

function RateLine({ data }: { data: MyProject }) {
  const { rates } = data;
  if (rates === null) {
    return <p className="text-xs text-text-muted">Курса выплаты звезды нет — суммы в долларах и рублях появятся, когда его зададут в разделе «Курсы»</p>;
  }
  const date = new Date(rates.at);
  const star = rates.starUsd.replace(".", ",");
  const dollar = RATE.format(Number(rates.usdRub));
  return (
    <p className="text-xs text-text-muted tabular-nums">
      1 ⭐ = {star} $ по курсу выплаты, 1 $ = {dollar} ₽{Number.isNaN(date.getTime()) ? "" : `, курс на ${RATE_DATE.format(date)}`}
    </p>
  );
}

/** Экран без загрузки: данные и смена месяца приходят снаружи — так его проверяют отдельно. */
export function MyProjectContent({ data, onMonth }: { data: MyProject; onMonth: (month: string) => void }) {
  const current = data.months[0] === data.month;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label="Месяц" value={data.month} onChange={(event) => onMonth(event.target.value)}>
          {data.months.map((month) => (
            <option key={month} value={month}>
              {monthTitle(month)}
            </option>
          ))}
        </Select>
        {current ? <span className="text-sm text-text-muted">месяц ещё идёт</span> : null}
      </div>
      <ShareBlock data={data} />
      <RevenueBlock data={data} />
      <HoldBlock data={data} />
      <DraftBlock data={data} />
      <ParticipantsBlock data={data} />
      <RateLine data={data} />
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Загрузка">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="h-24 rounded-md border border-border bg-surface-raised" />
      ))}
    </div>
  );
}

export function MyProjectScreen() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const { state, reload } = useApi(() => loadMyProject(api, month), [month]);
  return (
    <div className="flex flex-col gap-4">
      {state.status === "loading" ? <Skeleton /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? <MyProjectContent data={state.data} onMonth={setMonth} /> : null}
      {state.status === "error" ? null : <Button onClick={reload}>Обновить</Button>}
    </div>
  );
}
