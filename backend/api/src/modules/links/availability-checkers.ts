/**
 * Сервисы проверки доступности и мониторинга (docs/24-attribution-and-sharing.md
 * §3.3): их запросы к `/r/<код>` не клики. Иначе они раздувают число кликов
 * и роняют долю запусков — по цифрам кажется, что реклама не работает.
 */

export interface AvailabilityChecker {
  /** имя в логе, а когда появится экспорт метрик — значение метки; строчные латиница, цифры и дефис, список конечный */
  service: string;
  /** точные хосты `Referer`: строчные, без схемы и порта */
  refererHosts: readonly string[];
  /** фрагмент User-Agent; `null` — по нему сервис не опознаётся */
  userAgent: RegExp | null;
}

/**
 * Признак — подсказка, а не проверка личности: подделать его может кто угодно,
 * и цена ошибки — один неучтённый клик. Новый сервис добавляется записью в этот
 * список; общее правило краулеров (`crawler.ts`) не растягиваем: у проверок
 * другой ответ (без кеша), а слова вроде `bot` в их User-Agent не стоят отдельно.
 */
export const AVAILABILITY_CHECKERS: readonly AvailabilityChecker[] = [
  {
    // Check-Host: проверка сайта с узлов по всему миру. Referer `check-host.net`
    // наблюдали на 52 кликах из 89 у ссылки рекламной сети. User-Agent взят из
    // сторонних справочников ботов, документация сервиса его не называет, поэтому
    // главный признак — Referer.
    service: "check-host",
    refererHosts: ["check-host.net"],
    userAgent: /CheckHost/i,
  },
  {
    // UptimeRobot: монитор доступности. Справка сервиса называет User-Agent
    // `Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)`.
    // Отдельного слова `bot` в нём нет, общее правило краулеров его не ловит.
    service: "uptimerobot",
    refererHosts: [],
    userAgent: /UptimeRobot/i,
  },
  {
    // Pingdom (SolarWinds): монитор доступности. Токен в User-Agent —
    // `Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)`; документация
    // советует опознавать трафик по слову pingdom. Подчёркивания вокруг `bot` —
    // часть слова, общее правило краулеров его не ловит.
    service: "pingdom",
    refererHosts: [],
    userAgent: /Pingdom/i,
  },
  {
    // Site24x7: в справке сервиса браузерные мониторы дописывают `Site24x7`
    // к User-Agent обычного браузера, поэтому по общим признакам робота не видно.
    service: "site24x7",
    refererHosts: [],
    userAgent: /Site24x7/i,
  },
  {
    // HostTracker: проверяет сайты с сотен точек, распространён у русскоязычных
    // владельцев сайтов. User-Agent вида
    // `Mozilla/5.0 (compatible;HostTracker/2.0;+http://www.host-tracker.com/)`.
    service: "hosttracker",
    refererHosts: [],
    userAgent: /HostTracker/i,
  },
];

/** Хосты `Referer` из списка — для исключения старых кликов в SQL. */
export const CHECKER_REFERER_HOSTS: readonly string[] = AVAILABILITY_CHECKERS.flatMap((checker) => checker.refererHosts);

/**
 * Имя сервиса проверки или `null`: запрос похож на человека. Хост `Referer`
 * сравнивается точно, без порта: `check-host.net.evil.example` и
 * `evil-check-host.net` — не он. Сначала смотрят хосты, потом User-Agent.
 */
export function checkerOf(visitor: { userAgent: string | null; refererHost: string | null }): string | null {
  const host = visitor.refererHost === null ? null : visitor.refererHost.toLowerCase().replace(/:\d+$/, "");
  for (const checker of AVAILABILITY_CHECKERS) {
    if (host !== null && checker.refererHosts.includes(host)) return checker.service;
  }
  const { userAgent } = visitor;
  if (userAgent === null) return null;
  for (const checker of AVAILABILITY_CHECKERS) {
    if (checker.userAgent?.test(userAgent) === true) return checker.service;
  }
  return null;
}
