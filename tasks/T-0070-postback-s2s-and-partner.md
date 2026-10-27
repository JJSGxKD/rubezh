---
id: T-0070
title: Постбэки в s2s-сети и партнёру — шаблон адреса, click_id и sub1…sub5
epic: E14
priority: P2
status: ready
owner:
author: claude-lead2-2
size: M
depends_on: [T-0069, T-0067, T-0058]
zones:
  - backend/api/src/modules/ad-conversions/**
  - backend/api/src/modules/links/links.service.ts
  - backend/api/src/modules/links/links.repository.ts
  - backend/api/src/modules/links/link-networks.ts
  - backend/api/src/modules/links/click-params.ts
  - backend/api/src/modules/admin/admin-links.controller.ts
  - backend/api/src/modules/admin/admin-partners.controller.ts
  - backend/api/src/modules/partners/**
  - backend/api/test/postback-template.test.ts
  - backend/api/test/postback-address.test.ts
  - backend/api/test/postback-template-destination.test.ts
  - backend/api/test/postback-settings.test.ts
  - backend/api/test/click-params.test.ts
  - backend/api/test/postback-s2s.integration.test.ts
  - apps/admin/src/api/links.ts
  - apps/admin/src/api/partners.ts
  - apps/admin/src/screens/links/**
  - apps/admin/src/screens/partners/**
  - apps/admin/test/postbacks.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/23-referral-and-partner-program.md
  - docs/24-attribution-and-sharing.md
  - docs/35-stage4-plan.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 4
---

# T-0070. Постбэки в s2s-сети и партнёру — шаблон адреса, click_id и sub1…sub5

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0070.json)](README.md#значки-статуса) [![T-0069](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0069.json&label=T-0069)](archive/T-0069-postback-destinations-layer.md) [![T-0067](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0067.json&label=T-0067)](archive/T-0067-partner-links-and-binding.md) [![T-0058](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0058.json&label=T-0058)](archive/T-0058-redirect-deeplink-page.md)

## Зачем

Партнёр приводит игроков своей ссылкой и хочет знать, кто из них зарегистрировался
и заплатил; сети вроде PropellerAds ждут то же самое запросом на свой адрес.
После задачи у ссылки и у партнёра можно задать адрес постбэка с макросами, и
регистрация уходит туда с `click_id` и `sub1`…`sub5`, которые партнёр положил
в ссылку.

## Решения

Записаны в `docs/35-stage4-plan.md` Р86, Р96 (WP43, WP49 часть 4) и в `tasks/inbox.md`
(«Постбэки — общий слой адаптеров»).

- **Два назначения на общем шаблоне** (слой из T-0069): `s2s` — у ссылки без владельца-партнёра
  свой адрес (закупка команды в сети с постбэками); `partner` — у ссылки партнёра: адрес ссылки,
  а если его нет, общий адрес партнёра.
- **События:** у обоих по умолчанию только `registration`; колонка со списком заводится здесь,
  выбор в панели и новые события — T-0071.
- **Макросы** (Р96 + идентификатор): `{click_id}`, `{sub1}`…`{sub5}` — значения из ссылки партнёра;
  `{event}` — имя события; `{event_id}` — наш `conversion_id`, по нему приёмник отсекает повторы;
  `{amount}`, `{currency}` — сумма и валюта платежа **как заплачено**, без пересчёта
  (`docs/37-accounting.md`, О44): звёзды — `XTR`; у событий без платежа `0` и пусто.
- **Значения кодируются** `encodeURIComponent` в один проход: значение, похожее на макрос,
  повторно не раскрывается.
- **Адреса вводят люди, проверка двойная** — при сохранении и при каждой отправке: только `https`,
  без логина, пароля и порта, до 1024 знаков (после подстановки — 2048), макросов в имени сайта
  нет, внутренние адреса запрещены (по имени и по тому, во что оно разрешается),
  перенаправления не выполняются.
- **Прошлое не досылается:** при задании адреса фиксируется `postback_since`, постбэки идут по
  кликам после него.
- Журнал, повторы, «Отправить ещё раз» — как у AdsGram; отправка через `outbound.forService("ads.postback")`.
- Адрес сняли — строка пропускается (`no_address`); шаблон требует `{click_id}`, а в клике его
  не было — `no_click_id`.

## Как сейчас

- **`click_id` и `sub` не сохраняются:** ни T-0067, ни T-0058 их не трогают. `links.service.ts`
  `visit` кладёт на клик только `networkParamsOf(link.network, visitor.query)` (стр. ~87) и только
  для ссылки с сетью; у ссылки партнёра без сети `link_click.network_params = NULL`.
  `link-networks.ts:48-62` — `MACRO_VALUE` (печатные без пробелов, до 256) и `networkParamsOf`.
- **Слой T-0069:** `destinations/destination.ts` (`PostbackDestination`, `Prepared`),
  `adsgram.destination.ts`, `destination-targets.ts` (`TARGETS_CTE`, ветка AdsGram), провайдер
  `POSTBACK_DESTINATIONS` в `ad-conversions.module.ts`; `DueConversion` несёт `event`,
  `destination`, `params`, `purchase { amount, currency }`. `ad_conversion.network` — `NOT NULL`,
  новые строки пишут туда имя назначения.
- Параметры клика живут 31 сутки (`CONVERSION_WINDOWS.paramsKeepDays`), затем `purgeParams`.
- `Link.partnerId` (T-0067); `PATCH /api/v1/admin/links/:code` (T-0057, `links.manage`);
  `POST /api/v1/admin/partners/:partnerId` (`admin-partners.controller.ts`, `partners.edit`,
  аудит «было → стало»). Панель: `screens/links/LinkCard.tsx`, `screens/partners/`.
- Проверки внутренних адресов в коде нет; `ads.postback` в `OUTBOUND_SERVICES` (T-0059) есть.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** (после перебазирования на свежий `dev`, `--create-only` один раз):
   на таблицах `link` и `partner` колонки

   ```sql
   "postback_url" VARCHAR(1024),
   "postback_since" TIMESTAMPTZ(3),
   "postback_events" VARCHAR(24)[] NOT NULL DEFAULT ARRAY['registration']::VARCHAR(24)[],
   CHECK ("postback_events" <@ ARRAY['registration','purchase_first','purchase_repeat','d1_return']::VARCHAR(24)[]),
   CHECK (("postback_url" IS NULL) = ("postback_since" IS NULL))
   ```

   В `schema.prisma` — те же поля у `Link` и `Partner` (`postbackUrl`, `postbackSince`,
   `postbackEvents String[] @default(["registration"])`) с комментарием «адрес
   постбэка с макросами; `postbackSince` — с какого времени по кликам он действует».
3. **`destinations/postback-template.ts`:**

   ```ts
   export const POSTBACK_MACROS = ["click_id", "sub1", "sub2", "sub3", "sub4", "sub5", "event", "event_id", "amount", "currency"] as const;
   export type PostbackMacro = (typeof POSTBACK_MACROS)[number];
   /** Что не так с шаблоном — тексты для человека; пустой список — годится. */
   export function templateProblems(template: string): string[];
   /** Подставить значения в один проход; значения кодируются. */
   export function fillTemplate(template: string, values: Readonly<Record<PostbackMacro, string>>): URL;
   export function logUrlOf(url: URL): string;   // `https://host/path?***`, без запроса — без `?***`
   ```

   Тексты проблем дословно:
   «Адрес пустой» · «Адрес длиннее 1024 знаков» · «Адрес должен начинаться с https://»
   · «В адресе нельзя указывать логин и пароль» · «Порт в адресе не поддерживается» ·
   «Макрос {имя} неизвестен. Доступны: {click_id}, {sub1}…{sub5}, {event}, {event_id}, {amount}, {currency}» ·
   «Макросы нельзя ставить в имя сайта» · «Адрес не разбирается» ·
   «Адрес указывает на внутреннюю сеть».
   Проверка идёт по шаблону с подставленными образцами; имя сайта — часть до первого
   `/`, `?`, `#` после `https://`.
4. **`destinations/public-address.ts`:**

   ```ts
   /** IPv4 и IPv6 из внутренних диапазонов: частные, петля, link-local, CGNAT, документация, multicast, v4-в-v6. */
   export function isInternalAddress(ip: string): boolean;
   /** Имя сайта, которое внутренне само по себе: localhost, *.localhost, *.local, *.internal, *.lan, *.home.arpa, имя без точки, IP-литерал внутреннего диапазона. */
   export function isInternalHostname(host: string): boolean;
   export type HostCheck = { ok: true } | { ok: false; message: string; retry: boolean };
   /** Разрешить имя (таймаут 3 с) и проверить каждый ответ; любой внутренний — отказ без повтора. */
   export function checkHost(host: string, lookup?: (host: string) => Promise<readonly string[]>): Promise<HostCheck>;
   ```

   `templateProblems` использует `isInternalHostname`; `checkHost` — на отправке.
   Имя, которое не разрешилось или не ответило за 3 с, — `retry: true`.
5. **`destinations/template.destination.ts`** — `TemplateDestination` с `kind:
   "s2s" | "partner"` и `accepts` = все четыре события. `prepare(conversion)`:
   1. нет `conversion.postbackUrl` → `skip("no_address")`;
   2. шаблон использует `{click_id}`, а `params?.click_id` нет → `skip("no_click_id")`;
   3. значения: `click_id`, `sub1`…`sub5` из `params` (нет — пусто), `event`,
      `event_id = conversionId`, `amount`/`currency` из `purchase` (иначе `0` и пусто);
   4. `templateProblems` на уже сохранённом адресе (правила могли ужесточиться) →
      `fail { retry: false }`; подстановка длиннее 2048 → `fail { retry: false }` с
      текстом «Адрес после подстановки длиннее 2048 знаков»;
   5. `checkHost` не прошёл → `fail { message, retry }` с текстом «Адрес не прошёл
      проверку: …»;
   6. иначе `request` с `init: { method: "GET", redirect: "manual", headers: { "user-agent": "rubezh-postback/1" } }`
      и `logUrl = logUrlOf(url)`. Ответ 3xx разбирается `verdictOf` как отказ по сути.
6. **`destination-targets.ts`:** ветка `UNION ALL`:

   ```sql
   SELECT l.code, CASE WHEN l.partner_id IS NULL THEN 's2s' ELSE 'partner' END,
          (CASE WHEN l.postback_url IS NOT NULL THEN l.postback_events ELSE p.postback_events END)::text[],
          CASE WHEN l.postback_url IS NOT NULL THEN l.postback_since ELSE p.postback_since END
   FROM link l LEFT JOIN partner p ON p.partner_id = l.partner_id
   WHERE l.postback_url IS NOT NULL OR p.postback_url IS NOT NULL
   ```

   Ссылка с сетью AdsGram и своим адресом получает обе строки назначений.
7. **`conversions.repository.ts`:** `due` дополняется
   `LEFT JOIN link l … LEFT JOIN partner p …` и полем `postbackUrl:
   string | null = coalesce(l.postback_url, p.postback_url)` в `DueConversion`.
   `summaries(codes, destination)` уже умеет считать по назначению (T-0069).
8. **`ad-conversions.module.ts`:** в `POSTBACK_DESTINATIONS` добавить
   `new TemplateDestination("s2s")` и `new TemplateDestination("partner")`.
9. **Параметры клика — `links/click-params.ts`:**

   ```ts
   export const POSTBACK_PARAMS = ["click_id", "sub1", "sub2", "sub3", "sub4", "sub5"] as const;
   /** Что ссылка сохраняет на клике: макросы сети и, если у ссылки есть владелец-партнёр или свой адрес, click_id и sub1…sub5. */
   export function clickParamsOf(link: Pick<LinkRecord, "network" | "partnerId" | "postbackUrl">, query: Readonly<Record<string, string | undefined>>): Record<string, string> | null;
   ```

   Значение — по правилу `MACRO_VALUE` из `link-networks.ts` (его экспортировать):
   печатные знаки без пробелов, до 256, без `{`. В `visit` вызов `networkParamsOf`
   заменить на `clickParamsOf`. Ссылка без сети, без партнёра и без адреса — по-прежнему
   `null`. Параметры партнёра тоже обнуляются через 31 сутки.
10. **Админ-API (`links.manage` / `partners.edit`):**
    - `PATCH /api/v1/admin/links/:code` принимает `postbackUrl: string | null`
      (рядом с `target` из T-0057): `templateProblems` не пуст → 400, текст — первая
      проблема; пустая строка = `null`. Первое задание адреса и смена `null → адрес`
      ставят `postback_since = now`; смена адреса на другой `postback_since` не
      трогает; `null` обнуляет оба поля. Аудит `links.postback.set` с
      `after: { postback: logUrlOf(…) }` — запрос адреса в аудит не пишется;
    - `POST /api/v1/admin/partners/:partnerId` принимает `postbackUrl` по тем же
      правилам; в аудит «было → стало» адрес идёт в виде `logUrlOf`;
    - в виде ссылки и партнёра: `postbackUrl`, `postbackSince`, `postbackEvents`
      (полный адрес видят те, у кого право на правку).
11. **Панель:**
    - `apps/admin/src/api/links.ts`, `partners.ts` — поля и `setLinkPostback(api, code, url | null)`;
      схема строки журнала: `destination`, подпись назначения — «AdsGram» / «Адрес сети» /
      «Партнёр»; причины `no_address` → «адрес постбэка снят», `no_click_id` → «в ссылке не
      было click_id»;
    - `LinkCard.tsx` — блок «Постбэк по этой ссылке»: поле «Адрес постбэка» (у ссылки
      партнёра — «Адрес для этой ссылки (если пусто — общий адрес партнёра)»), кнопки
      «Сохранить», «Убрать адрес», «Вставить пример» (подставляет
      `https://example.com/postback?click_id={click_id}&event={event}&event_id={event_id}&amount={amount}&currency={currency}&sub1={sub1}`);
      подсказка: «Мы отправим GET-запрос по этому адресу. Подставляются: {click_id}, {sub1}…{sub5} —
      значения из ссылки, {event} — событие, {event_id} — наш идентификатор события, по нему
      приёмник отсекает повторы, {amount} и {currency} — сумма и валюта платежа (звёзды — XTR).
      Адрес только https, без логина, пароля и порта.»; под полем: «К адресу ссылки можно
      добавить click_id и sub1…sub5 — мы сохраним их и вернём в постбэке.»; состояние:
      «Отправляем по кликам с {дата}. События по более ранним кликам не отправляются.» либо
      «Адрес не задан — ничего не отправляем.»; «Получает: регистрация.»; ошибка сервера
      выводится как есть, без закрытия поля;
    - карточка партнёра — то же поле «Общий адрес постбэка партнёра» тем же блоком
      (компонент общий, в `screens/links/`; карточка партнёра его подключает);
    - журнал: колонка «Назначение».
12. **Документы** — раздел «Документы».

## Чего не трогаем

- AdsGram: формат, токен, окна, повторы — как в T-0069.
- Выбор событий в панели, `purchase_*` и `d1_return` в интерфейсе — T-0071 (колонка пока пишется
  только по умолчанию). Токен AdsGram партнёра (WP46 п. 4), воронка (T-0068), привязка (T-0067).
- Закрепление проверенного IP на время соединения — часть общего клиента (T-0059, T-0065); здесь
  проверка до отправки и запрет перенаправлений.
- Пересчёт сумм и переименование событий под сеть. Прямые ссылки без клика (`l-<код>`, T-0057):
  `click_id` взять неоткуда, события не порождаются.

## Сценарий и интерфейс

Карточка ссылки (`#/links/<код>`) или партнёра → «Адрес постбэка» → вставить или «Вставить
пример» → «Сохранить».

- загрузка: поле неактивно, пока карточка грузится;
- пусто: «Адрес не задан — ничего не отправляем.»;
- ошибка: текст проверки под полем («Адрес должен начинаться с https://» …), введённое остаётся;
- нет сети: «Не удалось сохранить — проверьте связь», введённое остаётся;
- нет права (`links.manage` у ссылки, `partners.edit` у партнёра): блока нет.

## Тесты

Первым коммитом, до кода.

- `postback-template.test.ts`:
  - валидный пример → `[]`; пустой → «Адрес пустой»; 1025 знаков → «Адрес длиннее 1024 знаков»;
  - `http://…` → «Адрес должен начинаться с https://»; `https://u:p@h.example/p` → «В адресе нельзя
    указывать логин и пароль»; `https://h.example:8443/p` → «Порт в адресе не поддерживается»;
    `https://{sub1}.example.com/p` → «Макросы нельзя ставить в имя сайта»; `…?x={nope}` → «Макрос
    {nope} неизвестен…»;
  - `fillTemplate`: `a&b=c#d` → `a%26b%3Dc%23d`; `sub3` не передан → пусто; значение `{sub1}` остаётся
    закодированным; макрос дважды — оба заменены; `logUrlOf` → `https://track.example.com/postback?***`.
- `postback-address.test.ts`:
  - `isInternalAddress` внутренние: `0.0.0.0`, `10.1.2.3`, `100.64.0.1`, `127.0.0.1`, `169.254.169.254`,
    `172.16.0.1`, `172.31.255.255`, `192.168.1.1`, `198.18.0.1`, `224.0.0.1`, `255.255.255.255`, `::`, `::1`,
    `fc00::1`, `fd12::1`, `fe80::1`, `ff02::1`, `::ffff:127.0.0.1`, `::ffff:10.0.0.1`; публичные: `8.8.8.8`,
    `1.1.1.1`, `172.32.0.1`, `100.63.255.255`, `2606:4700:4700::1111`, `::ffff:8.8.8.8`;
  - «Адрес указывает на внутреннюю сеть» для `https://localhost/p`, `127.0.0.1`, `[::1]`, `2130706433`,
    `10.0.0.5`, `meta.internal`, `printer.local`, `intranet`;
  - `checkHost` на подмене: публичный IP → `ok`; хоть один внутренний среди ответов →
    `ok: false, retry: false`; пустой ответ, `ENOTFOUND` и ответ позже 3 с → `retry: true`.
- `postback-template-destination.test.ts`:
  - регистрация, адрес `https://track.example.com/pb?cid={click_id}&e={event}&id={event_id}&a={amount}&c={currency}&s1={sub1}`,
    `params = { click_id: "k1", sub1: "x-y" }` → URL ровно `…?cid=k1&e=registration&id=<conversionId>&a=0&c=&s1=x-y`,
    `init.redirect = "manual"`, `logUrl = https://track.example.com/pb?***`;
  - покупка `purchase { amount: 50, currency: "XTR" }` → `a=50&c=XTR`, `e=purchase_first`;
  - адреса нет → `skip("no_address")`; `{click_id}` в шаблоне, в `params` нет → `skip("no_click_id")`; шаблон
    без `{click_id}` и `params = null` → `request`;
  - ужесточённые правила (старый внутренний адрес) и подстановка длиннее 2048 → `fail { retry: false }`; имя
    не разрешилось → `fail { retry: true }`;
  - через сервис на подмене `fetch`: 200 → `sent`; 302 → `failed`, второго вызова нет; 500 → повтор; повтор
    той же строки несёт тот же `event_id`; в логе нет запроса адреса.
- `click-params.test.ts`: ссылка партнёра, запрос `click_id=abc&sub1=x&sub9=y&sub2={sub2}` → на клике
  `{ click_id: "abc", sub1: "x" }`; обычная ссылка без сети, владельца и адреса → `null`; ссылка с адресом
  без владельца сохраняет; AdsGram с владельцем и адресом — оба набора; значение длиннее 256, с пробелом
  или с `{` отбрасывается.
- `postback-settings.test.ts`: `http://` → 400 с текстом проверки; без `links.manage` / `partners.edit` — 403;
  первое задание адреса ставит `postback_since`, смена адреса его не меняет, снятие и пустая строка
  обнуляют; аудит содержит `https://host/path?***`, а не запрос; лишнее поле тела — 400.
- `postback-s2s.integration.test.ts` (живой Postgres):
  - ссылка без сети и владельца с адресом: регистрация после засчитанного забега → строка
    `destination = 's2s'`, `network = 's2s'`; клик раньше `postback_since` — строки нет;
  - ссылка партнёра: адрес партнёра → `partner`; свой адрес ссылки важнее, события берутся у того
    объекта, чей адрес действует;
  - ссылка AdsGram со своим адресом → у клика две строки; повтор и два параллельных прохода не задваивают;
  - по умолчанию покупка строки не даёт; после `UPDATE … postback_events = '{registration,purchase_first}'`
    даёт `purchase_first`, но не `purchase_repeat`;
  - адрес снят после создания строки → при отправке `skipped`, `no_address`;
  - `CHECK`: неизвестное событие и адрес без `postback_since` отвергаются; `due` отдаёт `postbackUrl`
    ссылки или, если её нет, партнёра; аккаунт команды пропущен (`team`).
- `apps/admin/test/postbacks.test.ts`: подписи назначений и причин; строка «Отправляем по кликам с …» /
  «Адрес не задан…»; пример подставляется ровно как в «Шагах».

## Аналитика

Нет. Журнал отправок — таблица `ad_conversion`, как у WP43. Метрики Prometheus не
добавляем (кардинальность `link_code`/`partner_id` в метках запрещена).

## Настройки и окружение

Нет новых переменных и ключей `setting-catalog.ts`. Таймаут постбэка и паузы повторов —
прежние константы `conversion-rules.ts`; таймаут проверки имени (3 с) — константа в
`public-address.ts`.

## Документы

- `docs/35-stage4-plan.md`: WP43 и WP49 часть 4 — «Как сделано»: назначения `s2s` и
  `partner`, макросы, правило `postback_since`, проверка адреса.
- `docs/24-attribution-and-sharing.md`: параметры `click_id`, `sub1`…`sub5` на клике и их срок.
- `docs/23-referral-and-partner-program.md`: постбэки партнёру — где задать адрес, что уходит.
- `docs/21-diagrams.md`: ER (`link`, `partner` — колонки постбэка; `ad_conversion.destination`),
  схема потока конверсий — новые назначения.
- `docs/30-configuration-map.md`: где настраивается адрес постбэка (карточка ссылки и партнёра).

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: постбэки идут только по кликам после задания адреса
  (`postback_since`), прошлое не досылается.
- Подтверждено `claude-lead-1` 13.10.2026: `{event}` — наши имена без переименования под сеть; у событий
  без платежа `{amount}` = `0`, `{currency}` пусто.
- Подтверждено `claude-lead-1` 13.10.2026: адрес ссылки партнёра заменяет общий адрес партнёра, а не
  дополняет его; у ссылки без партнёра адрес — назначение `s2s`.
- Подтверждено `claude-lead-1` 13.10.2026: проверка внутренних адресов — до отправки; закрепление
  проверенного IP на время соединения — задача общего клиента.

## Критерии приёмки

- [ ] Адрес с макросами задаётся у ссылки и у партнёра; недопустимый отвергается понятным текстом.
- [ ] Регистрация уходит GET-запросом с закодированными `click_id`, `sub1`…`sub5`, `event`, `event_id`,
  `amount`, `currency`; повтор той же строки несёт тот же `event_id`, параллельные проходы не задваивают.
- [ ] `click_id` и `sub1`…`sub5` сохраняются на клике и обнуляются через 31 сутки.
- [ ] Внутренние адреса не принимаются при сохранении и не вызываются при отправке; перенаправления не
  выполняются; события до задания адреса не уходят.
- [ ] Запрос адреса не попадает ни в лог, ни в аудит, ни в журнал; AdsGram работает как в T-0069.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; в PR — чек-листы безопасности и нагрузки
  (`docs/15-engineering-standards.md` §7, §8) и план отката миграции.

## PR

- **Заголовок:** `feat(api): Постбэки в s2s-сети и партнёру с click_id и sub1…sub5`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОСТБЭКИ ПАРТНЁРУ И В S2S-СЕТИ**

  У ссылки и у партнёра можно задать адрес постбэка с макросами: регистрация игрока уходит на него вместе с click_id и sub1…sub5 из ссылки. Адрес проверяется при сохранении и при каждой отправке.

  🛠 **Что внутри**

  • только https, внутренние адреса и перенаправления запрещены
  • постбэки идут по кликам после задания адреса, прошлое не досылается
  • по умолчанию уходит регистрация, выбор событий — в T-0071

  ❓ **Нужно от команды**

  • @владелец — проверить на тестовой ссылке: задать адрес-приёмник, убедиться, что регистрация пришла один раз
  ```
