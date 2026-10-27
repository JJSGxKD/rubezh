---
id: T-0333
title: Проверка рекламы командой — каталог SDK-сетей и журнал проверок на сервере
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/ads/ads-tools.controller.ts
  - backend/api/src/modules/ads/ads-tools.service.ts
  - backend/api/src/modules/ads/ads-tools-limits.ts
  - backend/api/test/ads-tools.test.ts
shared:
  - backend/api/src/modules/ads/ads.module.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/test/route-limits.test.ts
  - packages/app-shell/src/state/analytics.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
  - docs/22-analytics-and-metrics.md
  - docs/29-admin-panel.md
  - docs/28-diagnostics.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0333. Проверка рекламы командой — каталог SDK-сетей и журнал проверок на сервере

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0333.json)](README.md#значки-статуса)

## Зачем

Команде нечем вручную показать ролик конкретной сети и формата: обычная выдача
(`POST /api/v1/ads/sessions`) сама выбирает сеть и блок, создаёт сессию, двигает
кулдауны и воронку. Нужны две серверные ручки для клиентского экрана «Проверка
рекламы» (T-0334): каталог SDK-сетей и блоков (в том числе выключенных) и приём
исхода проверки в журнал. Ничего не начисляется, сессий нет.

## Решения

- `docs/35-stage4-plan.md`, Р165 (27.10.2026): проверка ничего не трогает — ни
  сессии, ни награды, ни кулдаунов, ни капа, ни воронки; исход идёт событием
  аналитики и записью в аудит. Команду из воронки не исключаем.
- Право — существующее `tools.dev`, проверка на сервере через
  `RolesService.can(account, "tools.dev")`, как у `GET /api/v1/tools/access`.
  Скрытая кнопка не защита.
- Контроллер новый, в модуле рекламы: `@Controller("tools/ads")` в
  `backend/api/src/modules/ads/ads-tools.controller.ts`. `ToolsController` в
  модуле ролей не трогаем (модуль ролей не должен знать про рекламу).
- Ответ `POST /tools/ads/test-results` — **200 и `{ data: { ok: true } }`**, как
  у `POST /ads/sessions/:id/result` (соглашение модуля рекламы). Не 204.
- Только SDK-сети: те, у которых в профиле (`ad-networks.ts`) есть формат с
  `deliveryOf(format) === "sdk"`, кроме формата `task`. Сейчас это `adsgram`,
  `adsonar`, `richads`; Taddy (доставка `api`) и задания не входят.
- Событие аналитики `ad_tested` отправляет клиент (T-0334), а заводит в словаре
  эта задача.

## Как сейчас

- `backend/api/src/modules/roles/tools.controller.ts` — `GET /tools/access`
  (образец: `AuthGuard`, `accountOf(request)`, `limiter.consume`, `RateLimitedError`).
- `backend/api/src/modules/roles/roles-limits.ts` — образец файла лимитов
  (`RateLimit = { scope, limit, windowSec }`).
- `backend/api/src/modules/ads/ad-networks.ts` — `AD_NETWORK_PROFILES`
  (профиль: `key`, `keys: AdKeyField[]` с полем `key`, `formats: AdFormatSupport[]`),
  `profileOf`, `deliveryOf`, `PLACE_FORMAT` (место -> формат). Перепроверить строки
  перед правкой.
- `backend/api/src/modules/ads/ads-catalog.repository.ts` — токен
  `ADS_CATALOG_REPOSITORY`, `networks(): AdNetworkRow[]` (`networkKey`, `name`,
  `active`, `priority`, `keys`), `blocks(): AdBlockDef[]` (`blockId`, `networkKey`,
  `place`, `externalId`, `active`, `platforms`). Отдают и выключенное. Он уже
  экспортируется из `AdsModule`.
- `backend/api/src/modules/ads/ads-catalog.service.ts` — образец: `withTimeout`
  вокруг БД (`DB_TIMEOUT_MS = 3_000`), `this.roles.audit({ actorAccountId, action,
  target, before, after })`, JSON-лог через `Logger("ads")`.
- `backend/api/src/modules/ads/ads.controller.ts` — образец лимитов (`RateLimit`
  константами), `@HttpCode(200)`, `ValidationError` на плохое тело, `{ data: ... }`.
- `backend/api/src/modules/ads/ads.module.ts` — список `controllers` и `providers`.
- `RolesModule` глобальный: `RolesService` инжектируется без импорта.
- `backend/api/src/modules/events/event-dictionary.ts` (~стр. 305-321) — клиентские
  события рекламы; хелперы `id`, `count`, `seconds`, `payload(...)`.
- Журнал аудита в панели: `apps/admin/src/api/audit.ts` — `ACTION_TITLES`
  (стр. ~140), `auditObject` с `case "ads"` (стр. ~222).
- Тест-образцы: `backend/api/test/ads-catalog.test.ts` (HTTP-приложение
  с `AuthGuard`, памятью ролей и аккаунтов, `MemoryCatalog`),
  `backend/api/test/tools-access.test.ts`, `backend/api/test/route-limits.test.ts`,
  `backend/api/test/helpers/memory-roles.ts`, `memory-ads.ts` (поле `sessions`).

## Шаги по порядку

Тесты — первым коммитом (раздел «Тесты»).

1. `ads-tools-limits.ts`: экспортировать
   `ADS_TOOLS_LIMITS: Record<"catalog" | "result", RateLimit>` =
   `catalog: { scope: "ads_tools_catalog", limit: 120, windowSec: 3600 }`,
   `result: { scope: "ads_tools_result", limit: 300, windowSec: 3600 }`.
   Лимит по аккаунту.
2. `ads-tools.service.ts` — `@Injectable() AdsToolsService`. Зависимости:
   `@Inject(ADS_CATALOG_REPOSITORY) repository`, `RolesService`. **Не** зависит
   от `AdsService` и `ADS_REPOSITORY`: так сессии создать нечем.
   - `catalog(): Promise<ToolsAdsCatalog>`: прочитать `networks()` и `blocks()` под
     `withTimeout(…, 3_000, "реклама")`. Для каждой сети найти `profileOf(networkKey)`;
     пропустить сеть без профиля. `formats` = форматы профиля, у которых
     `deliveryOf(f) === "sdk"` и `f.format !== "task"`, значения `f.format`; пропустить
     сеть с пустым `formats`. `keys` — только поля, объявленные в `profile.keys`
     (по `field.key`), значения из `ad_network.keys`; чужие ключи отбрасываются.
     Порядок сетей: `priority`, затем `networkKey`.
     Блоки: только сети из каталога; формат блока = `PLACE_FORMAT[place]`, пропустить
     `task` и форматы, которых нет в `formats` сети. Поля блока:
     `{ blockId, network, place, format, externalId, active, platforms }`.
     Порядок: `network`, `place`, `blockId`. Выключенные сети и блоки остаются
     (`active: false`).
   - `recordResult(actor: AccountRef, input: ToolsAdsResult): Promise<void>`:
     1) проверить, что `input.network` в SDK-каталоге, а `format` у неё поддержан,
     иначе `ValidationError("Неизвестная сеть или формат")`;
     2) если `blockId !== null` — найти в `blocks()`: блок обязан существовать, быть
     той же сети и того же формата, иначе `ValidationError("Блок не подходит")`;
     3) `await this.roles.audit({ actorAccountId: actor.accountId, action: "ads.test",
     target: \`${network}:${format}\`, after: input })`;
     4) JSON-лог `Logger("ads").log(JSON.stringify({ module: "ads", event: "ad_tested",
     actor: actor.accountId, network, format, live, outcome, reason, ms }))`.
     Никаких записей в `ad_session`, настройки, кулдауны, паузы сетей, кошелёк.
   - Схема тела `toolsAdsResultSchema` (Zod, `.strict()`): `network: string 1..32`,
     `format: enum["rewarded","interstitial"]`, `blockId: string.uuid().nullable()`,
     `live: boolean`, `outcome: enum["completed","closed","failed"]`,
     `reason: enum[no_fill, sdk_error, load_failed, timeout, busy, unsupported,
     misconfigured, late].optional()` (список совпадает с `AdFailureReason` из
     `packages/shared-types`; бэкенд пакеты клиента не импортирует, поэтому копия
     с комментарием «держать равным»), `ms: number().int().min(0).max(600000)`.
     Уточнение: `reason` обязателен при `outcome === "failed"` и запрещён при
     остальных (через `.refine`).
   - Тип `ToolsAdsCatalog` — как в разделе «Сценарий» ниже.
3. `ads-tools.controller.ts` — `@Controller("tools/ads")`, `@UseGuards(AuthGuard)` на
   каждом методе (образец `ToolsController`). Порядок проверок в обоих маршрутах:
   лимит частоты (`RateLimitedError("Слишком часто — попробуй позже")`) -> право
   (`roles.can(account, "tools.dev")`, нет — `ForbiddenError("Недостаточно прав")`,
   можно через `roles.require`) -> разбор тела (`safeParse`, ошибка —
   `ValidationError("Некорректный результат проверки")`) -> сервис.
   - `@Get("catalog")` -> `{ data: await service.catalog() }`.
   - `@Post("test-results") @HttpCode(200)` -> `{ data: { ok: true } }`.
4. `ads.module.ts`: добавить `AdsToolsController` в `controllers`, `AdsToolsService`
   в `providers`.
5. `event-dictionary.ts`: после `ad_reward_claimed` добавить
   `ad_tested: { version: 1, payload: payload({ network: id, format: z.enum(["rewarded",
   "interstitial"]), live: z.boolean(), outcome: z.enum(["completed","closed","failed"]),
   reason: id.optional(), ms: seconds }) }` с комментарием на русском: проверка рекламы
   командой, не игровой показ; в воронку рекламы не входит. Порядок: сначала строка в
   `docs/22` (шаг ниже), потом здесь. Имя `ad_tested` добавить и в `ANALYTICS_EVENTS`
   (`packages/app-shell/src/state/analytics.ts`, после `ad_reward_claimed`): тест
   `scripts/test/event-dictionary.test.ts` требует равенства двух списков. Больше в
   этом файле ничего не трогать; отправляет событие T-0334. Поле `ms` — число
   (как у `load_time`), единица — миллисекунды.
6. `apps/admin/src/api/audit.ts`: в `ACTION_TITLES` добавить
   `"ads.test": "Проверка рекламы командой"`; в `case "ads"` для `action === "ads.test"`
   вернуть `{ kind: "проверка", label: target.replace(":", " · "), route: { section: "ads", id: null } }`
   (до ветки «сеть/блок»). Группа «Доход» подхватывает префикс `ads.` сама.
7. `route-limits.test.ts`: добавить два случая в таблицу (см. «Тесты»).
8. Документы — раздел «Документы».

## Чего не трогаем

- `POST /ads/sessions`, `AdsService`, `ad_session`, кулдауны, паузы сетей, кап роликов
  (T-0241), `InterstitialGate` и флаг `ads.interstitial`.
- `ToolsController` и `ToolsAccessService` в модуле ролей.
- Настройка `ads.test-mode` (глобальный тестовый режим) — не меняется и не читается.
- Taddy и формат `task`; новые права; схема БД и миграции (аудит пишет существующая
  таблица журнала).
- Клиентская часть и событие со стороны клиента — T-0334.
- Исключение команды из воронки, сводки и отчёта — не делаем (Р165).
- Метки Prometheus: новых нет.

## Сценарий и интерфейс

Панельного интерфейса нет; серверный контракт (единственный источник правды для T-0334).

`GET /api/v1/tools/ads/catalog` -> 200
`{ data: { networks: [{ network: string, name: string, active: boolean, keys: Record<string,string>, formats: ("rewarded"|"interstitial")[] }], blocks: [{ blockId: string, network: string, place: string, format: "rewarded"|"interstitial", externalId: string|null, active: boolean, platforms: string[] }] } }`.
Без входа 401, без права `tools.dev` 403, лимит — 429. Пустой каталог — `{ networks: [], blocks: [] }`.

`POST /api/v1/tools/ads/test-results`, тело
`{ network, format, blockId: string|null, live: boolean, outcome: "completed"|"closed"|"failed", reason?, ms }`
-> 200 `{ data: { ok: true } }`. Лишнее поле, неверный тип, `ms` вне 0..600000,
`reason` без `failed` или `failed` без `reason`, неизвестная сеть, не-SDK сеть,
формат, которого у сети нет, блок чужой сети или формата — 400.

## Тесты

Пишутся первым коммитом. Файл `backend/api/test/ads-tools.test.ts` (HTTP-приложение
по образцу `ads-catalog.test.ts`: настоящий `AuthGuard`, `MemoryRolesRepository`,
`MemoryAccountRepository`, память каталога, `MemoryAds` для проверки сессий).
Роль аккаунта задаётся через `ctx.roles.grant`.

- Каталог, доступ: без токена -> 401; `moderator` -> 403; `marketer` -> 403;
  `owner`, `admin`, `game_designer` -> 200.
- Каталог, содержимое: в базе adsgram (активна), adsonar (`active=false`), richads,
  taddy; блоки в том числе `active=false` и блок места `task` -> в ответе три сети
  (включая выключенную с `active: false`), нет `taddy`, нет блока формата `task`,
  выключенный блок есть с `active: false`; `format` блока совпадает с `PLACE_FORMAT`.
- Каталог, ключи: в `ad_network.keys` у richads лишний ключ `secret` -> в ответе
  только ключи из профиля (`pubId`, `appId`).
- Каталог, порядок: сети по `priority`, потом по ключу.
- Каталог пуст (нет сетей и блоков) -> `{ networks: [], blocks: [] }`.
- Результат, доступ: 401 без токена; 403 для `moderator`; без права тело не
  разбирается и аудит пуст.
- Результат, успех: `owner`, тело `{ network:"adsgram", format:"rewarded", blockId:<uuid
  существующего блока>, live:false, outcome:"completed", ms:14200 }` -> 200
  `{ data:{ok:true} }`; в `MemoryRolesRepository` одна запись аудита с `action:"ads.test"`,
  `target:"adsgram:rewarded"`, `actorAccountId` владельца и `after` равным телу.
- Результат, `failed` с `reason:"no_fill"` -> 200; `failed` без `reason` -> 400;
  `completed` с `reason` -> 400.
- Результат, `blockId: null` у richads/`interstitial` -> 200.
- Результат, строгое тело: лишнее поле -> 400; `ms: 600001`, `ms: -1`, `ms: 1.5` -> 400;
  `format:"task"` -> 400; `network:"taddy"` -> 400; `reason:"foo"` -> 400; `blockId`
  не uuid -> 400.
- Результат, блок: блок другой сети -> 400; блок места с другим форматом -> 400; несуществующий
  uuid -> 400. Аудит не пишется ни в одном из 400.
- Ничего не создаётся: после серии успешных вызовов обеих ручек `MemoryAds.sessions`
  пуст, настройки не менялись, `AdsToolsService` собран без `AdsService`.
- Лимит: после исчерпания лимита ответ 429 и сервис не вызывается (тест — в
  `route-limits.test.ts`).
- `route-limits.test.ts`: два случая `GET /tools/ads/catalog` (scope `ads_tools_catalog`)
  и `POST /tools/ads/test-results` (scope `ads_tools_result`), ключ — аккаунт, по
  образцу `GET /tools/access`.
- `apps/admin/test/audit.test.ts`: `actionTitle("ads.test")` — «Проверка рекламы
  командой»; `auditObject` для `ads.test` с целью `richads:interstitial` даёт
  `kind: "проверка"`, `label: "richads · interstitial"`.
- `scripts/test` / словарь событий: существующие тесты словаря и `pnpm docs:check`
  зелёные после добавления `ad_tested` (валидный payload принимается, лишнее поле нет).

## Аналитика

Новое клиентское событие `ad_tested` (отправляет T-0334; словарь и схема — здесь):
`network`, `format` (`rewarded`|`interstitial`), `live` (боевой показ или тестовый),
`outcome` (`completed`|`closed`|`failed`), `reason` (код отказа, только при `failed`),
`ms` (от нажатия до исхода, миллисекунды). Серверно — JSON-лог `ad_tested` и запись аудита
`ads.test`. В Prometheus ничего нового (метки: нет).

## Настройки и окружение

Новых ключей и переменных нет. Лимиты — константы `ADS_TOOLS_LIMITS` (строка в карте
конфигурации, раздел «Документы»).

## Документы

- `docs/22-analytics-and-metrics.md`: строка `ad_tested` в §3.3 (после
  `ad_reward_claimed`) и упоминание в перечне «Реклама» (~стр. 163); пометка, что
  событие командное и в воронку не входит.
- `docs/29-admin-panel.md`: в строке «Роли и аудит» или «Реклама» — одно предложение:
  проверки рекламы командой пишутся в журнал действием «Проверка рекламы командой».
- `docs/28-diagnostics.md` §2.3: два маршрута `GET /api/v1/tools/ads/catalog` и
  `POST /api/v1/tools/ads/test-results`, право `tools.dev`, ничего не начисляют.
- `docs/30-configuration-map.md`: строка про лимиты проверки рекламы
  (`backend/api/src/modules/ads/ads-tools-limits.ts` -> `ADS_TOOLS_LIMITS`), в конец
  таблицы своей темы.
- `docs/21-diagrams.md`: не требуется (схема БД и связи модулей не меняются); отметить
  в PR.

## Критерии приёмки

- [ ] `GET /tools/ads/catalog` и `POST /tools/ads/test-results` работают по контракту
  из раздела «Сценарий и интерфейс»; 401 без входа, 403 без `tools.dev`, 429 по лимиту.
- [ ] В каталоге только SDK-сети и форматы `rewarded`/`interstitial`; Taddy и `task`
  отсутствуют; выключенные сети и блоки присутствуют с `active: false`; наружу идут
  только ключи из профиля.
- [ ] Проверка права и лимита идёт до разбора тела; тело строгое (Zod `.strict()`).
- [ ] Исход пишется в аудит (`ads.test`, цель `<сеть>:<формат>`, `after` — тело) и в
  JSON-лог; ответ `200 { data: { ok: true } }`.
- [ ] `AdsToolsService` не зависит от `AdsService`/`ADS_REPOSITORY`; `ad_session`,
  кулдауны, настройки не затронуты (тест).
- [ ] Событие `ad_tested` в словаре, Zod-схеме и `docs/22` §3.3.
- [ ] Подпись и ссылка записи аудита в `apps/admin` показывают «Проверка рекламы командой».
- [ ] Гейт (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm budget`) и
  `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Проверка рекламы командой — каталог и журнал`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОВЕРКА РЕКЛАМЫ КОМАНДОЙ: СЕРВЕР**

  Для проверки рекламы появились две серверные ручки: каталог SDK-сетей и блоков (в том числе выключенных) и приём исхода проверки в журнал действий. Показ ничего не начисляет и не создаёт сессий.

  🛠 **Что сделано**

  • каталог сетей и блоков для тех, у кого есть право инструментов разработчика
  • исход проверки пишется в журнал действий («Проверка рекламы командой») и в лог
  • событие аналитики ad_tested добавлено в словарь
  • лимит частоты на обе ручки

  ❓ **Нужно от команды**

  • @участник1 — после влития задачи T-0334 экран в игре заработает
  ```
