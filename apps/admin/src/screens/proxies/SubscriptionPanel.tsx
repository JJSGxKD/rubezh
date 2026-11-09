import { useState } from "react";
import { deleteSubscription, fetchSubscription, probeSubscription, refreshSubscription, saveSubscription, type SubscriptionInfo, type SubscriptionOverview } from "../../api/proxy-subscription";
import type { ApiError } from "../../api/client";
import { api } from "../../services";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Loading, Notice, Panel, type Column } from "../../ui/kit";
import { toast, toastError } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { SubscriptionDialog } from "./SubscriptionDialog";
import { nodeRows, refreshLine, trafficLine, type NodeRow } from "./subscription-view";

/**
 * Блок «Подписка Xray» над списком прокси (docs/35-stage4-plan.md Р101,
 * tasks/T-0093): адрес подписки с множеством подключений, итог последнего
 * обновления, трафик и узлы. Адрес не показывается никогда — только подсказка
 * «хост …abcd». Менять может владелец (`proxies.edit`), остальным виден список.
 */
const NODE_COLUMNS: Column<NodeRow>[] = [
  { title: "Узел", primary: true, render: (row) => <span className="font-medium">{row.name}</span> },
  { title: "Состояние", render: (row) => <Badge tone={row.tone}>{row.statusLabel}</Badge> },
  { title: "Протокол", render: (row) => row.protocol },
  { title: "Страна", render: (row) => row.countryText },
  { title: "Хост", render: (row) => <code className="font-mono text-xs break-all">{row.host}</code> },
  { title: "Задержка", align: "right", render: (row) => row.latencyText },
];

export function SubscriptionPanel({ canEdit }: { canEdit: boolean }) {
  const { state, reload } = useApi(() => fetchSubscription(api), []);
  const [editing, setEditing] = useState<SubscriptionInfo | "new" | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState<"refresh" | "probe" | "toggle" | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { encryption, sidecar, subscription, nodes } = state.data;

  const run = async (kind: "refresh" | "probe", action: () => Promise<{ ok: true; data: SubscriptionOverview } | { ok: false; error: ApiError }>, done: string) => {
    setBusy(kind);
    const result = await action();
    setBusy(null);
    if (!result.ok) return void toastError(result.error);
    toast.success(done);
    reload();
  };

  return (
    <>
      <Panel
        title="Подписка Xray"
        help={HELP.proxies.subscription}
        actions={
          <>
            <Button onClick={reload}>Обновить</Button>
            {canEdit && subscription === null && encryption ? (
              <Button tone="primary" onClick={() => setEditing("new")}>
                Подключить подписку
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-muted">Адрес подписки с множеством подключений. Узлы становятся прокси для запросов сервера к внешним API.</p>
          {sidecar.connected ? null : (
            <Notice tone="info">Контейнер Xray не подключён: конфигу некуда записаться, узлы работать не будут. На машине разработчика так и должно быть.</Notice>
          )}
          {subscription === null ? (
            <>
              <p className="text-sm text-text-muted">Подписка не подключена</p>
              {encryption ? null : (
                <Notice tone="info">
                  Без ключа шифрования адрес подписки сохранить нельзя — задайте <code className="font-mono">SECRETS_ENCRYPTION_KEY</code> на сервере.
                </Notice>
              )}
            </>
          ) : (
            <SubscriptionCard
              subscription={subscription}
              nodes={nodes}
              canEdit={canEdit}
              busy={busy}
              onRefresh={() => void run("refresh", () => refreshSubscription(api), "Подписка обновлена")}
              onProbe={() => void run("probe", () => probeSubscription(api), "Узлы поставлены в очередь проверки")}
              onEdit={() => setEditing(subscription)}
              onToggle={async () => {
                setBusy("toggle");
                const result = await saveSubscription(api, { name: subscription.name, url: "", countries: subscription.countries.join(","), enabled: !subscription.enabled });
                setBusy(null);
                if (!result.ok) return void toastError(result.error);
                toast.success(subscription.enabled ? "Подписка отключена" : "Подписка включена");
                reload();
              }}
              onRemove={() => setRemoving(true)}
            />
          )}
        </div>
      </Panel>
      {editing === null ? null : (
        <SubscriptionDialog
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(_overview, created) => {
            setEditing(null);
            toast.success(created ? "Подписка подключена" : "Подписка сохранена", { description: "Список узлов обновится в течение минуты — или нажмите «Обновить сейчас»" });
            reload();
          }}
        />
      )}
      {removing && subscription !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(false);
          }}
          title="Удалить подписку"
          subject={`${subscription.name} · ${subscription.urlHint}`}
          changes={[{ label: "Узлов в переборе", value: `${String(nodes.length)} → 0` }]}
          action="Удалить подписку"
          tone="danger"
          onConfirm={async () => {
            const result = await deleteSubscription(api);
            if (!result.ok) return { ok: false, error: result.error.message };
            toast.success("Подписка удалена");
            reload();
            return { ok: true };
          }}
        />
      ) : null}
    </>
  );
}

function SubscriptionCard({
  subscription,
  nodes,
  canEdit,
  busy,
  onRefresh,
  onProbe,
  onEdit,
  onToggle,
  onRemove,
}: {
  subscription: SubscriptionInfo;
  nodes: SubscriptionOverview["nodes"];
  canEdit: boolean;
  busy: "refresh" | "probe" | "toggle" | null;
  onRefresh: () => void;
  onProbe: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const refresh = refreshLine(subscription);
  const traffic = trafficLine(subscription);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 max-w-2xl flex-1 basis-64 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{subscription.name}</span>
            {subscription.enabled ? <Badge tone="success">Включена</Badge> : <Badge>Выключена</Badge>}
          </div>
          <code className="font-mono text-xs break-all">{subscription.urlHint}</code>
          <p className={`text-xs ${refresh.tone === "danger" ? "text-danger" : "text-text-muted"}`}>{refresh.text}</p>
          {traffic === null ? null : <p className="text-xs text-text-muted">{traffic}</p>}
          <p className="text-xs text-text-muted">{subscription.countries.length === 0 ? "Страны узлов: любые" : `Страны узлов: ${subscription.countries.join(", ")}`}</p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onRefresh} disabled={busy !== null || !subscription.enabled}>
              {busy === "refresh" ? "Обновляю…" : "Обновить сейчас"}
            </Button>
            <Button onClick={onProbe} disabled={busy !== null || nodes.length === 0}>
              {busy === "probe" ? "Ставлю в очередь…" : "Проверить узлы"}
            </Button>
            <Button onClick={onEdit}>Изменить</Button>
            <Button onClick={onToggle} disabled={busy !== null}>
              {subscription.enabled ? "Отключить" : "Включить"}
            </Button>
            <Button tone="danger" onClick={onRemove}>
              Удалить
            </Button>
          </div>
        ) : null}
      </div>
      <DataTable columns={NODE_COLUMNS} rows={nodeRows(nodes)} rowKey={(row) => row.nodeKey} empty="Узлов пока нет — подписка ещё не обновлялась или в ней нет подходящих" />
    </div>
  );
}
