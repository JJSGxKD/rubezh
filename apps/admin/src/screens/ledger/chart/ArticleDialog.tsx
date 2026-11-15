import { useState } from "react";
import { createArticle, NAME_MAX, renameArticle, type Article } from "../../../api/ledger-chart";
import { api } from "../../../services";
import { FormDialog, isDirty } from "../../../ui/form-dialog";
import { Button, Field, Input, Notice, Select } from "../../../ui/kit";
import { toastError } from "../../../ui/toast";

/** Статья: название и вид (вид задаётся при заведении, переименование его не трогает). */
export function ArticleDialog({ article, onClose, onSaved }: { article: Article | null; onClose: () => void; onSaved: () => void }) {
  const initial = { name: article?.name ?? "", kind: article?.kind ?? "expense" };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    const name = form.name.trim();
    if (name === "") return setFailure("Назовите статью");
    setSaving(true);
    setFailure(null);
    const result = article === null ? await createArticle(api, { name, kind: form.kind }) : await renameArticle(api, article.articleId, name);
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
      title={article === null ? "Новая статья" : "Переименовать статью"}
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
        <Field label="Название" hint="«Сервер», «CDN», «ИИ-инструменты»">
          <Input value={form.name} maxLength={NAME_MAX} autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        {article !== null ? null : (
          <Field label="Вид">
            <Select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value === "income" ? "income" : "expense" })}>
              <option value="expense">Расход</option>
              <option value="income">Поступление</option>
            </Select>
          </Field>
        )}
        {failure === null ? null : <Notice>{failure}</Notice>}
      </div>
    </FormDialog>
  );
}
