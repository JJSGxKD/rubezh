import { useState } from "react";
import { Copy } from "lucide-react";
import { CABINET_ROW_ACTIONS, CABINET_TEXTS, SOURCE_TITLES, fetchCabinetLinks, type CabinetLink, type LinkSource } from "../../api/cabinet";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, Help, Loading } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { NewLinkDialog } from "./NewLinkDialog";

/** Скопировать адрес ссылки: тот, что выдал сервер, без доделок на клиенте. */
export function copyLink(url: string): void {
  void navigator.clipboard.writeText(url).then(
    () => toast.success("Адрес скопирован"),
    () => toast.error("Браузер не дал скопировать — выделите адрес вручную"),
  );
}

function sourceTitle(source: string | null): string {
  if (source === null) return "—";
  return SOURCE_TITLES[source as LinkSource] ?? source;
}

/**
 * Вкладка «Ссылки»: свои ссылки с переходами и запусками, «Новая ссылка» до потолка кабинета. В режиме
 * «глазами партнёра» кнопки создания нет.
 */
export function LinksTab({ partnerId }: { partnerId: string | null }) {
  const { state, reload } = useApi(() => fetchCabinetLinks(api, partnerId), [partnerId]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CabinetLink | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { links, limit, viewOnly } = state.data;
  const atCeiling = limit.used >= limit.max;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto flex items-center gap-1.5 text-sm text-text-muted">
          Ссылок: {formatNumber(limit.used)} из {formatNumber(limit.max)}
          <Help text={HELP.cabinet.links} />
        </p>
        {viewOnly ? null : (
          <Button tone="primary" disabled={atCeiling} blockedBy={atCeiling ? CABINET_TEXTS.ceiling : null} onClick={() => setCreating(true)}>
            Новая ссылка
          </Button>
        )}
      </div>
      {created === null ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-success/40 bg-surface-sunken px-3 py-2 text-sm">
          <span className="text-success">{CABINET_TEXTS.linkCreated}</span>
          <code className="min-w-0 break-all text-xs">{created.url ?? `/r/${created.code}`}</code>
          {created.url === null ? null : <Button onClick={() => copyLink(created.url ?? "")}>Скопировать</Button>}
        </div>
      )}
      <DataTable
        rows={links}
        rowKey={(link) => link.code}
        empty={viewOnly ? "У партнёра пока нет ссылок" : CABINET_TEXTS.noLinks}
        columns={[
          { title: "Название", primary: true, render: (link) => <span className="break-words">{link.campaign}</span> },
          { title: "Источник", render: (link) => sourceTitle(link.source) },
          { title: "Заметка", render: (link) => (link.note === null ? <span className="text-text-muted">—</span> : <span className="break-words">{link.note}</span>) },
          { title: "Переходов", align: "right", render: (link) => formatNumber(link.clicks) },
          { title: "Запусков", help: HELP.cabinet.launches, align: "right", render: (link) => formatNumber(link.launches) },
          { title: "Заведена", render: (link) => formatDateTime(link.createdAt) },
          {
            title: "",
            render: (link) =>
              link.url === null ? null : (
                <Button onClick={() => copyLink(link.url ?? "")} aria-label={`Скопировать адрес ссылки ${link.campaign}`}>
                  <Copy size={14} aria-hidden="true" />
                  {CABINET_ROW_ACTIONS.copyAddress}
                </Button>
              ),
          },
        ]}
      />
      {creating ? (
        <NewLinkDialog
          onClose={() => setCreating(false)}
          onCreated={(link) => {
            setCreated(link);
            reload();
          }}
        />
      ) : null}
    </section>
  );
}
