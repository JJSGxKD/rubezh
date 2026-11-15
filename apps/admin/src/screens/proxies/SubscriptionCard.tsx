import { useState } from "react";
import type { SubscriptionInfo } from "../../api/proxy-subscription";
import { Badge, Button, Help } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { SubscriptionNodes } from "./SubscriptionNodes";
import { deviceLine, nodesSummary, refreshLine, routingLine, trafficLine } from "./subscription-view";

/**
 * Карточка одной подписки Xray (docs/35-stage4-plan.md Р101, Р192): название,
 * состояние, подсказка адреса, итог обновления, трафик и срок, устройство у
 * поставщика, своя маршрутизация, страны, сводка по узлам и свои кнопки. Адрес не показывается никогда — только «хост …abcd».
 * Менять может владелец (`proxies.edit`), остальным виден список.
 */

export type CardAction = "refresh" | "probe" | "toggle";

export function SubscriptionCard({
  subscription,
  single,
  canEdit,
  busy,
  onRefresh,
  onProbe,
  onEdit,
  onToggle,
  onRemove,
}: {
  subscription: SubscriptionInfo;
  /** подписка в списке одна: узлы показаны сразу, иначе свёрнуты */
  single: boolean;
  canEdit: boolean;
  /** какое действие над этой подпиской идёт сейчас */
  busy: CardAction | null;
  onRefresh: () => void;
  onProbe: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const [opened, setOpened] = useState<boolean | null>(null);
  const open = opened ?? single;
  const refresh = refreshLine(subscription);
  const traffic = trafficLine(subscription);
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 max-w-2xl flex-1 basis-64 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-words">{subscription.name}</span>
            {subscription.enabled ? <Badge tone="success">Включена</Badge> : <Badge>Выключена</Badge>}
          </div>
          <code className="font-mono text-xs break-all">{subscription.urlHint}</code>
          <p className={`text-xs ${refresh.tone === "danger" ? "text-danger" : "text-text-muted"}`}>{refresh.text}</p>
          {traffic === null ? null : <p className="text-xs text-text-muted">{traffic}</p>}
          <p className="text-xs text-text-muted">
            {deviceLine(subscription.device)} <Help text={HELP.proxies.device} />
          </p>
          <p className="text-xs text-text-muted">{routingLine(subscription.routing)}</p>
          <p className="text-xs text-text-muted">{subscription.countries.length === 0 ? "Страны узлов: любые" : `Страны узлов: ${subscription.countries.join(", ")}`}</p>
          <p className="text-xs text-text-muted">{nodesSummary(subscription.nodes)}</p>
          {subscription.enabled ? null : <p className="text-xs text-text-muted">Узлы не в переборе; входы Xray за подпиской сохранены</p>}
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onRefresh} disabled={busy !== null || !subscription.enabled}>
              {busy === "refresh" ? "Обновляю…" : "Обновить сейчас"}
            </Button>
            <Button onClick={onProbe} disabled={busy !== null || subscription.nodes.length === 0}>
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
      <SubscriptionNodes nodes={subscription.nodes} open={open} onToggle={() => setOpened(!open)} />
    </div>
  );
}
