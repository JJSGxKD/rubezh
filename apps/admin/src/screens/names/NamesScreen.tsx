import { useState } from "react";
import { fetchCandidates } from "../../api/name-rule-candidates";
import { DEFAULT_WINDOW, fetchStats, lastHitText, sortRules, statsById, unusedRules, type RuleSort, type StatsWindow, RULE_SORTS } from "../../api/name-rule-stats";
import {
  CATEGORY_ACTIONS,
  CATEGORY_ORDER,
  CATEGORY_TITLES,
  KIND_TITLES,
  categoryCounts,
  fetchRules,
  removeRule,
  rulesOf,
  updateRule,
  type NameRule,
  type RuleCategory,
} from "../../api/name-rules";
import { formatDateTime } from "../../format";
import { api } from "../../services";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Loading, Panel, Select } from "../../ui/kit";
import { formatNumber } from "../../format";
import { toast, toastError } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { CandidatesTab } from "./CandidatesTab";
import { RecleanPanel } from "./RecleanPanel";
import { StatsPanel, type StatsState } from "./StatsPanel";
import { RuleDialog } from "./RuleDialog";

const TAB_KEY = "admin.names.tab";

/** Шестая вкладка — не категория правил, а кандидаты из ночного расчёта (T-0341). */
type Tab = RuleCategory | "candidates";
const TABS: readonly Tab[] = [...CATEGORY_ORDER, "candidates"];

/** Выбранная вкладка из хранилища браузера; оно может не отвечать — тогда вкладка не помнится. */
function storedTab(): Tab | null {
  try {
    const raw = window.localStorage.getItem(TAB_KEY);
    return TABS.find((tab) => tab === raw) ?? null;
  } catch {
    return null;
  }
}

function rememberTab(tab: Tab): void {
  try {
    window.localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Не запомнится — не страшно.
  }
}

/**
 * Фильтр имён (docs/35-stage4-plan.md, Р168): правила по пяти категориям,
 * форма с проверкой на примерах, перечистка старых ников и шестая вкладка —
 * кандидаты из ночного расчёта частых слов. Без выбранной вкладки экран
 * открывается на первой непустой категории.
 */
export function NamesScreen() {
  const { state, reload } = useApi(() => fetchRules(api), []);
  // Статистика грузится отдельно: список правил работает, пока она едет или не открылась.
  const [days, setDays] = useState<StatsWindow>(DEFAULT_WINDOW);
  const { state: statsState, reload: reloadStats } = useApi(() => fetchStats(api, days), [days]);
  const [onlyUnused, setOnlyUnused] = useState(false);
  const [sort, setSort] = useState<RuleSort>("recent");
  // Кандидаты грузятся отдельно, как статистика: от них зависит только счётчик вкладки и сама вкладка.
  const { state: candidatesState, reload: reloadCandidates } = useApi(() => fetchCandidates(api), []);
  const [chosen, setChosen] = useState<Tab | null>(storedTab);
  const [editing, setEditing] = useState<NameRule | "new" | null>(null);
  const [removing, setRemoving] = useState<NameRule | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const view = state.data;
  const counts = categoryCounts(view);
  const tab: Tab = chosen ?? CATEGORY_ORDER.find((category) => counts[category] > 0) ?? CATEGORY_ORDER[0];
  // Правила и сортировка живут в категориях; на вкладке кандидатов они не нужны, а новое правило — по умолчанию бренд.
  const category: RuleCategory = tab === "candidates" ? "brand" : tab;
  const candidatesCount = candidatesState.status === "ok" ? String(candidatesState.data.items.length) : "…";
  const stats: StatsState = statsState.status === "ok" ? { status: "ok", stats: statsState.data } : statsState.status === "error" ? { status: "error", retry: reloadStats } : { status: "loading" };
  const loaded = stats.status === "ok" ? stats.stats : null;
  const byId = loaded === null ? null : statsById(loaded);
  const inTab = rulesOf(view, category);
  // «Не срабатывали» оставляет в списке только такие правила; порядок — по выбору.
  const rules = sortRules(onlyUnused && loaded !== null ? unusedRules(inTab, loaded) : inTab, loaded, sort);

  const choose = (next: Tab): void => {
    rememberTab(next);
    setChosen(next);
  };

  const toggle = async (rule: NameRule): Promise<void> => {
    const result = await updateRule(api, rule.ruleId, { active: !rule.active });
    if (!result.ok) {
      toastError(result.error);
      return;
    }
    toast.success(rule.active ? "Правило выключено" : "Правило включено");
    reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <RecleanPanel view={view} />
      <StatsPanel rules={view.rules} state={stats} days={days} onDays={setDays} onlyUnused={onlyUnused} onOnlyUnused={setOnlyUnused} today={new Date()} />
      <Panel
        title="Фильтр имён"
        help={HELP.names.categories}
        actions={
          <Button tone="primary" onClick={() => setEditing("new")}>
            Добавить правило
          </Button>
        }
      >
        <div className="mb-1 flex flex-wrap gap-1.5" role="tablist" aria-label="Категория">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              onClick={() => choose(item)}
              className={`rounded-pill border px-3 py-1 text-xs transition-colors ${tab === item ? "border-accent bg-accent/15 text-accent" : "border-border text-text-muted hover:border-border-strong hover:text-text"}`}
            >
              {item === "candidates" ? `Кандидаты · ${candidatesCount}` : `${CATEGORY_TITLES[item]} · ${String(counts[item])}`}
            </button>
          ))}
        </div>
        {tab === "candidates" ? (
          candidatesState.status === "loading" ? (
            <Loading />
          ) : candidatesState.status === "error" ? (
            <ErrorNotice error={candidatesState.error} onRetry={reloadCandidates} />
          ) : (
            <CandidatesTab view={candidatesState.data} limits={view.limits} onChanged={reloadCandidates} />
          )
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-text-muted">
                {CATEGORY_TITLES[category]}: {CATEGORY_ACTIONS[category]}
              </p>
              <Select aria-label="Порядок правил" value={sort} onChange={(event) => setSort(RULE_SORTS.find((item) => item.value === event.target.value)?.value ?? "recent")}>
                {RULE_SORTS.map((item) => (
                  <option key={item.value} value={item.value}>
                    Сначала: {item.title.toLowerCase()}
                  </option>
                ))}
              </Select>
            </div>
            <DataTable
              rows={rules}
              rowKey={(rule) => rule.ruleId}
              empty={onlyUnused ? "В этой категории все действующие правила срабатывали" : "В этой категории правил пока нет. Встроенный словарь работает и без них"}
              columns={[
                {
                  title: "Правило",
                  help: HELP.names.kinds,
                  render: (rule) => (
                    <span className="flex max-w-80 min-w-0 flex-col break-words">
                      <code className="font-mono text-sm">{rule.pattern}</code>
                      <span className="text-xs text-text-muted">{KIND_TITLES[rule.kind]}</span>
                    </span>
                  ),
                },
                { title: "Заметка", render: (rule) => <span className="text-text-muted">{rule.note ?? "—"}</span> },
                {
                  title: "Срабатываний",
                  align: "right",
                  // Загрузка — «…»; выключенное правило без данных — прочерк: у него нечего считать.
                  render: (rule) => (stats.status === "loading" ? "…" : stats.status === "error" || byId === null ? "—" : !rule.active && (byId.get(rule.ruleId)?.hits ?? 0) === 0 ? "—" : formatNumber(byId.get(rule.ruleId)?.hits ?? 0)),
                },
                {
                  title: "Последний раз",
                  render: (rule) => (stats.status === "loading" ? "…" : byId === null ? "—" : <span className="md:whitespace-nowrap">{lastHitText(byId.get(rule.ruleId)?.lastDay ?? null, new Date())}</span>),
                },
                { title: "Статус", render: (rule) => <Badge tone={rule.active ? "success" : "neutral"}>{rule.active ? "действует" : "выключено"}</Badge> },
                { title: "Изменено", render: (rule) => <span className="md:whitespace-nowrap">{formatDateTime(rule.updatedAt)}</span> },
                {
                  title: "",
                  render: (rule) => (
                    <span className="flex flex-wrap justify-end gap-1.5 max-md:flex-col max-md:items-stretch">
                      <Button onClick={() => setEditing(rule)}>Править</Button>
                      <Button onClick={() => void toggle(rule)}>{rule.active ? "Выключить" : "Включить"}</Button>
                      <Button tone="danger" onClick={() => setRemoving(rule)}>
                        Удалить
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          </>
        )}
      </Panel>

      {editing === null ? null : (
        <RuleDialog
          limits={view.limits}
          rule={editing === "new" ? null : editing}
          category={category}
          onClose={() => setEditing(null)}
          onSaved={() => {
            reload();
            setEditing(null);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Удалить правило?"
        subject={removing?.pattern ?? ""}
        action="Удалить"
        tone="danger"
        onConfirm={async () => {
          if (removing === null) return { ok: true };
          const result = await removeRule(api, removing.ruleId);
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success("Правило удалено");
          reload();
          return { ok: true };
        }}
      >
        <p className="text-sm">Ники, которые оно вырезало, вернутся при следующей перечистке.</p>
      </ConfirmDialog>
    </div>
  );
}
