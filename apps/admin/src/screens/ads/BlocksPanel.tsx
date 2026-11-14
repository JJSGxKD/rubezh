import { useState, type ReactNode } from "react";
import { PLACE_TITLES, SUCCESS_TITLES, archiveBlock, reachLabel, unarchiveBlock, type AdBlock, type AdsView } from "../../api/ads";
import { formatDateTime } from "../../format";
import { api } from "../../services";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, Help, Panel, type Column } from "../../ui/kit";
import { toast, toastError } from "../../ui/toast";
import { BlockDialog } from "./BlockDialog";
import { BLOCKS_TABS, BLOCK_STATE_HINTS, archiveTone, blockStateOf, blockStateText, blockSubject, blocksOfTab, blocksTabCounts, type BlocksTab } from "./blocks-view";

/**
 * Блоки мест (docs/29-admin-panel.md, WP12; архив — docs/35-stage4-plan.md
 * Р200): блок из кабинета сети, привязанный к месту показа. Над таблицей —
 * вкладки «Действующие» и «Архив»: блок в архиве выключен, виден только там и
 * не правится, пока его не вернули. Клик по строке действующего блока открывает
 * карточку; «В архив» просит подтверждения (оно может снять блок с выдачи),
 * «Вернуть» — нет: ничего не включает. `initialTab` нужен только тестам.
 */
export function BlocksPanel({ view, canEdit, onSaved, initialTab = "current" }: { view: AdsView; canEdit: boolean; onSaved: () => void; initialTab?: BlocksTab }) {
  const [tab, setTab] = useState<BlocksTab>(initialTab);
  const [open, setOpen] = useState<AdBlock | "new" | null>(null);
  const [archiving, setArchiving] = useState<AdBlock | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const networkName = (key: string) => view.networks.find((network) => network.networkKey === key)?.name ?? key;
  const counts = blocksTabCounts(view.blocks);

  const restore = async (block: AdBlock): Promise<void> => {
    setRestoring(block.blockId);
    const result = await unarchiveBlock(api, block.blockId);
    setRestoring(null);
    if (!result.ok) return toastError(result.error);
    toast.success("Блок возвращён выключенным", { description: "Включите его в карточке блока" });
    onSaved();
  };

  const common: Column<AdBlock>[] = [
    { title: "Место", render: (block) => PLACE_TITLES[block.place] },
    { title: "Сеть", render: (block) => networkName(block.networkKey) },
    { title: "Блок", help: HELP.ads.externalId, render: (block) => (block.externalId === null ? <span className="text-text-muted">по ключам сети</span> : <span className="font-mono text-xs">{block.externalId}</span>) },
    { title: "Успех", render: (block) => SUCCESS_TITLES[block.success] },
  ];
  const action = (render: (block: AdBlock) => ReactNode): Column<AdBlock>[] => (canEdit ? [{ title: "", align: "right", render }] : []);
  const columns: Column<AdBlock>[] =
    tab === "current"
      ? [
          ...common,
          { title: "Где", help: HELP.ads.reach, render: (block) => reachLabel(view, block) },
          { title: "Состояние", render: (block) => <BlockStateBadge view={view} block={block} /> },
          ...action((block) => (
            <Button
              className="whitespace-nowrap"
              onClick={(event) => {
                // Строка открывает карточку блока, а кнопка — нет.
                event.stopPropagation();
                setArchiving(block);
              }}
            >
              В архив
            </Button>
          )),
        ]
      : [
          ...common,
          { title: "В архиве с", render: (block) => formatDateTime(block.archivedAt) },
          ...action((block) => (
            <Button
              className="whitespace-nowrap"
              disabled={restoring === block.blockId}
              onClick={(event) => {
                event.stopPropagation();
                void restore(block);
              }}
            >
              Вернуть
            </Button>
          )),
        ];

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
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Блоки">
          {BLOCKS_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`rounded-pill border px-3 py-1 text-xs transition-colors ${tab === item.id ? "border-accent bg-accent/15 text-accent" : "border-border text-text-muted hover:border-border-strong hover:text-text"}`}
            >
              {`${item.title} · ${String(counts[item.id])}`}
            </button>
          ))}
        </div>
        <Help text={HELP.ads.archive} />
      </div>
      <DataTable
        rows={blocksOfTab(view.blocks, tab)}
        rowKey={(block) => block.blockId}
        onRowClick={canEdit && tab === "current" ? (block) => setOpen(block) : undefined}
        empty={tab === "current" ? "Блоков нет — заведите блок кнопкой «Новый блок»" : "В архиве пусто — сюда попадают блоки, убранные кнопкой «В архив»"}
        columns={columns}
      />
      {open === null ? null : <BlockDialog view={view} block={open} onClose={() => setOpen(null)} onSaved={onSaved} />}
      {archiving === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setArchiving(null);
          }}
          title="Убрать блок в архив"
          subject={blockSubject(view, archiving)}
          changes={[{ label: "Состояние", value: `${blockStateText(view, archiving)} → в архиве, выключен` }]}
          action="В архив"
          tone={archiveTone(view, archiving)}
          onConfirm={async () => {
            const result = await archiveBlock(api, archiving.blockId);
            if (!result.ok) return { ok: false, error: result.error.message };
            toast.success("Блок убран в архив и выключен");
            onSaved();
            return { ok: true };
          }}
        />
      )}
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
