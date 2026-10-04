/**
 * Предпросмотр для панели (docs/35-stage4-plan.md WP32, Р83): панель
 * встраивает страницу клиента `preview/` и шлёт ей черновик, и обе стороны
 * должны знать адрес друг друга — для политики источников и для того, чьи
 * сообщения принимать.
 *
 * Адреса задаёт окружение: `VITE_ADMIN_URL` — адрес панели для клиента,
 * `VITE_PREVIEW_URL` — адрес страницы предпросмотра для панели. На
 * dev-сервере без них — петля с портами из карты (docs/20-env-and-ports.md
 * §2): предпросмотр работает из коробки. В сборке без адреса предпросмотра
 * нет: угадывать боевой домен нельзя.
 */

type Env = Record<string, string | undefined>;

/** Источник из адреса; битый адрес — `null`, а не исключение: лучше без предпросмотра, чем без сборки. */
export function originOf(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || !URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
}

/** С каких адресов панели клиент принимает черновик и кому разрешает встроить себя во фрейм. */
export function adminOrigins(env: Env, dev: boolean): string[] {
  const configured = originOf(env.VITE_ADMIN_URL ?? "");
  if (configured !== null) return [configured];
  if (!dev) return [];
  const port = Number(env.ADMIN_PORT ?? 5176);
  // Панель на dev-сервере слушает петлю (apps/admin/vite.config.ts), а открывают её и по имени.
  return [`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`];
}

/** Где панель берёт страницу предпросмотра. */
export function previewUrl(env: Env, dev: boolean): string {
  const configured = (env.VITE_PREVIEW_URL ?? "").trim();
  if (originOf(configured) !== null) return configured;
  if (!dev) return "";
  const port = Number(env.WEB_TELEGRAM_PORT ?? 5173);
  // С сертификатом dev-сервер клиента — по https (scripts/vite/dev-server.ts).
  const scheme = (env.DEV_HTTPS_CERT ?? "").trim() === "" ? "http" : "https";
  return `${scheme}://127.0.0.1:${String(port)}/preview/`;
}
