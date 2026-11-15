import { useState } from "react";
import { api } from "../../services";
import { consequenceText, monthOptions, setShare, shareProblem, type Participant, type StakeholdersView } from "../../api/stakeholders";
import { formatNumber } from "../../format";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Field, Input, Select } from "../../ui/kit";

/** Число из поля: запятая или точка; пустое и мусор — `NaN`, окно скажет, что доля не годится. */
function parsePercent(text: string): number {
  const normalized = text.trim().replace(",", ".");
  return normalized === "" ? Number.NaN : Number(normalized);
}

/**
 * Окно «Изменить долю» (tasks/T-0454): расчёт остатка владельцу виден до отправки, сумма больше 100 %
 * блокирует кнопку, ошибка сервера остаётся под формой, окно не закрывается.
 */
export function ShareDialog({ view, participant, onClose, onSaved }: { view: StakeholdersView; participant: Participant; onClose: () => void; onSaved: (next: StakeholdersView) => void }) {
  const months = monthOptions(view.month);
  const [text, setText] = useState(participant.current === null ? "" : String(participant.current.sharePercent));
  const [month, setMonth] = useState(view.month);
  const percent = parsePercent(text);
  const check = shareProblem(view, participant.accountId, percent, month);
  const valid = check.problem === null;

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Доля: ${participant.name}`}
      subject={participant.current === null ? "Сейчас доли нет" : `Сейчас ${formatNumber(participant.current.sharePercent)} %`}
      problem={check.problem}
      changes={valid ? [{ label: "Владельцу останется", value: `${formatNumber(check.ownerLeft)} %` }] : []}
      reason={{ min: 3, max: 500, hint: "Попадёт в историю и аудит. Участник причину не видит." }}
      action="Изменить долю"
      onConfirm={async (note) => {
        const result = await setShare(api, participant.accountId, { sharePercent: percent, fromMonth: month, note });
        if (!result.ok) return { ok: false, error: result.error.message };
        onSaved(result.data);
        return { ok: true };
      }}
    >
      <div className="flex flex-col gap-3">
        <Field label="Доля, %">
          <Input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} placeholder="25" className="w-32" />
        </Field>
        <Field label="С месяца">
          <Select value={month} onChange={(event) => setMonth(event.target.value)}>
            {months.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {valid ? <p className="text-sm">{consequenceText(participant.name, percent, month)}</p> : null}
      </div>
    </ConfirmDialog>
  );
}
