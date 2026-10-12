import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { WALLET_RESOURCES } from "../wallet/wallet-types.js";
import { takeTesterSnapshot, type SnapshotTotals } from "./tester-snapshot.js";
import { WIPE_ORDER, WIPE_PLAN } from "./wipe-plan.js";

/**
 * Команда вайпа перед лончем (docs/35-stage4-plan.md, Р87, tasks/T-0041):
 * подсчёт, снимок компенсаций тестерам и стирание игрового прогресса.
 * Инструкция запуска — docs/20-env-and-ports.md §5.4: бэкап до команды,
 * `--plan`, затем `--run --confirm <сегодня UTC>`.
 *
 * - **Что стирать, решает план** (`wipe-plan.ts`, T-0039): команда берёт порядок
 *   из `WIPE_ORDER` и сама ничего не решает.
 * - **Снимок и стирание — одна транзакция.** Упало что угодно — не стёрто
 *   ничего и снимка нет.
 * - **Запись игроков на время вайпа закрыта.** Транзакция атомарна для самой
 *   команды, но записей игроков не ждёт: начисление между снимком и стиранием
 *   в снимок не попало бы, а стирание его унесло, запись после `DELETE` своей
 *   таблицы пережила бы вайп наполовину. Поэтому первым делом транзакция берёт
 *   `SHARE ROW EXCLUSIVE` на все стираемые таблицы, `purchase` и
 *   `tester_compensation`: чтение идёт, запись ждёт конца транзакции, а второй
 *   одновременный запуск ждёт первый и упирается в готовый снимок. Пока захват
 *   ждёт, за ним стоят все записи игроков, поэтому он ограничен `lock_timeout`:
 *   лучше упасть с понятным отказом, чем подвесить игру.
 * - **Только `deleteMany`, `TRUNCATE` запрещён.** `TRUNCATE run CASCADE` стёр бы
 *   и журнал покупок, который не стирается никогда. Покупка второго шанса
 *   переживает вайп: связь с забегом `SetNull`, обнуляется только `run_id`.
 * - Запуск — только с подтверждением сегодняшней датой UTC (`parseWipeArgs`):
 *   случайная строка из истории терминала ничего не сотрёт.
 */

/** Потолок всей транзакции вайпа и каждого её запроса: пул держит запрос 15 секунд, а стирание большой таблицы дольше. */
const TRANSACTION_TIMEOUT_MS = 10 * 60_000;
const TRANSACTION_MAX_WAIT_MS = 30_000;
/** Сколько ждать захвата таблиц: пока он ждёт, за ним стоят записи игроков. */
const LOCK_TIMEOUT_MS = 10_000;

export interface WipeCounts {
  /** сколько строк в каждой модели сейчас — для `--plan` */
  rows: Record<Prisma.ModelName, number>;
  snapshot: SnapshotTotals;
}

export interface WipeResult {
  deleted: Partial<Record<Prisma.ModelName, number>>;
  snapshot: SnapshotTotals;
}

/** Стереть все строки модели; параметром — чтобы тест проверил откат на сбое посреди. */
export type Deleter = (tx: Prisma.TransactionClient, model: Prisma.ModelName) => Promise<{ count: number }>;

const MODELS = Object.values(Prisma.ModelName);

/** Потолок запроса пула (15 с) действует и в транзакции вайпа, пока его не поднять: только внутри этой транзакции (`SET LOCAL`). */
async function allowLongStatements(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(TRANSACTION_TIMEOUT_MS)}, true)`;
}

/** Не дождались захвата таблиц: транзакция откатилась, ничего не изменено, запуск можно повторить. */
export class WipeLockError extends Error {}

/** «Не удалось захватить таблицы за 10 секунд: повторите» — с числом и склонением секунд. */
export function lockTimeoutText(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const last = seconds % 10;
  const word = seconds % 100 >= 11 && seconds % 100 <= 14 ? "секунд" : last === 1 ? "секунду" : last >= 2 && last <= 4 ? "секунды" : "секунд";
  return `Не удалось захватить таблицы за ${String(seconds)} ${word}: повторите`;
}

/** Postgres отменил запрос по `lock_timeout` (код 55P03): драйвер кладёт его то в текст, то в причину. */
function isLockTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes("lock timeout") || error.message.includes("55P03")) return true;
  return "cause" in error && isLockTimeout(error.cause);
}

interface Countable {
  count(): Promise<number>;
}

function isCountable(value: unknown): value is Countable {
  return typeof value === "object" && value !== null && "count" in value && typeof value.count === "function";
}

/** Делегат Prisma зовётся именем модели с маленькой буквы: `RunAdContinue` → `runAdContinue`. */
async function countOf(tx: Prisma.TransactionClient, model: Prisma.ModelName): Promise<number> {
  const delegate: unknown = Reflect.get(tx, model.charAt(0).toLowerCase() + model.slice(1));
  if (!isCountable(delegate)) throw new Error(`У модели ${model} нет подсчёта строк`);
  return await delegate.count();
}

/** Посчитать и ничего не менять: строки по моделям и итоги снимка без записи. */
export async function planWipe(prisma: PrismaClient, now: Date): Promise<WipeCounts> {
  return await prisma.$transaction(
    async (tx) => {
      await allowLongStatements(tx);
      // Заполняется по списку всех моделей схемы — полнота видна в тесте.
      const rows = {} as Record<Prisma.ModelName, number>;
      for (const model of MODELS) rows[model] = await countOf(tx, model);
      const snapshot = await takeTesterSnapshot(tx, now, { write: false });
      return { rows, snapshot };
    },
    // Один снимок базы на все подсчёты: строки и итоги согласуются между собой.
    { isolationLevel: "RepeatableRead", timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );
}

/**
 * Снимок и стирание одной транзакцией. Бросает — ничего не изменено. `lockTimeoutMs` — сколько
 * ждать захвата таблиц; тест сокращает его, чтобы не ждать десять секунд.
 */
export async function runWipe(prisma: PrismaClient, now: Date, deleter: Deleter = deleteAll, lockTimeoutMs: number = LOCK_TIMEOUT_MS): Promise<WipeResult> {
  return await prisma.$transaction(
    async (tx) => {
      await allowLongStatements(tx);
      await lockTables(tx, lockTimeoutMs);
      const snapshot = await takeTesterSnapshot(tx, now, { write: true });
      const deleted: Partial<Record<Prisma.ModelName, number>> = {};
      for (const model of WIPE_ORDER) deleted[model] = (await deleter(tx, model)).count;
      return { deleted, snapshot };
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );
}

/**
 * Таблицы, которые вайп стирает или читает снимком, — по `@@map` схемы. 18 таблиц плана в порядке
 * `WIPE_ORDER`, затем `purchase` (из неё снимок берёт покупки и ссылку на забег обнуляет стирание)
 * и `tester_compensation` (по ней снимок проверяет, не было ли вайпа). Полноту против `WIPE_ORDER`
 * проверяет тест: таблица, добавленная в план без строки здесь, роняет его.
 */
export const WIPE_LOCK_TABLES: readonly string[] = [
  "run_ad_continue",
  "run_reward",
  "run_boost",
  "task_run",
  "run",
  "task_progress",
  "showcase_offer",
  "item_event",
  "item",
  "wallet_entry",
  "wallet_balance",
  "wallet_daily",
  "account_progress",
  "friend_gift",
  "daily_reward",
  "wheel_spin",
  "vip_daily",
  "notification",
  "purchase",
  "tester_compensation",
];

/**
 * Закрыть запись в таблицы вайпа до конца транзакции: чтение идёт, запись и второй запуск ждут.
 * Срок ожидания — `lock_timeout` только в этой транзакции; не дождались — отказ с текстом, а не зависшая игра.
 */
async function lockTables(tx: Prisma.TransactionClient, timeoutMs: number): Promise<void> {
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${String(timeoutMs)}, true)`;
  // Имена — из константы выше, не из ввода: идентификаторы в SQL параметром не передать.
  const tables = WIPE_LOCK_TABLES.map((table) => `"${table}"`).join(", ");
  try {
    await tx.$executeRawUnsafe(`LOCK TABLE ${tables} IN SHARE ROW EXCLUSIVE MODE`);
  } catch (error: unknown) {
    if (isLockTimeout(error)) throw new WipeLockError(lockTimeoutText(timeoutMs), { cause: error });
    throw error;
  }
}

/**
 * Стереть все строки модели плана. Ветка на каждую из 18 стираемых моделей — явная,
 * без обращения к делегату по имени: стирание не должно зависеть от опечатки.
 * Модель, которой тут нет, — отказ; тест проверяет, что ветка есть у каждой модели `WIPE_ORDER`.
 */
export const deleteAll: Deleter = async (tx, model) => {
  switch (model) {
    case "RunAdContinue":
      return await tx.runAdContinue.deleteMany({});
    case "RunReward":
      return await tx.runReward.deleteMany({});
    case "RunBoost":
      return await tx.runBoost.deleteMany({});
    case "TaskRun":
      return await tx.taskRun.deleteMany({});
    case "Run":
      return await tx.run.deleteMany({});
    case "TaskProgress":
      return await tx.taskProgress.deleteMany({});
    case "ShowcaseOffer":
      return await tx.showcaseOffer.deleteMany({});
    case "ItemEvent":
      return await tx.itemEvent.deleteMany({});
    case "Item":
      return await tx.item.deleteMany({});
    case "WalletEntry":
      return await tx.walletEntry.deleteMany({});
    case "WalletBalance":
      return await tx.walletBalance.deleteMany({});
    case "WalletDaily":
      return await tx.walletDaily.deleteMany({});
    case "AccountProgress":
      return await tx.accountProgress.deleteMany({});
    case "FriendGift":
      return await tx.friendGift.deleteMany({});
    case "DailyReward":
      return await tx.dailyReward.deleteMany({});
    case "WheelSpin":
      return await tx.wheelSpin.deleteMany({});
    case "VipDaily":
      return await tx.vipDaily.deleteMany({});
    case "Notification":
      return await tx.notification.deleteMany({});
    default:
      throw new Error(`Модель ${model} не входит в план стирания`);
  }
};

/** Что просит запустить человек. */
export type WipeCommand = { kind: "plan" } | { kind: "run" };

/** Ошибка вызова команды: текст подсказки, код выхода 2. */
export class WipeUsageError extends Error {
  readonly exitCode = 2;
}

const CONFIRM_HINT = "Подтвердите сегодняшней датой UTC: --confirm ГГГГ-ММ-ДД";
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Без аргументов или `--plan` — только подсчёт. Запуск — только `--run --confirm <сегодня UTC>`;
 * любые другие аргументы — ошибка, ничего не меняющая.
 */
export function parseWipeArgs(argv: readonly string[], today: string): WipeCommand {
  let plan = false;
  let run = false;
  let confirm: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan" && !plan) plan = true;
    else if (arg === "--run" && !run) run = true;
    else if (arg === "--confirm" && confirm === null) {
      confirm = argv[index + 1] ?? "";
      index += 1;
    } else throw new WipeUsageError(`Неизвестный или повторный аргумент: ${arg ?? ""}. ${CONFIRM_HINT}`);
  }
  if (plan && (run || confirm !== null)) throw new WipeUsageError(`--plan нельзя сочетать с запуском. ${CONFIRM_HINT}`);
  if (plan || (!run && confirm === null)) return { kind: "plan" };
  if (!run) throw new WipeUsageError(`--confirm без --run ничего не запускает. ${CONFIRM_HINT}`);
  if (confirm === null || !DATE_FORMAT.test(confirm) || confirm !== today) throw new WipeUsageError(CONFIRM_HINT);
  return { kind: "run" };
}

/** Число с пробелами между разрядами: 12345 → «12 345». */
const grouped = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function snapshotLines(snapshot: SnapshotTotals): string[] {
  const restored = WALLET_RESOURCES.filter((resource) => (snapshot.restored[resource] ?? 0) > 0).map((resource) => `${resource} ${grouped(snapshot.restored[resource] ?? 0)}`);
  return [
    "Снимок компенсаций:",
    `  тестеров: ${grouped(snapshot.testers)}`,
    `  строк компенсации: ${grouped(snapshot.accounts)}`,
    `  бонус тестерам, самоцветов: ${grouped(snapshot.bonusGems)}`,
    `  звёзд за второй шанс к переводу в самоцветы: ${grouped(snapshot.continueStars)}`,
    `  вернётся из купленного: ${restored.length === 0 ? "ничего" : restored.join(", ")}`,
  ];
}

/** Вывод `--plan`: сначала стираемые модели в порядке плана, затем оставляемые по алфавиту. */
export function formatPlan(counts: WipeCounts, today: string): string[] {
  const kept = MODELS.filter((model) => WIPE_PLAN[model].action === "keep").sort();
  const lines = ["План вайпа — строки по моделям:"];
  for (const model of WIPE_ORDER) lines.push(`стереть  ${model}  ${grouped(counts.rows[model])}`);
  for (const model of kept) lines.push(`оставить  ${model}  ${grouped(counts.rows[model])}`);
  lines.push("", ...snapshotLines(counts.snapshot), "", `Ничего не изменено. Запуск: wipe --run --confirm ${today}`);
  return lines;
}

/** Вывод `--run`: сколько стёрто по моделям и что записал снимок. Его сохраняет человек по инструкции. */
export function formatResult(result: WipeResult): string[] {
  const lines = ["Вайп выполнен одной транзакцией:"];
  for (const model of WIPE_ORDER) lines.push(`стёрто  ${model}  ${grouped(result.deleted[model] ?? 0)}`);
  lines.push("", ...snapshotLines(result.snapshot));
  return lines;
}
