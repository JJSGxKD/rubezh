import { useState, type FormEvent } from "react";
import type { ApiError } from "../../api/client";
import { CANCELLABLE, PROMO_STATE_TITLES, PROMO_TITLE_MAX, cancelPromo, createPromo, draftProblem, emptyDraft, fetchPromos, promoPrice, type Promo, type PromoDraft } from "../../api/shop-promos";
import { formatDateTime } from "../../format";
import { api } from "../../services";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel, Select } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { useApi } from "../../ui/use-api";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

const STATE_TONES: Partial<Record<string, "success" | "info" | "neutral" | "warning">> = { active: "success", scheduled: "info", cancelled: "warning" };

/**
 * Акции магазина (docs/35-stage4-plan.md WP10, часть 8): скидка от цены
 * каталога на срок. Предпросмотр цены — тем же правилом, что сервер, чтобы
 * опечатку в проценте было видно до отправки; пересечение с соседними
 * акциями товара сервер объяснит сам.
 */
export function PromosScreen() {
  const { state, reload } = useApi(() => fetchPromos(api), []);
  const [draft, setDraft] = useState<PromoDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { promos, skus, limits } = state.data;
  const input = draft ?? emptyDraft(skus);
  const sku = skus.find((candidate) => candidate.sku === input.sku);
  const problem = draftProblem(input, limits, new Date());
  const titleOf = (id: string) => skus.find((candidate) => candidate.sku === id)?.title ?? id;
  const set = (patch: Partial<PromoDraft>) => setDraft({ ...input, ...patch });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setPending(true);
    const result = await createPromo(api, input);
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `Акция на «${titleOf(result.data.sku)}» заведена — игроки увидят её в течение полуминуты после начала` });
    setDraft(null);
    reload();
  };

  const cancel = async (promo: Promo) => {
    setConfirmCancel(null);
    const result = await cancelPromo(api, promo.promoId);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `Акция на «${titleOf(promo.sku)}» снята` });
    reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Новая акция" help={HELP.promos.promos}>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Товар">
              <Select value={input.sku} onChange={(event) => set({ sku: event.target.value })}>
                {skus.map((candidate) => (
                  <option key={candidate.sku} value={candidate.sku}>
                    {candidate.title} — {candidate.stars} ⭐
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Скидка, %" help={HELP.promos.percent} hint={`от ${String(limits.minPercent)} до ${String(limits.maxPercent)}`}>
              <Input type="number" min={limits.minPercent} max={limits.maxPercent} step={1} value={String(input.percent)} onChange={(event) => set({ percent: Number(event.target.value) })} className="w-24" />
            </Field>
            <Field label="Начало" help={HELP.promos.start} hint="пусто — сразу">
              <Input type="datetime-local" value={input.startsAt} onChange={(event) => set({ startsAt: event.target.value })} />
            </Field>
            <Field label="Дней" help={HELP.promos.days} hint={`до ${String(limits.maxDays)}`}>
              <Input type="number" min={1} max={limits.maxDays} step={1} value={String(input.days)} onChange={(event) => set({ days: Number(event.target.value) })} className="w-20" />
            </Field>
          </div>
          <Field label={`Подпись баннера — ${String(input.title.trim().length)} из ${String(PROMO_TITLE_MAX)}`} help={HELP.promos.title}>
            <Input value={input.title} onChange={(event) => set({ title: event.target.value })} maxLength={PROMO_TITLE_MAX + 10} placeholder="Неделя самоцветов" className="w-full max-w-md" />
          </Field>
          {sku === undefined || problem !== null ? null : (
            <Notice tone="info">
              Игрок увидит: <s>{sku.stars} ⭐</s> → {promoPrice(sku.stars, input.percent)} ⭐. Следующая акция на этот товар — не раньше чем через {limits.restDays} дней после конца этой.
            </Notice>
          )}
          <div className="flex gap-2">
            <Button tone="primary" type="submit" disabled={problem !== null || pending}>
              Завести
            </Button>
          </div>
          {problem === null ? null : <Notice tone="info">{problem}</Notice>}
        </form>
        {outcome === null ? null : <div className="mt-3">{outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}</div>}
      </Panel>

      <Panel title="Акции">
        <DataTable
          rows={promos}
          rowKey={(promo) => promo.promoId}
          empty="Акций ещё не было"
          columns={[
            { title: "Товар", render: (promo) => titleOf(promo.sku) },
            { title: "Скидка", align: "right", render: (promo) => `−${String(promo.percent)}%` },
            {
              title: "Цена, ⭐",
              align: "right",
              render: (promo) => {
                const stars = skus.find((candidate) => candidate.sku === promo.sku)?.stars;
                return stars === undefined ? "—" : `${String(stars)} → ${String(promoPrice(stars, promo.percent))}`;
              },
            },
            { title: "Начало", render: (promo) => formatDateTime(promo.startsAt) },
            { title: "Конец", render: (promo) => formatDateTime(promo.cancelledAt !== null && promo.cancelledAt < promo.endsAt ? promo.cancelledAt : promo.endsAt) },
            { title: "Подпись", render: (promo) => promo.title ?? <span className="text-text-muted">по товару</span> },
            { title: "Состояние", help: HELP.promos.state, render: (promo) => <Badge tone={STATE_TONES[promo.state] ?? "neutral"}>{PROMO_STATE_TITLES[promo.state] ?? promo.state}</Badge> },
            {
              title: "",
              render: (promo) => {
                if (!CANCELLABLE.has(promo.state)) return null;
                // Вернуть снятую нельзя — только завести новую, и то через 14 дней: второе нажатие подтверждает.
                return confirmCancel === promo.promoId ? (
                  <span className="flex gap-2">
                    <Button tone="danger" onClick={() => void cancel(promo)}>
                      Да, снять
                    </Button>
                    <Button onClick={() => setConfirmCancel(null)}>Отмена</Button>
                  </span>
                ) : (
                  <Button onClick={() => setConfirmCancel(promo.promoId)}>Снять</Button>
                );
              },
            },
          ]}
        />
      </Panel>
    </div>
  );
}
