import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../../../generated/prisma/client.js";
import { PRISMA } from "../../../../infra/database.js";

/**
 * Часовые корзины трафика узлов Xray в базе (`proxy_traffic_hour`,
 * docs/35-stage4-plan.md Р192, tasks/T-0386). Запрос к базе живёт здесь, а не в
 * сборщике и сервисе (docs/15-engineering-standards.md §2.3). Внешнего ключа на
 * подписку нет: отчёт соединяется с живыми подписками, а строки удалённой уходят
 * по сроку хранения.
 */

/** Прибавка трафика узла подписки за один час. */
export interface TrafficRow {
  /** начало часа по UTC */
  hour: Date;
  subscriptionKey: string;
  nodeKey: string;
  /** название узла на момент чтения: узел мог уйти из подписки */
  nodeName: string;
  upBytes: bigint;
  downBytes: bigint;
}

/** Сумма узла подписки за окно отчёта. */
export interface TrafficTotal {
  subscriptionKey: string;
  nodeKey: string;
  /** название из самой поздней корзины окна */
  nodeName: string;
  upBytes: bigint;
  downBytes: bigint;
}

export const TRAFFIC_REPOSITORY = Symbol("TRAFFIC_REPOSITORY");

export interface TrafficRepository {
  /**
   * Прибавить трафик к корзинам одним запросом: нет строки — создаётся, есть —
   * байты складываются, название берётся новое. Прибавление атомарно в базе,
   * поэтому реплики пишут без замка и ничего не теряют. Всё или ничего.
   */
  add(rows: readonly TrafficRow[]): Promise<void>;
  /** Сумма по подписке и узлу с корзин начиная с `fromHour` (включительно). */
  report(fromHour: Date): Promise<TrafficTotal[]>;
  /** Удалить корзины строго старше `hour`; сколько удалено. */
  deleteBefore(hour: Date): Promise<number>;
}

/** Строки одного ключа сворачиваются: два ряда с одним ключом в одном `INSERT … ON CONFLICT` база отвергла бы. */
function merged(rows: readonly TrafficRow[]): TrafficRow[] {
  const byKey = new Map<string, TrafficRow>();
  for (const row of rows) {
    const key = `${row.hour.getTime()}|${row.subscriptionKey}|${row.nodeKey}`;
    const found = byKey.get(key);
    byKey.set(key, found === undefined ? { ...row } : { ...row, upBytes: found.upBytes + row.upBytes, downBytes: found.downBytes + row.downBytes });
  }
  return [...byKey.values()];
}

interface TotalRow {
  subscription_key: string;
  node_key: string;
  node_name: string;
  up_bytes: bigint;
  down_bytes: bigint;
}

@Injectable()
export class PrismaTrafficRepository implements TrafficRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async add(rows: readonly TrafficRow[]): Promise<void> {
    const batch = merged(rows);
    if (batch.length === 0) return;
    // Массивы строками с приведением типа: час и BIGINT проходят через драйвер без потери точности.
    const hours = batch.map((row) => row.hour.toISOString());
    const subscriptions = batch.map((row) => row.subscriptionKey);
    const nodes = batch.map((row) => row.nodeKey);
    const names = batch.map((row) => row.nodeName);
    const ups = batch.map((row) => row.upBytes.toString());
    const downs = batch.map((row) => row.downBytes.toString());
    await this.prisma.$executeRaw`
      INSERT INTO proxy_traffic_hour (hour, subscription_key, node_key, node_name, up_bytes, down_bytes)
      SELECT u.hour, u.subscription_key, u.node_key, u.node_name, u.up_bytes, u.down_bytes
      FROM unnest(${hours}::timestamptz[], ${subscriptions}::text[], ${nodes}::text[], ${names}::text[], ${ups}::bigint[], ${downs}::bigint[])
        AS u(hour, subscription_key, node_key, node_name, up_bytes, down_bytes)
      ON CONFLICT (hour, subscription_key, node_key) DO UPDATE SET
        up_bytes = proxy_traffic_hour.up_bytes + EXCLUDED.up_bytes,
        down_bytes = proxy_traffic_hour.down_bytes + EXCLUDED.down_bytes,
        node_name = EXCLUDED.node_name`;
  }

  async report(fromHour: Date): Promise<TrafficTotal[]> {
    // Название — из самой поздней корзины узла в окне: порядок внутри группы берёт его одним проходом.
    const rows = await this.prisma.$queryRaw<TotalRow[]>`
      SELECT subscription_key, node_key,
             (array_agg(node_name ORDER BY hour DESC))[1] AS node_name,
             sum(up_bytes)::bigint AS up_bytes,
             sum(down_bytes)::bigint AS down_bytes
      FROM proxy_traffic_hour
      WHERE hour >= ${fromHour}
      GROUP BY subscription_key, node_key`;
    return rows.map((row) => ({ subscriptionKey: row.subscription_key, nodeKey: row.node_key, nodeName: row.node_name, upBytes: BigInt(row.up_bytes), downBytes: BigInt(row.down_bytes) }));
  }

  async deleteBefore(hour: Date): Promise<number> {
    const { count } = await this.prisma.proxyTrafficHour.deleteMany({ where: { hour: { lt: hour } } });
    return count;
  }
}
