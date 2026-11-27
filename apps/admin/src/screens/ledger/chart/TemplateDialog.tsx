import { useState } from "react";
import { amountToForm, amountToText, createTemplate, MONTH_NAMES, NAME_MAX, NOTE_MAX, updateTemplate, type Article, type Place, type Template, type TemplateSchedule } from "../../../api/ledger-chart";
import { api } from "../../../services";
import { FormDialog, isDirty } from "../../../ui/form-dialog";
import { Button, Field, FieldRow, Input, Notice, Select } from "../../../ui/kit";
import { toastError } from "../../../ui/toast";

/** Шаблон расхода: статья, место (сумма — в его валюте), график — каждый месяц или раз в год в выбранном месяце. */
export function TemplateDialog({
  template,
  places,
  articles,
  onClose,
  onSaved,
}: {
  template: Template | null;
  places: readonly Place[];
  articles: readonly Article[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const expenseArticles = articles.filter((article) => article.kind === "expense" && !article.archived);
  const livePlaces = places.filter((place) => !place.archived);
  const initial = {
    name: template?.name ?? "",
    articleId: template?.articleId ?? expenseArticles[0]?.articleId ?? "",
    placeAccountId: template?.placeAccountId ?? livePlaces[0]?.accounts[0]?.accountId ?? "",
    amount: template === null ? "" : amountToForm(template.amount),
    schedule: (template?.schedule ?? "monthly") as TemplateSchedule,
    month: template?.month ?? 1,
    note: template?.note ?? "",
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const place = livePlaces.find((candidate) => candidate.accounts.some((account) => account.accountId === form.placeAccountId));

  const submit = async () => {
    const name = form.name.trim();
    if (name === "") return setFailure("Назовите шаблон");
    if (form.articleId === "" || form.placeAccountId === "") return setFailure("Нужны статья расхода и место хранения");
    const amount = amountToText(form.amount);
    if (amount === null || amount === "invalid" || Number(amount) <= 0) return setFailure("Сумма — положительное число");
    setSaving(true);
    setFailure(null);
    const body = {
      name,
      articleId: form.articleId,
      placeAccountId: form.placeAccountId,
      amount,
      schedule: form.schedule,
      month: form.schedule === "yearly" ? form.month : null,
      note: form.note.trim() === "" ? null : form.note.trim(),
    };
    const result = template === null ? await createTemplate(api, body) : await updateTemplate(api, template.templateId, body);
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
      title={template === null ? "Новый шаблон" : "Изменить шаблон"}
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
        <Field label="Название" hint="«VPS», «CDN»">
          <Input value={form.name} maxLength={NAME_MAX} autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <FieldRow>
          <Field label="Статья расхода">
            <Select value={form.articleId} onChange={(event) => setForm({ ...form, articleId: event.target.value })}>
              {expenseArticles.map((article) => (
                <option key={article.articleId} value={article.articleId}>
                  {article.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Место хранения">
            <Select value={form.placeAccountId} onChange={(event) => setForm({ ...form, placeAccountId: event.target.value })}>
              {livePlaces.flatMap((candidate) =>
                candidate.accounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.name}
                  </option>
                )),
              )}
            </Select>
          </Field>
        </FieldRow>
        <Field label={`Сумма${place === undefined ? "" : `, ${place.currency}`}`} hint="В валюте места; перед проведением сумму можно поправить по факту">
          <Input inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
        </Field>
        <FieldRow>
          <Field label="График">
            <Select value={form.schedule} onChange={(event) => setForm({ ...form, schedule: event.target.value === "yearly" ? "yearly" : "monthly" })}>
              <option value="monthly">Каждый месяц</option>
              <option value="yearly">Раз в год</option>
            </Select>
          </Field>
          {form.schedule === "yearly" ? (
            <Field label="Месяц">
              <Select value={String(form.month)} onChange={(event) => setForm({ ...form, month: Number(event.target.value) })}>
                {MONTH_NAMES.map((title, index) => (
                  <option key={title} value={index + 1}>
                    {title}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </FieldRow>
        <Field label="Заметка" hint="Необязательно">
          <Input value={form.note} maxLength={NOTE_MAX} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        </Field>
        {failure === null ? null : <Notice>{failure}</Notice>}
      </div>
    </FormDialog>
  );
}
