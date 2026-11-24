import { useMemo, useState, type ReactNode } from "react";
import { sendPayout } from "../../../api/ledger-periods";
import { loadPlaces } from "../../../api/ledger-operations";
import { api } from "../../../services";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { Field, Input, Notice, Select, TextArea } from "../../../ui/kit";
import { toast } from "../../../ui/toast";
import { useApi } from "../../../ui/use-api";
import { flattenPlaces } from "../operations/preview";
import { formatRub, monthTitle, payoutBody, payoutProblem, TEXT_MAX, type PayoutForm, type PayoutTarget } from "./model";

/**
 * Окно выплаты за закрытый месяц (tasks/T-0470, Р222): получатель задан строкой, из которой окно открыто, сумма —
 * остаток долга из ответа сервера (владелец вводит свою), место — любое неархивное место нужной валюты. Молчащему
 * дольше срока и оспорившему платят по решению владельца — тогда причина обязательна. Всё остальное — остатки,
 * сроки, чек-лист — проверяет сервер, его текст показывается под полями. Деньги переводит человек, учёт их записывает.
 */
export function PayoutDialog({ period, target, onClose, onDone }: { period: string; target: PayoutTarget; onClose: () => void; onDone: () => void }): ReactNode {
  const places = useApi(() => loadPlaces(api), []);
  const options = useMemo(() => (places.state.status === "ok" ? flattenPlaces(places.state.data).filter((place) => !place.archived && (target.currency === null || place.currency === target.currency)) : []), [places.state, target.currency]);

  const [form, setForm] = useState<PayoutForm>(() => ({
    payee: target.payee,
    from: "",
    amount: target.amount,
    reason: "",
    note: target.note(period),
    at: new Date().toISOString().slice(0, 10),
  }));
  const set = (patch: Partial<PayoutForm>): void => setForm((current) => ({ ...current, ...patch }));

  const loadFailed = places.state.status === "error";
  const noPlaces = places.state.status === "ok" && options.length === 0;
  const problem = loadFailed ? "Список мест не загрузился — закройте окно и откройте снова" : noPlaces ? "Нет места нужной валюты — заведите его на вкладке «Места и статьи»" : payoutProblem(form, target, options);

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`${target.action}: ${target.label}`}
      subject={`За ${monthTitle(period)}`}
      problem={problem}
      action="Отправить выплату"
      changes={target.amount === "" ? [] : [{ label: "Остаток долга", value: target.currency === "RUB" ? formatRub(target.amount) : `${target.amount} ${target.currency ?? ""}` }]}
      onConfirm={async () => {
        const result = await sendPayout(api, payoutBody(period, form));
        if (!result.ok) return { ok: false, error: result.error.message };
        toast.success(result.data.status === "pending" ? "Выплата ждёт подтверждения владельца" : "Выплата проведена");
        onDone();
        return { ok: true };
      }}
    >
      {places.state.status === "loading" ? <p className="text-sm text-text-muted">Загрузка мест…</p> : null}
      <Field label="Откуда платите">
        <Select value={form.from} onChange={(event) => set({ from: event.target.value })}>
          <option value="">Выберите место</option>
          {options.map((place) => (
            <option key={place.accountId} value={place.accountId}>
              {`${place.name} · ${place.currency}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={target.currency === null ? "Сумма (в валюте места)" : `Сумма, ${target.currency}`} hint={target.amount === "" ? "Забрать можно любую часть доли" : "По умолчанию — остаток долга; можно меньше"}>
        <Input inputMode="decimal" value={form.amount} onChange={(event) => set({ amount: event.target.value })} />
      </Field>
      <Field label="Дата выплаты">
        <Input type="date" value={form.at} onChange={(event) => set({ at: event.target.value })} />
      </Field>
      <Field label="Описание">
        <Input maxLength={TEXT_MAX} value={form.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      {target.needsReason ? (
        <>
          {target.reasonHint === null ? null : <Notice tone="warning">{target.reasonHint}</Notice>}
          <Field label="Причина вашего решения" hint="Попадёт в учёт вместе с выплатой">
            <TextArea rows={3} maxLength={TEXT_MAX} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        </>
      ) : null}
    </ConfirmDialog>
  );
}
