import { useState, type FormEvent } from "react";
import { api } from "../../app";
import type { ApiError } from "../../api/client";
import { conversion, createLink, fetchLinks, SLUG } from "../../api/links";
import { formatDateTime, formatNumber } from "../../format";
import { Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

/**
 * Ссылки кампаний: завести ссылку `/r/<код>` для поста, канала или партнёра и
 * видеть клики и запуски по ней. Клики краулеров превью сюда не попадают.
 */
export function LinksScreen() {
  const { state, reload } = useApi(() => fetchLinks(api), []);
  const [campaign, setCampaign] = useState("");
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<{ tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null>(null);

  const valid = SLUG.test(campaign) && (source === "" || SLUG.test(source));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const result = await createLink(api, { campaign, source: source || undefined, note: note.trim() || undefined });
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `Ссылка готова: ${result.data.url}` });
    setCampaign("");
    setSource("");
    setNote("");
    reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Новая ссылка">
        <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-2">
          <Field label="Кампания" hint="латиница, цифры, дефис">
            <Input value={campaign} onChange={(event) => setCampaign(event.target.value.trim().toLowerCase())} placeholder="launch-post" maxLength={64} />
          </Field>
          <Field label="Источник">
            <Input value={source} onChange={(event) => setSource(event.target.value.trim().toLowerCase())} placeholder="tg-channel" maxLength={64} />
          </Field>
          <Field label="Заметка">
            <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} className="w-72" />
          </Field>
          <Button tone="primary" type="submit" disabled={!valid}>
            Завести
          </Button>
        </form>
        {outcome === null ? null : <div className="mt-3">{outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}</div>}
      </Panel>
      <Panel title="Ссылки" actions={<Button onClick={reload}>Обновить</Button>}>
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === "ok" ? (
          <DataTable
            rows={state.data.links}
            rowKey={(row) => row.code}
            empty="Ссылок ещё нет"
            columns={[
              { title: "Кампания", render: (row) => row.campaign },
              { title: "Источник", render: (row) => row.source ?? "—" },
              { title: "Адрес", render: (row) => <code className="text-xs">{row.url}</code> },
              { title: "Кликов", render: (row) => formatNumber(row.clicks), align: "right" },
              { title: "За 30 дней", render: (row) => formatNumber(row.clicks30d), align: "right" },
              { title: "Запусков", render: (row) => formatNumber(row.launches), align: "right" },
              { title: "Конверсия", render: (row) => (conversion(row) === null ? "—" : `${conversion(row)}%`), align: "right" },
              { title: "Заведена", render: (row) => formatDateTime(row.createdAt) },
              { title: "Заметка", render: (row) => row.note ?? "—" },
            ]}
          />
        ) : null}
      </Panel>
    </div>
  );
}
