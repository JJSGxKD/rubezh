import { z } from "zod";
import type { CheckStatus } from "../../../api/content";

/**
 * Правила панели «Симуляция: черновик против версии в игре» (tasks/T-0305):
 * разбор итога воркера (`apps/sim-worker/src/report.ts`), «у края», «устарела»
 * и рельсы шагов. Без DOM и без запросов — всё проверяется тестом.
 */

/** Опрос статуса: раз в 2 секунды и не дольше трёх минут (решение T-0305). */
export const CHECK_POLL_MS = 2_000;
export const CHECK_POLL_LIMIT_MS = 180_000;
/** Доля запаса от границы коридора, в которой метрика ещё в коридоре, но «у края». */
const EDGE_SHARE = 0.1;
/** Забегов в наборе по умолчанию: два бота на версии и на черновике, по двадцать зёрен. */
export const CHECK_RUNS_ESTIMATE = 80;

const problemSchema = z.object({ path: z.string(), message: z.string() });
const boundsSchema = z.object({
  min: z.number().nullable(),
  max: z.number().nullable(),
});
const sideSchema = z.object({
  value: z.number(),
  verdict: z.enum(["in", "below", "above"]),
});

const corridorSchema = z.object({
  id: z.enum([
    "passiveDeathBeforeSec",
    "dodgingMedianSec",
    "dodgingDeathsBeforeMinuteRatioMax",
    "firstLevelUpSec",
    "firstChestEventSec",
  ]),
  title: z.string(),
  corridor: boundsSchema,
  baseCorridor: boundsSchema,
  draft: sideSchema.nullable(),
  base: sideSchema.nullable(),
});
export type CorridorLine = z.infer<typeof corridorSchema>;
export type CorridorId = CorridorLine["id"];

const outcomeSchema = z.looseObject({
  schemaProblems: z.array(problemSchema),
  contentProblems: z.array(problemSchema),
  report: z
    .looseObject({
      timeout: z.boolean(),
      seeds: z.number(),
      scenarios: z.array(z.unknown()),
      corridors: z.array(corridorSchema),
    })
    .nullable(),
});
export type CheckOutcome = z.infer<typeof outcomeSchema>;
export type Problem = z.infer<typeof problemSchema>;

/** Итог воркера из `report` проверки; ошибка воркера (`{ error }`) и мусор — не итог, `null`. */
export function parseCheckOutcome(raw: unknown): CheckOutcome | null {
  const parsed = outcomeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type EdgeLevel = "ok" | "edge" | "out";

/**
 * Где метрика относительно коридора. «У края» — в пределах 10 % от границы:
 * у двустороннего коридора доля считается от его ширины, у одностороннего — от
 * самой границы. Сама граница — ещё внутри коридора.
 */
export function edgeLevel(
  value: number,
  bounds: { min: number | null; max: number | null },
): EdgeLevel {
  const { min, max } = bounds;
  if ((min !== null && value < min) || (max !== null && value > max))
    return "out";
  const margin =
    min !== null && max !== null
      ? (max - min) * EDGE_SHARE
      : Math.abs(min ?? max ?? 0) * EDGE_SHARE;
  if (min !== null && value < min + margin) return "edge";
  if (max !== null && value > max - margin) return "edge";
  return "ok";
}

const RATIO_IDS: ReadonlySet<CorridorId> = new Set([
  "dodgingDeathsBeforeMinuteRatioMax",
]);

/** Время — «4:05», доля — «14 %». */
export function formatMetric(id: CorridorId, value: number): string {
  if (RATIO_IDS.has(id)) return `${String(Math.round(value * 100))} %`;
  const total = Math.round(value);
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, "0")}`;
}

export type RowLevel = EdgeLevel | "none";

export interface CorridorRow {
  line: CorridorLine;
  /** «4:05 → 3:40»: версия в игре, черновик; прочерк — считать было не из чего */
  text: string;
  level: RowLevel;
}

/** Строка метрики. Вне коридора — по вердикту сервера, «у края» — по запасу. */
export function corridorRow(line: CorridorLine): CorridorRow {
  const base =
    line.base === null ? "—" : formatMetric(line.id, line.base.value);
  const draft =
    line.draft === null ? "—" : formatMetric(line.id, line.draft.value);
  const level: RowLevel =
    line.draft === null
      ? "none"
      : line.draft.verdict !== "in"
        ? "out"
        : edgeLevel(line.draft.value, line.corridor);
  return { line, text: `${base} → ${draft}`, level };
}

export function rowMark(row: Pick<CorridorRow, "level">): string {
  if (row.level === "ok") return "✓";
  if (row.level === "edge") return "· у края";
  if (row.level === "out") return "✗ вне коридора";
  return "";
}

/** Прогон устарел, когда снимок черновика после него изменился. */
export function isStale(
  checkedHash: string | null,
  currentHash: string,
): boolean {
  return checkedHash !== null && checkedHash !== currentHash;
}

export function staleNote(lastEdit: string | null): string {
  return lastEdit === null
    ? "Прогнана до правки — устарела"
    : `Прогнана до правки «${lastEdit}» — устарела`;
}

export type RailId = "schema" | "checks" | "simulation";
export type RailState = "idle" | "run" | "ok" | "fail" | "stale";

export interface RailStep {
  id: RailId;
  label: string;
  state: RailState;
}

export interface Rails {
  steps: RailStep[];
  /** все шаги зелёные и прогон свежий: «В staging» и «Опубликовать» (T-0306) живут только тогда */
  ready: boolean;
}

const LABELS: Record<RailId, string> = {
  schema: "Схема",
  checks: "Проверки",
  simulation: "Симуляция",
};

function simulationState(
  outcome: CheckOutcome,
  status: CheckStatus | null,
): RailState {
  const report = outcome.report;
  if (status === "timeout" || report === null || report.timeout) return "fail";
  const rows = report.corridors.map(corridorRow);
  if (rows.some((row) => row.level === "out")) return "fail";
  return rows.some((row) => row.level !== "none") ? "ok" : "idle";
}

/** Рельсы «Схема → Проверки → Симуляция». Устаревший прогон не зелёный ни на одном шаге. */
export function railSteps(input: {
  outcome: CheckOutcome | null;
  status: CheckStatus | null;
  stale: boolean;
  running: boolean;
}): Rails {
  const make = (states: [RailState, RailState, RailState]): Rails => {
    const ids: RailId[] = ["schema", "checks", "simulation"];
    return {
      steps: ids.map((id, index) => ({
        id,
        label: LABELS[id],
        state: states[index] ?? "idle",
      })),
      ready: states.every((state) => state === "ok"),
    };
  };
  if (input.running) return make(["run", "run", "run"]);
  const { outcome, status } = input;
  if (outcome === null)
    return make([
      "idle",
      "idle",
      status === "failed" || status === "timeout" ? "fail" : "idle",
    ]);
  if (input.stale) return make(["stale", "stale", "stale"]);
  if (outcome.schemaProblems.length > 0) return make(["fail", "idle", "idle"]);
  return make([
    "ok",
    outcome.contentProblems.length > 0 ? "fail" : "ok",
    simulationState(outcome, status),
  ]);
}
