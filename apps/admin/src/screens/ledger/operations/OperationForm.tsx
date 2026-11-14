import { useEffect, useMemo, useState } from "react";
import { KIND_LABELS, saveOperation, submitOperation, type OperationKind, type OperationView } from "../../../api/ledger-operations";
import { api } from "../../../services";
import { Button, Notice } from "../../../ui/kit";
import { FormDialog, isDirty } from "../../../ui/form-dialog";
import { toast } from "../../../ui/toast";
import { emptyForm, formFromInput, inputFromForm, suggestFee, type FormState } from "./form-model";
import { OperationFields } from "./OperationFields";
import { Lines } from "./OperationCard";
import { approvalOutlook, previewOf, receiptWarning, reversalPreview, type Chart, type PreviewLine } from "./preview";

/**
 * Окно операции (tasks/T-0464, Р220, Р221): поля вида, предпросмотр проводки, подпись «Проведётся сразу / Ждёт
 * подтверждения владельца» и предупреждение о чеке НПД. «Сохранить черновик» только записывает, «Провести» ещё и
 * отправляет: сервер сам решает, провести сразу или поставить к владельцу. Ошибки сервера — под формой его же текстом.
 */
export interface FormTarget {
  /** вид новой операции; у правки и исправления — из них */
  kind: OperationKind;
  /** правка черновика */
  editing?: OperationView;
  /** исправляемая проведённая операция */
  fixing?: OperationView;
}

function initialForm(target: FormTarget): FormState {
  if (target.editing !== undefined) return formFromInput(target.editing.input);
  const today = new Date().toISOString().slice(0, 10);
  if (target.fixing?.entry != null) return { ...emptyForm("reversal", today), sourceKey: target.fixing.entry.sourceKey };
  return emptyForm(target.kind, today);
}

export function OperationForm({
  target,
  chart,
  canApprove,
  thresholdUsd,
  onClose,
  onDone,
}: {
  target: FormTarget;
  chart: Chart;
  canApprove: boolean;
  /** порог подтверждения в долларах, если панель его знает */
  thresholdUsd: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const initial = useMemo(() => initialForm(target), [target]);
  const [form, setForm] = useState<FormState>(initial);
  const [draftId, setDraftId] = useState<string | null>(target.editing?.operationId ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Комиссию по шаблону места подставляем, пока человек её не правил: смена места или суммы пересчитывает подсказку.
  useEffect(() => {
    if (form.feeEdited || (form.kind !== "transfer" && form.kind !== "exchange")) return;
    const next = suggestFee(form, chart);
    if (next.feePercent !== form.feePercent || next.fixedAmount !== form.fixedAmount || next.fixedCurrency !== form.fixedCurrency) setForm((current) => ({ ...current, ...next }));
  }, [form, chart]);

  const built = useMemo(() => inputFromForm(form, chart), [form, chart]);
  const preview = useMemo(() => (built.ok ? previewOf(built.input, chart) : null), [built, chart]);
  const lines: readonly PreviewLine[] = form.kind === "reversal" ? reversalPreview(target.fixing?.entry?.lines ?? []) : preview?.ok === true ? preview.lines : [];
  const problems = !built.ok ? [built.problem] : preview !== null && !preview.ok ? preview.problems : [];
  const ready = built.ok && problems.length === 0;
  const warning = built.ok ? receiptWarning(built.input, chart) : null;
  const outlook = approvalOutlook({ kind: form.kind, amountUsd: undefined, canApprove, thresholdUsd });

  const run = async (andSubmit: boolean): Promise<void> => {
    if (!built.ok) return;
    setPending(true);
    setError(null);
    const saved = await saveOperation(api, built.input, draftId);
    if (!saved.ok) {
      setPending(false);
      return setError(saved.error.message);
    }
    setDraftId(saved.data.operationId);
    if (!andSubmit) {
      setPending(false);
      toast.success("Черновик сохранён");
      return onDone();
    }
    const sent = await submitOperation(api, saved.data.operationId);
    setPending(false);
    if (!sent.ok) return setError(`Черновик сохранён, но не проведён: ${sent.error.message}`);
    toast.success(sent.data.status === "pending" ? "Операция ждёт подтверждения владельца" : "Операция проведена");
    onDone();
  };

  const title = target.editing !== undefined ? `Черновик: ${KIND_LABELS[form.kind].toLowerCase()}` : form.kind === "reversal" ? "Исправление операции" : KIND_LABELS[form.kind];
  const blocked = pending ? null : ready ? null : "Заполните форму: подробности — в предпросмотре";
  return (
    <FormDialog
      open
      wide
      title={title}
      dirty={isDirty(initial, form)}
      onClose={onClose}
      footer={(requestClose) => (
        <>
          <Button onClick={requestClose} disabled={pending}>
            Отмена
          </Button>
          <Button disabled={!ready || pending} onClick={() => void run(false)}>
            Сохранить черновик
          </Button>
          <Button tone="primary" disabled={!ready || pending} blockedBy={blocked} onClick={() => void run(true)}>
            {pending ? "Отправляем…" : "Провести"}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <OperationFields form={form} chart={chart} set={(patch) => setForm((current) => ({ ...current, ...patch }))} />
        <section aria-label="Предпросмотр проводки" className="flex flex-col gap-2 rounded-sm bg-surface-sunken px-3 py-2">
          <h3 className="text-xs text-text-muted">Проводка, которую создаст сервер</h3>
          {lines.length > 0 ? <Lines lines={lines} /> : <p className="text-sm text-text-muted">Появится, когда форма будет заполнена</p>}
          {problems.length === 0 ? null : (
            <ul className="list-disc pl-5 text-xs text-text-muted">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <p className={`text-sm font-medium ${outlook.verdict === "pending" ? "text-warning" : outlook.verdict === "immediate" ? "text-success" : "text-text-muted"}`}>{outlook.text}</p>
        </section>
        {warning === null ? null : <Notice tone="warning">{warning}</Notice>}
        {error === null ? null : <Notice>{error}</Notice>}
      </div>
    </FormDialog>
  );
}
