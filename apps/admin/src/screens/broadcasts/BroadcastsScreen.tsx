import { useEffect, useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import {
  actOnBroadcast,
  createBroadcast,
  deliveredShare,
  EMPTY_SEGMENT,
  estimateAudience,
  fetchBroadcast,
  fetchBroadcasts,
  outcomeText,
  segmentSummary,
  startBroadcast,
  STATUS_LOOK,
  testBroadcast,
  updateBroadcast,
  type BroadcastAction,
  type BroadcastInput,
  type BroadcastView,
} from "../../api/broadcasts";
import { formatDateTime, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Badge, Button, DataTable, ErrorNotice, KeyValue, Loading, Notice, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { BroadcastForm } from "./BroadcastForm";

/**
 * Рассылки в бота (docs/29-admin-panel.md §7): черновик с аудиторией, тест
 * себе, одобрение, старт, пауза и отмена, итог доставки. Кнопки — по правам;
 * решает всё равно сервер.
 */
export function BroadcastsScreen({ id }: { id: string | null }) {
  return id === null ? <BroadcastList /> : <BroadcastCard key={id} broadcastId={id} />;
}

function StatusBadge({ status }: { status: BroadcastView["status"] }) {
  const look = STATUS_LOOK[status];
  return <Badge tone={look.tone}>{look.text}</Badge>;
}

const NEW_BROADCAST: BroadcastInput = { title: "", text: "", buttonText: "", segment: EMPTY_SEGMENT };

function BroadcastList() {
  const { state, reload } = useApi(() => fetchBroadcasts(api), []);
  const [creating, setCreating] = useState(false);

  const create = async (input: BroadcastInput): Promise<ApiError | null> => {
    const result = await createBroadcast(api, input);
    if (!result.ok) return result.error;
    navigate({ section: "broadcasts", id: result.data.broadcastId });
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      {creating ? (
        <Panel title="Новая рассылка">
          <BroadcastForm initial={NEW_BROADCAST} submitLabel="Сохранить черновик" buttonLocked={false} onSubmit={create} onCancel={() => setCreating(false)} />
        </Panel>
      ) : null}
      <Panel
        title="Рассылки"
        actions={
          <div className="flex gap-2">
            {creating ? null : (
              <Button tone="primary" onClick={() => setCreating(true)}>
                Новая
              </Button>
            )}
            <Button onClick={reload}>Обновить</Button>
          </div>
        }
      >
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === "ok" ? (
          <DataTable
            rows={state.data.broadcasts}
            rowKey={(row) => row.broadcastId}
            onRowClick={(row) => navigate({ section: "broadcasts", id: row.broadcastId })}
            empty="Рассылок ещё нет"
            columns={[
              { title: "Название", render: (row) => row.title },
              { title: "Состояние", render: (row) => <StatusBadge status={row.status} /> },
              { title: "Получателей", render: (row) => (row.audience === null ? "—" : formatNumber(row.audience)), align: "right" },
              { title: "Создана", render: (row) => formatDateTime(row.createdAt) },
              { title: "Запущена", render: (row) => (row.startedAt === null ? "—" : formatDateTime(row.startedAt)) },
            ]}
          />
        ) : null}
      </Panel>
    </div>
  );
}

type Outcome = { tone: "success" | "info"; text: string } | { tone: "danger"; error: ApiError } | null;

function BroadcastCard({ broadcastId }: { broadcastId: string }) {
  const { state, reload } = useApi(() => fetchBroadcast(api, broadcastId), [broadcastId]);
  const view = useSession((session) => session.view);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<{ kind: "start"; audience: number } | { kind: "cancel" } | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const sending = state.status === "ok" && state.data.status === "sending";
  // Идущую рассылку видно вживую: итог обновляется сам, пока очередь не кончится.
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(reload, 5_000);
    return () => clearInterval(timer);
  }, [sending, reload]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const broadcast = state.data;
  const canEdit = can(view, "broadcast.edit");
  const canSend = can(view, "broadcast.send");
  const canApprove = can(view, "broadcast.approve");
  const me = view.status === "ready" ? view.identity.account.accountId : null;

  const run = async (work: () => Promise<Outcome>) => {
    setPending(true);
    setOutcome(await work());
    setPending(false);
    setConfirming(null);
    reload();
  };

  const act = (action: BroadcastAction, done: string) =>
    run(async () => {
      const result = await actOnBroadcast(api, broadcastId, action);
      return result.ok ? { tone: "success", text: done } : { tone: "danger", error: result.error };
    });

  const prepareStart = async () => {
    const result = await estimateAudience(api, broadcast.segment);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setConfirming({ kind: "start", audience: result.data.audience });
  };

  const needsSecondKey = (audience: number) => audience > broadcast.approvalAudience && (broadcast.approvedBy === null || broadcast.approvedBy === me);

  const save = async (input: BroadcastInput): Promise<ApiError | null> => {
    const result = await updateBroadcast(api, broadcastId, input);
    if (!result.ok) return result.error;
    setEditing(false);
    setOutcome({ tone: "success", text: "Черновик сохранён; одобрение, если было, снято" });
    reload();
    return null;
  };

  const initial: BroadcastInput = { title: broadcast.title, text: broadcast.text, buttonText: broadcast.buttonText ?? "", segment: broadcast.segment };

  return (
    <div className="flex flex-col gap-4">
      <Panel title={broadcast.title} actions={<Button onClick={() => navigate({ section: "broadcasts", id: null })}>К списку</Button>}>
        <div className="flex flex-col gap-3">
          <KeyValue
            items={[
              ["Состояние", <StatusBadge key="status" status={broadcast.status} />],
              ["Аудитория", segmentSummary(broadcast.segment).join("; ")],
              ["Одобрена", broadcast.approvedBy === null ? "нет" : broadcast.approvedBy === me ? "вами" : "да"],
              ["Создана", formatDateTime(broadcast.createdAt)],
              ["Запущена", broadcast.startedAt === null ? "—" : formatDateTime(broadcast.startedAt)],
              ["Закончена", broadcast.finishedAt === null ? "—" : formatDateTime(broadcast.finishedAt)],
            ]}
          />
          <div className="flex max-w-xl flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3">
            <p className="whitespace-pre-wrap text-sm">{broadcast.text}</p>
            {broadcast.buttonText === null ? null : (
              <span className="self-start rounded-sm bg-accent/15 px-3 py-1 text-sm text-accent" title={broadcast.buttonUrl ?? undefined}>
                {broadcast.buttonText}
              </span>
            )}
          </div>
        </div>
      </Panel>

      {editing ? (
        <Panel title="Правка черновика">
          <BroadcastForm initial={initial} submitLabel="Сохранить" buttonLocked onSubmit={save} onCancel={() => setEditing(false)} />
        </Panel>
      ) : (
        <Panel title="Действия">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {broadcast.status === "draft" && canEdit ? <Button onClick={() => setEditing(true)}>Изменить</Button> : null}
              {broadcast.status === "draft" && canEdit ? (
                <Button
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      const result = await testBroadcast(api, broadcastId);
                      return result.ok ? { tone: result.data.status === "sent" ? "success" : "info", text: outcomeText(result.data) } : { tone: "danger", error: result.error };
                    })
                  }
                >
                  Тест себе
                </Button>
              ) : null}
              {broadcast.status === "draft" && canApprove && broadcast.approvedBy === null ? (
                <Button disabled={pending} onClick={() => void act("approve", "Одобрено: запустить может другой человек с правом отправки")}>
                  Одобрить
                </Button>
              ) : null}
              {broadcast.status === "draft" && canSend && confirming === null ? (
                <Button tone="primary" disabled={pending} onClick={() => void prepareStart()}>
                  Запустить…
                </Button>
              ) : null}
              {broadcast.status === "sending" && canSend ? (
                <Button disabled={pending} onClick={() => void act("pause", "Пауза — очередь остановится со следующей пачки")}>
                  Пауза
                </Button>
              ) : null}
              {broadcast.status === "paused" && canSend ? (
                <Button tone="primary" disabled={pending} onClick={() => void act("resume", "Продолжаем")}>
                  Продолжить
                </Button>
              ) : null}
              {(broadcast.status === "draft" || broadcast.status === "sending" || broadcast.status === "paused") && canSend && confirming === null ? (
                <Button tone="danger" disabled={pending} onClick={() => setConfirming({ kind: "cancel" })}>
                  Отменить…
                </Button>
              ) : null}
            </div>
            {confirming?.kind === "start" ? (
              <div className="flex flex-col gap-2">
                {confirming.audience === 0 ? (
                  <Notice tone="info">В аудитории никого — писать некому.</Notice>
                ) : needsSecondKey(confirming.audience) ? (
                  <Notice tone="info">
                    Получат {formatNumber(confirming.audience)} — больше {formatNumber(broadcast.approvalAudience)}. Нужно одобрение другого человека с правом одобрять рассылки.
                  </Notice>
                ) : (
                  <Notice tone="info">Получат {formatNumber(confirming.audience)}. После старта текст и аудиторию не поменять.</Notice>
                )}
                <div className="flex gap-2">
                  {confirming.audience > 0 && !needsSecondKey(confirming.audience) ? (
                    <Button
                      tone="primary"
                      disabled={pending}
                      onClick={() =>
                        void run(async () => {
                          const result = await startBroadcast(api, broadcastId);
                          return result.ok ? { tone: "success", text: `Запущено: ${formatNumber(result.data.audience)} получателей в очереди` } : { tone: "danger", error: result.error };
                        })
                      }
                    >
                      Да, запустить
                    </Button>
                  ) : null}
                  <Button onClick={() => setConfirming(null)}>Отмена</Button>
                </div>
              </div>
            ) : null}
            {confirming?.kind === "cancel" ? (
              <div className="flex gap-2">
                <Button tone="danger" disabled={pending} onClick={() => void act("cancel", "Рассылка отменена — неотправленное так и останется в очереди")}>
                  Да, отменить навсегда
                </Button>
                <Button onClick={() => setConfirming(null)}>Не отменять</Button>
              </div>
            ) : null}
            {outcome === null ? null : outcome.tone === "danger" ? <Notice>{outcome.error.message}</Notice> : <Notice tone={outcome.tone}>{outcome.text}</Notice>}
          </div>
        </Panel>
      )}

      {broadcast.stats === null ? null : (
        <Panel title="Итог" actions={<Button onClick={reload}>Обновить</Button>}>
          <KeyValue
            items={[
              ["Получателей", broadcast.audience === null ? "—" : formatNumber(broadcast.audience)],
              ["Доставлено", `${formatNumber(broadcast.stats.sent)}${deliveredShare(broadcast.stats) === null ? "" : ` (${deliveredShare(broadcast.stats)}%)`}`],
              ["Ждут в очереди", formatNumber(broadcast.stats.queued)],
              ["Бот заблокирован заранее", formatNumber(broadcast.stats.blocked)],
              ["Отказы", formatNumber(broadcast.stats.failed)],
              ["Заблокировали после рассылки", formatNumber(broadcast.stats.blockedAfter)],
              ["Переходы и запуски", broadcast.linkCode === null ? "без кнопки" : `раздел «Ссылки», кампания bc-${broadcast.broadcastId.slice(0, 8)}`],
            ]}
          />
        </Panel>
      )}
    </div>
  );
}
