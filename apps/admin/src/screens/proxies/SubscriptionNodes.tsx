import type { SubscriptionNode } from "../../api/proxy-subscription";
import { Badge, Button, DataTable, type Column } from "../../ui/kit";
import { nodeRows, nodesToggleLabel, type NodeRow } from "./subscription-view";

/**
 * Узлы одной подписки Xray (docs/35-stage4-plan.md Р101, Р192): таблица с
 * состоянием и задержкой, рабочие сверху. Подписок несколько — таблица свёрнута
 * кнопкой «Показать узлы (37)», чтобы список подписок читался целиком.
 */
const NODE_COLUMNS: Column<NodeRow>[] = [
  { title: "Узел", primary: true, render: (row) => <span className="font-medium">{row.name}</span> },
  { title: "Состояние", render: (row) => <Badge tone={row.tone}>{row.statusLabel}</Badge> },
  { title: "Протокол", render: (row) => row.protocol },
  { title: "Страна", render: (row) => row.countryText },
  { title: "Хост", render: (row) => <code className="font-mono text-xs break-all">{row.host}</code> },
  { title: "Задержка", align: "right", render: (row) => row.latencyText },
];

export function SubscriptionNodes({ nodes, open, onToggle }: { nodes: readonly SubscriptionNode[]; open: boolean; onToggle: () => void }) {
  if (nodes.length === 0) return <p className="text-xs text-text-muted">Узлов пока нет — подписка ещё не обновлялась или в ней нет подходящих</p>;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button onClick={onToggle} aria-expanded={open}>
          {nodesToggleLabel(nodes.length, open)}
        </Button>
      </div>
      {open ? <DataTable columns={NODE_COLUMNS} rows={nodeRows(nodes)} rowKey={(row) => row.nodeKey} /> : null}
    </div>
  );
}
