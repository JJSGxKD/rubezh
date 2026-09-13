import type { Plugin } from "vite";

/**
 * Dev-сервер без перезагрузок страницы на обрыве связи.
 *
 * Клиент Vite, потеряв websocket, ждёт, пока сервер снова ответит, и
 * безусловно перезагружает страницу. Связь рвётся не только при перезапуске
 * сервера: через туннель на телефоне это блокировка экрана, сворачивание
 * Telegram, простой туннеля. Каждый такой обрыв посреди забега выкидывал
 * тестера на заставку.
 *
 * Плагин меняет эту перезагрузку на плашку «обновить»: игра продолжается, а
 * тестер сам выбирает момент. Горячие обновления после обрыва не приходят —
 * клиент Vite не умеет переподключаться без перезагрузки, — и плашка честно об
 * этом говорит. Правка кода, которую Vite применяет полной перезагрузкой,
 * по-прежнему перезагружает страницу: это решение разработчика, а не случайность.
 *
 * Только dev-сервер: в сборку плагин не попадает (`apply: "serve"`).
 */
export function stableDevSession(): Plugin {
  let warned = false;

  return {
    name: "rubezh:stable-dev-session",
    apply: "serve",
    enforce: "post",
    transform(code, id) {
      if (!isViteClient(id)) return null;

      const patched = patchViteClient(code);
      if (patched === null) {
        // Клиент Vite поменялся после обновления: молча вернуться к
        // перезагрузкам нельзя — никто не поймёт, почему они вернулись.
        if (!warned) {
          this.warn(
            "stable-dev-session: не нашёл перезагрузку после обрыва в клиенте Vite — " +
              "страница снова будет перезагружаться. Обновите шаблон в scripts/vite/stable-dev-session.ts",
          );
          warned = true;
        }
        return null;
      }
      return { code: patched, map: null };
    },
  };
}

/** Перезагрузка после восстановления связи — ровно то место, которое меняем. */
const RELOAD_AFTER_RECONNECT = /await waitForSuccessfulPing\(url\.href\);\s*location\.reload\(\);/;

export function isViteClient(id: string): boolean {
  return id.replace(/\\/g, "/").includes("/vite/dist/client/client.mjs");
}

/**
 * Заменить перезагрузку плашкой. `null` — шаблон не найден, клиент не тронут.
 *
 * Плашка — обычный DOM без зависимостей: клиент Vite выполняется раньше
 * приложения и ничего о нём не знает. Стили — числами: токены дизайн-системы
 * здесь недоступны, а плашка — инструмент разработки, не часть интерфейса.
 */
export function patchViteClient(code: string): string | null {
  if (!RELOAD_AFTER_RECONNECT.test(code)) return null;
  return code.replace(
    RELOAD_AFTER_RECONNECT,
    `await waitForSuccessfulPing(url.href);\n(${showStaleSessionBanner.toString()})();`,
  );
}

function showStaleSessionBanner(): void {
  const id = "rubezh-dev-stale-session";
  if (document.getElementById(id) !== null) return;

  console.warn(
    "[vite] связь с dev-сервером восстановлена без перезагрузки: изменения кода придут после ручного обновления",
  );

  const button = document.createElement("button");
  button.id = id;
  button.type = "button";
  button.textContent = "dev: связь восстановлена · обновить";
  button.style.cssText = [
    "position:fixed",
    "left:8px",
    "bottom:calc(8px + env(safe-area-inset-bottom))",
    "z-index:2147483647",
    "padding:6px 10px",
    "border:1px solid #3a4560",
    "border-radius:9999px",
    "background:#121622",
    "color:#a8b2c6",
    "font:12px system-ui,sans-serif",
    "opacity:0.9",
  ].join(";");
  button.addEventListener("click", () => location.reload());
  document.body.appendChild(button);
}
