import { useEffect, useMemo, useState } from "react";
import {
  approveOperation,
  discardOperation,
  draftPeriod,
  KIND_LABELS,
  loadArticles,
  loadOperations,
  loadPlaces,
  mergeOperations,
  OPERATION_STATUSES,
  rejectOperation,
  STATUS_LABELS,
  submitOperation,
  type OperationKind,
  type OperationStatus,
  type OperationView,
} from "../../../api/ledger-operations";
import { api } from "../../../services";
import { can } from "../../../state/session";
import { useSession } from "../../../state/use-session";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { Button, ErrorNotice, Field, FieldRow, Input, Loading, Panel, Select } from "../../../ui/kit";
import { toast, toastError } from "../../../ui/toast";
import { useApi } from "../../../ui/use-api";
import { OperationCard } from "./OperationCard";
import { OperationForm, type FormTarget } from "./OperationForm";
import { flattenPlaces, type Chart } from "./preview";
import { amountText } from "./summary";

/**
 * Вкладка «Операции» раздела «Бухгалтерия» (tasks/T-0464, Р220, docs/29-admin-panel.md §6.5): кнопки видов, «Расходы
 * месяца», список операций со статусами и фильтром, у владельца — блок «На подтверждении». Внести и править — право
 * `finance.entry.create`, решить — `finance.operation.approve`; скрытая кнопка — удобство, решает сервер.
 */
const FORM_KINDS: readonly OperationKind[] = ["transfer", "exchange", "expense", "income", "loan"];
/** Порог подтверждения панель не знает: его читает сервер из настроек (`finance.approve-threshold-usd`). */
const THRESHOLD_UNKNOWN = null;

type Pending = { type: "approve" | "reject" | "discard"; operation: OperationView };

export function OperationsTab() {
  const canEdit = useSession((session) => can(session.view, "finance.entry.create"));
  const canApprove = useSession((session) => can(session.view, "finance.operation.approve"));
  const [status, setStatus] = useState<OperationStatus | "">("");
  const first = useApi(() => loadOperations(api, { status }, null), [status]);
  const queue = useApi(() => (canApprove ? loadOperations(api, { status: "pending" }, null) : Promise.resolve({ ok: true as const, data: { operations: [], next: null } })), [canApprove]);
  const places = useApi(() => loadPlaces(api), []);
  const articles = useApi(() => loadArticles(api), []);

  const [more, setMore] = useState<{ operations: OperationView[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setMore(null);
  }, [status, first.state]);

  const [form, setForm] = useState<FormTarget | null>(null);
  const [asking, setAsking] = useState<Pending | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [monthOpen, setMonthOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));

  const chart: Chart | null = useMemo(
    () => (places.state.status === "ok" && articles.state.status === "ok" ? { places: flattenPlaces(places.state.data), articles: articles.state.data } : null),
    [places.state, articles.state],
  );

  const refresh = (): void => {
    first.reload();
    queue.reload();
    places.reload();
  };

  const submit = (operation: OperationView): void => {
    setBusyId(operation.operationId);
    void submitOperation(api, operation.operationId).then((result) => {
      setBusyId(null);
      if (!result.ok) return toastError(result.error, "Не удалось провести");
      toast.success(result.data.status === "pending" ? "Операция ждёт подтверждения владельца" : "Операция проведена");
      refresh();
    });
  };

  if (first.state.status === "loading" || places.state.status === "loading" || articles.state.status === "loading") return <Loading />;
  if (first.state.status === "error") return <ErrorNotice error={first.state.error} onRetry={first.reload} />;
  if (places.state.status === "error") return <ErrorNotice error={places.state.error} onRetry={places.reload} />;
  if (articles.state.status === "error") return <ErrorNotice error={articles.state.error} onRetry={articles.reload} />;
  if (chart === null) return <Loading />;

  const page = first.state.data;
  const operations = more === null ? page.operations : mergeOperations(page.operations, more.operations);
  const next = more === null ? page.next : more.next;
  const loadMore = (): void => {
    if (next === null) return;
    setLoadingMore(true);
    void loadOperations(api, { status }, next).then((result) => {
      setLoadingMore(false);
      if (!result.ok) return toastError(result.error, "Не удалось загрузить операции");
      setMore({ operations: mergeOperations(more?.operations ?? [], result.data.operations), next: result.data.next });
    });
  };

  const card = (operation: OperationView) => (
    <OperationCard
      key={operation.operationId}
      operation={operation}
      places={chart.places}
      articles={chart.articles}
      canApprove={canApprove}
      canEdit={canEdit}
      busy={busyId === operation.operationId}
      onApprove={() => setAsking({ type: "approve", operation })}
      onReject={() => setAsking({ type: "reject", operation })}
      onSubmit={() => submit(operation)}
      onEdit={() => setForm({ kind: operation.kind, editing: operation })}
      onDiscard={() => setAsking({ type: "discard", operation })}
      onFix={() => setForm({ kind: "reversal", fixing: operation })}
    />
  );

  const waiting = queue.state.status === "ok" ? queue.state.data.operations : [];
  const summary = asking === null ? "" : `${KIND_LABELS[asking.operation.kind]} · ${amountText(asking.operation, chart.places)} · ${asking.operation.input.note}`;

  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          {FORM_KINDS.map((kind) => (
            <Button key={kind} onClick={() => setForm({ kind })}>
              {KIND_LABELS[kind]}
            </Button>
          ))}
          <Button onClick={() => setMonthOpen(true)}>Расходы месяца</Button>
        </div>
      ) : null}

      {canApprove ? (
        <Panel title={`На подтверждении — ${String(waiting.length)}`}>
          {queue.state.status === "error" ? (
            <ErrorNotice error={queue.state.error} onRetry={queue.reload} />
          ) : waiting.length === 0 ? (
            <p className="text-sm text-text-muted">На подтверждении ничего нет</p>
          ) : (
            <ul className="flex flex-col gap-2">{waiting.map(card)}</ul>
          )}
        </Panel>
      ) : null}

      <FieldRow>
        <Field label="Статус">
          <Select value={status} onChange={(event) => setStatus(event.target.value as OperationStatus | "")}>
            <option value="">Все</option>
            {OPERATION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
      </FieldRow>

      {operations.length === 0 ? (
        <p className="text-sm text-text-muted">{status === "" ? "Операций пока нет — начните с перевода или расхода" : "С таким статусом операций нет"}</p>
      ) : (
        <ul className="flex flex-col gap-2">{operations.map(card)}</ul>
      )}
      {next === null ? null : (
        <div>
          <Button disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Загрузка…" : "Показать ещё"}
          </Button>
        </div>
      )}

      {form === null ? null : (
        <OperationForm
          target={form}
          chart={chart}
          canApprove={canApprove}
          thresholdUsd={THRESHOLD_UNKNOWN}
          onClose={() => setForm(null)}
          onDone={() => {
            setForm(null);
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={asking?.type === "approve"}
        onOpenChange={(open) => (open ? undefined : setAsking(null))}
        title="Подтвердить операцию?"
        subject={summary}
        changes={[{ label: "Что будет", value: "Проводка запишется в журнал" }]}
        action="Подтвердить"
        onConfirm={async () => {
          if (asking === null) return { ok: false, error: "Операция не выбрана" };
          const result = await approveOperation(api, asking.operation.operationId, undefined);
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success("Операция подтверждена и проведена");
          refresh();
          return { ok: true };
        }}
      />
      <ConfirmDialog
        open={asking?.type === "reject"}
        onOpenChange={(open) => (open ? undefined : setAsking(null))}
        title="Отклонить операцию?"
        subject={summary}
        reason={{ min: 3, max: 500, label: "Причина отказа", hint: "Её увидит тот, кто внёс операцию" }}
        action="Отклонить"
        tone="danger"
        onConfirm={async (reason) => {
          if (asking === null) return { ok: false, error: "Операция не выбрана" };
          const result = await rejectOperation(api, asking.operation.operationId, reason);
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success("Операция отклонена");
          refresh();
          return { ok: true };
        }}
      />
      <ConfirmDialog
        open={asking?.type === "discard"}
        onOpenChange={(open) => (open ? undefined : setAsking(null))}
        title="Удалить черновик?"
        subject={summary}
        action="Удалить"
        tone="danger"
        onConfirm={async () => {
          if (asking === null) return { ok: false, error: "Операция не выбрана" };
          const result = await discardOperation(api, asking.operation.operationId);
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success("Черновик удалён");
          refresh();
          return { ok: true };
        }}
      />
      <ConfirmDialog
        open={monthOpen}
        onOpenChange={setMonthOpen}
        title="Расходы месяца"
        subject="Черновики операций по шаблонам повторяющихся расходов"
        problem={/^\d{4}-(0[1-9]|1[0-2])$/u.test(month) ? null : "Выберите месяц"}
        action="Создать черновики"
        onConfirm={async () => {
          const result = await draftPeriod(api, month);
          if (!result.ok) return { ok: false, error: result.error.message };
          const { created, existing, failed } = result.data;
          const text = `Создано черновиков: ${String(created)}, уже были: ${String(existing)}`;
          if (failed.length === 0) toast.success(text);
          else toast.warning(`${text}. Не вышло: ${failed.map((item) => `${item.name} — ${item.reason}`).join("; ")}`);
          refresh();
          return { ok: true };
        }}
      >
        <Field label="Месяц">
          <Input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
