import { useState } from "react";
import { discrepancyAction, runReconcile, titleOf, PLATFORMS, type Discrepancy, type DiscrepancyActionId, type ReconcileOverview } from "../../api/payments";
import { formatDateTime, formatNumber } from "../../format";
import { hrefOf } from "../../routes";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, Loading, Notice, Panel } from "../../ui/kit";
import { toast, toastError } from "../../ui/toast";
import type { Loaded } from "../../ui/use-api";
import { ChargeId, NoteActionDialog, OneLine, PurchaseOpen } from "./PaymentParts";
import { discrepancyButtons, discrepancyLabel, lastRunLine, resolutionLabel } from "./payments-tabs";

/** Что и каким окном делает кнопка расхождения; тексты — tasks/T-0438. */
const ACTIONS: Readonly<Record<DiscrepancyActionId, { button: string; title: string; body: string; tone: "secondary" | "danger" }>> = {
  retry: {
    button: "Повторить учёт…",
    title: "Повторить учёт",
    body: "Оплата или возврат запишутся по выписке площадки тем же путём, что сообщение от бота. Дважды ничего не начислится.",
    tone: "secondary",
  },
  refund: {
    button: "Вернуть звёзды…",
    title: "Вернуть звёзды",
    body: "Звёзды вернутся игроку по этой оплате. Покупка останется неоплаченной, забирать нечего. Отменить нельзя.",
    tone: "danger",
  },
  dismiss: {
    button: "Разобрано…",
    title: "Разобрано",
    body: "Расхождение закроется без действий с деньгами. Напишите, почему, — причина останется в журнале.",
    tone: "secondary",
  },
};

const DONE: Readonly<Record<DiscrepancyActionId, string>> = {
  retry: "Учёт повторён",
  refund: "Возврат заказан",
  dismiss: "Расхождение закрыто",
};

function confirmText(action: DiscrepancyActionId, row: Discrepancy): string {
  if (action === "refund") return `Вернуть ${formatNumber(row.amount)} ⭐`;
  return action === "retry" ? "Повторить" : "Закрыть расхождение";
}

/**
 * Вкладка «Расхождения» раздела «Платежи» (tasks/T-0438): последняя сверка
 * выписки площадки с покупками, открытые расхождения с действиями и закрытые
 * за 30 дней. Какое действие допустимо, решает вид расхождения; сервер
 * проверит ещё раз и ответит `409`, если расхождение уже разобрали.
 */
export function PaymentDiscrepancies({ state, reload, canSupport }: { state: Loaded<ReconcileOverview>; reload: () => void; canSupport: boolean }) {
  const [running, setRunning] = useState(false);
  const [acting, setActing] = useState<{ row: Discrepancy; action: DiscrepancyActionId } | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { enabled, lastRuns, open, resolved } = state.data;

  const run = async () => {
    setRunning(true);
    const result = await runReconcile(api);
    setRunning(false);
    if (!result.ok) return toastError(result.error);
    const failed = result.data.find((summary) => summary.error !== null);
    if (failed?.error != null) toast.error("Сверка оборвалась", { description: `${titleOf(PLATFORMS, failed.platform)}: ${failed.error}` });
    else toast.success("Сверка закончена", { description: `Новых расхождений: ${String(result.data.reduce((sum, summary) => sum + summary.found, 0))}` });
    reload();
  };

  const healthy = lastRuns.length > 0 && lastRuns.every((item) => item.error === null);
  const emptyText = lastRuns.length === 0 ? "Сверок ещё не было" : healthy ? "Расхождений нет — последняя сверка сошлась" : "Открытых расхождений нет";

  return (
    <div className="flex flex-col gap-4">
      {enabled ? null : <Notice tone="info">Сверка выключена в «Настройках» — ключ «Сверка оплат с площадкой»</Notice>}
      <Panel
        title="Сверка с площадкой"
        help={HELP.payments.discrepancies}
        actions={
          canSupport ? (
            <Button tone="primary" disabled={running} onClick={() => void run()}>
              {running ? "Сверяем…" : "Сверить сейчас"}
            </Button>
          ) : undefined
        }
      >
        {lastRuns.length === 0 ? (
          <p className="text-sm text-text-muted">{lastRunLine(null)}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-text-muted">
            {lastRuns.map((item) => (
              <li key={item.platform}>
                <span className="font-medium text-text">{titleOf(PLATFORMS, item.platform)}</span> · {lastRunLine(item)}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Открытые · ${String(open.length)}`}>
        {open.length === 0 ? (
          <p className="text-sm text-text-muted">{emptyText}</p>
        ) : (
          <DataTable
            rows={open}
            rowKey={(row) => row.discrepancyId}
            columns={[
              { title: "Вид", primary: true, render: (row) => discrepancyLabel(row.kind, row.platform) },
              { title: "Когда", render: (row) => formatDateTime(row.occurredAt) },
              { title: "Игрок", render: (row) => <Payer row={row} /> },
              { title: "Покупка", render: (row) => <PurchaseOpen purchaseId={row.purchaseId} /> },
              { title: "Оплата", render: (row) => <ChargeId value={row.chargeId} /> },
              { title: "⭐", align: "right", render: (row) => formatNumber(row.amount) },
              ...(canSupport
                ? [
                    {
                      // Не безымянная колонка: на телефоне безымянные кнопки встают рядом с видом и сжимают его в столбик.
                      title: "Действия",
                      render: (row: Discrepancy) => (
                        <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                          {discrepancyButtons(row.kind).map((action) => (
                            <Button key={action} tone={ACTIONS[action].tone} className="whitespace-nowrap" onClick={() => setActing({ row, action })}>
                              {ACTIONS[action].button}
                            </Button>
                          ))}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Panel>

      <details className="rounded-md border border-border bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold">Закрытые за 30 дней · {resolved.length}</summary>
        <div className="mt-3">
          {resolved.length === 0 ? (
            <p className="text-sm text-text-muted">За 30 дней ничего не закрыто</p>
          ) : (
            <DataTable
              rows={resolved}
              rowKey={(row) => row.discrepancyId}
              columns={[
                { title: "Вид", primary: true, render: (row) => discrepancyLabel(row.kind, row.platform) },
                { title: "Когда", render: (row) => formatDateTime(row.resolvedAt ?? row.occurredAt) },
                { title: "Решение", render: (row) => (row.resolution === null ? "—" : resolutionLabel(row.resolution)) },
                { title: "Кто", render: (row) => row.resolvedByName ?? "—" },
                { title: "Причина", render: (row) => (row.note === null ? "—" : <OneLine text={row.note} />) },
              ]}
            />
          )}
        </div>
      </details>

      {acting === null ? null : (
        <NoteActionDialog
          key={`${acting.row.discrepancyId}-${acting.action}`}
          title={ACTIONS[acting.action].title}
          description={`${discrepancyLabel(acting.row.kind, acting.row.platform)} · ${formatNumber(acting.row.amount)} ⭐ · ${formatDateTime(acting.row.occurredAt)}`}
          body={ACTIONS[acting.action].body}
          confirm={confirmText(acting.action, acting.row)}
          tone={acting.action === "refund" ? "danger" : "primary"}
          run={(note) => discrepancyAction(api, acting.row.discrepancyId, acting.action, note)}
          done={{ title: DONE[acting.action] }}
          onClose={() => setActing(null)}
          onDone={reload}
        />
      )}
    </div>
  );
}

/** Игрок расхождения: имя ссылкой на его карточку; аккаунта нет — идентификатор на площадке или прочерк. */
function Payer({ row }: { row: Discrepancy }) {
  if (row.accountId !== null) {
    const name = row.displayName ?? "игрок";
    return (
      <a href={hrefOf({ section: "players", id: row.accountId, tab: "purchases" })} title={name} className="block max-w-[14rem] break-words text-accent underline-offset-2 hover:underline">
        {name}
      </a>
    );
  }
  return row.payerId === null ? <>—</> : <>{`игрок ${row.payerId} на площадке`}</>;
}
