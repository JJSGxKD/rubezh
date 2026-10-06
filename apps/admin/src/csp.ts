/**
 * Политика источников панели (docs/29-admin-panel.md §8).
 *
 * Своя, а не общая с игрой (`scripts/vite/content-security-policy.ts`): у
 * панели другие соседи. Игру встраивает Telegram Web, а панель не встраивает
 * никто — `frame-ancestors 'none'` закрывает кликджекинг на кнопках
 * блокировки и начислений. Адрес API у панели всегда свой же домен: Caddy
 * поддомена панели проксирует `/api/v1/admin` в API, поэтому чужих источников
 * в `connect-src` нет вовсе.
 *
 * Та же политика ставится на dev-сервере, на просмотре сборки и в Caddy —
 * чтобы проверенное локально совпадало с тем, что увидит команда. Виджет
 * входа Telegram добавит сюда `telegram.org` своей задачей, вместе с доменом.
 */

export type PolicyMode = "dev" | "build";

/**
 * Откуда приходят аватары игроков — тот же список, что у игры
 * (`scripts/vite/content-security-policy.ts`, там же почему): `t.me` лишь
 * перенаправляет на CDN Telegram, и без него фото не грузится.
 */
export const AVATAR_ORIGINS = ["https://t.me", "https://*.telesco.pe", "https://*.cdn-telegram.org"] as const;

/**
 * `previewOrigin` — источник страницы предпросмотра клиента (docs/35-stage4-plan.md
 * WP32, `scripts/vite/preview-origins.ts`): панель встраивает её фреймом, и
 * больше никого. Пусто — фреймов нет вовсе.
 */
export function adminContentSecurityPolicy(mode: PolicyMode, previewOrigin: string | null = null): string {
  const dev = mode === "dev";

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // В разработке React вставляет встроенный скрипт горячей перезагрузки. В
    // сборке его нет, и скрипты — только свои.
    "script-src": dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // Ширина полос прогресса в карточке задаётся атрибутом style; внедрение
    // стиля — куда меньшая дыра, чем внедрение скрипта, а скрипты закрыты.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", ...AVATAR_ORIGINS],
    "font-src": ["'self'"],
    // Websocket горячей перезагрузки — только на dev-сервере.
    "connect-src": dev ? ["'self'", "ws:", "wss:"] : ["'self'"],
    // Клиент Vite ждёт возвращения сервера в воркере из blob: (подробно —
    // scripts/vite/content-security-policy.ts); в сборке клиента Vite нет.
    "worker-src": dev ? ["'self'", "blob:"] : ["'self'"],
    "frame-src": previewOrigin === null ? ["'none'"] : [previewOrigin],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
  };

  const policy = Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(" ")}`);
  // На dev-сервере панель открывается по http: переписывание на https её бы сломало.
  if (!dev) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}
