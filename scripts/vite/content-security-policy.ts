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
 *   Phaser), `blob:` и аватары игроков: их адрес приходит в данных запуска
 *   (`AVATAR_ORIGINS` ниже). `blob:` сегодня не нужен никому — вся графика процедурная, — но
 *   загрузчик Phaser грузит файл текстуры через `fetch` и отдаёт картинке
 *   адрес `blob:`. Без него первый же спрайт из `assets/` молча не
 *   нарисуется, и разбираться, почему, будет тот, кто о политике не знает;
 * - **воркеры** — свои, а на dev-сервере ещё `blob:`. Воркер из `blob:`
 *   создаёт не Phaser (он лишь проверяет, есть ли `Worker`, и сам воркеров
 *   не заводит), а клиент Vite: потеряв websocket HMR, он ждёт возвращения
 *   сервера в `SharedWorker`, собранном из `blob:`. Заблокированный воркер не
 *   бросает исключение, а молча не отвечает — ожидание не кончается, и после
 *   обрыва связи нет ни перезагрузки, ни плашки из `stable-dev-session.ts`:
 *   страница остаётся без горячих правок и ничего об этом не говорит.
 *   Чужого кода `blob:` не пускает: такой адрес выпускает только скрипт, уже
 *   работающий на нашей странице, и граница проходит по `script-src`, а не
 *   здесь. В сборке клиента Vite нет, а свой код воркеров не создаёт, поэтому
 *   `blob:` там не нужен — и не добавляется: лишнее разрешение в строгой
 *   политике потом никто не заметит. `'self'` в сборке указан явно, хотя без
 *   директивы браузер взял бы то же из `script-src`: решение про воркеры
 *   записано, а не выведено из запасного правила;
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
  /**
   * Сторонняя аналитика Graspil в Telegram-сборке — только когда задан её
   * ключ: без него политика не пускает ни одного чужого скрипта.
   */
  graspil?: boolean;
  /**
   * Реклама сетей — в Telegram-сборке: их SDK показывает её на нашей
   * странице. Другие площадки рекламы сетей не показывают, и политика их
   * сборок чужого не пускает.
   */
  ads?: boolean;
}

/**
 * Graspil — аналитика Mini App (решение участника 1 от 26.09.2026,
 * docs/22-analytics-and-metrics.md §9): скрипт — со своего домена, отчёты
 * уходят POST-запросами на другой. `telegram-web-app.js` не нужен —
 * `Telegram.WebApp` ставит прослойка адаптера.
 */
export const GRASPIL_SCRIPT_ORIGINS = ["https://w.graspil.com"] as const;
export const GRASPIL_CONNECT_ORIGINS = ["https://wb.graspil.com"] as const;

/**
 * Скрипты рекламных сетей (docs/35-stage4-plan.md WP12) — их SDK, и только
 * они: адреса — `adapter-telegram/src/ads/networks.ts`, поддомены — потому
 * что SDK догружает свои части с них.
 */
export const AD_SCRIPT_ORIGINS = [
  "https://sad.adsgram.ai",
  "https://*.adsgram.ai",
  "https://static.sonartech.io",
  "https://*.sonartech.io",
  "https://richinfo.co",
  "https://*.richinfo.co",
  "https://sdk.taddy.pro",
  "https://*.taddy.pro",
] as const;

/**
 * Креативы рекламы — с любых адресов. Ролик, картинку и фрейм объявления
 * сеть берёт у рекламодателя или его площадки, и списка их нет ни у нас, ни
 * у сети; пиксели показа уходят туда же. Граница безопасности остаётся на
 * `script-src`: исполнять на странице можно только SDK сетей, а картинка,
 * ролик, чужой фрейм и запрос скрипт не внедряют.
 */
export const AD_CREATIVE_SOURCES = ["https:"] as const;

/** Кто вправе встраивать приложение во фрейм: Telegram Web, и больше никто. */
export const FRAME_ANCESTORS = ["'self'", "https://web.telegram.org"] as const;

/**
 * Откуда приходят аватары. Адрес фото в данных запуска Telegram —
 * `t.me/i/userpic/…`, но это перенаправление на CDN Telegram
 * (`cdnN.telesco.pe`), а политика проверяет и адрес после перенаправления:
 * с одним `t.me` картинка молча не грузится, и игрок видит инициалы вместо
 * фото. Номер сервера CDN меняется, поэтому — весь поддомен; `cdn-telegram.org`
 * — второе имя того же CDN.
 */
export const AVATAR_ORIGINS = ["https://t.me", "https://*.telesco.pe", "https://*.cdn-telegram.org"] as const;

export function contentSecurityPolicy({ mode, apiOrigin, graspil = false, ads = false }: PolicyInput): string {
  const dev = mode === "dev";
  const api = originOf(apiOrigin);
  const scripts = [...(graspil ? GRASPIL_SCRIPT_ORIGINS : []), ...(ads ? AD_SCRIPT_ORIGINS : [])];
  const connects = [...(graspil ? GRASPIL_CONNECT_ORIGINS : []), ...(ads ? AD_CREATIVE_SOURCES : [])];
  const creatives = ads ? [...AD_CREATIVE_SOURCES] : [];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // В разработке React вставляет встроенный скрипт горячей перезагрузки, а
    // Vite — стили через <style>. В сборке ни того ни другого нет.
    "script-src": dev ? ["'self'", "'unsafe-inline'", ...scripts] : ["'self'", ...scripts],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", ...AVATAR_ORIGINS, ...creatives],
    // Ролики и фреймы объявлений — только с рекламой; без неё — как всё прочее, свои.
    ...(ads ? { "media-src": ["'self'", "blob:", ...creatives], "frame-src": ["'self'", ...creatives] } : {}),
    // Клиент Vite ждёт сервер после обрыва HMR в воркере из blob: — без
    // него страница не узнает, что сервер вернулся.
    "worker-src": dev ? ["'self'", "blob:"] : ["'self'"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(api === null ? [] : [api]), ...connects, ...(dev ? ["ws:", "wss:"] : [])],
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
