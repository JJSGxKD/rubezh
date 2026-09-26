import type { AppConfig } from "../../config/app-config.js";
import type { LoadoutStatus } from "./run-loadouts.js";
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
 *   снаряжения, которого сервер не подписывал;
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
  | "loadout_stale";

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
}

export interface Verdict {
  verdict: RunVerdict;
  reasons: VerdictReason[];
}

const REJECTING: ReadonlySet<VerdictReason> = new Set(["weapons_over_slots", "longer_than_wall_clock", "unpaid_continue", "loadout_forged"]);
const SUSPICIOUS: ReadonlySet<VerdictReason> = new Set(["kill_rate", "level_rate", "unknown_content", "underpaid_continue", "loadout_stale"]);

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

  return { verdict: verdictOf(reasons), reasons };
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
