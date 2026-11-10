import { useState } from "react";
import { deleteSubscription, fetchSubscriptions, probeSubscription, refreshSubscription, updateSubscription, type SubscriptionInfo, type SubscriptionOverview } from "../../api/proxy-subscription";
import type { ApiError } from "../../api/client";
import { api } from "../../services";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { HELP } from "../../ui/help";
import { Button, ErrorNotice, Loading, Notice, Panel } from "../../ui/kit";
import { toast, toastError } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { SubscriptionCard, type CardAction } from "./SubscriptionCard";
import { SubscriptionDialog } from "./SubscriptionDialog";
import { canAddSubscription, limitLine, slotLine } from "./subscription-view";

/**
 * Блок «Подписки Xray» над списком прокси (docs/35-stage4-plan.md Р101, Р192,
 * tasks/T-0093, tasks/T-0384): адреса подписок с множеством подключений, у
 * каждой свой итог обновления, трафик, узлы и кнопки. Узлы всех включённых
 * подписок — общий запас прокси. Адрес не показывается никогда — только
 * подсказка «хост …abcd». Менять может владелец (`proxies.edit`), остальным
 * виден список.
 */
type Outcome = { ok: true; data: unknown } | { ok: false; error: ApiError };

export function SubscriptionPanel({ canEdit }: { canEdit: boolean }) {
  const { state, reload } = useApi(() => fetchSubscriptions(api), []);
  const [editing, setEditing] = useState<SubscriptionInfo | "new" | null>(null);
  const [removing, setRemoving] = useState<SubscriptionInfo | null>(null);
  /** какое действие идёт над какой подпиской: у каждой подписки свои кнопки, и нажимают их независимо */
  const [busy, setBusy] = useState<Readonly<Record<string, CardAction>>>({});

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const overview: SubscriptionOverview = state.data;
  const { encryption, sidecar, subscriptions } = overview;
  const full = limitLine(overview);

  const run = async (subscription: SubscriptionInfo, action: CardAction, work: () => Promise<Outcome>, done: string) => {
    setBusy((current) => ({ ...current, [subscription.key]: action }));
    const result = await work();
    setBusy((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== subscription.key)));
    if (!result.ok) return void toastError(result.error);
    toast.success(done);
    reload();
  };

  return (
    <>
      <Panel
        title="Подписки Xray"
        help={HELP.proxies.subscription}
        actions={
          <>
            <Button onClick={reload}>Обновить</Button>
            {canEdit && encryption && canAddSubscription(overview) ? (
              <Button tone="primary" onClick={() => setEditing("new")}>
                Добавить подписку
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-muted">
            Адреса подписок с множеством подключений. Узлы всех включённых подписок — общий запас прокси для запросов сервера к внешним API: в перебор идут лучшие по задержке.
          </p>
          <p className="text-xs text-text-muted">{slotLine(overview)}</p>
          {sidecar.connected ? null : (
            <Notice tone="info">Контейнер Xray не подключён: конфигу некуда записаться, узлы работать не будут. На машине разработчика так и должно быть.</Notice>
          )}
          {full === null ? null : <p className="text-xs text-text-muted">{full}</p>}
          {subscriptions.length === 0 ? (
            <>
              <p className="text-sm text-text-muted">Подписки не подключены</p>
              {encryption ? null : (
                <Notice tone="info">
                  Без ключа шифрования адрес подписки сохранить нельзя — задайте <code className="font-mono">SECRETS_ENCRYPTION_KEY</code> на сервере.
                </Notice>
              )}
            </>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {subscriptions.map((subscription) => (
                <SubscriptionCard
                  key={subscription.key}
                  subscription={subscription}
                  single={subscriptions.length === 1}
                  canEdit={canEdit}
                  busy={busy[subscription.key] ?? null}
                  onRefresh={() => void run(subscription, "refresh", () => refreshSubscription(api, subscription.key), "Подписка обновлена")}
                  onProbe={() => void run(subscription, "probe", () => probeSubscription(api, subscription.key), "Узлы поставлены в очередь проверки")}
                  onEdit={() => setEditing(subscription)}
                  onToggle={() =>
                    void run(
                      subscription,
                      "toggle",
                      () => updateSubscription(api, subscription.key, { name: subscription.name, url: "", countries: subscription.countries.join(","), enabled: !subscription.enabled }),
                      subscription.enabled ? "Подписка отключена" : "Подписка включена",
                    )
                  }
                  onRemove={() => setRemoving(subscription)}
                />
              ))}
            </div>
          )}
        </div>
      </Panel>
      {editing === null ? null : (
        <SubscriptionDialog
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            if (created) toast.success("Подписка добавлена", { description: "Список узлов появится в течение минуты — или нажмите «Обновить сейчас»" });
            else toast.success("Подписка сохранена");
            reload();
          }}
        />
      )}
      {removing === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title="Удалить подписку"
          subject={`${removing.name} · ${removing.urlHint}`}
          changes={[{ label: "Узлов в переборе", value: `${String(removing.enabled ? removing.nodes.length : 0)} → 0` }]}
          action="Удалить подписку"
          tone="danger"
          onConfirm={async () => {
            const result = await deleteSubscription(api, removing.key);
            if (!result.ok) return { ok: false, error: result.error.message };
            toast.success("Подписка удалена");
            reload();
            return { ok: true };
          }}
        />
      )}
    </>
  );
}
