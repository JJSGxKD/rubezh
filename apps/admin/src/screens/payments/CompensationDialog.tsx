import { useState } from "react";
import type { ApiError } from "../../api/client";
import { compensatePayment, fetchCompensationPreview, type CompensationPreview } from "../../api/payments";
import { PURCHASE_NOTE_MAX } from "../../api/players";
import { formatDateTime, formatNumber, plural } from "../../format";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Button, ErrorNotice, Field, Input, Notice, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { compensationProblem, gemsProblem, gemsWord, manualGrantsLine } from "./payments-tabs";

/**
 * Окно «Компенсировать за сбой оплаты» (tasks/T-0438, Р209, WP53). Окно
 * создаётся под каждое открытие: предложение сервера читается заново, а
 * причина прежнего раза не остаётся в поле. Деньги видны до нажатия — на
 * кнопке «Начислить N самоцветов». Право `payments.compensate` и все правила
 * проверяет сервер; панель показывает кнопку, только если он прислал
 * `compensate` в действиях карточки.
 */
export function CompensationDialog({ purchaseId, onClose, onDone }: { purchaseId: string; onClose: () => void; onDone: () => void }) {
  const { state, reload } = useApi(() => fetchCompensationPreview(api, purchaseId), [purchaseId]);
  if (state.status === "ok" && state.data.blockedReason === null) return <Form preview={state.data} onClose={onClose} onDone={onDone} />;

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Компенсировать за сбой оплаты"
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      {state.status === "loading" ? <p className="text-sm text-text-muted">Считаем…</p> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" && state.data.blockedReason !== null ? <Notice tone="warning">{state.data.blockedReason}</Notice> : null}
    </Dialog>
  );
}

/** Форма начисления — после того, как предпросмотр прочитан и компенсация не заблокирована. */
function Form({ preview, onClose, onDone }: { preview: CompensationPreview; onClose: () => void; onDone: () => void }) {
  const { existing, maxGems, suggestedGems } = preview;
  // Записанная, но не начисленная компенсация доначисляется прежней суммой: сервер берёт сумму из неё.
  const locked = existing !== null && !existing.credited;
  const [gemsText, setGemsText] = useState(locked ? String(existing.gems) : suggestedGems === null ? "" : String(suggestedGems));
  const [note, setNote] = useState(locked ? existing.note : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const gems = gemsText.trim() === "" ? Number.NaN : Number(gemsText);
  // Недоначисленную строку потолок настроек не режет: она записана при прежнем потолке.
  const ceiling = locked ? Math.max(maxGems, existing.gems) : maxGems;
  const problem = compensationProblem(gems, ceiling, note);
  const sumProblem = gemsText.trim() === "" ? null : gemsProblem(gems, ceiling);
  const valid = Number.isInteger(gems) && gems >= 1;

  const submit = async () => {
    if (pending || problem !== null) return;
    setPending(true);
    setError(null);
    const result = await compensatePayment(api, preview.purchaseId, { gems, note: note.trim() });
    setPending(false);
    if (!result.ok) {
      // `409`: покупка изменилась или компенсация уже начислена — карточка перечитывается, текст остаётся в окне.
      if (result.error.status === 409) onDone();
      return setError(result.error);
    }
    toast.success("Компенсация начислена", { description: "Игрок получит сообщение в игре и в боте" });
    onClose();
    onDone();
  };

  const close = () => {
    if (!pending) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : close())}
      title="Компенсировать за сбой оплаты"
      description={`Оплата ${formatNumber(preview.chargedStars)} ⭐`}
      footer={
        <>
          <Button disabled={pending} onClick={close}>
            Отмена
          </Button>
          <Button tone="primary" disabled={problem !== null || pending} onClick={() => void submit()}>
            {pending ? "Начисляем…" : valid ? `Начислить ${formatNumber(gems)} ${gemsWord(gems)}` : "Начислить"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm">Самоцветы лягут на счёт игрока, он получит извинение в игре и в боте. За одну покупку — одна компенсация.</p>
        {preview.equivalentGems === null || suggestedGems === null ? null : (
          <p className="text-sm text-text-muted">
            Оплата {formatNumber(preview.chargedStars)} ⭐ · эквивалент {formatNumber(preview.equivalentGems)} {plural(preview.equivalentGems, ["самоцвет", "самоцвета", "самоцветов"])} · × {formatNumber(preview.multiplier)} — предлагаем {formatNumber(suggestedGems)}
          </p>
        )}
        {locked ? (
          <Notice tone="warning">
            Компенсация записана, но не начислилась: {formatNumber(existing.gems)} {gemsWord(existing.gems)}. Нажмите «Начислить» — начислится та же сумма
          </Notice>
        ) : null}
        {preview.recentManual.length === 0 ? null : (
          <Notice tone="warning">Игроку уже начисляли вручную за 30 дней: {manualGrantsLine(preview.recentManual)}. Проверьте, что это не компенсация за ту же покупку.</Notice>
        )}
        <Field label="Самоцветы" help={HELP.payments.compensation} hint={`От 1 до ${formatNumber(maxGems)} — потолок задаётся в «Настройках»`} error={sumProblem ?? undefined}>
          <Input type="number" inputMode="numeric" min={1} max={maxGems} step={1} value={gemsText} disabled={locked || pending} onChange={(event) => setGemsText(event.target.value)} />
        </Field>
        <Field label="Причина" hint={locked ? `Записана ${formatDateTime(existing.createdAt)}${existing.actorName === null ? "" : ` · ${existing.actorName}`}` : "Попадёт в журнал действий и в сообщение команде."}>
          <TextArea rows={3} maxLength={PURCHASE_NOTE_MAX} value={note} disabled={locked || pending} onChange={(event) => setNote(event.target.value)} />
        </Field>
        {error === null ? null : <Notice>{error.message}</Notice>}
      </div>
    </Dialog>
  );
}
