import { useState, type FormEvent } from "react";
import { useSession } from "../state/use-session";
import { Button, Field, Input, Notice } from "../ui/kit";

/**
 * Вход в панель (docs/29-admin-panel.md §8): подтверждением в боте — на
 * проде это единственный путь. Панель показывает код и ссылку на бота, бот —
 * тот же код и кнопку «Войти». Вход разработчика — только в сборке для
 * разработки: на проде сервер его всё равно не примет.
 */
export function Login() {
  const view = useSession((state) => state.view);
  const loginBot = useSession((state) => state.loginBot);
  const cancelBot = useSession((state) => state.cancelBot);

  if (view.status !== "anonymous") return null;
  const { bot } = view;

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-md border border-border bg-surface p-6">
        <h1 className="text-xl">Рубеж — панель</h1>
        {view.notice === null ? null : <Notice tone="info">{view.notice}</Notice>}

        {bot.status === "waiting" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">Код на экране — бот покажет такой же:</p>
            <p className="text-center font-mono text-4xl tracking-widest" aria-label={`Код ${bot.code}`}>
              {bot.code}
            </p>
            <a
              href={bot.link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-sm bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-pressed"
            >
              Открыть бота
            </a>
            <p className="text-xs text-text-muted">Сверьте код в боте и нажмите «Войти» — панель откроется сама. Ждём подтверждения…</p>
            <Button onClick={cancelBot}>Отмена</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {bot.status === "failed" ? <Notice>{bot.message}</Notice> : null}
            <Button tone="primary" disabled={bot.status === "opening"} onClick={() => void loginBot()}>
              {bot.status === "opening" ? "Открываем вход…" : "Войти через Telegram"}
            </Button>
            <p className="text-xs text-text-muted">Вход подтверждается в боте игры: нужен аккаунт с ролью в панели.</p>
          </div>
        )}

        {import.meta.env.DEV ? <DevLogin /> : null}
      </div>
    </main>
  );
}

/** Вход разработчика по имени `dev-<id>:Имя` — сервер пускает его только при `AUTH_DEV_LOGIN`. */
function DevLogin() {
  const view = useSession((state) => state.view);
  const loginDev = useSession((state) => state.loginDev);
  const [devUser, setDevUser] = useState("dev-1:Разработчик");
  if (view.status !== "anonymous") return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (devUser.trim() !== "") void loginDev(devUser);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-border pt-4">
      <Field label="Вход разработчика" hint="Формат dev-<id>:Имя. Работает только при AUTH_DEV_LOGIN на сервере; в разработке такой аккаунт — владелец.">
        <Input value={devUser} onChange={(event) => setDevUser(event.target.value)} maxLength={128} />
      </Field>
      {view.loginError === null ? null : <Notice>{view.loginError.message}</Notice>}
      <Button type="submit" disabled={view.pending}>
        {view.pending ? "Входим…" : "Войти как разработчик"}
      </Button>
    </form>
  );
}
