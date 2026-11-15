import { useState } from "react";
import { retryPaymentJob, type FailedJob, type PaymentJobs as PaymentJobsData } from "../../api/payments";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, Loading, Notice, Panel } from "../../ui/kit";
import type { Loaded } from "../../ui/use-api";
import { ChargeId, NoteActionDialog, OneLine, PurchaseOpen } from "./PaymentParts";
import { jobKindLabel } from "./payments-tabs";

/**
 * Вкладка «Брошенные задания» раздела «Платежи» (tasks/T-0438): задания
 * очереди оплаты, которые не прошли за все попытки. Повтор — целиком, со
 * свежей серией попыток; ничего не удваивается, запись оплаты и выдача
 * идемпотентны, а решает сервер.
 */
export function PaymentJobs({ state, reload, canSupport }: { state: Loaded<PaymentJobsData>; reload: () => void; canSupport: boolean }) {
  const [acting, setActing] = useState<FailedJob | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { available, jobs } = state.data;

  return (
    <div className="flex flex-col gap-4">
      {available ? null : <Notice tone="warning">Очередь оплаты недоступна: Redis не отвечает или оплата выключена</Notice>}
      <Panel
        title={`Брошенные задания · ${String(jobs.length)}`}
        help={HELP.payments.jobs}
        actions={<Button onClick={reload}>Обновить</Button>}
      >
        {jobs.length === 0 ? (
          <p className="text-sm text-text-muted">Брошенных заданий нет</p>
        ) : (
          <DataTable
            rows={jobs}
            rowKey={(row) => row.jobId}
            columns={[
              { title: "Когда", primary: true, render: (row) => formatDateTime(row.failedAt) },
              { title: "Вид", render: (row) => jobKindLabel(row.kind) },
              { title: "Оплата", render: (row) => <ChargeId value={row.chargeId} /> },
              { title: "Покупка", render: (row) => <PurchaseOpen purchaseId={row.purchaseId} /> },
              { title: "⭐", align: "right", render: (row) => (row.amount === null ? "—" : formatNumber(row.amount)) },
              { title: "Причина", render: (row) => <OneLine text={row.reason} widthClass="max-w-[18rem]" /> },
              { title: "Попыток", align: "right", render: (row) => formatNumber(row.attempts) },
              ...(canSupport
                ? [
                    {
                      title: "Действия",
                      render: (row: FailedJob) => (
                        <Button className="whitespace-nowrap" onClick={() => setActing(row)}>
                          Повторить…
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Panel>

      {acting === null ? null : (
        <NoteActionDialog
          key={acting.jobId}
          title="Повторить задание"
          description={`${jobKindLabel(acting.kind)} · ${acting.amount === null ? "без суммы" : `${formatNumber(acting.amount)} ⭐`} · ${formatDateTime(acting.failedAt)}`}
          body="Задание повторится целиком, со свежей серией попыток. Запустите после того, как причина сбоя исправлена, иначе оно снова упадёт."
          confirm="Повторить"
          tone="primary"
          run={(note) => retryPaymentJob(api, acting.jobId, note)}
          done={{ title: "Задание повторено" }}
          onClose={() => setActing(null)}
          onDone={reload}
        />
      )}
    </div>
  );
}
