import { useState } from "react";
import { PLACE_TITLES, SUCCESS_TITLES, reachLabel, type AdBlock, type AdsView } from "../../api/ads";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, Panel } from "../../ui/kit";
import { BlockDialog } from "./BlockDialog";
import { BLOCK_STATE_HINTS, blockStateOf, blockStateText } from "./blocks-view";

/**
 * Блоки мест (docs/29-admin-panel.md, WP12): блок из кабинета сети, привязанный
 * к месту показа; клик по строке открывает карточку блока.
 */
export function BlocksPanel({ view, canEdit, onSaved }: { view: AdsView; canEdit: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState<AdBlock | "new" | null>(null);
  const networkName = (key: string) => view.networks.find((network) => network.networkKey === key)?.name ?? key;

  return (
    <Panel
      title="Блоки мест"
      help={HELP.ads.blocks}
      actions={
        canEdit ? (
          <Button tone="primary" onClick={() => setOpen("new")}>
            Новый блок
          </Button>
        ) : null
      }
    >
      <DataTable
        rows={view.blocks}
        rowKey={(block) => block.blockId}
        onRowClick={canEdit ? (block) => setOpen(block) : undefined}
        empty="Блоков нет — заведите блок кнопкой «Новый блок»"
        columns={[
          { title: "Место", render: (block) => PLACE_TITLES[block.place] },
          { title: "Сеть", render: (block) => networkName(block.networkKey) },
          { title: "Блок", help: HELP.ads.externalId, render: (block) => (block.externalId === null ? <span className="text-text-muted">по ключам сети</span> : <span className="font-mono text-xs">{block.externalId}</span>) },
          { title: "Успех", render: (block) => SUCCESS_TITLES[block.success] },
          { title: "Где", help: HELP.ads.reach, render: (block) => reachLabel(view, block) },
          { title: "Состояние", render: (block) => <BlockStateBadge view={view} block={block} /> },
        ]}
      />
      {open === null ? null : <BlockDialog view={view} block={open} onClose={() => setOpen(null)} onSaved={onSaved} />}
    </Panel>
  );
}

/** Состояние блока в выдаче: слова и хвосты — из `blocks-view.ts`, тона — по состоянию. */
function BlockStateBadge({ view, block }: { view: AdsView; block: AdBlock }) {
  const state = blockStateOf(view, block);
  const text = `${blockStateText(view, block)}${BLOCK_STATE_HINTS[state]}`;
  if (state === "problem") {
    return (
      <span className="flex flex-col gap-0.5">
        <Badge tone="danger">{text}</Badge>
        <span className="text-xs text-danger">{block.problem}</span>
      </span>
    );
  }
  if (state === "off") return <Badge tone="warning">{text}</Badge>;
  if (state === "served") return <Badge tone="success">{text}</Badge>;
  return <Badge>{text}</Badge>;
}
