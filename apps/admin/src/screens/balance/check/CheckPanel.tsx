import type { ReactNode } from "react";
import { HELP } from "../../../ui/help";
import { Button, Help, Notice } from "../../../ui/kit";
import {
  CHECK_RUNS_ESTIMATE,
  corridorRow,
  type CorridorId,
  rowMark,
  staleNote,
  type CorridorRow,
  type Problem,
  type RailState,
  type Rails,
  type RowLevel,
} from "./check-rules";
import type { CheckState } from "./use-check";

const RAIL_MARK: Record<RailState, string> = {
  idle: "○",
  run: "…",
  ok: "✓",
  fail: "✗",
  stale: "!",
};
const RAIL_TONE: Record<RailState, string> = {
  idle: "text-text-muted",
  run: "text-info",
  ok: "text-success",
  fail: "text-danger",
  stale: "text-warning",
};

/** Рельсы в шапке: «Схема → Проверки → Симуляция» с состоянием каждого шага. */
export function CheckRails({ rails }: { rails: Rails }) {
  return (
    <ol
      aria-label="Шаги проверки"
      className="flex flex-wrap items-center gap-1.5 text-sm"
    >
      {rails.steps.map((step, index) => (
        <li key={step.id} className="flex items-center gap-1.5">
          {index === 0 ? null : (
            <span aria-hidden="true" className="text-text-muted">
              →
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-sm bg-surface px-2 py-1">
            <span aria-hidden="true" className={RAIL_TONE[step.state]}>
              {RAIL_MARK[step.state]}
            </span>
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

const CORRIDOR_HELP: Record<CorridorId, string> = {
  passiveDeathBeforeSec: HELP.balance.corridorPassiveDeath,
  dodgingMedianSec: HELP.balance.corridorDodgingMedian,
  dodgingDeathsBeforeMinuteRatioMax: HELP.balance.corridorDodgingEarlyDeaths,
  firstLevelUpSec: HELP.balance.corridorFirstLevelUp,
  firstChestEventSec: HELP.balance.corridorFirstChest,
};

const LEVEL_TONE: Record<RowLevel, string> = {
  ok: "text-success",
  edge: "text-warning",
  out: "text-danger",
  none: "text-text-muted",
};
const LEVEL_FILL: Record<RowLevel, string> = {
  ok: "bg-success",
  edge: "bg-warning",
  out: "bg-danger",
  none: "bg-text-muted",
};

function BandMark({
  left,
  className,
  label,
}: {
  left: number;
  className: string;
  label: string;
}) {
  return (
    <i
      role="img"
      aria-label={label}
      className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${className}`}
      style={{ left: `${String(left)}%` }}
    />
  );
}

/** Полоса с осью: коридор тоном, две метки — версия в игре (кольцо) и черновик (точка). */
function Band({ row }: { row: CorridorRow }) {
  const { line } = row;
  const values = [
    line.corridor.min,
    line.corridor.max,
    line.base?.value ?? null,
    line.draft?.value ?? null,
  ].filter((value): value is number => value !== null);
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values);
  const span = (hi - lo) * 1.1 || 1;
  const at = (value: number): number =>
    Math.max(0, Math.min(100, ((value - lo) / span) * 100));
  const from = line.corridor.min === null ? 0 : at(line.corridor.min);
  const to = line.corridor.max === null ? 100 : at(line.corridor.max);
  return (
    <div className="relative h-4" aria-hidden={false}>
      <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <div
        className={`absolute top-1/2 h-1.5 -translate-y-1/2 rounded-sm opacity-30 ${LEVEL_FILL[row.level === "out" ? "out" : "ok"]}`}
        style={{
          left: `${String(from)}%`,
          width: `${String(Math.max(0, to - from))}%`,
        }}
      />
      {line.base === null ? null : (
        <BandMark
          left={at(line.base.value)}
          className="border-2 border-text-muted bg-bg"
          label="Версия в игре"
        />
      )}
      {line.draft === null ? null : (
        <BandMark
          left={at(line.draft.value)}
          className={LEVEL_FILL[row.level]}
          label="Черновик"
        />
      )}
    </div>
  );
}

function Problems({
  title,
  items,
  onGo,
}: {
  title: string;
  items: readonly Problem[];
  onGo: (path: string) => boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-1.5 text-sm text-danger">
        <span aria-hidden="true">✗</span>
        {title}
      </p>
      <ul className="flex flex-col gap-1 pl-5 text-sm">
        {items.map((problem, index) => (
          <li key={`${problem.path}:${String(index)}`}>
            <button
              type="button"
              className="text-left underline-offset-2 hover:underline"
              onClick={() => onGo(problem.path)}
              title="Перейти к записи в таблице"
            >
              <span className="text-text-muted">{problem.path}</span> —{" "}
              {problem.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Ok({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-sm text-success">
      <span aria-hidden="true">✓</span>
      <span className="text-text">{children}</span>
    </p>
  );
}

/**
 * Правая колонка «Баланса» (tasks/T-0305): «Симуляция: черновик против v{N}» —
 * проверки контента галочками и метрики ботов полосами с коридором.
 */
export function CheckPanel({
  versionNo,
  check,
  canEdit,
  lastEdit,
  onGo,
}: {
  versionNo: number;
  check: CheckState;
  canEdit: boolean;
  lastEdit: string | null;
  /** перейти к строке таблицы по пути; `false` — для пути нет вкладки */
  onGo: (path: string) => boolean;
}) {
  const { outcome, running } = check;
  const rows = outcome?.report?.corridors.map(corridorRow) ?? [];
  const failedWorker =
    !running &&
    outcome === null &&
    (check.status === "failed" || check.status === "timeout");
  return (
    <section
      aria-label="Симуляция"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          Симуляция: черновик против v{versionNo}
          <Help text={HELP.balance.check} />
        </h2>
        <Button
          tone={outcome === null || check.stale ? "primary" : "secondary"}
          disabled={running || !canEdit}
          onClick={check.start}
        >
          {check.stale ? "Проверить снова" : "Проверить"}
        </Button>
      </header>

      {running ? (
        <p role="status">Проверяем… бот играет {CHECK_RUNS_ESTIMATE} забегов</p>
      ) : null}
      {check.error === null ? null : <Notice>{check.error.message}</Notice>}
      {check.problem === null ? null : (
        <Notice tone="warning">{check.problem}</Notice>
      )}
      {failedWorker && check.problem === null ? (
        <Notice tone="warning">Проверка не посчиталась. Повторите её.</Notice>
      ) : null}
      {check.stale && !running ? (
        <Notice tone="warning">{staleNote(lastEdit)}</Notice>
      ) : null}
      {outcome === null &&
      !running &&
      check.error === null &&
      check.status === null ? (
        <p className="text-sm text-text-muted">
          Проверки ещё не было. «Проверить» прогонит контент через проверки и
          сыграет ботами на версии и на черновике.
        </p>
      ) : null}

      {outcome === null ? null : (
        <div
          className={`flex flex-col gap-3 ${check.stale ? "opacity-60" : ""}`}
        >
          {outcome.schemaProblems.length > 0 ? (
            <Problems
              title="Схема: не сходится"
              items={outcome.schemaProblems}
              onGo={onGo}
            />
          ) : (
            <Ok>Схема сходится</Ok>
          )}
          {outcome.schemaProblems.length > 0 ? null : outcome.contentProblems
              .length > 0 ? (
            <Problems
              title="Проверки контента: есть замечания"
              items={outcome.contentProblems}
              onGo={onGo}
            />
          ) : (
            <Ok>Проверки контента пройдены</Ok>
          )}

          {outcome.report?.timeout === true ? (
            <Notice tone="warning">
              Симуляция не уложилась в предел времени: часть сценариев не
              посчитана.
            </Notice>
          ) : null}
          {rows.length === 0 ? null : (
            <ul className="flex flex-col gap-3">
              {rows.map((row) => (
                <li key={row.line.id} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="flex items-center gap-1">
                      {row.line.title}
                      <Help text={CORRIDOR_HELP[row.line.id]} />
                    </span>
                    <span
                      className={`whitespace-nowrap ${LEVEL_TONE[row.level]}`}
                    >
                      <span className="tabular-nums">{row.text}</span>{" "}
                      {rowMark(row)}
                    </span>
                  </div>
                  <Band row={row} />
                </li>
              ))}
            </ul>
          )}
          {rows.length === 0 ? null : (
            <p className="text-xs text-text-muted">
              Кольцо — версия в игре, точка — черновик, полоса — коридор
              баланса.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
