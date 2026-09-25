import { useState, type FormEvent } from "react";
import { create } from "zustand";
import { api } from "../../app";
import type { ApiError } from "../../api/client";
import { searchPlayers, type PlayerRow } from "../../api/players";
import { formatDateTime } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Input, Loading, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";

/**
 * Последний поиск переживает переход в карточку и обратно: разбирая жалобу,
 * открывают несколько игроков подряд из одного списка.
 */
type Found = { status: "idle" } | { status: "loading" } | { status: "ok"; players: PlayerRow[] } | { status: "error"; error: ApiError };

const useSearch = create<{ query: string; found: Found; ticket: number }>()(() => ({ query: "", found: { status: "idle" }, ticket: 0 }));

async function runSearch(query: string): Promise<void> {
  const ticket = useSearch.getState().ticket + 1;
  useSearch.setState({ query, found: { status: "loading" }, ticket });
  const result = await searchPlayers(api, query);
  // Ответ старого поиска не перетирает новый.
  if (useSearch.getState().ticket !== ticket) return;
  useSearch.setState({ found: result.ok ? { status: "ok", players: result.data.players } : { status: "error", error: result.error } });
}

export function PlayerSearch() {
  const { query, found } = useSearch();
  const [draft, setDraft] = useState(query);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text !== "") void runSearch(text);
  };

  return (
    <Panel title="Игроки">
      <form onSubmit={submit} className="mb-4 flex gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Telegram ID, @юзернейм или часть имени"
          maxLength={64}
          autoFocus
          className="w-96"
        />
        <Button tone="primary" type="submit">
          Найти
        </Button>
      </form>
      {found.status === "idle" ? <p className="text-sm text-text-muted">Telegram ID — точно, юзернейм — с начала, имя — по вхождению.</p> : null}
      {found.status === "loading" ? <Loading /> : null}
      {found.status === "error" ? <ErrorNotice error={found.error} onRetry={() => void runSearch(query)} /> : null}
      {found.status === "ok" ? (
        <DataTable
          rows={found.players}
          rowKey={(player) => player.accountId}
          onRowClick={(player) => navigate({ section: "players", id: player.accountId })}
          empty="Никого не нашли"
          columns={[
            { title: "Имя", render: (player) => player.displayName },
            { title: "Площадка", render: (player) => player.platform },
            { title: "ID на площадке", render: (player) => player.pii?.platformUserId ?? "скрыт" },
            { title: "Юзернейм", render: (player) => (player.pii === null ? "скрыт" : player.pii.username === null ? "—" : `@${player.pii.username}`) },
            { title: "С нами с", render: (player) => formatDateTime(player.createdAt) },
            { title: "Статус", render: (player) => (player.banned === null ? null : <Badge tone="danger">заблокирован</Badge>) },
          ]}
        />
      ) : null}
    </Panel>
  );
}
