import { useState } from "react";
import { CABINET_LIMITS, LINK_SOURCES, SOURCE_TITLES, createCabinetLink, emptyLinkForm, linkFormProblems, type CabinetLink, type LinkSource } from "../../api/cabinet";
import { api } from "../../services";
import { FormDialog, isDirty } from "../../ui/form-dialog";
import { HELP } from "../../ui/help";
import { Button, Field, Input, Notice, Select } from "../../ui/kit";
import { toastError } from "../../ui/toast";

/**
 * Новая ссылка партнёра: название, источник списком и заметка. Остальное — цель, сеть, постбэк — не его выбор:
 * ссылка ведёт в Mini App. Ошибки сервера (потолок кабинета, незнакомый знак) показываются под формой словами.
 */
export function NewLinkDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (link: CabinetLink) => void }) {
  const [form, setForm] = useState(emptyLinkForm());
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problems = linkFormProblems(form);
  const valid = problems.campaign === undefined && problems.note === undefined;

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    setFailure(null);
    const result = await createCabinetLink(api, form);
    setSaving(false);
    if (!result.ok) {
      // Отказ по существу (потолок, знаки) остаётся в окне; сбой сети — тостом с подробностями.
      if (result.error.kind === "rejected") setFailure(result.error.message);
      else toastError(result.error);
      return;
    }
    onCreated(result.data);
    onClose();
  };

  return (
    <FormDialog
      open
      title="Новая ссылка"
      dirty={isDirty(emptyLinkForm(), form)}
      onClose={onClose}
      footer={(requestClose) => (
        <>
          <Button onClick={requestClose}>Отмена</Button>
          <Button tone="primary" disabled={saving} onClick={() => void submit()}>
            {saving ? "Создаём…" : "Создать ссылку"}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Field label="Название" help={HELP.cabinet.linkName} hint="Для вас: «Мой канал», «Стрим 12 октября»" error={touched ? problems.campaign : undefined}>
          <Input value={form.campaign} maxLength={CABINET_LIMITS.nameMax} onChange={(event) => setForm({ ...form, campaign: event.target.value })} placeholder="Мой канал" autoFocus />
        </Field>
        <Field label="Что это" help={HELP.cabinet.linkSource}>
          <Select
            value={form.source}
            onChange={(event) => {
              const next = LINK_SOURCES.find((known) => known === event.target.value);
              if (next !== undefined) setForm({ ...form, source: next as LinkSource });
            }}
          >
            {LINK_SOURCES.map((known) => (
              <option key={known} value={known}>
                {SOURCE_TITLES[known]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Заметка — ${String(form.note.trim().length)} из ${String(CABINET_LIMITS.noteMax)}`} hint="Необязательно: название канала или поста" error={touched ? problems.note : undefined}>
          <Input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="Игровой угол" />
        </Field>
        {failure === null ? null : <Notice>{failure}</Notice>}
      </div>
    </FormDialog>
  );
}
