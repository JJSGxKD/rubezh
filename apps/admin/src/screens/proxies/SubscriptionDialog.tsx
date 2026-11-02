import { useState, type FormEvent } from "react";
import { EMPTY_SUBSCRIPTION_FORM, saveSubscription, type SubscriptionInfo, type SubscriptionOverview } from "../../api/proxy-subscription";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { Button, Field, Input, Notice } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { countriesProblem, subscriptionUrlProblem } from "./subscription-view";

/**
 * Окно подписки Xray: подключение и правка. Адрес живёт только в состоянии окна:
 * закрыли — пропал, назад сервер его не отдаёт. При правке пустое поле оставляет
 * прежний адрес (docs/35-stage4-plan.md Р101).
 */
export function SubscriptionDialog({
  existing,
  onClose,
  onSaved,
}: {
  /** правка этой подписки; `null` — новая */
  existing: SubscriptionInfo | null;
  onClose: () => void;
  onSaved: (overview: SubscriptionOverview, created: boolean) => void;
}) {
  const [form, setForm] = useState(existing === null ? EMPTY_SUBSCRIPTION_FORM : { name: existing.name, url: "", countries: existing.countries.join(", "), enabled: existing.enabled });
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const nameProblem = form.name.trim() === "" ? "Укажите название" : form.name.trim().length > 60 ? "Название — не длиннее 60 знаков" : null;
  const problem = nameProblem ?? subscriptionUrlProblem(form.url, { keep: existing !== null }) ?? countriesProblem(form.countries);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem !== null || saving) return;
    setSaving(true);
    const result = await saveSubscription(api, form);
    setSaving(false);
    if (!result.ok) return void toast.error(result.error.message);
    onSaved(result.data, existing === null);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={existing === null ? "Подключить подписку Xray" : `Подписка «${existing.name}»`}
      description={existing === null ? "Адрес с множеством подключений: узлы станут прокси для запросов сервера" : `Адрес сейчас: ${existing.urlHint}`}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="primary" type="submit" form="subscription-form" disabled={saving}>
            {saving ? "Сохраняю…" : "Сохранить"}
          </Button>
        </>
      }
    >
      <form id="subscription-form" className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} autoComplete="off" noValidate>
        {touched && problem !== null ? <Notice tone="danger">{problem}</Notice> : null}
        <Field label="Название">
          <Input value={form.name} onChange={(event) => set({ name: event.target.value })} maxLength={60} placeholder="Основная подписка" autoFocus />
        </Field>
        <Field label="Адрес подписки" hint={existing === null ? "Адрес секретный: после сохранения он не показывается" : "Пусто — адрес останется прежним. Новый адрес заменит узлы целиком"}>
          <Input type="password" value={form.url} onChange={(event) => set({ url: event.target.value })} placeholder={existing === null ? "https://" : "••••••••"} autoComplete="new-password" spellCheck={false} className="font-mono" />
        </Field>
        <Field label="Страны узлов" hint="Коды стран через запятую, например DE, NL. Пусто — любые">
          <Input value={form.countries} onChange={(event) => set({ countries: event.target.value.toUpperCase() })} placeholder="DE, NL" spellCheck={false} className="font-mono uppercase" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
          Включена
        </label>
      </form>
    </Dialog>
  );
}
