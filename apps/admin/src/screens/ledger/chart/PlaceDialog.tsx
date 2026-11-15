import { useState } from "react";
import { createPlace, feeToForm, feeToInput, NAME_MAX, PLACE_CURRENCIES, updatePlace, type Place } from "../../../api/ledger-chart";
import { api } from "../../../services";
import { FormDialog, isDirty } from "../../../ui/form-dialog";
import { Button, Field, FieldRow, Input, Notice, Select } from "../../../ui/kit";
import { toastError } from "../../../ui/toast";

/**
 * Место хранения: название, валюта (при заведении; потом не меняется — под неё открыт счёт) и шаблон комиссии:
 * процент, фикса и её валюта. Обе половины пусты — комиссии нет.
 */
export function PlaceDialog({ place, onClose, onSaved }: { place: Place | null; onClose: () => void; onSaved: () => void }) {
  const initial = { name: place?.name ?? "", currency: place?.currency ?? "RUB", ...feeToForm(place?.fee ?? null, place?.currency ?? "RUB") };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    const name = form.name.trim();
    if (name === "") return setFailure("Назовите место");
    const fee = feeToInput(form);
    if (!fee.ok) return setFailure(fee.problem);
    setSaving(true);
    setFailure(null);
    const result =
      place === null
        ? await createPlace(api, { name, currency: form.currency, ...(fee.fee === null ? {} : { fee: fee.fee }) })
        : await updatePlace(api, place.placeId, { name, fee: fee.fee });
    setSaving(false);
    if (!result.ok) {
      if (result.error.kind === "rejected") setFailure(result.error.message);
      else toastError(result.error);
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <FormDialog
      open
      title={place === null ? "Новое место хранения" : "Изменить место"}
      dirty={isDirty(initial, form)}
      onClose={onClose}
      footer={(requestClose) => (
        <>
          <Button onClick={requestClose}>Отмена</Button>
          <Button tone="primary" disabled={saving} onClick={() => void submit()}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Field label="Название" hint="«Карта Т-Банка», «Кошелёк TON»">
          <Input value={form.name} maxLength={NAME_MAX} autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Валюта" {...(place === null ? {} : { hint: "Валюта места не меняется" })}>
          <Select
            value={form.currency}
            disabled={place !== null}
            onChange={(event) => setForm({ ...form, currency: event.target.value, fixedCurrency: place === null ? event.target.value : form.fixedCurrency })}
          >
            {PLACE_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </Field>
        <FieldRow>
          <Field label="Комиссия, %" hint="Например 2 или 2,5; пусто — без процента">
            <Input inputMode="decimal" value={form.percent} onChange={(event) => setForm({ ...form, percent: event.target.value })} />
          </Field>
          <Field label="Фикса" hint="Пусто — без фиксы">
            <Input inputMode="decimal" value={form.fixed} onChange={(event) => setForm({ ...form, fixed: event.target.value })} />
          </Field>
          <Field label="Валюта фиксы">
            <Select value={form.fixedCurrency} onChange={(event) => setForm({ ...form, fixedCurrency: event.target.value })}>
              {PLACE_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
        </FieldRow>
        {failure === null ? null : <Notice>{failure}</Notice>}
      </div>
    </FormDialog>
  );
}
