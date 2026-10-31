import type { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Метка «Отдельная доска» в отчётах панели (docs/35-stage4-plan.md Р104,
 * T-0115). Это измерение при выборке, а не поле события: в поток событий,
 * таблицы аналитики и Prometheus ничего не добавляется. Метку читают только
 * отчёты панели и только держатель права `players.board.restrict`; чат,
 * постбэки сетям, кабинет партнёров и выплаты считают аккаунт обычным игроком
 * (`board-mark-boundary.test.ts` держит эту границу).
 *
 * Аккаунт помечен, если вид действовал в окне отчёта хотя бы часть времени:
 * снятый вид не стирает прошлые цифры.
 */

export const BOARD_MARK_LABEL = "Отдельная доска";

/** Вид, о котором метка. Строкой, а не из каталога: каталог не должен тянуть отчёты. */
const BOARD_KIND = "separate_board";

export interface MarkWindow {
  from: Date;
  to: Date;
}

/** Сколько помеченных и какая часть сводки на них приходится. */
export interface BoardMark {
  /** аккаунтов с видом в окне */
  marked: number;
  /** из них открывавших игру в окне */
  active: number;
  /** из них созданных в окне */
  newAccounts: number;
  /** их завершённых забегов без читов — те же, что считает сводка */
  runs: number;
}

export const NO_BOARD_MARK: BoardMark = { marked: 0, active: 0, newAccounts: 0, runs: 0 };

interface ViewTimes {
  startsAt: Date;
  endsAt: Date | null;
  liftedAt: Date | null;
  settledAt: Date | null;
}

/**
 * То же правило, что в запросе `markedAccountIds`: вид начался до конца окна и
 * кончился после его начала. Конец — самое раннее из срока, снятия и расчёта;
 * пусто — бесконечность.
 */
export function markedInWindow(view: ViewTimes, from: Date, to: Date): boolean {
  if (view.startsAt.getTime() >= to.getTime()) return false;
  const ends = [view.endsAt, view.liftedAt, view.settledAt].filter((moment): moment is Date => moment !== null);
  if (ends.length === 0) return true;
  return Math.min(...ends.map((moment) => moment.getTime())) > from.getTime();
}

/**
 * Помеченные аккаунты окна. Таблица видов мала (десятки строк на сотни тысяч
 * аккаунтов), поэтому отдельный индекс по `kind` не заводим: фильтр идёт по
 * существующему, остальное — последовательный просмотр крошечной таблицы.
 */
export async function markedAccountIds(prisma: PrismaClient, from: Date, to: Date): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ account_id: string }[]>`
    SELECT DISTINCT account_id::text AS account_id
    FROM account_restriction
    WHERE kind = ${BOARD_KIND}
      AND starts_at < ${to}
      AND (LEAST(lifted_at, settled_at, ends_at) IS NULL OR LEAST(lifted_at, settled_at, ends_at) > ${from})`;
  return rows.map((row) => row.account_id);
}

interface RawCounts {
  active: bigint;
  new_accounts: bigint;
  runs: bigint;
}

/** Счёты по помеченным: сначала список id, затем три счёта по `account_id = ANY`. */
export async function boardMark(prisma: PrismaClient, { from, to }: MarkWindow): Promise<BoardMark> {
  const ids = await markedAccountIds(prisma, from, to);
  if (ids.length === 0) return NO_BOARD_MARK;
  const [counts] = await prisma.$queryRaw<RawCounts[]>`
    SELECT
      (SELECT count(DISTINCT account_id) FROM account_session
        WHERE account_id = ANY(${ids}::uuid[]) AND started_at >= ${from} AND started_at < ${to}) AS active,
      (SELECT count(*) FROM account
        WHERE account_id = ANY(${ids}::uuid[]) AND created_at >= ${from} AND created_at < ${to}) AS new_accounts,
      -- Забег с читами — разработчика, как и в сводке игроков.
      (SELECT count(*) FROM run
        WHERE account_id = ANY(${ids}::uuid[]) AND status = 'finished' AND NOT cheats
          AND finished_at >= ${from} AND finished_at < ${to}) AS runs`;
  return { marked: ids.length, active: Number(counts?.active ?? 0), newAccounts: Number(counts?.new_accounts ?? 0), runs: Number(counts?.runs ?? 0) };
}
