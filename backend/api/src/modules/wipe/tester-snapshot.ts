import type { Prisma } from "../../generated/prisma/client.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import { bonusGems, grantOfKey, type CompensationGrant } from "./compensation-rules.js";

/**
 * Снимок компенсаций перед вайпом (docs/35-stage4-plan.md, Р87, tasks/T-0040).
 *
 * Вайп сотрёт кошелёк, журнал покупок в нём и уровень, а тестеру обещано
 * вернуть купленное за звёзды и дать бонус: после вайпа считать будет не из
 * чего. Поэтому снимок записывает «кому что вернуть» заранее, а выдаёт уже
 * окно «Спасибо за тест» (T-0042).
 *
 * Зовётся командой вайпа (T-0041) **внутри её транзакции**: между снимком и
 * стиранием никто не успевает ничего начислить, и снимок не расходится с тем,
 * что стёрто. Своих транзакций функция не открывает и ничего не стирает.
 *
 * Звёзды за второй шанс запоминаются звёздами, а не самоцветами: курс — открытый
 * вопрос О43, его применяет выдача, и решение по нему до вайпа не потребует
 * переделывать снимок.
 */

/** Сколько значений в одном `IN (…)` и одной вставке: запрос не упирается в предел параметров Postgres. */
const CHUNK = 1_000;

export interface SnapshotTotals {
  accounts: number;
  testers: number;
  bonusGems: number;
  /** сколько вернётся из купленного, по ресурсам */
  restored: Partial<Record<WalletResource, number>>;
  /** звёзды за второй шанс — к переводу в самоцветы при выдаче */
  continueStars: number;
}

interface Row {
  accountId: string;
  tester: boolean;
  level: number;
  bonusGems: number;
  grants: CompensationGrant[];
  continueStars: number;
}

function* chunks<T>(items: readonly T[]): Generator<T[]> {
  for (let from = 0; from < items.length; from += CHUNK) yield items.slice(from, from + CHUNK);
}

/** Порядок выдач в строке: по покупке, затем по ресурсу — одинаковый при любом числе повторов снимка. */
function byPurchaseThenResource(a: CompensationGrant, b: CompensationGrant): number {
  if (a.purchaseId !== b.purchaseId) return a.purchaseId < b.purchaseId ? -1 : 1;
  if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1;
  return 0;
}

/** Аккаунты, сыгравшие хотя бы один завершённый забег без читов: читы доступны только в инструментах команды. */
async function testersOf(tx: Prisma.TransactionClient): Promise<Set<string>> {
  const runs = await tx.run.groupBy({ by: ["accountId"], where: { status: "finished", cheats: false } });
  return new Set(runs.map((run) => run.accountId));
}

/**
 * Что начислили живые невозвращённые покупки — по аккаунтам. Источник —
 * строки журнала кошелька `purchase:<purchaseId>:<ресурс>`, а не каталог
 * магазина: состав набора мог поменяться после покупки.
 */
async function grantsOf(tx: Prisma.TransactionClient): Promise<Map<string, CompensationGrant[]>> {
  const entries = await tx.walletEntry.findMany({
    where: { reason: "purchase", idempotencyKey: { startsWith: "purchase:" }, amount: { gt: 0 } },
    select: { accountId: true, idempotencyKey: true, amount: true },
  });
  const found: { accountId: string; grant: CompensationGrant }[] = [];
  for (const entry of entries) {
    const grant = grantOfKey(entry.idempotencyKey, Number(entry.amount));
    if (grant !== null) found.push({ accountId: entry.accountId, grant });
  }

  // Тестовые оплаты бывают только в разработке, а за возвращённые деньги возвращать нечего.
  const counted = new Set<string>();
  for (const ids of chunks([...new Set(found.map((item) => item.grant.purchaseId))])) {
    const purchases = await tx.purchase.findMany({
      where: { purchaseId: { in: ids }, mode: "live", refundedAt: null, refundRequestedAt: null },
      select: { purchaseId: true },
    });
    for (const purchase of purchases) counted.add(purchase.purchaseId);
  }

  const byAccount = new Map<string, CompensationGrant[]>();
  for (const { accountId, grant } of found) {
    if (!counted.has(grant.purchaseId)) continue;
    byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), grant]);
  }
  for (const grants of byAccount.values()) grants.sort(byPurchaseThenResource);
  return byAccount;
}

/** Звёзды, списанные за второй шанс, который не вернули, — по аккаунтам. Начислений в кошельке у него нет. */
async function continueStarsOf(tx: Prisma.TransactionClient): Promise<Map<string, number>> {
  const sums = await tx.purchase.groupBy({
    by: ["accountId"],
    where: { product: "continue_run", mode: "live", paidAt: { not: null }, refundedAt: null, refundRequestedAt: null },
    _sum: { chargedStars: true },
  });
  const stars = new Map<string, number>();
  for (const sum of sums) {
    const total = sum._sum.chargedStars ?? 0;
    if (total > 0) stars.set(sum.accountId, total);
  }
  return stars;
}

async function levelsOf(tx: Prisma.TransactionClient, accountIds: readonly string[]): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  for (const ids of chunks(accountIds)) {
    const progress = await tx.accountProgress.findMany({ where: { accountId: { in: ids } }, select: { accountId: true, level: true } });
    for (const item of progress) levels.set(item.accountId, item.level);
  }
  return levels;
}

function totalsOf(rows: readonly Row[]): SnapshotTotals {
  const restored: Partial<Record<WalletResource, number>> = {};
  for (const row of rows) {
    for (const grant of row.grants) restored[grant.resource] = (restored[grant.resource] ?? 0) + grant.amount;
  }
  return {
    accounts: rows.length,
    testers: rows.filter((row) => row.tester).length,
    bonusGems: rows.reduce((sum, row) => sum + row.bonusGems, 0),
    restored,
    continueStars: rows.reduce((sum, row) => sum + row.continueStars, 0),
  };
}

/**
 * Снимок компенсаций (Р87). `write: false` — только посчитать для `wipe --plan`;
 * `write: true` — записать строки и знак «Тестер». Повторный снимок с записью —
 * ошибка: второй вайп — новое решение, а не повтор команды.
 *
 * Строка компенсации есть только у того, кому есть что выдать: тестер, или у
 * него есть купленное, или звёзды за второй шанс. Знак «Тестер» ставится здесь,
 * а не при выдаче: он виден, даже если игрок окно «Спасибо за тест» не открыл.
 */
export async function takeTesterSnapshot(tx: Prisma.TransactionClient, now: Date, options: { write: boolean }): Promise<SnapshotTotals> {
  if (options.write && (await tx.testerCompensation.findFirst({ select: { accountId: true } })) !== null) {
    throw new Error("снимок компенсаций уже есть — вайп уже был");
  }

  const testers = await testersOf(tx);
  const grants = await grantsOf(tx);
  const continueStars = await continueStarsOf(tx);

  const accountIds = [...new Set([...testers, ...grants.keys(), ...continueStars.keys()])].sort();
  const levels = await levelsOf(tx, accountIds);
  const rows: Row[] = accountIds.map((accountId) => {
    const tester = testers.has(accountId);
    const level = levels.get(accountId) ?? 1;
    return { accountId, tester, level, bonusGems: tester ? bonusGems(level) : 0, grants: grants.get(accountId) ?? [], continueStars: continueStars.get(accountId) ?? 0 };
  });

  if (options.write) {
    for (const part of chunks(rows)) {
      await tx.testerCompensation.createMany({
        data: part.map((row) => ({
          accountId: row.accountId,
          tester: row.tester,
          level: row.level,
          bonusGems: row.bonusGems,
          grants: row.grants.map(({ purchaseId, resource, amount }) => ({ purchaseId, resource, amount })),
          continueStars: row.continueStars,
          snapshotAt: now,
        })),
      });
    }
    // Знак, поставленный раньше, не перезаписывается: «навсегда» — с первого раза.
    for (const ids of chunks(rows.filter((row) => row.tester).map((row) => row.accountId))) {
      await tx.account.updateMany({ where: { accountId: { in: ids }, testerAt: null }, data: { testerAt: now } });
    }
  }
  return totalsOf(rows);
}
