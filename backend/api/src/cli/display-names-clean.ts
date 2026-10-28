import { pathToFileURL } from "node:url";
import { configFromEnvironment } from "../config/app-config.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createPrisma } from "../infra/database.js";
import { storedNameFor } from "../modules/auth/account.repository.js";
import type { NameVerdict } from "../modules/auth/display-name.js";
import type { NameRuleSet } from "../modules/name-rules/name-rules-engine.js";
import { loadNameRuleSet } from "../modules/name-rules/name-rules.repository.js";

/**
 * Почистить ники старых аккаунтов (tasks/T-0150): после выката новые входы
 * чистят ник сами, а те, кто не заходил, остаются с прежним — эта команда
 * прогоняет их тем же правилом, что вход.
 *
 *   pnpm --filter backend-api names:clean --dry-run   — только счётчики по вердиктам
 *   pnpm --filter backend-api names:clean             — почистить
 *
 * В контейнере — `node dist/cli/display-names-clean.js [--dry-run]`. Безопасно
 * повторять: чистый ник второй проход не меняет. У аккаунта без исходника
 * (`platformName`) нынешний ник чистится и сам же становится исходником.
 * Закреплённые модератором ники пропускаются. Правила фильтра имён из базы
 * (Р168) применяются тем же набором, что и при входе.
 */

const PAGE_SIZE = 500;
const VERDICTS: readonly NameVerdict[] = ["ok", "trimmed", "symbols", "empty", "profanity"];

/** Что команде нужно знать об аккаунте. */
export interface CleanupRow {
  accountId: string;
  displayName: string;
  username: string | null;
  platformName: string | null;
  nameLockedAt: Date | null;
}

export interface CleanupUpdate {
  accountId: string;
  displayName: string;
  /** исходник: прежний, а у аккаунта без него — нынешний ник до чистки */
  platformName: string;
}

export interface CleanupPlan {
  updates: CleanupUpdate[];
  /** вердикты по незакреплённым аккаунтам, и по тем, чей ник менять не нужно */
  byVerdict: Record<NameVerdict, number>;
  /** закреплённые пропущены */
  locked: number;
}

function emptyVerdicts(): Record<NameVerdict, number> {
  return { ok: 0, trimmed: 0, symbols: 0, empty: 0, profanity: 0 };
}

/**
 * Что менять в пачке. Чистится исходник, а если его нет — нынешний ник.
 * Аккаунт, у которого ник уже такой, каким его сделал бы вход, в
 * обновления не попадает: пустой исходник у чистого ника заполнит следующий
 * вход, а лишняя запись по каждому аккаунту команде ни к чему.
 */
export function planCleanup(rows: readonly CleanupRow[], rules?: NameRuleSet): CleanupPlan {
  const updates: CleanupUpdate[] = [];
  const byVerdict = emptyVerdicts();
  let locked = 0;
  for (const row of rows) {
    if (row.nameLockedAt !== null) {
      locked += 1;
      continue;
    }
    const source = row.platformName ?? row.displayName;
    const clean = storedNameFor(source, row.username, row.accountId, rules);
    byVerdict[clean.verdict] += 1;
    if (clean.name !== row.displayName) updates.push({ accountId: row.accountId, displayName: clean.name, platformName: source });
  }
  return { updates, byVerdict, locked };
}

export interface CleanArgs {
  dryRun: boolean;
}

export function parseCleanArgs(argv: readonly string[]): CleanArgs {
  const unknown = argv.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Неизвестные параметры: ${unknown.join(" ")}. Допустим только --dry-run`);
  return { dryRun: argv.includes("--dry-run") };
}

export interface CleanResult {
  scanned: number;
  /** сколько аккаунтов нужно менять */
  planned: number;
  /** сколько изменено; при --dry-run всегда 0 */
  updated: number;
  /** запись пропущена: аккаунт изменился между чтением и записью (вошёл игрок или модератор закрепил ник) */
  skipped: number;
  locked: number;
  byVerdict: Record<NameVerdict, number>;
}

/** Точки вмешательства для теста: в проде не задаются. */
export interface CleanHooks {
  /** после чтения пачки, перед её записью; пачки без изменений и сухой прогон его не вызывают */
  afterRead?: (rows: readonly CleanupRow[]) => Promise<void>;
  /** после каждой обработанной пачки, с нарастающими итогами (перечистка из панели показывает по нему ход) */
  onPage?: (progress: CleanResult) => Promise<void>;
  /** спрашивается перед каждой пачкой; `true` — выйти из цикла с тем, что набрано */
  shouldStop?: () => Promise<boolean>;
}

/**
 * Проход по всем аккаунтам пачками по `PAGE_SIZE`: курсор — `accountId`, а не
 * номер страницы, поэтому заведённые посреди прохода аккаунты ничего не
 * сдвигают. Запись условная: строка меняется, только если ник и исходник в
 * ней те же, что мы прочитали, и ник не закреплён, — игрок, вошедший посреди
 * чистки, не получает назад стёртое.
 */
export async function cleanAll(prisma: PrismaClient, args: CleanArgs, hooks: CleanHooks = {}, rules?: NameRuleSet): Promise<CleanResult> {
  const result: CleanResult = { scanned: 0, planned: 0, updated: 0, skipped: 0, locked: 0, byVerdict: emptyVerdicts() };
  let cursor: string | null = null;
  for (;;) {
    if ((await hooks.shouldStop?.()) === true) break;
    const rows: CleanupRow[] = await prisma.account.findMany({
      where: cursor === null ? {} : { accountId: { gt: cursor } },
      orderBy: { accountId: "asc" },
      take: PAGE_SIZE,
      select: { accountId: true, displayName: true, username: true, platformName: true, nameLockedAt: true },
    });
    const last = rows.at(-1);
    if (last === undefined) break;
    cursor = last.accountId;

    const plan = planCleanup(rows, rules);
    result.scanned += rows.length;
    result.planned += plan.updates.length;
    result.locked += plan.locked;
    for (const verdict of VERDICTS) result.byVerdict[verdict] += plan.byVerdict[verdict];
    if (!args.dryRun && plan.updates.length > 0) {
      await hooks.afterRead?.(rows);
      const before = new Map(rows.map((row) => [row.accountId, row]));
      const writes = plan.updates.flatMap((update) => {
        const read = before.get(update.accountId);
        if (read === undefined) return [];
        return [
          prisma.account.updateMany({
            where: { accountId: update.accountId, nameLockedAt: null, displayName: read.displayName, platformName: read.platformName },
            data: { displayName: update.displayName, platformName: update.platformName },
          }),
        ];
      });
      const outcomes = await prisma.$transaction(writes);
      for (const outcome of outcomes) {
        if (outcome.count === 0) result.skipped += 1;
        else result.updated += 1;
      }
    }
    await hooks.onPage?.({ ...result, byVerdict: { ...result.byVerdict } });
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseCleanArgs(process.argv.slice(2));
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  try {
    // Правила читаются один раз на весь проход: вход и команда считают ник по одному набору.
    // Битое правило пропускается с id в стандартном потоке ошибок, без шаблона.
    const rules = await loadNameRuleSet(prisma, (def, reason) => console.warn(`Правило ${def.ruleId} пропущено: ${reason}`));
    const result = await cleanAll(prisma, args, {}, rules);
    // Одна строка в формате логов бэкенда: по ней видно, сколько ников почищено и почему.
    console.log(JSON.stringify({ module: "names", event: "names_cleaned", byVerdict: result.byVerdict, dryRun: args.dryRun, scanned: result.scanned, planned: result.planned, updated: result.updated, skipped: result.skipped, locked: result.locked, rules: rules.size }));
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
