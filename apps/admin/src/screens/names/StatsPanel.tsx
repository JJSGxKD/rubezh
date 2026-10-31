import { DEFAULT_WINDOW, STATS_WINDOWS, WINDOW_TITLES, topLine, topRules, trackedNote, unusedRules, type NameRuleStats, type StatsWindow } from "../../api/name-rule-stats";
import type { NameRule } from "../../api/name-rules";
import { formatNumber } from "../../format";
import { HELP } from "../../ui/help";
import { Button, Loading, Notice, Panel, Select } from "../../ui/kit";

/** Состояние статистики для экрана: список правил от неё не зависит, и загрузка или сбой его не блокируют. */
export type StatsState = { status: "loading" } | { status: "error"; retry: () => void } | { status: "ok"; stats: NameRuleStats };

/**
 * «Что срабатывает» (Р168, T-0340): окно, топ-5 правил, «Не срабатывали» кнопкой-фильтром и оговорка про
 * начало учёта. Считаем входы игроков, а не людей — сноска говорит это словами.
 */
export function StatsPanel({
  rules,
  state,
  days,
  onDays,
  onlyUnused,
  onOnlyUnused,
  today,
}: {
  rules: readonly NameRule[];
  state: StatsState;
  days: StatsWindow;
  onDays: (days: StatsWindow) => void;
  onlyUnused: boolean;
  onOnlyUnused: (value: boolean) => void;
  today: Date;
}) {
  const stats = state.status === "ok" ? state.stats : null;
  const top = stats === null ? [] : topRules(rules, stats);
  const unused = stats === null ? [] : unusedRules(rules, stats);
  const note = stats === null ? null : trackedNote(stats, today);

  return (
    <Panel
      title="Что срабатывает"
      help={HELP.names.stats}
      actions={
        <Select aria-label="Окно статистики" value={days} onChange={(event) => onDays(STATS_WINDOWS.find((window) => String(window) === event.target.value) ?? DEFAULT_WINDOW)}>
          {STATS_WINDOWS.map((window) => (
            <option key={window} value={window}>
              {WINDOW_TITLES[window]}
            </option>
          ))}
        </Select>
      }
    >
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Notice>Статистику загрузить не удалось</Notice>
          <Button onClick={state.retry}>Повторить</Button>
        </div>
      ) : null}
      {stats === null ? null : (
        <div className="flex flex-col gap-3">
          {stats.totalHits === 0 ? (
            <p className="text-sm text-text-muted">За выбранный период срабатываний не было</p>
          ) : (
            <div className="flex flex-col gap-1">
              <h3 className="text-xs text-text-muted">Топ за период</h3>
              <ol className="flex flex-col gap-0.5 text-sm">
                {top.map((item) => (
                  <li key={item.rule.ruleId} className="flex items-baseline justify-between gap-3">
                    <code className="min-w-0 font-mono break-words" title={topLine(item)}>
                      {item.rule.pattern}
                    </code>
                    <span className="shrink-0 tabular-nums">{formatNumber(item.hits)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button onClick={() => onOnlyUnused(!onlyUnused)} aria-pressed={onlyUnused}>
              Не срабатывали: {String(unused.length)}
            </Button>
            <span className="text-xs text-text-muted">{onlyUnused ? "в списке только они, нажмите ещё раз — вернуть все" : "действующие правила без единого срабатывания за окно"}</span>
          </div>
          {note === null ? null : <Notice tone="info">{note}</Notice>}
        </div>
      )}
      <p className="mt-3 text-xs text-text-muted">
        Считаем входы игроков, а не людей: игрок, заходящий каждый день, даёт срабатывание каждый день. Перечистка не считается. Цифры приблизительные — при сбое очереди часть пачек теряется.
      </p>
    </Panel>
  );
}
