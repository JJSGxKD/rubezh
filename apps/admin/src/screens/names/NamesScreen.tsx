import { useState } from "react";
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
import { Badge, Button, DataTable, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { RecleanPanel } from "./RecleanPanel";
import { RuleDialog } from "./RuleDialog";

const TAB_KEY = "admin.names.tab";

/** Выбранная вкладка из хранилища браузера; оно может не отвечать — тогда вкладка не помнится. */
function storedTab(): RuleCategory | null {
  try {
    const raw = window.localStorage.getItem(TAB_KEY);
    return CATEGORY_ORDER.find((category) => category === raw) ?? null;
  } catch {
    return null;
  }
}

function rememberTab(tab: RuleCategory): void {
  try {
    window.localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Не запомнится — не страшно.
  }
}

/**
 * Фильтр имён (docs/35-stage4-plan.md, Р168): правила по пяти категориям,
 * форма с проверкой на примерах и перечистка старых ников. Без выбранной
 * вкладки экран открывается на первой непустой.
 */
export function NamesScreen() {
  const { state, reload } = useApi(() => fetchRules(api), []);
  const [chosen, setChosen] = useState<RuleCategory | null>(storedTab);
  const [editing, setEditing] = useState<NameRule | "new" | null>(null);
  const [removing, setRemoving] = useState<NameRule | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const view = state.data;
  const counts = categoryCounts(view);
  const tab = chosen ?? CATEGORY_ORDER.find((category) => counts[category] > 0) ?? CATEGORY_ORDER[0];
  const rules = rulesOf(view, tab);

  const choose = (next: RuleCategory): void => {
    rememberTab(next);
    setChosen(next);
  };

  const toggle = async (rule: NameRule): Promise<void> => {
    const result = await updateRule(api, rule.ruleId, { active: !rule.active });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(rule.active ? "Правило выключено" : "Правило включено");
    reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <RecleanPanel view={view} />
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
          {CATEGORY_ORDER.map((category) => (
            <button
              key={category}
              type="button"
              role="tab"
              aria-selected={tab === category}
              onClick={() => choose(category)}
              className={`rounded-pill border px-3 py-1 text-xs transition-colors ${tab === category ? "border-accent bg-accent/15 text-accent" : "border-border text-text-muted hover:border-border-strong hover:text-text"}`}
            >
              {CATEGORY_TITLES[category]} · {counts[category]}
            </button>
          ))}
        </div>
        <p className="mb-3 text-xs text-text-muted">{CATEGORY_TITLES[tab]}: {CATEGORY_ACTIONS[tab]}</p>
        <DataTable
          rows={rules}
          rowKey={(rule) => rule.ruleId}
          empty="В этой категории правил пока нет. Встроенный словарь работает и без них"
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
            { title: "Заметка", render: (rule) => <span className="text-text-muted">{rule.note ?? ""}</span> },
            { title: "Статус", render: (rule) => <Badge tone={rule.active ? "success" : "neutral"}>{rule.active ? "действует" : "выключено"}</Badge> },
            { title: "Изменено", render: (rule) => <span className="whitespace-nowrap">{formatDateTime(rule.updatedAt)}</span> },
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
      </Panel>

      {editing === null ? null : (
        <RuleDialog
          limits={view.limits}
          rule={editing === "new" ? null : editing}
          category={tab}
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
