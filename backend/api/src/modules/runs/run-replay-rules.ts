import { createHash } from "node:crypto";
import { z } from "zod";
import type { ItemRarity } from "../items/item-catalog.js";
import type { Division } from "../rating/division-rules.js";
import type { RunMode } from "./run-rules.js";
import type { RunVerdict, VerdictReason } from "./run-verdict.js";

/**
 * Перепроверка забегов повтором (docs/35-stage4-plan.md WP5, tasks/T-0319):
 * чистые правила без Nest, базы, Redis и часов — их читают сервис, репозиторий
 * и тесты.
 *
 * Три вопроса. Кому повтор обязателен — тем, от кого что-то зависит: верх
 * досок, высокие дивизионы, редкая добыча, победа над Стражем. Кого повторять
 * из остальных — выборкой, чтобы следить за детерминизмом движка. И что делает
 * исход с забегом: расхождение на первых неделях — подозрение, а не отказ,
 * потому что сначала меряем, насколько V8 сервера расходится с JavaScriptCore
 * iPhone (docs/35-stage4-plan.md, Б5).
 */

/** Исходы повтора: то, что воркер называет вердиктом, плюс `no_proof` — записи не пришло. */
export const REPLAY_OUTCOMES = ["match", "mismatch", "content_mismatch", "not_replayable", "broken", "timeout", "no_proof"] as const;
export type ReplayOutcome = (typeof REPLAY_OUTCOMES)[number];

/** Состояние забега по перепроверке: «ожидает» или исход. `null` в колонке — повтор забегу не нужен. */
export const REPLAY_STATES = ["pending", ...REPLAY_OUTCOMES] as const;
export type ReplayState = (typeof REPLAY_STATES)[number];

/** Что может вернуть воркер: без `no_proof` — его ставит сервер, когда ждать нечего. */
export const WORKER_OUTCOMES = ["match", "mismatch", "content_mismatch", "not_replayable", "broken", "timeout"] as const satisfies readonly ReplayOutcome[];
export type WorkerOutcome = (typeof WORKER_OUTCOMES)[number];

/** Имя очереди — то же, что у воркера (`apps/sim-worker/src/replay-job.ts`); сервер его кода не импортирует, тест сверяет. */
export const REPLAY_QUEUE_NAME = "replay";

/** Место в доске, до которого повтор обязателен (T-0294): первая сотня общей или сезонной. */
export const REPLAY_TOP_PLACE = 100;

/** Записи нет столько часов после конца забега — исход `no_proof`. */
export const REPLAY_NO_PROOF_HOURS = 72;

/** Задание стоит в очереди дольше и ответа нет — воркер молчит: исход `timeout` (наша сторона). */
export const REPLAY_SILENT_HOURS = 72;

/** Сколько минут задание считается живым: по истечении сервер проверяет очередь и, если задания нет, ставит его заново. */
export const REPLAY_REQUEUE_MINUTES = 30;

/** На сколько дней продлевается хранение записи у проверенных верхних и у разошедшихся (T-0317: обычные — неделя). */
export const REPLAY_KEEP_DAYS = 180;

/** Приоритет BullMQ: меньше число — раньше. Обязательные и решение модератора обгоняют выборку. */
const PRIORITY_URGENT = 1;
const PRIORITY_SAMPLE = 10;

/** Почему повтор обязателен: в лог и в разбор, чтобы было видно, чем забег заслужил проверку. */
export type ReplayReason = "rubezh" | "loot" | "top_board" | "top_season" | "division";

/** Что известно о забеге и его последствиях к моменту решения. Числа читает сервис, правило их не добывает. */
export interface ReplayFacts {
  mode: RunMode;
  cheats: boolean;
  verdict: RunVerdict;
  /** забег попал в рейтинг */
  ranked: boolean;
  /** место, которое забег занимает на доске всех времён игрока; `null` — не лучший забег игрока или не в доске */
  boardPlace: number | null;
  /** то же в таблице недели */
  seasonPlace: number | null;
  /** дивизион недели по месту и размеру таблицы */
  seasonDivision: Division | null;
  /** высшая редкость добычи забега; `null` — добычи нет или она ещё неизвестна */
  lootRarity: ItemRarity | null;
  /** победа над Стражем рубежа заявлена и не вызвала подозрения */
  rubezhCleared: boolean;
}

export type ReplayDecision = { need: "required"; reasons: ReplayReason[] } | { need: "sample" } | { need: "none" };

const NONE: ReplayDecision = { need: "none" };
const TOP_DIVISIONS: readonly Division[] = ["ruby", "gold"];
/** Эпическая и выше (docs/35-stage4-plan.md WP5): выше редкой, без повтора такая добыча не выдаётся. */
const RARE_LOOT: ReadonlySet<ItemRarity> = new Set<ItemRarity>(["epic", "legendary", "mythic"]);

/** Добыча, ради которой повтор обязателен. */
export function lootNeedsReplay(rarity: ItemRarity | null): boolean {
  return rarity !== null && RARE_LOOT.has(rarity);
}

function isTopPlace(place: number | null): boolean {
  return place !== null && Number.isInteger(place) && place >= 1 && place <= REPLAY_TOP_PLACE;
}

/**
 * Бросок выборки — число от 0 до 1 от хэша `runId`: решение воспроизводимо, и
 * повторная доставка итога или перезапуск сервера не меняют его. Не `Math.random`:
 * по одному и тому же забегу два ответа были бы двумя разными решениями.
 */
export function sampleRoll(runId: string): number {
  const digest = createHash("sha256").update(`replay-sample:${runId}`).digest();
  // 48 бит помещаются в число двойной точности без потерь.
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

/**
 * Нужен ли повтор. Пролог, забег с читами и забег не с вердиктом `ok` не
 * повторяются: награда пролога разовая и малая, а у остальных рейтинга и наград
 * и так нет. Победа над Стражем и редкая добыча делают повтор обязательным и без
 * рейтинга — награда идёт по вердикту, а не по доске. Верх и дивизион — только у
 * забега в рейтинге. Остальные рейтинговые — выборкой.
 */
export function decideReplay(runId: string, facts: ReplayFacts, sampleRate: number): ReplayDecision {
  if (facts.mode === "prologue" || facts.cheats || facts.verdict !== "ok") return NONE;
  const reasons: ReplayReason[] = [];
  if (facts.rubezhCleared) reasons.push("rubezh");
  if (lootNeedsReplay(facts.lootRarity)) reasons.push("loot");
  if (facts.ranked) {
    if (isTopPlace(facts.boardPlace)) reasons.push("top_board");
    if (isTopPlace(facts.seasonPlace)) reasons.push("top_season");
    if (facts.seasonDivision !== null && TOP_DIVISIONS.includes(facts.seasonDivision)) reasons.push("division");
  }
  if (reasons.length > 0) return { need: "required", reasons };
  if (facts.ranked && sampleRoll(runId) < sampleRate) return { need: "sample" };
  return NONE;
}

/** Каким вердиктом отвечает расхождение: ключ панели `replay.mismatch-verdict`; всё, кроме «rejected», — подозрение. */
export type MismatchVerdict = "suspicious" | "rejected";

export function mismatchVerdictOf(value: string): MismatchVerdict {
  return value === "rejected" ? "rejected" : "suspicious";
}

const SEVERITY: Record<RunVerdict, number> = { ok: 0, suspicious: 1, rejected: 2 };

/** Строже из двух вердиктов; `null` — вердикта ещё нет, как `ok`. Расхождение не смягчает отказ, поставленный раньше. */
export function strictestVerdict(current: RunVerdict | null, next: RunVerdict): RunVerdict {
  return SEVERITY[current ?? "ok"] >= SEVERITY[next] ? (current ?? "ok") : next;
}

/** Что исход делает с забегом и записью. */
export interface OutcomeEffect {
  replayVerdict: ReplayOutcome;
  /** новый вердикт забега; `null` — не меняется */
  verdict: RunVerdict | null;
  /** причина, которая дописывается к причинам вердикта */
  reason: VerdictReason | null;
  /** забег уходит из рейтинга */
  unrank: boolean;
  /** на сколько дней продлить хранение записи; `null` — как было */
  keepProofDays: number | null;
  /** сбой на нашей стороне — в лог с предупреждением, игрок ни при чём */
  ourSide: boolean;
}

export interface OutcomeContext {
  /** вердикт забега сейчас */
  verdict: RunVerdict | null;
  /** повтор был обязательным */
  required: boolean;
  mismatchVerdict: MismatchVerdict;
}

/**
 * Вердикт и рейтинг меняет только расхождение. `content_mismatch`, `broken` и
 * `timeout` — сторона сервера (не тот снимок контента, упавший воркер, предел
 * времени): игрок не отвечает. `not_replayable` и `no_proof` вердикта не меняют,
 * а что они значат для наград и верха — решает T-0320.
 */
export function effectOf(outcome: ReplayOutcome, context: OutcomeContext): OutcomeEffect {
  const base: OutcomeEffect = { replayVerdict: outcome, verdict: null, reason: null, unrank: false, keepProofDays: null, ourSide: false };
  switch (outcome) {
    case "match":
      // Выборочному забегу долгое хранение ни к чему: проверенным верхним записи нужны, остальным — нет.
      return { ...base, keepProofDays: context.required ? REPLAY_KEEP_DAYS : null };
    case "mismatch":
      // Запись разошедшегося нужна и разбору, и «Повторить снова», и замеру расхождения движков.
      return { ...base, verdict: strictestVerdict(context.verdict, context.mismatchVerdict), reason: "replay_mismatch", unrank: true, keepProofDays: REPLAY_KEEP_DAYS };
    case "content_mismatch":
    case "broken":
    case "timeout":
      return { ...base, ourSide: true };
    case "not_replayable":
    case "no_proof":
      return base;
  }
}

const count = z.number().int().nonnegative();

/**
 * Исход задания из Redis — данные из чужого процесса, форму проверяем, а не
 * приводим (`apps/sim-worker/src/replay-job.ts`, `ReplayResult`). Лишние поля
 * отбрасываются: воркер новее сервера может дописать своё.
 */
export const replayResultSchema = z.object({
  runId: z.string().min(1).max(64),
  verdict: z.enum(WORKER_OUTCOMES),
  reason: z.string().max(2_000).nullable().default(null),
  divergedTick: count.nullable().default(null),
  replayed: z
    .object({ ticks: count, survivalSec: z.number().nonnegative(), level: count, enemiesKilled: count, checksum: z.number().int() })
    .nullable()
    .default(null),
  durationMs: count.default(0),
});
export type ReplayResult = z.output<typeof replayResultSchema>;
export type ReplayedTotals = NonNullable<ReplayResult["replayed"]>;

/** Площадка клиента для метки метрики: низкая кардинальность, без `unknown` не обойтись — подмена веба испортила бы срез. */
export const CLIENT_OS = ["ios", "android", "desktop", "web", "unknown"] as const;
export type ClientOs = (typeof CLIENT_OS)[number];

/**
 * Площадка по последней сессии игрока (`account_session`). iOS и Android — по ОС,
 * где бы ни открылась игра: браузер на iPhone тоже на WebKit, и расхождение
 * движков смотрят именно по нему. Дальше — по классу устройства.
 */
export function clientOsOf(session: { os: string; deviceClass: string } | null): ClientOs {
  if (session === null) return "unknown";
  if (session.os === "ios") return "ios";
  if (session.os === "android") return "android";
  if (session.deviceClass === "web") return "web";
  if (session.deviceClass === "desktop") return "desktop";
  return "unknown";
}

/** Приоритет задания: обязательные и повтор по просьбе модератора — вперёд выборки. */
export function jobPriorityOf(input: { required: boolean; byModerator: boolean }): number {
  return input.required || input.byModerator ? PRIORITY_URGENT : PRIORITY_SAMPLE;
}

const JOB_PREFIX = "replay-";

/**
 * Идентификатор задания — забег и попытка. Попытка растёт только по «Повторить
 * снова», поэтому повторная постановка той же попытки (после потери Redis)
 * не плодит заданий, а исход прошлой попытки не ложится на новую. Двоеточия
 * в идентификаторе нет: BullMQ его не принимает.
 */
export function jobIdOf(runId: string, attempt: number): string {
  return `${JOB_PREFIX}${runId}-${String(attempt)}`;
}

/** Забег и попытка из идентификатора задания; `null` — чужое задание. */
export function parseJobId(jobId: string): { runId: string; attempt: number } | null {
  if (!jobId.startsWith(JOB_PREFIX)) return null;
  const rest = jobId.slice(JOB_PREFIX.length);
  const split = rest.lastIndexOf("-");
  if (split <= 0) return null;
  const attempt = rest.slice(split + 1);
  if (!/^\d{1,9}$/.test(attempt)) return null;
  return { runId: rest.slice(0, split), attempt: Number(attempt) };
}
