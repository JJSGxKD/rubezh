import { useState, type FormEvent } from "react";
import { useSession } from "../state/use-session";
import { Button, Field, Input, Notice } from "../ui/kit";

/**
 * Вход разработчика — единственный вход, пока у панели нет домена: виджет
 * Telegram требует адреса, который вписан в BotFather (docs/35-stage4-plan.md,
 * WP17). Сервер принимает его только при `AUTH_DEV_LOGIN`.
 */
export function Login() {
  const view = useSession((state) => state.view);
  const loginDev = useSession((state) => state.loginDev);
  const [devUser, setDevUser] = useState("dev-1:Разработчик");

  if (view.status !== "anonymous") return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (devUser.trim() !== "") void loginDev(devUser);
  };

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-md border border-border bg-surface p-6">
        <h1 className="text-xl">Рубеж — панель</h1>
        {view.notice === null ? null : <Notice tone="info">{view.notice}</Notice>}
        <Field label="Вход разработчика" hint="Формат dev-<id>:Имя. Работает только при AUTH_DEV_LOGIN на сервере; в разработке такой аккаунт — владелец.">
          <Input value={devUser} onChange={(event) => setDevUser(event.target.value)} autoFocus maxLength={128} />
        </Field>
        {view.loginError === null ? null : <Notice>{view.loginError.message}</Notice>}
        <Button tone="primary" type="submit" disabled={view.pending}>
          {view.pending ? "Входим…" : "Войти"}
        </Button>
        <p className="text-xs text-text-disabled">Вход через Telegram появится вместе с доменом панели.</p>
      </form>
    </main>
  );
}
