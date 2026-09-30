import { useState, type FormEvent, type ReactNode } from "react";
import { create } from "zustand";
import type { ApiError } from "../../api/client";
import {
  EMPTY_FILTERS,
  LIST_PLATFORMS,
  LIST_SORTS,
  LIST_SOURCES,
  fetchPlayerList,
  filtersProblem,
  sourceLabel,
  type PlayerListFilters,
  type PlayerListItem,
  type YesNo,
} from "../../api/player-list";
import { formatDateTime } from "../../format";
import { api } from "../../services";
import { useSession } from "../../state/use-session";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel, Select } from "../../ui/kit";
import { navigate } from "../../ui/router";

/**
 * Список игроков с фильтрами (docs/35-stage4-plan.md WP32). Фильтры и
 * загруженные страницы переживают переход в карточку и обратно — разбирают
 * обычно несколько игроков из одного списка подряд. Порядок и страница — на
 * сервере, по индексу; «Показать ещё» догружает следующую.
 */
type Listed =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; players: PlayerListItem[]; cursor: string | null; more: boolean }
  | { status: "error"; error: ApiError };

interface ListStore {
  filters: PlayerListFilters;
  listed: Listed;
  ticket: number;
}

const useList = create<ListStore>()(() => ({ filters: EMPTY_FILTERS, listed: { status: "idle" }, ticket: 0 }));

async function load(filters: PlayerListFilters, append: boolean): Promise<void> {
  const current = useList.getState();
  const previous = append && current.listed.status === "ok" ? current.listed : null;
  const ticket = current.ticket + 1;
  useList.setState({ filters, ticket, listed: previous === null ? { status: "loading" } : { ...previous, more: true } });
  const result = await fetchPlayerList(api, filters, previous?.cursor ?? null);
  // Ответ старого запроса не перетирает новый: фильтры успели поменять.
  if (useList.getState().ticket !== ticket) return;
  if (!result.ok) return useList.setState({ listed: previous === null ? { status: "error", error: result.error } : { ...previous, more: false } });
  useList.setState({ listed: { status: "ok", players: [...(previous?.players ?? []), ...result.data.players], cursor: result.data.nextCursor, more: false } });
}

const YES_NO: [YesNo, string][] = [
  ["", "неважно"],
  ["yes", "да"],
  ["no", "нет"],
];

function YesNoField(props: { label: string; value: YesNo; onChange(value: YesNo): void }): ReactNode {
  return (
    <Field label={props.label}>
      <Select value={props.value} onChange={(event) => props.onChange(YES_NO.find(([key]) => key === event.target.value)?.[0] ?? "")}>
        {YES_NO.map(([key, title]) => (
          <option key={key} value={key}>
            {title}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function PlayerList() {
  const { filters, listed } = useList();
  const [draft, setDraft] = useState<PlayerListFilters>(filters);
  const withPayments = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("analytics.revenue.view"));
  const problem = filtersProblem(draft);
  const set = <K extends keyof PlayerListFilters>(key: K, value: PlayerListFilters[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem === null) void load(draft, false);
  };

  return (
    <Panel title="Список игроков" actions={<span className="text-xs text-text-muted">фильтры — все вместе; пустое — неважно</span>}>
      <form onSubmit={submit} className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Площадка">
            <Select value={draft.platform} onChange={(event) => set("platform", LIST_PLATFORMS.find((platform) => platform === event.target.value) ?? "")}>
              <option value="">все</option>
              {LIST_PLATFORMS.map((platform) => (
                <option key={platform} value={platform}>
                  {platform}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Уровень от">
            <Input type="number" min={1} max={999} value={draft.levelMin} onChange={(event) => set("levelMin", event.target.value)} className="w-20" />
          </Field>
          <Field label="до">
            <Input type="number" min={1} max={999} value={draft.levelMax} onChange={(event) => set("levelMax", event.target.value)} className="w-20" />
          </Field>
          <Field label="Регистрация с">
            <Input type="date" value={draft.registeredFrom} onChange={(event) => set("registeredFrom", event.target.value)} />
          </Field>
          <Field label="по">
            <Input type="date" value={draft.registeredTo} onChange={(event) => set("registeredTo", event.target.value)} />
          </Field>
          <Field label="Заходил с">
            <Input type="date" value={draft.seenFrom} onChange={(event) => set("seenFrom", event.target.value)} />
          </Field>
          <Field label="по">
            <Input type="date" value={draft.seenTo} onChange={(event) => set("seenTo", event.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Откуда пришёл">
            <Select value={draft.source} onChange={(event) => set("source", LIST_SOURCES.find(([key]) => key === event.target.value)?.[0] ?? "")}>
              <option value="">неважно</option>
              {LIST_SOURCES.map(([key, title]) => (
                <option key={key} value={key}>
                  {title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Кампания">
            <Input value={draft.campaign} onChange={(event) => set("campaign", event.target.value)} placeholder="spring-promo" maxLength={64} className="w-36" />
          </Field>
          {withPayments ? <YesNoField label="Платящий" value={draft.payer} onChange={(value) => set("payer", value)} /> : null}
          <YesNoField label="Заблокирован" value={draft.banned} onChange={(value) => set("banned", value)} />
          <YesNoField label="Можно писать" value={draft.canMessage} onChange={(value) => set("canMessage", value)} />
          <Field label="Порядок">
            <Select value={draft.sort} onChange={(event) => set("sort", LIST_SORTS.find(([key]) => key === event.target.value)?.[0] ?? "registered")}>
              {LIST_SORTS.map(([key, title]) => (
                <option key={key} value={key}>
                  {title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Направление">
            <Select value={draft.order} onChange={(event) => set("order", event.target.value === "asc" ? "asc" : "desc")}>
              <option value="desc">сначала новые и старшие</option>
              <option value="asc">сначала ранние и младшие</option>
            </Select>
          </Field>
          <Button tone="primary" type="submit" disabled={problem !== null}>
            Показать
          </Button>
          <Button onClick={() => setDraft(EMPTY_FILTERS)}>Сбросить</Button>
        </div>
        {problem === null ? null : <Notice tone="info">{problem}</Notice>}
      </form>

      {listed.status === "idle" ? <p className="text-sm text-text-muted">Задайте фильтры и нажмите «Показать» — или сразу «Показать»: все игроки, новые сверху.</p> : null}
      {listed.status === "loading" ? <Loading /> : null}
      {listed.status === "error" ? <ErrorNotice error={listed.error} onRetry={() => void load(filters, false)} /> : null}
      {listed.status === "ok" ? (
        <div className="flex flex-col gap-3">
          <DataTable
            rows={listed.players}
            rowKey={(player) => player.accountId}
            onRowClick={(player) => navigate({ section: "players", id: player.accountId })}
            empty="Под фильтры никто не подходит"
            columns={[
              { title: "Имя", render: (player) => player.displayName },
              { title: "Площадка", render: (player) => player.platform },
              { title: "ID на площадке", render: (player) => player.pii?.platformUserId ?? "скрыт" },
              { title: "Уровень", render: (player) => player.level },
              { title: "Регистрация", render: (player) => formatDateTime(player.createdAt) },
              { title: "Заходил", render: (player) => formatDateTime(player.lastSeenAt) },
              { title: "Откуда", render: (player) => (player.campaign === null ? sourceLabel(player.source) : `${sourceLabel(player.source)}: ${player.campaign}`) },
              ...(withPayments ? [{ title: "Платящий", render: (player: PlayerListItem) => (player.payer === true ? <Badge tone="success">да</Badge> : "—") }] : []),
              { title: "Писать", render: (player) => (player.canMessage === true ? "можно" : "нельзя") },
              { title: "Статус", render: (player) => (player.banned === null ? null : <Badge tone="danger">заблокирован</Badge>) },
            ]}
          />
          {listed.cursor === null ? (
            <p className="text-xs text-text-muted">Показаны все: {listed.players.length}</p>
          ) : (
            <Button disabled={listed.more} onClick={() => void load(filters, true)}>
              {listed.more ? "Загружаем…" : "Показать ещё"}
            </Button>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
