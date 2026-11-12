import type { TrafficPeriod, TrafficReport } from "../../api/proxy-traffic";

/**
 * Чистые функции блока «Трафик через узлы Xray» (docs/35-stage4-plan.md Р192,
 * tasks/T-0386): байты словами, узлы всех подписок одной таблицей, итоги по
 * подпискам и подпись окна по времени смотрящего. Вынесены из компонента ради
 * теста.
 */

const KB = 1024;
const UNITS = ["КБ", "МБ", "ГБ", "ТБ"] as const;
const ONE_DECIMAL = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * «512 Б», «1,5 ГБ»: меньше килобайта — целые байты, дальше КБ, МБ, ГБ и ТБ с одним
 * знаком после запятой. Округление до «1024,0 КБ» не выдаётся — единица
 * переходит в следующую. Терабайт — последняя единица.
 */
export function bytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  if (Math.round(bytes) < KB) return `${String(Math.round(bytes))} Б`;
  let value = bytes / KB;
  let unit = 0;
  while (unit < UNITS.length - 1 && Math.round(value * 10) / 10 >= KB) {
    value /= KB;
    unit += 1;
  }
  return `${ONE_DECIMAL.format(value)} ${UNITS[unit] ?? "ТБ"}`;
}

export interface TrafficRow {
  /** подписка и узел: один узел может прийти из двух подписок */
  key: string;
  /** «Берлин» или «Берлин (нет в подписке)» */
  name: string;
  /** узла уже нет в подписке */
  gone: boolean;
  subscriptionName: string;
  upBytes: number;
  downBytes: number;
  totalBytes: number;
  upText: string;
  downText: string;
  totalText: string;
}

/** Узлы всех подписок одной таблицей по «всего» по убыванию; при равенстве — по названию и подписке, чтобы порядок не прыгал. */
export function trafficRows(report: Pick<TrafficReport, "subscriptions">): TrafficRow[] {
  return report.subscriptions
    .flatMap((subscription) =>
      subscription.nodes.map((node) => ({
        key: `${subscription.key}:${node.nodeKey}`,
        base: node.name,
        name: node.inSubscription ? node.name : `${node.name} (нет в подписке)`,
        gone: !node.inSubscription,
        subscriptionName: subscription.name,
        upBytes: node.upBytes,
        downBytes: node.downBytes,
        totalBytes: node.upBytes + node.downBytes,
      })),
    )
    .sort((a, b) => b.totalBytes - a.totalBytes || a.base.localeCompare(b.base, "ru") || a.subscriptionName.localeCompare(b.subscriptionName, "ru"))
    .map(({ base: _base, ...row }) => ({ ...row, upText: bytesText(row.upBytes), downText: bytesText(row.downBytes), totalText: bytesText(row.totalBytes) }));
}

/** Строка на подписку: «Основная: отдано 1,2 ГБ · получено 15,3 ГБ · всего 16,5 ГБ». Подписки — в порядке сервера. */
export function subscriptionTotals(report: Pick<TrafficReport, "subscriptions">): { key: string; name: string; text: string }[] {
  return report.subscriptions.map((subscription) => ({
    key: subscription.key,
    name: subscription.name,
    text: `${subscription.name}: отдано ${bytesText(subscription.upBytes)} · получено ${bytesText(subscription.downBytes)} · всего ${bytesText(subscription.upBytes + subscription.downBytes)}`,
  }));
}

const pad = (value: number): string => String(value).padStart(2, "0");

function localStamp(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** «с 06.11 14:00 до 07.11 14:00» по времени смотрящего: в базе и API всё в UTC. Мусор в границах — пустая подпись. */
export function windowLabel(report: Pick<TrafficReport, "from" | "to">): string {
  const from = localStamp(report.from);
  const to = localStamp(report.to);
  return from === null || to === null ? "" : `с ${from} до ${to}`;
}

const PERIOD_LABELS: Record<TrafficPeriod, string> = { day: "Сутки", week: "7 дней", month: "30 дней" };

export const periodLabel = (period: TrafficPeriod): string => PERIOD_LABELS[period];
