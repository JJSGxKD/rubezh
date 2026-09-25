import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { funnelReport, type FunnelRow } from "../modules/funnel/funnel-report.js";

/**
 * Воронка по источнику первого касания (docs/35-stage4-plan.md, Р30): сколько
 * аккаунтов дошло до каждой вехи — от входа в бота до первой покупки.
 *
 *   pnpm --filter backend-api funnel:report            — последние 30 суток
 *   pnpm --filter backend-api funnel:report 2026-10-01 2026-10-08
 *
 * Даты — по UTC, конец не включается. Только чтение: базу можно спрашивать
 * хоть боевую. В контейнере — `node dist/cli/funnel-report.js`.
 */

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;

async function main(): Promise<void> {
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const [fromArg, toArg] = process.argv.slice(2);
  const to = toArg === undefined ? new Date() : parseDay(toArg);
  const from = fromArg === undefined ? new Date(to.getTime() - DEFAULT_DAYS * DAY_MS) : parseDay(fromArg);

  const prisma = createPrisma(config);
  try {
    const rows = await funnelReport(prisma, from, to);
    console.log(`воронка ${from.toISOString().slice(0, 10)} — ${to.toISOString().slice(0, 10)}, когорта по первому контакту`);
    if (rows.length === 0) {
      console.log("аккаунтов с вехами за период нет");
      return;
    }
    console.table(rows.map(shown));
  } finally {
    await prisma.$disconnect();
  }
}

function parseDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Дата — ГГГГ-ММ-ДД, а не «${value}»`);
  return new Date(`${value}T00:00:00Z`);
}

/** Доля — от всех аккаунтов строки: так видно, на какой вехе отваливаются. */
function shown(row: FunnelRow): Record<string, string | number> {
  const share = (count: number): string => `${count} (${Math.round((count / row.accounts) * 100)}%)`;
  return {
    площадка: row.platform,
    источник: row.startRef === null ? row.startKind : `${row.startKind}:${row.startRef}`,
    аккаунтов: row.accounts,
    "вошёл в бота": share(row.entered),
    "открыл игру": share(row.appOpened),
    "начал забег": share(row.firstRunStarted),
    "закончил забег": share(row.firstRunFinished),
    "2 забега": share(row.runs2),
    "5 забегов": share(row.runs5),
    D1: share(row.returnedD1),
    D7: share(row.returnedD7),
    покупка: share(row.firstPurchase),
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
