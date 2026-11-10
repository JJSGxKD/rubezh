---
id: T-0385
title: Пул Xray — транспорт и безопасность узла, устройство и маршрутизация подписки
epic: E13
priority: P2
status: ready
owner:
author: claude-lead2-4
size: M
depends_on: [T-0384]
zones:
  - packages/proxy-kit/src/routing.ts
  - packages/proxy-kit/src/subscription.ts
  - packages/proxy-kit/src/xray-json/document.ts
  - packages/proxy-kit/src/fetch-subscription.ts
  - packages/proxy-kit/test/routing.test.ts
  - packages/proxy-kit/test/subscription.test.ts
  - packages/proxy-kit/test/xray-json.test.ts
  - packages/proxy-kit/test/fetch-subscription.test.ts
  - packages/proxy-kit/test/fixtures/xray-json/**
  - packages/proxy-kit/test/fixtures/xray-json.ts
  - backend/api/src/modules/proxies/subscription/subscription.repository.ts
  - backend/api/src/modules/proxies/subscription/subscription.sync.ts
  - backend/api/src/modules/proxies/subscription/subscription-views.ts
  - backend/api/src/modules/proxies/subscription/subscription-download.ts
  - backend/api/src/modules/proxies/subscription/subscription.service.ts
  - backend/api/test/proxy-subscription-details.test.ts
  - backend/api/test/proxy-subscription.integration.test.ts
  - backend/api/test/helpers/memory-subscription.ts
  - apps/admin/src/api/proxy-subscription.ts
  - apps/admin/src/screens/proxies/SubscriptionCard.tsx
  - apps/admin/src/screens/proxies/SubscriptionNodes.tsx
  - apps/admin/src/screens/proxies/subscription-view.ts
  - apps/admin/test/proxy-subscription.test.ts
shared:
  - packages/proxy-kit/src/index.ts
  - packages/proxy-kit/README.md
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - apps/admin/src/ui/help.ts
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 5
---

# T-0385. Пул Xray — транспорт и безопасность узла, устройство и маршрутизация подписки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0385.json)](README.md#значки-статуса) [![T-0384](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0384.json&label=T-0384)](T-0384-xray-multi-subscription.md)

## Зачем

В разделе «Прокси» владелец видит у узла протокол, страну и хост, но не видит, как
узел подключается: транспорт (RAW, XHTTP, gRPC, WebSocket…) и безопасность (TLS,
REALITY, без шифрования). Не видно и того, сколько устройств подписка занимает у
поставщика и есть ли в ней своя маршрутизация. Р192 требует показывать всё это.
Маршрутизация — только для сведения: наш перебор её не применяет.

## Решения

- **Р192** (`docs/35-stage4-plan.md`): в таблице узлов — транспорт и безопасность; у
  подписки — сколько устройств она занимает и есть ли в ней своя маршрутизация;
  маршрутизация только показывается.
- **Р101, T-0093**: `x-hwid` постоянный — HMAC от ключа подписки и
  `SECRETS_ENCRYPTION_KEY` (`subscriptionHwid`, `subscription-download.ts`). Одна
  подписка — одно устройство у поставщика.

Решения этой спецификации (`claude-lead2-4`, 07.11.2026, в рамках Р192):

- **Устройство — всегда «1».** Число не считается: сервер ходит с одним `x-hwid` на
  подписку. Рядом — **отпечаток: первые 8 знаков** `x-hwid` и с чем мы
  представляемся (`Linux`, `v2rayN/7.0`). Отпечатка хватает, чтобы найти устройство в
  кабинете поставщика. Полный идентификатор не показываем: он не секрет, но
  полностью не нужен. Адрес подписки и ключ шифрования по отпечатку не восстановить.
  Без ключа шифрования отпечатка нет.
- **Маршрутизация — из двух источников, которые мы уже принимаем:**
  1. JSON-подписка Xray (`parseXrayJson`, `xray-json/document.ts`) — блок `routing`
     каждого конфига. Ссылки (base64 и текст) маршрутизации не несут;
  2. заголовок ответа поставщика `routing`, который выдают панели для клиента Happ
     (`happ://routing/add/<base64>` или `happ://routing/onadd/<base64>`). Разбираются
     списки `DirectSites`, `DirectIp`, `BlockSites`, `BlockIp`. Другой формат или
     нечитаемое значение дают «есть, состав не разобран», а не ошибку.
- **Что считается.** «Мимо туннеля» — записи (домены, IP, списки `geosite:`/`geoip:`)
  из правил, ведущих в выход с протоколом `freedom` того же конфига, и из
  `DirectSites`/`DirectIp`. «Блокируется» — то же для `blackhole` и
  `BlockSites`/`BlockIp`. Повторы между конфигами и источниками считаются один раз.
  В подсказки идут только `geosite:…` и `geoip:…` — до 8 штук, по первому появлению.
  Сырые домены и IP не показываются, только число.
- **«Своя маршрутизация есть»** — если в ней нашлась хоть одна запись мимо туннеля
  или блокировки, либо пришёл заголовок `routing`. Правила, которые всё шлют в
  туннель, маршрутизацией не считаются.
- **Безопасность словами.** `tls` — «TLS», `reality` — «REALITY». `none` у VLESS и
  Trojan — «без шифрования». `none` у VMess и Shadowsocks — «шифр протокола»: эти
  протоколы шифруют сами, и надпись «без шифрования» была бы неправдой. Флаг
  `flow` дописывается: `xtls-rprx-vision` — « · Vision», другой — « · <flow>».
- **Транспорт словами:** `tcp` — «RAW» (так Xray зовёт его с версии 24), `ws` —
  «WebSocket», `grpc` — «gRPC», `httpupgrade` — «HTTPUpgrade», `xhttp` — «XHTTP».

## Как сейчас

- `packages/proxy-kit/src/node.ts`: в `ProxyNode` уже есть `transport.network`
  (`NodeNetwork`), `security.kind` (`none`/`tls`/`reality`) и `flow`. В базу и в
  панель они не попадают.
- `xray-json/document.ts`, `parseXrayJson`: схема `config` читает `remarks` и `outbounds`;
  `routing` не разбирается. Образец JSON с `routing` —
  `test/fixtures/xray-json/remnawave-array.json` (правила в `direct`, выход `freedom`).
- `fetch-subscription.ts`: из заголовков берутся `subscription-userinfo` и
  `profile-update-interval`. Тип результата — `FetchedSubscription`.
- Узлы в базе — `ProxySubscriptionNode` (`schema.prisma` ~2291): protocol, name, country,
  host, state, failures, latencyMs, slot. Транспорта и безопасности нет.
- `subscription.sync.ts`, `storedNode(...)` — узел для таблицы. `applyRefresh` пишет
  итог, трафик и срок.
- `subscription-views.ts`: `SubscriptionView`, `NodeView`, `nodeViews`.
- Панель (после T-0384): карточка `SubscriptionCard.tsx`, таблица `SubscriptionNodes.tsx`
  с колонками «Узел», «Состояние», «Протокол», «Страна», «Хост», «Задержка»; строка
  трафика `trafficLine` (`subscription-view.ts`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`packages/proxy-kit/src/routing.ts`** (новый, без импортов из монорепо):

   ```ts
   export interface RoutingSummary {
     /** откуда известно: JSON-конфиг подписки, заголовок поставщика */
     sources: ("json" | "header")[];
     /** записей мимо туннеля; null — заголовок есть, состав не разобран */
     direct: number | null;
     block: number | null;
     /** geosite:/geoip: из записей мимо туннеля, до 8, строчными */
     hints: string[];
   }
   export function routingOfConfigs(configs: readonly unknown[]): RoutingSummary | null;
   export function parseRoutingHeader(value: string | null): RoutingSummary | null;
   export function mergeRouting(a: RoutingSummary | null, b: RoutingSummary | null): RoutingSummary | null;
   export function hasOwnRouting(summary: RoutingSummary | null): boolean;
   ```

   - `routingOfConfigs`: для каждого конфига — карта «тег выхода → протокол» из его
     `outbounds`. Правило `routing.rules[]` с `outboundTag` на `freedom` идёт в
     «мимо туннеля», на `blackhole` — в «блокируется». Правила с `balancerTag` и в
     другие выходы не считаются. Записи — элементы `domain[]` и `ip[]` правила; у
     правила без них (только `port`, `protocol`, `network`) — одна запись, ключ
     которой — JSON правила с упорядоченными ключами. Повторы по строке записи
     схлопываются. Мусор (не объект, не массив) пропускается молча: это сведения,
     а не узлы. Нет ни одной записи — `null`.
   - `parseRoutingHeader`: `null`, пусто или длиннее 16 384 знаков — `null`. Значение
     по шаблону `^happ://routing/(?:on)?add/(.+)$` — последняя часть base64 (обычный
     или URL-safe, `decodeBase64` из `internal/base64.ts`) → JSON-объект → массивы
     `DirectSites`, `DirectIp` (мимо туннеля) и `BlockSites`, `BlockIp` (блокировка),
     элементы-строки. Не разобралось — `{ sources: ["header"], direct: null, block: null, hints: [] }`.
   - Подсказка — запись, которая после перевода в строчные проходит
     `^(geosite|geoip):[a-z0-9._!@-]{1,56}$`. Остальное в подсказки не идёт.
   - `mergeRouting` — объединение источников. Числа складываются после схлопывания
     повторов, поэтому функция работает с множествами записей, а не с числами:
     внутри модуля держи `Set`, наружу — `RoutingSummary`. Если у одного источника
     `null` в числах, в итоге — число второго.
3. **`subscription.ts`:** в `SubscriptionParse` — поле `routing: RoutingSummary | null`;
   у base64 и текста — `null`. **`xray-json/document.ts`:** схема `config` — плюс
   `routing: z.unknown().optional()`; `parseXrayJson` в итоге `ok` отдаёт
   `routing: routingOfConfigs(разобранные конфиги)`.
4. **`fetch-subscription.ts`:** в `FetchedSubscription` — `routingHeader: string | null`,
   значение заголовка `routing` как есть. Экспорт новых имён — в `index.ts`.
5. **Миграция** — после перебазирования на свежий `dev`, без базы (`tasks/README.md`,
   «Общие файлы»). `ProxySubscriptionNode`:

   ```prisma
   /// транспорт (`NodeNetwork` proxy-kit); null — узел записан до T-0385 и ещё не обновлялся
   network  String? @db.VarChar(12)
   /// `none`, `tls` или `reality`
   security String? @db.VarChar(8)
   flow     String? @db.VarChar(32)
   ```

   `ProxySubscription`:

   ```prisma
   /// `none`, `json`, `header`, `json+header`; null — подписка не обновлялась после T-0385
   routingSource String?  @map("routing_source") @db.VarChar(12)
   routingDirect Int?     @map("routing_direct")
   routingBlock  Int?     @map("routing_block")
   routingHints  String[] @map("routing_hints") @db.VarChar(64)
   ```

   В `migration.sql` руками: `CHECK ("network" IS NULL OR "network" IN ('tcp','ws','grpc','httpupgrade','xhttp'))`,
   `CHECK ("security" IS NULL OR "security" IN ('none','tls','reality'))`,
   `CHECK ("routing_source" IS NULL OR "routing_source" IN ('none','json','header','json+header'))`,
   `CHECK ("routing_direct" IS NULL OR "routing_direct" >= 0)`, то же для `routing_block`.
   Данные не заполняются: поля появятся при следующем обновлении подписки. Новых
   моделей нет — `wipe-plan.ts` не трогается.
6. **Репозиторий и обновление.** `StoredNode` — плюс `network`, `security`, `flow`
   (`string | null`). `RefreshWrite` — плюс `routing: { source: string; direct: number | null; block: number | null; hints: string[] }`.
   `storedNode(...)` берёт `node.transport.network`, `node.security.kind`, `node.flow`.
   В `sync.ts`: `routing = mergeRouting(parsed.routing, parseRoutingHeader(fetched.routingHeader))`;
   `source` — `"none"`, если `!hasOwnRouting(routing)`, иначе `sources.join("+")` в
   порядке `json`, `header`. Неудачное обновление (`recordFailure`) маршрутизацию не
   трогает. `MemorySubscriptionRepository` — то же.
7. **Ответ панели** (`subscription-views.ts`, `subscription.service.ts`):
   - `NodeView` — плюс `network`, `security`, `flow`;
   - `SubscriptionView` — плюс
     `routing: { source: "none" | "json" | "header" | "json+header"; direct: number | null; block: number | null; hints: string[] } | null`
     (`null` — `routing_source` пуст);
   - плюс `device: { count: 1; hwidPrefix: string | null; os: string; userAgent: string }`.
     `hwidPrefix` — `subscriptionHwid(cipher, key).slice(0, 8)`, без шифра — `null`;
     `os` — константа `DEVICE_OS`. Её экспортировать из `proxy-kit`
     (`fetch-subscription.ts`), а не дублировать. `userAgent` — `SUBSCRIPTION_USER_AGENT`.
     Полного `x-hwid` нет ни в ответе, ни в аудите, ни в логе.
8. **Панель:**
   - `api/proxy-subscription.ts` — схемы под поля шага 7 (`network`, `security`,
     `flow` — `string | null`: незнакомое значение показывается как есть, а не роняет
     разбор);
   - `subscription-view.ts` — `transportLabel(network)`, `securityLabel(protocol, security, flow)`,
     `deviceLine(device)`, `routingLine(routing)` (тексты — раздел «Сценарий»);
     `NodeRow` — плюс `transportText`, `securityText`;
   - `SubscriptionNodes.tsx` — колонки «Транспорт» и «Безопасность» после «Протокол»;
   - `SubscriptionCard.tsx` — строки `deviceLine` и `routingLine` под строкой трафика;
     у строки устройства — значок-подсказка `HELP.proxies.device`.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Сами разбор узлов и причины пропуска. Новые параметры узла (ECH, `extra`, flow и
  прочее) — T-0387.
- Перебор и выбор узла: маршрутизация подписки в него не попадает (Р192).
- `x-hwid`, `User-Agent`, `x-device-os` — как отправлялись, так и отправляются.
- Конфиг Xray и `xray-config.ts`.

## Сценарий и интерфейс

Таблица узлов, колонки по порядку: «Узел», «Состояние», «Протокол», «Транспорт»,
«Безопасность», «Страна», «Хост», «Задержка». Примеры: «RAW» · «REALITY · Vision»;
«WebSocket» · «TLS»; «gRPC» · «TLS»; «RAW» · «шифр протокола» (Shadowsocks). Узел
до первого обновления после выкатки — «—» в обеих колонках.

Карточка подписки, строки под трафиком:

- **Устройство:** «Занимает 1 устройство у поставщика · отпечаток 3f9a2c1b… · Linux,
  v2rayN/7.0». Без ключа шифрования: «Занимает 1 устройство у поставщика · отпечаток
  появится, когда на сервере будет ключ шифрования».
  `HELP.proxies.device`: «Сервер представляется поставщику одним постоянным устройством
  на подписку. Отпечаток — начало его идентификатора: по нему устройство находится в
  кабинете поставщика. Если на сервере сменят ключ шифрования, идентификатор станет
  другим и у поставщика появится ещё одно устройство — старое можно удалить в кабинете».
- **Маршрутизация:**
  - не обновлялась после выкатки — «Своя маршрутизация: станет известно после
    обновления подписки»;
  - `none` — «Своя маршрутизация: нет»;
  - есть, с числами — «Своя маршрутизация: есть (в JSON-конфиге) — мимо туннеля 12,
    например geosite:category-ru, geoip:ru; блокируется 3. Наш перебор её не применяет».
    Источник: «в JSON-конфиге», «в заголовке поставщика», «в JSON-конфиге и заголовке
    поставщика». Нулевая часть опускается: «мимо туннеля 4» без «блокируется 0».
    Подсказок нет — без «например…»;
  - заголовок не разобран — «Своя маршрутизация: есть (в заголовке поставщика), состав
    не разобран. Наш перебор её не применяет».

Загрузка, ошибка, нет сети, ограничение аккаунта — как в карточке T-0384.

## Тесты

Первым коммитом.

- **`packages/proxy-kit/test/routing.test.ts`:**
  - `remnawave-array.json` → `sources: ["json"]`, мимо туннеля — записи из правил на
    `direct` (`geoip:private` и др.), правило `protocol: bittorrent` — одна запись;
    повтор правила во втором конфиге не удваивает счёт;
  - правило в `proxy` и правило с `balancerTag` не считаются; только такие — `null`;
  - `blackhole` → `block`;
  - подсказки: строчные, без повторов, не больше 8; `GEOSITE:Category-RU` →
    `geosite:category-ru`; `domain:example.com` и сырой IP в подсказки не идут, но
    считаются;
  - заголовок `happ://routing/onadd/<base64 JSON с DirectSites: ["geosite:category-ru"], DirectIp: ["geoip:ru"], BlockSites: []>`
    → `direct: 2`, `block: 0`, подсказки обе; URL-safe base64 без `=` — то же;
  - заголовок `happ://routing/add/!!!`, `something-else`, 20 000 знаков →
    `{ sources: ["header"], direct: null, block: null, hints: [] }`; `null` и `""` → `null`;
  - `mergeRouting`: одна и та же запись в JSON и в заголовке считается один раз,
    `sources: ["json", "header"]`;
  - мусор вместо `routing` (`routing: 5`, `rules: "x"`) — без исключения.
- **`test/xray-json.test.ts`, `test/subscription.test.ts`** — у JSON-подписки есть
  `routing`, у ссылок и base64 — `null`; прежние ожидания по узлам не меняются.
- **`test/fetch-subscription.test.ts`** — заголовок `routing` приходит в
  `routingHeader`; без заголовка — `null`.
- **`backend/api/test/proxy-subscription-details.test.ts`** (подмены как в
  `proxy-subscription.test.ts`):
  - после обновления у узлов в базе `network`, `security`, `flow` из разбора
    (reality+vision, ws+tls, shadowsocks);
  - маршрутизация: JSON с `direct` → `routing_source = json`; ссылки + заголовок →
    `header`; оба → `json+header`; ничего → `none`; неудачное обновление прежнее
    значение не трогает;
  - обзор: `device.count = 1`, `hwidPrefix` — 8 hex и совпадает с началом `x-hwid`,
    который ушёл поставщику в подменённом `fetch`; без шифра — `null`; в JSON ответа
    нет полного `x-hwid`;
  - узел, записанный до миграции (поля `null`), отдаётся с `null`, разбор не падает.
- **`backend/api/test/proxy-subscription.integration.test.ts`** — `network = 'udp'` и
  `routing_source = 'x'` нарушают CHECK; `routing_hints` пишутся и читаются массивом.
- **`apps/admin/test/proxy-subscription.test.ts`** — `transportLabel` по всем пяти и
  `null`; `securityLabel`: vless+none → «без шифрования», vmess+none → «шифр
  протокола», reality+vision → «REALITY · Vision», tls+`xtls-rprx-vision-udp443` → «TLS ·
  xtls-rprx-vision-udp443»; `deviceLine` с отпечатком и без; `routingLine` во всех
  пяти состояниях раздела «Сценарий», включая нулевую часть и пустые подсказки.

## Аналитика

Нет: сведения для панели, игрок их не видит.

## Настройки и окружение

Нет.

## Документы

- **`docs/29-admin-panel.md`**, строка «Прокси», блок подписок: таблица узлов — плюс
  «транспорт, безопасность»; у подписки — строки «занимает 1 устройство у поставщика,
  отпечаток» и «своя маршрутизация» (из JSON-конфига и заголовка `routing`, только для
  сведения, перебор её не применяет).
- **`docs/30-configuration-map.md`**, строка «Подписка Xray на сервере»: разбор
  маршрутизации — `packages/proxy-kit/src/routing.ts` (подсказок до 8, заголовок до
  16 384 знаков).
- **`packages/proxy-kit/README.md`**, «Что умеет» — сводка маршрутизации подписки
  (`routing.ts`: JSON-конфиг и заголовок `routing`).
- **`docs/21-diagrams.md`**: ER — новые колонки `proxy_subscription_node` и `proxy_subscription`.

## Критерии приёмки

- [ ] В таблице узлов видны транспорт и безопасность словами; Shadowsocks и VMess без
      TLS не названы «без шифрования».
- [ ] У подписки видно «Занимает 1 устройство у поставщика» и отпечаток (8 знаков);
      полного `x-hwid`, адреса и ключа нет ни в ответе, ни в аудите.
- [ ] Своя маршрутизация видна по JSON и по заголовку `routing`, с числами и
      подсказками; неразборчивый заголовок — «состав не разобран», а не ошибка
      обновления.
- [ ] Узлы до первого обновления после выкатки показываются с «—», ничего не падает.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(api): Транспорт, безопасность и маршрутизация подписок Xray`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ТРАНСПОРТ И МАРШРУТИЗАЦИЯ ПОДПИСОК XRAY**

  В разделе «Прокси» у узлов подписки видны транспорт (RAW, XHTTP, gRPC, WebSocket) и безопасность (TLS, REALITY, без шифрования). У подписки видно, что она занимает одно устройство у поставщика, с отпечатком, и есть ли в ней своя маршрутизация.

  🛠 **Эксплуатация**

  • новые сведения появятся после ближайшего обновления каждой подписки
  • маршрутизация подписки только показывается — перебор узлов её не применяет
  ```

## Вопросы к тимлиду

Неблокирующие: спецификация написана по варианту «(Рекомендуется)».

1. **Формат заголовка `routing`.** Разбирается вид Happ (`happ://routing/…`, списки
   `DirectSites`/`DirectIp`/`BlockSites`/`BlockIp`); остальное — «есть, состав не
   разобран». (а) Так и оставить (Рекомендуется); (б) прислать образец заголовка
   действующего поставщика — исполнитель добавит его в тест как есть.
2. **Отпечаток устройства.** (а) Первые 8 знаков `x-hwid` (Рекомендуется); (б) не
   показывать вовсе, только «1 устройство».
