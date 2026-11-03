import { DomainError } from "../../common/domain-error.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import type { Difficulty, RunMode } from "./run-rules.js";
import type { RunVerdict } from "./run-verdict.js";

/**
 * Правила пролога (tasks/T-0279, docs/35-stage4-plan.md Р151): первого забега
 * аккаунта на три минуты, который кончается победой над Стражем рубежа. Чистые
 * функции — без базы и часов, чтобы правило читалось одним взглядом, а запись и
 * награда (`prologue.service.ts`) на него опирались.
 *
 * Пролог не пишет рекорд и рейтинг и не двигает задания; награда — один раз на
 * аккаунт; пока он не пройден, «Награда дня» и «Задания» закрыты.
 */

/** Сложность пролога: движок ставит её сам (`PrologueDef`), сервер другой не принимает. */
export const PROLOGUE_DIFFICULTY: Difficulty = "easy";

/** Пролог на другой сложности — битое тело, а не режим: 400 `run_invalid`. */
export class PrologueDifficultyError extends DomainError {
  constructor() {
    super("run_invalid", "Пролог проходят только на лёгкой сложности", 400);
  }
}

/** «Награда дня» и «Задания» закрыты, пока не пройден пролог. */
export class PrologueRequiredError extends DomainError {
  constructor() {
    super("prologue_required", "Сначала пройди пролог — первый забег", 409);
  }
}

/**
 * Каким режимом записать забег. Запрошенный пролог на другой сложности — 400 при
 * любом признаке: старый клиент с битым телом получает отказ, а не молчаливый
 * `endless`. Пролог аккаунта, который его уже прошёл, — обычный забег без наград
 * пролога: клиент старой сборки, не знающий о признаке, не ломается. Нет поля
 * режима — `endless`, как у сборок до пролога.
 */
export function admitMode(input: { mode: RunMode | undefined; difficulty: Difficulty; doneAt: Date | null }): RunMode {
  if (input.mode !== "prologue") return "endless";
  if (input.difficulty !== PROLOGUE_DIFFICULTY) throw new PrologueDifficultyError();
  return input.doneAt === null ? "prologue" : "endless";
}

/**
 * Минимальная длина пролога, секунды: Страж приходит на 160-й секунде (последний
 * отрезок таймлайна `content/prologue.ts`), победа раньше него невозможна. Сервер
 * пакет `core-game` не импортирует, поэтому число продублировано, а равенство
 * с контентом держит `scripts/test/run-rules.test.ts`.
 */
export const PROLOGUE_MIN_SEC = 160;

/** Допуск между секундой победы и длиной забега, секунды: округление клиента (как у рубежа). */
const PROLOGUE_TOLERANCE_SEC = 1;

/**
 * Победа в прологе — флаг клиента (`result.prologue.won`), вердикт не «отклонён» и
 * правдоподобная длина: секунда победы сходится с длиной забега (допуск
 * `PROLOGUE_TOLERANCE_SEC`), а сам забег не короче пролога (`PROLOGUE_MIN_SEC`).
 * Без правдоподобия флаг подделывает любой клиент: «победа» на тридцатой секунде
 * платила бы награду. Такой забег записывается, но признак не ставится и награды нет.
 * Исход забега (`outcome`) не смотрим: победа приходит как `abandoned` с тем же итогом.
 * Подозрительный забег — повод посмотреть, а не приговор, как у награды за забег.
 */
export function isPrologueWin(input: {
  mode: RunMode;
  won: boolean | undefined;
  /** секунда победы со слов итога (`result.prologue.sec`) */
  sec: number | undefined;
  survivalSec: number;
  verdict: RunVerdict;
}): boolean {
  if (input.mode !== "prologue" || input.won !== true || input.verdict === "rejected") return false;
  if (input.sec === undefined || Math.abs(input.sec - input.survivalSec) > PROLOGUE_TOLERANCE_SEC) return false;
  return input.survivalSec >= PROLOGUE_MIN_SEC;
}

/** Разделы открыты, когда пролог пройден (у старых аккаунтов признак ставит миграция). */
export function sectionsOpen(doneAt: Date | null): boolean {
  return doneAt !== null;
}

export function requireSectionsOpen(doneAt: Date | null): void {
  if (!sectionsOpen(doneAt)) throw new PrologueRequiredError();
}

export type PrologueResource = Extract<WalletResource, "coins" | "gems">;

/**
 * Ключ начисления — на аккаунт, а не на забег: пролог платит один раз, какой бы
 * забег ни выиграл. Монеты — без суффикса, самоцветы — со своим.
 */
export function prologueGrantKey(accountId: string, resource: PrologueResource): string {
  return resource === "coins" ? `prologue:${accountId}` : `prologue:${accountId}:gems`;
}

/** Только ненулевые строки: панель вправе обнулить любую часть награды. */
export function prologueRewardLines(coins: number, gems: number): { resource: PrologueResource; amount: number }[] {
  const lines: { resource: PrologueResource; amount: number }[] = [];
  if (coins > 0) lines.push({ resource: "coins", amount: coins });
  if (gems > 0) lines.push({ resource: "gems", amount: gems });
  return lines;
}
