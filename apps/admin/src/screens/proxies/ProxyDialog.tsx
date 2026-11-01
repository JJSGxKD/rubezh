import { useState, type FormEvent } from "react";
import { EMPTY_FORM, PROXY_SCHEMES, createProxy, formOf, proxyAddress, proxyProblem, updateProxy, type ProxyForm, type ProxyRow } from "../../api/proxies";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Button, Field, Input, Notice, Select } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * Окно прокси: добавление и правка. Пароль живёт только в состоянии окна:
 * закрыли — пропал. При правке пустое поле оставляет прежний пароль, удалить
 * его можно только явной отметкой (docs/35-stage4-plan.md Р91).
 */
export function ProxyDialog({
  existing,
  storageEnabled,
  onClose,
  onSaved,
}: {
  /** правка этого прокси; `null` — новый */
  existing: ProxyRow | null;
  /** есть ключ шифрования: пароль можно сохранить */
  storageEnabled: boolean;
  onClose: () => void;
  onSaved: (saved: ProxyRow, created: boolean) => void;
}) {
  const [form, setForm] = useState<ProxyForm>(existing === null ? EMPTY_FORM : formOf(existing));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<ProxyForm>) => setForm((current) => ({ ...current, ...patch }));
  const problem = proxyProblem(form, existing === null ? undefined : { passwordSet: existing.passwordSet });
  const passwordLocked = !storageEnabled && existing?.passwordSet !== true;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem !== null || saving) return;
    setSaving(true);
    const result = existing === null ? await createProxy(api, form) : await updateProxy(api, existing.proxyId, form);
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
      title={existing === null ? "Добавить прокси" : `Прокси «${existing.name}»`}
      description={existing === null ? "Через него сервер пойдёт к внешним API, если напрямую не вышло" : proxyAddress(existing)}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="primary" type="submit" form="proxy-form" disabled={saving}>
            {saving ? "Сохраняю…" : "Сохранить"}
          </Button>
        </>
      }
    >
      <form id="proxy-form" className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} autoComplete="off" noValidate>
        {touched && problem !== null ? <Notice tone="danger">{problem}</Notice> : null}
        <Field label="Название">
          <Input value={form.name} onChange={(event) => set({ name: event.target.value })} maxLength={60} placeholder="Туннель в Нидерланды" autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr_7rem]">
          <Field label="Схема">
            <Select value={form.scheme} onChange={(event) => set({ scheme: event.target.value as ProxyForm["scheme"] })}>
              {PROXY_SCHEMES.map((scheme) => (
                <option key={scheme} value={scheme}>
                  {scheme}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Адрес" hint="Домен, имя сервиса в сети контейнеров или IP — без схемы и порта">
            <Input value={form.host} onChange={(event) => set({ host: event.target.value })} placeholder="proxy.example.com" spellCheck={false} className="font-mono" />
          </Field>
          <Field label="Порт">
            <Input value={form.port} onChange={(event) => set({ port: event.target.value })} inputMode="numeric" placeholder="3128" className="font-mono" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Логин" hint="Необязательно">
            <Input value={form.username} onChange={(event) => set({ username: event.target.value })} maxLength={128} autoComplete="off" spellCheck={false} />
          </Field>
          <Field
            label="Пароль"
            help={HELP.proxies.password}
            hint={passwordLocked ? "Ключа шифрования на сервере нет — пароль сохранить нельзя" : existing?.passwordSet === true ? "Пусто — пароль останется прежним" : undefined}
          >
            <Input
              type="password"
              value={form.password}
              onChange={(event) => set({ password: event.target.value })}
              placeholder={existing?.passwordSet === true ? "••••••••" : ""}
              autoComplete="new-password"
              disabled={passwordLocked || form.clearPassword === true}
              maxLength={256}
            />
          </Field>
        </div>
        {existing?.passwordSet === true ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.clearPassword === true} onChange={(event) => set({ clearPassword: event.target.checked, password: "" })} />
            Удалить пароль
          </label>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Страна" help={HELP.proxies.country} hint="Две латинские буквы, например NL">
            <Input value={form.country} onChange={(event) => set({ country: event.target.value.toUpperCase() })} maxLength={2} placeholder="NL" spellCheck={false} className="font-mono uppercase" />
          </Field>
          <Field label="Порядок" help={HELP.proxies.priority} hint={existing === null ? "Пусто — в конец списка" : undefined}>
            <Input value={form.priority ?? ""} onChange={(event) => set({ priority: event.target.value })} inputMode="numeric" placeholder="10" className="font-mono" />
          </Field>
        </div>
        <Field label="Заметка" hint="Необязательно: зачем этот прокси и кому принадлежит">
          <Input value={form.note} onChange={(event) => set({ note: event.target.value })} maxLength={200} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
          Включён
        </label>
      </form>
    </Dialog>
  );
}
