import { useEffect, useState, type FormEvent } from "react";
import { create } from "zustand";
import type { ApiError } from "../../api/client";
import { FEED_STATUSES, MODES, PLATFORMS, PRODUCTS, fetchPaymentsFeed, markLabel, titleOf, type FeedRow } from "../../api/payments";
import { purchaseLabel, purchaseState } from "../../api/players";
import { formatDateTime, formatNumber } from "../../format";
import { hrefOf } from "../../routes";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Panel, Select } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { EMPTY_FEED_FILTERS, FEED_FILTER_LABELS, feedChips, feedQuery, filtersProblem, searchProblem, type FeedFilters } from "./feed-filters";

/**
 * Лента платежей (tasks/T-0437): все покупки всех игроков, свежие сверху.
 * Фильтры, поиск и загруженные страницы живут в состоянии модуля, как у
 * списка игроков: из карточки платежа «назад» возвращает ту же ленту. Страница
 * и порядок — на сервере по курсору; «Показать ещё» догружает следующую.
 */
type Listed =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; rows: FeedRow[]; next: string | null; more: boolean }
  | { status: "error"; error: ApiError };

interface FeedStore {
  filters: FeedFilters;
  listed: Listed;
  ticket: number;
}

const useFeed = create<FeedStore>()(() => ({ filters: EMPTY_FEED_FILTERS, listed: { status: "idle" }, ticket: 0 }));

async function load(filters: FeedFilters, append: boolean): Promise<void> {
  const current = useFeed.getState();
  const previous = append && current.listed.status === "ok" ? current.listed : null;
  const ticket = current.ticket + 1;
  useFeed.setState({ filters, ticket, listed: previous === null ? { status: "loading" } : { ...previous, more: true } });
  const result = await fetchPaymentsFeed(api, feedQuery(filters), previous?.next ?? null);
  // Ответ старого запроса не перетирает новый: фильтры успели поменять.
  if (useFeed.getState().ticket !== ticket) return;
  if (!result.ok) return useFeed.setState({ listed: previous === null ? { status: "error", error: result.error } : { ...previous, more: false } });
  useFeed.setState({ listed: { status: "ok", rows: [...(previous?.rows ?? []), ...result.data.rows], next: result.data.next, more: false } });
}

/** Лента одного игрока: из карточки платежа. */
export function showAccountFeed(next: FeedFilters): void {
  void load(next, false);
  navigate({ section: "payments", id: null });
}

export function PaymentsFeed() {
  const { filters, listed } = useFeed();
  const [draft, setDraft] = useState<FeedFilters>(filters);
  const [q, setQ] = useState(filters.q);
  const [open, setOpen] = useState(false);
  const chips = feedChips(filters);
  const problem = filtersProblem(draft);
  const queryProblem = searchProblem(q);
  const filtered = chips.length > 0 || filters.q.trim() !== "";

  // Первое открытие раздела — свежие платежи сразу; вернулись из карточки — лента уже в хранилище.
  useEffect(() => {
    if (useFeed.getState().listed.status === "idle") void load(useFeed.getState().filters, false);
  }, []);

  const apply = (next: FeedFilters) => {
    setDraft(next);
    setQ(next.q);
    void load(next, false);
  };
  const set = <K extends keyof FeedFilters>(key: K, value: FeedFilters[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const search = (event: FormEvent) => {
    event.preventDefault();
    if (queryProblem === null) apply({ ...filters, q: q.trim() });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem === null) {
      setOpen(false);
      apply({ ...draft, q: filters.q });
    }
  };

  return (
    <Panel title="Платежи" help={HELP.payments.feed}>
      <form onSubmit={search} className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Номер покупки или идентификатор оплаты" {...(queryProblem === null ? {} : { error: queryProblem })}>
          <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Вставьте номер целиком" maxLength={256} className="w-full min-w-0 sm:w-96" />
        </Field>
        <div className="pt-5">
          <Button type="submit" tone="primary" disabled={queryProblem !== null || (q.trim() === "" && filters.q === "")}>
            Найти
          </Button>
        </div>
      </form>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => setOpen(!open)}>{chips.length === 0 ? "Фильтры" : `Фильтры · ${String(chips.length)}`}</Button>
        {chips.map((chip) => (
          <span key={chip.key} className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-surface-sunken py-0.5 pr-0.5 pl-2 text-xs">
            <span className="min-w-0 truncate">{chip.label}</span>
            <button type="button" aria-label={`Снять фильтр: ${chip.label}`} onClick={() => apply(chip.clear(filters))} className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-raised hover:text-text">
              ×
            </button>
          </span>
        ))}
        {chips.length >= 2 ? <Button onClick={() => apply({ ...EMPTY_FEED_FILTERS, q: filters.q })}>Сбросить</Button> : null}
      </div>

      <form onSubmit={submit} className={open ? "mb-4 flex flex-wrap items-end gap-2" : "hidden"}>
        <Field label={FEED_FILTER_LABELS.status}>
          <Select value={draft.status} onChange={(event) => set("status", FEED_STATUSES.find(([key]) => key === event.target.value)?.[0] ?? "")}>
            <option value="">все</option>
            {FEED_STATUSES.map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={FEED_FILTER_LABELS.product}>
          <Select value={draft.product} onChange={(event) => set("product", PRODUCTS.find(([key]) => key === event.target.value)?.[0] ?? "")}>
            <option value="">все</option>
            {PRODUCTS.map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={FEED_FILTER_LABELS.platform}>
          <Select value={draft.platform} onChange={(event) => set("platform", PLATFORMS.find(([key]) => key === event.target.value)?.[0] ?? "")}>
            <option value="">все</option>
            {PLATFORMS.map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={FEED_FILTER_LABELS.mode}>
          <Select value={draft.mode} onChange={(event) => set("mode", MODES.find(([key]) => key === event.target.value)?.[0] ?? "")}>
            <option value="">все</option>
            {MODES.map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${FEED_FILTER_LABELS.period}: счёт с`}>
          <Input type="date" value={draft.from} onChange={(event) => set("from", event.target.value)} />
        </Field>
        <Field label="по">
          <Input type="date" value={draft.to} onChange={(event) => set("to", event.target.value)} />
        </Field>
        <Button tone="primary" type="submit" disabled={problem !== null} blockedBy={problem}>
          Показать
        </Button>
        <Button onClick={() => setDraft({ ...EMPTY_FEED_FILTERS, q: filters.q })}>Сбросить</Button>
      </form>

      {listed.status === "idle" || listed.status === "loading" ? <Loading /> : null}
      {listed.status === "error" ? <ErrorNotice error={listed.error} onRetry={() => void load(filters, false)} /> : null}
      {listed.status === "ok" && listed.rows.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-text-muted">{filtered ? "Ничего не нашли — снимите фильтр или проверьте номер" : "Платежей пока нет"}</p>
          {filtered ? <Button onClick={() => apply(EMPTY_FEED_FILTERS)}>Сбросить фильтры</Button> : null}
        </div>
      ) : null}
      {listed.status === "ok" && listed.rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          <DataTable
            rows={listed.rows}
            rowKey={(row) => row.purchase.purchaseId}
            onRowClick={(row) => navigate({ section: "payments", id: row.purchase.purchaseId })}
            columns={[
              { title: "Счёт", render: (row) => formatDateTime(row.purchase.invoicedAt) },
              {
                title: "Игрок",
                // Длинный ник не растягивает строку: одна строка с «…», полное имя — подсказкой.
                render: (row) => (
                  <span className="block max-w-[14rem] truncate" title={row.account.displayName}>
                    {row.account.displayName}
                  </span>
                ),
              },
              {
                title: "Что",
                primary: true,
                render: (row) => (
                  <a href={hrefOf({ section: "payments", id: row.purchase.purchaseId })} onClick={(event) => event.stopPropagation()} className="text-accent underline-offset-2 hover:underline">
                    {purchaseLabel(row.purchase)}
                  </a>
                ),
              },
              { title: "Площадка", phone: "hide", render: (row) => titleOf(PLATFORMS, row.account.platform) },
              { title: "Списано, ⭐", align: "right", render: (row) => formatNumber(row.purchase.chargedStars) },
              { title: "Состояние", render: (row) => <StateBadges purchase={row.purchase} /> },
              { title: "Пометки", render: (row) => (row.marks.length === 0 ? null : <MarkList marks={row.marks} />) },
            ]}
          />
          {listed.next === null ? (
            <p className="text-xs text-text-muted">Показаны все: {listed.rows.length}</p>
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

/** Состояние покупки бейджем и «тест» у тестовой оплаты. */
export function StateBadges({ purchase }: { purchase: FeedRow["purchase"] }) {
  const state = purchaseState(purchase);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={state.tone}>{state.label}</Badge>
      {purchase.mode === "test" ? <Badge tone="info">тест</Badge> : null}
    </span>
  );
}

/** Пометки ленты бейджами; пусто — ничего. */
export function MarkBadges({ marks }: { marks: readonly string[] }) {
  return (
    <>
      {marks.map((mark) => {
        const { label, tone } = markLabel(mark);
        return (
          <Badge key={mark} tone={tone}>
            {label}
          </Badge>
        );
      })}
    </>
  );
}

function MarkList({ marks }: { marks: readonly string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      <MarkBadges marks={marks} />
    </span>
  );
}
