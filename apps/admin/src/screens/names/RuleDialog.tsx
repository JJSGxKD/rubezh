import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  CATEGORY_ORDER,
  CATEGORY_TITLES,
  KIND_HINTS,
  KIND_TITLES,
  RULE_KINDS,
  createRule,
  ruleBodyOf,
  ruleFormSchema,
  updateRule,
  type NameRule,
  type RuleCategory,
  type RuleForm,
  type RuleLimits,
} from "../../api/name-rules";
import { api } from "../../services";
import { ChoiceCards } from "../../ui/choice";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Button, Field, Input, Notice, Select } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { TryOutDialog } from "./TryOutDialog";

/**
 * Форма правила: что искать, как искать, в какой категории, заметка и
 * переключатель «действует». Отказ сервера по шаблону (400, 409) — под полем
 * «Что искать» дословно; нет связи — под формой, окно остаётся открытым.
 */
export function RuleDialog({ limits, rule, category, onClose, onSaved }: { limits: RuleLimits; rule: NameRule | null; category: RuleCategory; onClose: () => void; onSaved: () => void }) {
  const defaults: RuleForm = rule === null ? { category, kind: "exact", pattern: "", note: "", active: true } : { category: rule.category, kind: rule.kind, pattern: rule.pattern, note: rule.note ?? "", active: rule.active };
  const form = useForm<RuleForm>({ resolver: zodResolver(ruleFormSchema(limits)), defaultValues: defaults, mode: "onChange" });
  const { errors, isSubmitting, isValid } = form.formState;
  const [failure, setFailure] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);
  const kind = form.watch("kind");

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    const body = ruleBodyOf(values);
    const result = rule === null ? await createRule(api, body) : await updateRule(api, rule.ruleId, body);
    if (!result.ok) {
      if (result.error.kind === "rejected" || result.error.status === 409) form.setError("pattern", { type: "server", message: result.error.message });
      else setFailure(result.error.message);
      return;
    }
    toast.success(rule === null ? "Правило добавлено" : "Правило сохранено");
    onSaved();
  });

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={rule === null ? "Новое правило" : "Правило"}
        description="Правило начинает действовать у новых входов в течение секунд. Старые ники меняет перечистка."
        footer={
          <>
            <Button onClick={() => setTrying(true)} disabled={form.watch("pattern").trim() === ""} className="mr-auto">
              Проверить на примерах
            </Button>
            <Button onClick={onClose}>Отмена</Button>
            <Button tone="primary" type="submit" form="name-rule-form" disabled={isSubmitting || !isValid}>
              {isSubmitting ? "Сохраняем…" : "Сохранить"}
            </Button>
          </>
        }
      >
        <form id="name-rule-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Field label="Что искать" error={errors.pattern?.message}>
            <Input {...form.register("pattern")} autoComplete="off" maxLength={limits.patternMax * 2} />
          </Field>
          <ChoiceCards
            label="Как искать"
            value={kind}
            columns={3}
            onChange={(next) => form.setValue("kind", next, { shouldValidate: true, shouldDirty: true })}
            choices={RULE_KINDS.map((value) => ({ value, title: KIND_TITLES[value], description: KIND_HINTS[value] }))}
          />
          {kind === "regex" ? <Notice tone="info">{HELP.names.regex}</Notice> : null}
          <Field label="Категория" help={HELP.names.categories}>
            <Select {...form.register("category")}>
              {CATEGORY_ORDER.map((item) => (
                <option key={item} value={item}>
                  {CATEGORY_TITLES[item]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Заметка" hint="Необязательно: зачем правило, для себя и коллег" error={errors.note?.message}>
            <Input {...form.register("note")} autoComplete="off" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...form.register("active")} />
            Действует
          </label>
          {failure === null ? null : <Notice>{failure}</Notice>}
        </form>
      </Dialog>
      {trying ? (
        <TryOutDialog
          limits={limits}
          candidate={{ ...(rule === null ? {} : { ruleId: rule.ruleId }), category: form.getValues("category"), kind: form.getValues("kind"), pattern: form.getValues("pattern").trim() }}
          onClose={() => setTrying(false)}
        />
      ) : null}
    </>
  );
}
