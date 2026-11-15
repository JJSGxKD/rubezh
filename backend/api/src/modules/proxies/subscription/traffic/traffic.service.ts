import { Inject, Injectable } from "@nestjs/common";
import { RolesService, type AccountRef } from "../../../roles/roles.service.js";
import { SUBSCRIPTION_REPOSITORY, type SubscriptionRepository } from "../subscription.repository.js";
import { TrafficCollector } from "./traffic.collector.js";
import { TRAFFIC_REPOSITORY, type TrafficRepository, type TrafficTotal } from "./traffic.repository.js";
import { windowOf, type TrafficPeriod } from "./traffic-rules.js";

/**
 * Отчёт о трафике узлов Xray в панели (docs/35-stage4-plan.md Р192,
 * tasks/T-0386): сколько байт ушло к каждому узлу каждой подписки и пришло от
 * него за сутки, неделю или месяц. Смотреть — `proxies.view` (новых прав нет).
 *
 * Корзины соединяются с живыми подписками: строки удалённой подписки в отчёт не
 * попадают, а узел, которого в подписке уже нет, остаётся с названием из корзины и
 * пометкой `inSubscription: false`. «Отдано» — байты от нас к узлу (uplink),
 * «получено» — от узла к нам (downlink).
 */

export interface TrafficNodeView {
  nodeKey: string;
  name: string;
  /** узел ещё в подписке; нет — он ушёл из неё, а трафик за окно остался */
  inSubscription: boolean;
  upBytes: number;
  downBytes: number;
}

export interface TrafficSubscriptionView {
  key: string;
  name: string;
  upBytes: number;
  downBytes: number;
  /** только узлы, через которые что-то прошло; по «всего» по убыванию */
  nodes: TrafficNodeView[];
}

export interface TrafficReport {
  period: TrafficPeriod;
  /** начало первого часа окна, ISO */
  from: string;
  /** конец текущего часа, ISO */
  to: string;
  /** когда эта реплика последний раз получила счётчики Xray; `null` — ни разу (контейнера нет или он не отвечает) */
  lastCollectedAt: string | null;
  subscriptions: TrafficSubscriptionView[];
}

/** Байты числом, как `trafficUsedBytes` подписки: точность до 2^53 — это петабайты. */
const asNumber = (value: bigint): number => Number(value);

@Injectable()
export class TrafficService {
  constructor(
    @Inject(TRAFFIC_REPOSITORY) private readonly repository: TrafficRepository,
    @Inject(SUBSCRIPTION_REPOSITORY) private readonly subscriptions: SubscriptionRepository,
    private readonly roles: RolesService,
    private readonly collector: TrafficCollector,
  ) {}

  async report(actor: AccountRef, period: TrafficPeriod, now: Date = new Date()): Promise<TrafficReport> {
    await this.roles.require(actor, "proxies.view");
    const { from, to } = windowOf(period, now);
    const [totals, snapshots] = await Promise.all([this.repository.report(from), this.subscriptions.list()]);

    const bySubscription = new Map<string, TrafficTotal[]>();
    for (const total of totals) bySubscription.set(total.subscriptionKey, [...(bySubscription.get(total.subscriptionKey) ?? []), total]);

    return {
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      lastCollectedAt: this.collector.lastCollectedAt?.toISOString() ?? null,
      subscriptions: snapshots.map(({ subscription, nodes }) => {
        const current = new Map(nodes.map((node) => [node.nodeKey, node.name]));
        const rows = [...(bySubscription.get(subscription.key) ?? [])].sort(
          (a, b) => compareBig(b.upBytes + b.downBytes, a.upBytes + a.downBytes) || (current.get(a.nodeKey) ?? a.nodeName).localeCompare(current.get(b.nodeKey) ?? b.nodeName, "ru") || (a.nodeKey < b.nodeKey ? -1 : 1),
        );
        return {
          key: subscription.key,
          name: subscription.name,
          upBytes: asNumber(rows.reduce((sum, row) => sum + row.upBytes, 0n)),
          downBytes: asNumber(rows.reduce((sum, row) => sum + row.downBytes, 0n)),
          nodes: rows.map((row) => ({
            nodeKey: row.nodeKey,
            name: current.get(row.nodeKey) ?? row.nodeName,
            inSubscription: current.has(row.nodeKey),
            upBytes: asNumber(row.upBytes),
            downBytes: asNumber(row.downBytes),
          })),
        };
      }),
    };
  }
}

const compareBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
