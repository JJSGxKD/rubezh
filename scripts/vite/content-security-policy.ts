/**
 * Политика источников клиента (docs/34-stage3-plan.md, WP3).
 *
 * Одна на все площадки и все места, где отдаётся клиент: dev-сервер,
 * просмотр сборки и Caddy в проде (docs/09-ci-cd.md §10) — чтобы политика,
 * проверенная локально, была той же, что увидит игрок.
 *
 * Что клиент на самом деле грузит — сверено с кодом, а не угадано:
 *
 * - **скрипты** — только свои. SDK Telegram (`@tma.js/sdk`) лежит в бандле,
 *   а не подключается с `telegram.org`, и `'unsafe-eval'` не нужен никому;
 * - **стили** — свои и встроенные. Встроенный — критичный CSS и заставка в
 *   `index.html`: он там ради того, чтобы не было белого экрана до первого
 *   кадра, и вынести его в файл значит вернуть белый экран. Внедрение стиля —
 *   куда меньшая дыра, чем внедрение скрипта, а скрипты закрыты строго;
 * - **картинки** — свои, `data:` (иконка в разметке и служебные текстуры
 *   Phaser), `blob:` и аватары игроков с `t.me`: их адрес приходит в данных
 *   запуска. `blob:` сегодня не нужен никому — вся графика процедурная, — но
 *   загрузчик Phaser грузит файл текстуры через `fetch` и отдаёт картинке
 *   адрес `blob:`. Без него первый же спрайт из `assets/` молча не
 *   нарисуется, и разбираться, почему, будет тот, кто о политике не знает;
 * - **соединения** — свой домен и адрес API. В разработке ещё websocket HMR;
 * - **встраивание** — только в Telegram Web. Он открывает Mini App во
 *   фрейме, и `frame-ancestors 'none'` сломал бы игру там, где её никто не
 *   тестирует: мобильные и десктопные клиенты открывают её не во фрейме.
 *   Запрет встраивания всем остальным закрывает кликджекинг.
 */

export type PolicyMode = "dev" | "build";

export interface PolicyInput {
  mode: PolicyMode;
  /** адрес API, если он на другом домене; пусто — тот же домен */
  apiOrigin: string;
}

/** Кто вправе встраивать приложение во фрейм: Telegram Web, и больше никто. */
export const FRAME_ANCESTORS = ["'self'", "https://web.telegram.org"] as const;

/** Откуда приходят аватары: адрес фото в данных запуска Telegram. */
export const AVATAR_ORIGINS = ["https://t.me"] as const;

export function contentSecurityPolicy({ mode, apiOrigin }: PolicyInput): string {
  const dev = mode === "dev";
  const api = originOf(apiOrigin);

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // В разработке React вставляет встроенный скрипт горячей перезагрузки, а
    // Vite — стили через <style>. В сборке ни того ни другого нет.
    "script-src": dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", ...AVATAR_ORIGINS],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(api === null ? [] : [api]), ...(dev ? ["ws:", "wss:"] : [])],
    "frame-ancestors": [...FRAME_ANCESTORS],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
  };

  const policy = Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(" ")}`);
  // В разработке сервер бывает по http — переписывать запросы на https там
  // значит сломать dev-сборку, открытую без сертификата.
  if (!dev) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

/**
 * Источник из адреса API: политика знает домены, а не пути. Битый адрес —
 * `null`, а не исключение: лучше строгая политика без чужого домена, чем
 * клиент, который не собрался.
 */
function originOf(value: string): string | null {
  if (value.trim() === "") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
