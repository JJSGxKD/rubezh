import { useState } from "react";
import { CABINET_LIMITS, codeProblem, copyCabinetPromo, type CabinetPromo } from "../../api/cabinet";
import { rewardText } from "../../api/promo-codes";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { FormDialog } from "../../ui/form-dialog";
import { HELP } from "../../ui/help";
import { Button, Field, Input, KeyValue, Notice } from "../../ui/kit";
import { toast, toastError } from "../../ui/toast";

/**
 * Копия промокода с новым словом. Награда, лимит и срок — как у исходного кода, и здесь они только показаны:
 * поменять их может команда. Занятое слово сервер отвечает словами, окно остаётся открытым.
 */
export function CopyPromoDialog({ source, onClose, onCopied }: { source: CabinetPromo; onClose: () => void; onCopied: () => void }) {
  const [code, setCode] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problem = codeProblem(code);

  const submit = async () => {
    setTouched(true);
    if (problem !== null) return;
    setSaving(true);
    setFailure(null);
    const result = await copyCabinetPromo(api, source.campaignId, code);
    setSaving(false);
    if (!result.ok) {
      if (result.error.kind === "rejected") setFailure(result.error.message);
      else toastError(result.error);
      return;
    }
    toast.success(`Код ${result.data.code} готов — игроки вводят его в меню игры`);
    onCopied();
    onClose();
  };

  return (
    <FormDialog
      open
      title="Копия промокода"
      dirty={code.trim() !== ""}
      onClose={onClose}
      footer={(requestClose) => (
        <>
          <Button onClick={requestClose}>Отмена</Button>
          <Button tone="primary" disabled={saving} onClick={() => void submit()}>
            {saving ? "Создаём…" : "Сделать копию"}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Field label="Новое кодовое слово" help={HELP.cabinet.copyWord} hint="Буквы и цифры; регистр, пробелы и дефисы не важны. Слово нельзя поменять после создания — его уже назовут в посте" error={touched && problem !== null ? problem : undefined}>
          <Input value={code} maxLength={CABINET_LIMITS.codeMax} onChange={(event) => setCode(event.target.value)} placeholder="Например, STREAM 12" autoFocus />
        </Field>
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-xs text-text-muted">
            Как у исходного кода
            <span className="font-mono">{source.code}</span>
          </p>
          <KeyValue
            items={[
              ["Награда", rewardText(source.reward), HELP.cabinet.copySame],
              ["Лимит погашений", source.maxRedemptions === null ? "без лимита" : formatNumber(source.maxRedemptions)],
              ["Срок", source.endsAt === null ? "бессрочно" : `до ${formatDateTime(source.endsAt)}`],
            ]}
          />
        </div>
        {failure === null ? null : <Notice>{failure}</Notice>}
      </div>
    </FormDialog>
  );
}
