import type { AppConfig } from "../../config/app-config.js";
import { countersPlausible, type RunCounters } from "./run-counters.js";
import type { BoostStatus, LoadoutStatus } from "./run-loadouts.js";
import { MAX_WEAPONS } from "./run-rules.js";

/**
 * Антифрод забега, фаза 1 (docs/34-stage3-plan.md, WP4).
 *
 * Здесь **структура** проверок, а не пороги: числа приходят из конфигурации
 * (решение Р7), потому что опубликованный порог говорит читеру, сколько
 * ровно можно. Функция чистая — вход и выход без обращения к базе и часам, —
 * поэтому каждое правило проверяется отдельно и на границе.
 *
 * Два сорта причин, и путать их нельзя:
 *
 * - **отказ (`rejected`)** — то, чего честный клиент не пришлёт никогда:
 *   оружий больше, чем слотов; забег длиннее, чем прошло времени по часам
 *   сервера (пауза в игровое время не идёт, поэтому честный забег всегда
 *   короче прошедшего); второй шанс, за который не заплачено, — честный
 *   клиент продолжает только после подтверждения оплаты сервером; снимок
 *   снаряжения, которого сервер не подписывал, или с уровнем выше уровня
 *   аккаунта; буст, не купленный на забег;
 * - **подозрение (`suspicious`)** — статистика: слишком быстро убивал, слишком
 *   быстро качался, незнакомая сборка, продолжение оплачено по меньшему
 *   числу минут, чем прошло, снимок снаряжения устарел. Здесь бывают и
 *   честные исключения, поэтому
 *   забег сохраняется, но в рейтинг не идёт и ждёт разбора.
 *
 * Ни то ни другое не выбрасывает забег: он пишется в базу с вердиктом.
 * Ошибиться может и проверка, а данные, выброшенные сегодня, завтра не
 * разобрать.
 */

export type RunVerdict = "ok" | "suspicious" | "rejected";

/**
 * Рубеж (T-0121, Р102, Р105): секунда прихода стража и минимальная длительность
 * боя с ним. Сервер пакет `shared-types` не импортирует (его не подключает ни
 * один модуль бэкенда), поэтому числа продублированы, а их равенство с
 * `RUBEZH_AT_SEC` и `RUBEZH_MIN_FIGHT_SEC` держит тест `rubezh-win.test.ts`.
 */
export const RUBEZH_AT_SEC = 600;
export const RUBEZH_MIN_FIGHT_SEC = 5;
/** Допуск между секундой победы и длиной забега, секунды: округление клиента. */
const RUBEZH_TOLERANCE_SEC = 1;

/** Что итог заявляет о рубеже; остаток здоровья стража на правдоподобие победы не влияет. */
export interface RubezhClaim {
  reached: boolean;
  clearedSec: number | null;
}

/** Победа заявлена: страж пришёл и пал. Засчитывает её вердикт, а не это условие. */
export function rubezhClaimsWin(claim: RubezhClaim | null | undefined): boolean {
  return claim?.reached === true && claim.clearedSec !== null;
}

/**
 * Победа, которой сервер верит: заявлена и не вызвала подозрения. Для награды и
 * отметки в рейтинге этого мало — нужен ещё вердикт `ok` и забег без читов,
 * но подозрение в рубеже уже опускает вердикт, поэтому отдельной проверки
 * причины не нужно.
 */
export function rubezhWinOf(claim: RubezhClaim | null | undefined, reasons: readonly VerdictReason[]): boolean {
  return rubezhClaimsWin(claim) && !reasons.includes("rubezh_implausible");
}

export type VerdictReason =
  | "weapons_over_slots"
  | "longer_than_wall_clock"
  | "kill_rate"
  | "level_rate"
  | "unknown_content"
  /** продолжений больше, чем оплачено */
  | "unpaid_continue"
  /** за продолжение заплачено по меньшему числу минут, чем прошло к нему (Р5.2) */
  | "underpaid_continue"
  /** время забега не проверено: старт не дошёл или пришёл слишком поздно — вердикт не меняет */
  | "unverified_time"
  /** снимок снаряжения не подписан сервером или чужой */
  | "loadout_forged"
  /** снимок настоящий, но надетое с тех пор изменилось */
  | "loadout_stale"
  /** уровень снимка выше уровня аккаунта: открыто то, что игроку не положено */
  | "loadout_level_ahead"
  /** буст не куплен на этот забег или возвращён */
  | "boost_unpaid"
  /**
   * счётчики итога не сходятся с ходом боя: вердикт не меняет (как
   * `unverified_time`), но счётчики не идут в задания и достижения
   */
  | "counters_implausible"
  /**
   * победа над стражем невозможна по времени: раньше, чем страж мог пасть, позже
   * конца забега, при `reached: false`, или страж «пришёл» до отметки
   */
  | "rubezh_implausible";

export interface VerdictInput {
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  weaponCount: number;
  contentHash: string;
  /** когда забег начался по часам сервера; `null` — неизвестно */
  startedAtMs: number | null;
  /** когда пришёл итог, по часам сервера */
  finishedAtMs: number;
  /** сколько вторых шансов в забеге */
  continues: number;
  /** сколько из них оплачено */
  paidContinues: number;
  underpaidContinues: boolean;
  /**
   * Забег с читами: бесплатное продолжение в забеге разработчика — тоже чит,
   * и отказом оно не считается. В рейтинг такой забег не идёт и так.
   */
  cheats: boolean;
  /** снаряжение забега против подписанного снимка (`run-loadouts.ts`) */
  loadout: LoadoutStatus;
  /** заявленные бусты против покупок на забег */
  boosts: BoostStatus;
  /** счётчики итога; `null` — итог без них (старая сборка) */
  counters: RunCounters | null;
  /** рубеж из итога; нет поля — забег до рубежа или итог старой сборки */
  rubezh?: RubezhClaim | null;
}

export interface Verdict {
  verdict: RunVerdict;
  reasons: VerdictReason[];
}

const REJECTING: ReadonlySet<VerdictReason> = new Set(["weapons_over_slots", "longer_than_wall_clock", "unpaid_continue", "loadout_forged", "loadout_level_ahead", "boost_unpaid"]);
const SUSPICIOUS: ReadonlySet<VerdictReason> = new Set(["kill_rate", "level_rate", "unknown_content", "underpaid_continue", "loadout_stale", "rubezh_implausible"]);

export function judgeRun(input: VerdictInput, limits: AppConfig["runs"]): Verdict {
  const reasons: VerdictReason[] = [];

  if (input.weaponCount > MAX_WEAPONS) reasons.push("weapons_over_slots");

  if (input.startedAtMs === null) {
    reasons.push("unverified_time");
  } else {
    const wallClockSec = (input.finishedAtMs - input.startedAtMs) / 1000;
    if (input.survivalSec > wallClockSec + limits.wallClockToleranceSec) reasons.push("longer_than_wall_clock");
  }

  // Темп считается от длины забега, но не короче минуты для уровней: первые
  // уровни приходят за полминуты, и короткий забег иначе выглядел бы
  // невозможным. Для убийств хватает секунды — делить на ноль нельзя.
  const killsPerSec = input.enemiesKilled / Math.max(input.survivalSec, 1);
  if (killsPerSec > limits.maxKillsPerSec) reasons.push("kill_rate");

  const levelsPerMin = input.level / Math.max(input.survivalSec / 60, 1);
  if (levelsPerMin > limits.maxLevelsPerMin) reasons.push("level_rate");

  // Пустой список — проверка выключена: сборку, не внесённую в список, иначе
  // приняли бы за чужую просто потому, что список забыли заполнить.
  if (limits.knownContentHashes.size > 0 && !limits.knownContentHashes.has(input.contentHash)) {
    reasons.push("unknown_content");
  }

  if (!input.cheats && input.continues > input.paidContinues) reasons.push("unpaid_continue");
  if (input.underpaidContinues) reasons.push("underpaid_continue");

  if (input.loadout === "forged") reasons.push("loadout_forged");
  if (input.loadout === "stale") reasons.push("loadout_stale");
  if (input.loadout === "level_ahead") reasons.push("loadout_level_ahead");
  if (input.boosts === "unpaid") reasons.push("boost_unpaid");

  // Ни отказ, ни подозрение: рейтинг на счётчиках не строится, и ложное
  // срабатывание не должно выбивать честный забег из него.
  if (input.counters !== null && !countersPlausible(input.counters, { survivalSec: input.survivalSec, enemiesKilled: input.enemiesKilled })) {
    reasons.push("counters_implausible");
  }

  if (input.rubezh != null && !rubezhPlausible(input.rubezh, input.survivalSec)) reasons.push("rubezh_implausible");

  return { verdict: verdictOf(reasons), reasons };
}

/**
 * Клиенту не верим: победа заявлена без стража, раньше, чем страж мог пасть, или
 * позже конца забега. Страж «пришёл» при выживании короче отметки — тоже. Страж,
 * который пришёл и не пал, ничего больше не требует.
 */
function rubezhPlausible(claim: RubezhClaim, survivalSec: number): boolean {
  if (claim.reached && survivalSec < RUBEZH_AT_SEC - RUBEZH_TOLERANCE_SEC) return false;
  if (claim.clearedSec === null) return true;
  if (!claim.reached) return false;
  return claim.clearedSec >= RUBEZH_AT_SEC + RUBEZH_MIN_FIGHT_SEC && claim.clearedSec <= survivalSec + RUBEZH_TOLERANCE_SEC;
}

function verdictOf(reasons: readonly VerdictReason[]): RunVerdict {
  if (reasons.some((reason) => REJECTING.has(reason))) return "rejected";
  if (reasons.some((reason) => SUSPICIOUS.has(reason))) return "suspicious";
  return "ok";
}

/**
 * Время начала, которому можно верить. Клиент сообщает, сколько секунд
 * забега прошло к отправке старта; сервер вычитает это из своего времени
 * приёма. Слишком большое опоздание — старт пролежал в очереди без сети, и
 * верить ему нельзя: иначе заявленное «прошло много» подарило бы запас
 * читеру, а у честного игрока время всё равно не проверится.
 */
export function trustedStartMs(receivedAtMs: number, elapsedSec: number, maxDelaySec: number): number | null {
  if (elapsedSec > maxDelaySec) return null;
  return receivedAtMs - Math.max(elapsedSec, 0) * 1000;
}
