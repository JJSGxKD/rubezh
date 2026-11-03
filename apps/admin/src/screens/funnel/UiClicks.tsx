import { useState } from "react";
import { api } from "../../services";
import { fetchUiClicks, fetchUiScreens, formatShare, rangeProblem, UI_CLICK_PLATFORMS, type UiClickRow, type UiScreen } from "../../api/ui-clicks";
import { periodFromDates, platformTitle, presetPeriod } from "../../api/funnel";
import { formatNumber } from "../../format";
import { Button, DataTable, ErrorNotice, Field, Loading, Notice, Panel, Select, type Column } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { customProblem, DEFAULT_PRESET, PeriodPicker, type PeriodValue } from "../../ui/period-picker";
import { useApi } from "../../ui/use-api";

type Window = { from: string; to: string };

/** Период выбора в запрос; свой с ошибкой или длиннее предела отчёта запроса не даёт. */
function windowOf(value: PeriodValue): Window | null {
  if (value.preset !== "custom") return presetPeriod(value.preset, new Date());
  if (customProblem(value.from, value.to) !== null || rangeProblem(value.from, value.to) !== null) return null;
  const { from, to } = periodFromDates(value.from, value.to);
  return from === undefined || to === undefined ? null : { from, to };
}

/**
 * Нажатия по экранам: слева — экраны, которые открывали за период, с числом
 * открывших, справа — кнопки выбранного экрана: сколько раз нажали, сколько
 * игроков и какая доля открывших экран нажала. Доля — по игрокам, а не по
 * нажатиям: десять нажатий одного игрока не делают кнопку заметной.
 */
export function UiClicksScreen() {
  const [value, setValue] = useState<PeriodValue>({ preset: DEFAULT_PRESET });
  const [window, setWindow] = useState<Window>(() => windowOf({ preset: DEFAULT_PRESET }) as Window);
  const [platform, setPlatform] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const { state, reload } = useApi(() => fetchUiScreens(api, window, platform), [window.from, window.to, platform]);

  const choose = (next: PeriodValue) => {
    setValue(next);
    // Свой период с ошибкой не отправляется: прежний остаётся на экране.
    const resolved = windowOf(next);
    if (resolved !== null) setWindow(resolved);
  };
  const refresh = () => {
    setWindow(windowOf(value) ?? window);
    reload();
  };

  const problem = value.preset === "custom" ? (customProblem(value.from, value.to) ?? rangeProblem(value.from, value.to)) : null;
  const screens = state.status === "ok" ? state.data.screens : [];
  // Выбранный экран мог пропасть из списка при смене периода — тогда первый.
  const screen = chosen !== null && screens.some((item) => item.screen === chosen) ? chosen : (screens[0]?.screen ?? null);

  return (
    <Panel title="Нажатия по экранам" help={HELP.uiClicks.report} actions={<Button onClick={refresh}>Обновить</Button>}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <PeriodPicker value={value} onChange={choose} />
        <Field label="Площадка">
          <Select value={platform ?? ""} onChange={(event) => setPlatform(event.target.value === "" ? null : event.target.value)}>
            <option value="">Все площадки</option>
            {UI_CLICK_PLATFORMS.map((item) => (
              <option key={item} value={item}>
                {platformTitle(item)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {problem !== null ? <Notice tone="warning">{problem}: показан прежний период.</Notice> : null}
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={refresh} /> : null}
      {state.status === "ok" && screens.length === 0 ? <p className="text-sm text-text-muted">Нажатий за период нет</p> : null}
      {state.status === "ok" && screens.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-[minmax(12rem,16rem)_1fr]">
          <ScreenList screens={screens} current={screen} onChoose={setChosen} />
          {screen === null ? null : <ScreenClicks screen={screen} window={window} platform={platform} />}
        </div>
      ) : null}
    </Panel>
  );
}

function ScreenList({ screens, current, onChoose }: { screens: readonly UiScreen[]; current: string | null; onChoose: (screen: string) => void }) {
  return (
    <ul className="flex flex-col gap-1" aria-label="Экраны">
      {screens.map((item) => (
        <li key={item.screen}>
          <button
            type="button"
            aria-pressed={item.screen === current}
            onClick={() => onChoose(item.screen)}
            className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-sm px-2.5 text-left text-sm max-md:min-h-10 ${item.screen === current ? "bg-surface-raised text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]" : "text-text-muted hover:text-text"}`}
          >
            <span className="truncate">{item.screen}</span>
            <span className="text-xs tabular-nums">{formatNumber(item.players)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ScreenClicks({ screen, window, platform }: { screen: string; window: Window; platform: string | null }) {
  const { state, reload } = useApi(() => fetchUiClicks(api, screen, window, platform), [screen, window.from, window.to, platform]);
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { opened, rows } = state.data;

  const columns: Column<UiClickRow>[] = [
    { title: "Кнопка", render: (row) => <code className="text-xs">{row.control}</code> },
    { title: "Нажатий", render: (row) => formatNumber(row.clicks), align: "right" },
    { title: "Игроков нажало", render: (row) => formatNumber(row.players), align: "right" },
    { title: "Доля открывших", help: HELP.uiClicks.share, render: (row) => <ShareBar share={row.share} /> },
  ];

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-semibold">
        Экран <code>{screen}</code>
      </h3>
      <p className="text-sm">Открыли {formatNumber(opened)} игроков</p>
      <DataTable rows={rows} rowKey={(row) => row.control} empty="Нажатий за период нет" columns={columns} />
    </section>
  );
}

/** Полоса доли: число рядом, чтобы полосу не пришлось читать на глаз. */
function ShareBar({ share }: { share: number | null }) {
  return (
    <span className="flex min-w-32 items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-pill bg-surface-sunken" aria-hidden="true">
        <span className="block h-full rounded-pill bg-accent" style={{ width: `${share ?? 0}%` }} />
      </span>
      <span className="w-12 text-right text-sm tabular-nums">{formatShare(share)}</span>
    </span>
  );
}
