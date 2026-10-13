import { useEffect, useState, type FormEvent } from "react";
import { useSession } from "../state/use-session";
import { QrCode } from "../ui/qr-code";
import { Button, Field, Input, Notice } from "../ui/kit";

/** Сторона QR на экране; заглушка при открытии запроса — того же размера, чтобы экран не прыгал. */
const QR_SIZE = 200;

/**
 * Вход в панель (docs/29-admin-panel.md §8): подтверждением в боте — на
 * проде это единственный путь. Запрос открывается вместе со страницей: QR и
 * кнопка ведут диплинком сразу в приложение Telegram, запасная ссылка — на
 * t.me в браузере. Бот показывает такой же код, устройство и место: по ним
 * видно подмену, когда чужой QR показывают чужому человеку. Вход
 * разработчика — только в сборке для разработки: на проде сервер его всё
 * равно не примет.
 */
export function Login() {
  const view = useSession((state) => state.view);
  const startBotLogin = useSession((state) => state.startBotLogin);
  const loginBot = useSession((state) => state.loginBot);
  const anonymous = view.status === "anonymous";

  // Один раз за показ страницы: повторный вызов у стора ничего не открывает.
  useEffect(() => {
    if (anonymous) void startBotLogin();
  }, [anonymous, startBotLogin]);

  if (view.status !== "anonymous") return null;
  const { bot } = view;

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-md border border-border bg-surface p-6">
        <h1 className="text-xl">Вход в панель</h1>
        {view.notice === null ? null : <Notice tone="info">{view.notice}</Notice>}

        {bot.status === "waiting" ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <QrCode value={bot.deepLink ?? bot.link} size={QR_SIZE} label="QR для входа через Telegram" />
            <p className="text-sm text-text-muted">Отсканируйте телефоном с Telegram или нажмите кнопку — бот покажет такой же код</p>
            <p className="font-mono text-4xl tracking-widest" aria-label={`Код ${bot.code}`}>
              {bot.code}
            </p>
            <a
              href={bot.deepLink ?? bot.link}
              className="inline-flex w-full items-center justify-center rounded-sm bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-pressed"
            >
              Открыть Telegram
            </a>
            <a href={bot.link} target="_blank" rel="noopener noreferrer" className="text-xs text-text-muted underline hover:text-text">
              Telegram не установлен на этом устройстве? Открыть в браузере
            </a>
            <p className="text-xs text-text-muted">Сверьте код в боте и нажмите «Войти» — панель откроется сама.</p>
          </div>
        ) : bot.status === "failed" ? (
          <div className="flex flex-col gap-3">
            <Notice>{bot.message}</Notice>
            <Button tone="primary" onClick={() => void loginBot()}>
              Начать заново
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3" role="status">
            <div className="rounded-md bg-surface-sunken" style={{ width: QR_SIZE, height: QR_SIZE }} aria-hidden="true" />
            <p className="text-sm text-text-muted">Открываем вход…</p>
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
