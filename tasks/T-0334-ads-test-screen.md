---
id: T-0334
title: Проверка рекламы командой — экран в игре и debug на вызов в адаптере
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0333]
zones:
  - packages/app-shell/src/screens/settings.tsx
  - packages/app-shell/src/screens/ads-check.tsx
  - packages/app-shell/src/screens/ads-check-rules.ts
  - packages/app-shell/src/state/ads-check.ts
  - packages/app-shell/src/i18n/ru-team.json
  - packages/adapter-telegram/src/ads/networks.ts
  - packages/app-shell/test/ads-check-rules.test.ts
  - packages/app-shell/test/ads-check.test.ts
  - packages/adapter-telegram/test/ads-debug.test.ts
  - docs/28-diagnostics.md
shared:
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/state/navigation.ts
  - packages/app-shell/src/app/App.tsx
  - packages/app-shell/src/app/lazy-screens.tsx
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0334. Проверка рекламы командой — экран в игре и debug на вызов в адаптере

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0334.json)](README.md#значки-статуса) [![T-0333](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0333.json&label=T-0333)](T-0333-ads-test-tools-server.md)

## Зачем

Команда не может проверить, показывает ли сеть рекламу на устройстве, не заводя
настоящую сессию выдачи: та двигает кулдауны, паузу сетей и воронку. Задача
добавляет клиентскую часть решения Р165: экран «Проверка рекламы» в «Помощи в
тестировании» (право `tools.dev`), который показывает выбранный блок напрямую
через адаптер, и правку адаптера, чтобы режим «тестовый или боевой» действовал
на один вызов, а не навсегда.

## Решения

- **Р165** (`docs/35-stage4-plan.md`): раздел «Проверка рекламы» у `tools.dev`;
  по умолчанию тестовый показ сети (debug только на вызов), боевой — по
  галочке с предупреждением; показ ничего не трогает: сессии нет, наград,
  кулдаунов, капа и воронки нет; исход — на экране, событием аналитики и в
  аудите. Первая версия: SDK-сети, форматы «за награду» и «межстраничная».
  Taddy и задания — не здесь.
- Серверная часть — T-0333 (зависимость): `GET /api/v1/tools/ads/catalog`,
  `POST /api/v1/tools/ads/test-results`, событие `ad_tested` в словаре. Эта
  задача только вызывает их. Если форма ответа в T-0333 отличается от
  описанной ниже, исполнитель сверяет по влитому T-0333, а не домысливает.
- Показ идёт **напрямую** через `adapter.showAd` без `POST /ads/sessions`.
- Тексты команды — в `ru-team.json` (как у звуковой лаборатории), не в `ru.json`.
  Исключение — две строки пункта списка в `TestersScreen`: он не грузит
  командный словарь (`i18n/team`), по образцу `testers.soundLab` они лежат в
  `ru.json` (в `shared`).
- Репозиторий публичный: в текстах и комментариях правила сетей пишутся
  нейтрально («свои клики сеть считает недействительными»), без подробностей.

## Как сейчас

Проверить строки по коду: они могли сдвинуться.

- `packages/shared-types/src/index.ts` (~51–90, 269): `AdShowRequest` =
  `{ network, blockId: string | null, format: "rewarded" | "interstitial" |
  "task", keys, debug?, readyWithinMs? }`; `AdShowOutcome` = `completed` |
  `closed` | `failed { reason: AdFailureReason }`; `PlatformAdapter.showAd?`.
- `packages/app-shell/src/state/ad-watch.ts`: `browserDeps()` (экспорт) отдаёт
  `show` (= `adapter.showAd.bind(adapter)`, `undefined` на площадке без
  рекламы), `mute` (звук игры молчит на время ролика), `track`, `now`.
  `adsPlayable()` — есть ли показ у площадки. Логику мест не трогаем: экран
  берёт готовое.
- `packages/app-shell/src/state/tools.ts`: `useToolsAccess()` →
  `{ admin, stressTest, devMode }`; `admin` = право `tools.dev`.
- `packages/app-shell/src/state/api-request.ts`: `apiRequest(path, schema,
  { method, body? })` под сессией; ответ обязан быть `{ data: ... }`, иначе
  `failure: "unavailable"` (ответ 204 без тела тоже даст такой отказ — для
  отправки результата это допустимо, см. шаг 3). Образец обёртки —
  `createAdsApi` в `state/ads-api.ts`.
- `packages/app-shell/src/screens/settings.tsx` (~255–295): `TestersScreen`,
  в `{access.admin ? ... }` лежит пункт `testers.soundLab`.
- `packages/app-shell/src/state/navigation.ts` (~27–32): `ScreenId`;
  `app/App.tsx` (~225–236): `renderScreen`; `app/lazy-screens.tsx` (~40, 91):
  `loaders` и `screen(...)`. Образец экрана команды — `screens/sound-lab.tsx`
  (`import "../i18n/team"`).
- `packages/app-shell/src/i18n/index.ts`: `formatDecimal(value, max)` не
  добавляет хвостовой ноль (`3` вместо `3,0`), поэтому секунды в исходе
  форматируются своим `Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1,
  maximumFractionDigits: 1 })` в `ads-check-rules.ts`.
- `packages/app-shell/src/state/analytics.ts`: список `ANALYTICS_EVENTS`.
  Тест `scripts/test/event-dictionary.test.ts` требует, чтобы клиентский список
  совпадал с серверным словарём. Имя `ad_tested` в оба списка должен внести
  T-0333 (иначе его PR красный); здесь событие только отправляется через
  `track("ad_tested", ...)`. Если после влития T-0333 `ad_tested` в
  `ANALYTICS_EVENTS` нет — это вопрос тимлиду, не правка «заодно».
- `packages/adapter-telegram/src/ads/networks.ts`: `createAdsgram()` (~130–161)
  кэширует контроллер в `Map` по `blockId` — `init({ blockId, debug })` один
  раз, потому вызов с другим `debug` идёт со старым режимом. `createRichads()`
  (~212–237) хранит `controller = { key: "pubId:appId", instance }` и
  `initialize({ pubId, appId, debug })` один раз на пару ключей — та же беда.
  `createAdsonar()` (~168–203) кладёт `isDebug=true` в адрес скрипта, а скрипт
  грузится один раз за запуск (`ensureScript`), поэтому режим AdSonar задаёт
  первый показ после запуска игры.
- `packages/adapter-telegram/src/ads/ad-shower.ts` (~61): `debug` берётся из
  `request.debug === true` на каждый вызов; `busy` не даёт два показа разом.
- Тесты адаптера — `packages/adapter-telegram/test/ads.test.ts` (поддельные
  SDK: `fakeLoader`, `adsgramController`). В новом файле хелперы повторяются
  копией, существующий файл не правим.

## Шаги по порядку

1. **Адаптер, `networks.ts`.** Режим входит в ключ кэша:
   - AdsGram: ключ `Map` — `` `${request.blockId}|${env.debug ? "debug" : "live"}` ``;
     `init` вызывается один раз на ключ;
   - RichAds: `key = ` `` `${pubId}:${appId}:${env.debug ? "debug" : "live"}` ``;
     смена режима создаёт новый `TelegramAdsController` и вызывает
     `initialize` с новым `debug`;
   - AdSonar не меняется (скрипт грузится один раз). Поведение обычных
     показов игроков не меняется: у игрока режим по слову сервера один и
     тот же, ключ кэша тот же, что и раньше, кроме случая смены настройки.
   - Комментарий у обеих правок — на русском, «почему»: проверка командой
     идёт в обоих режимах за один запуск.
2. **Чистые правила, `screens/ads-check-rules.ts`** (без React). Типы и
   функции:
   - `type AdsCheckFormat = "rewarded" | "interstitial"`;
   - `interface AdsCheckNetwork { network: string; name: string; active:
     boolean; keys: Record<string, string>; formats: AdsCheckFormat[] }`;
   - `interface AdsCheckBlock { blockId: string; network: string; place:
     string; format: AdsCheckFormat; externalId: string | null; active:
     boolean; platforms: string[] }`;
   - `groupCatalog(networks, blocks): { network: AdsCheckNetwork; blocks:
     AdsCheckBlock[] }[]` — порядок сетей как в ответе, блоки внутри по
     `place`, затем по `blockId`; блок без сети в списке сетей пропускается;
     сеть без блоков остаётся (пустая группа);
   - `showRequestOf(block, network, options: { live: boolean; startLike:
     boolean }): AdShowRequest` — `network: block.network`, `blockId:
     block.externalId`, `format: block.format`, `keys: network.keys`, `debug:
     !options.live`; `readyWithinMs: 2000` только если `block.format ===
     "interstitial"` и `options.startLike`, иначе ключа нет вовсе;
   - `outcomeLabel(outcome: AdShowOutcome, ms: number): string` — тексты
     ниже, секунды с одним знаком;
   - `testResultOf(block, outcome, live, ms)` → тело `POST /tools/ads/test-results`:
     `{ network, format, blockId: block.blockId, live, outcome: outcome.kind,
     ms }` плюс `reason` только при `failed`; `ms` округляется и зажимается в
     `0..600000`;
   - `testedEventOf(...)` → полезная нагрузка `ad_tested`: `{ network, format,
     live, outcome, ms }` и `reason` только при `failed` (без ключа, не
     `null`).
   Тексты (ключи в `ru-team.json`, префикс `adsCheck.`):
   - `adsCheck.title`: «Проверка рекламы»;
   - `adsCheck.intro`: «Показ рекламы сети одной кнопкой: без забега, награды и записи выдачи. Исход виден здесь и уходит в журнал команды.»;
   - `adsCheck.unsupported`: «Показ SDK-рекламы есть только в Telegram»;
   - `adsCheck.loading`: «Загружаем сети и блоки…»;
   - `adsCheck.error`: «Не удалось загрузить сети и блоки.»; `adsCheck.retry`: «Повторить»;
   - `adsCheck.empty`: «Сетей с показом через SDK нет.»;
   - `adsCheck.live`: «Боевой показ»; `adsCheck.live.hint`: «Выключено — тестовый показ: сеть его не засчитывает.»;
   - `adsCheck.live.warning`: «Боевой ролик: не нажимай на объявление — свои клики сеть считает недействительными»;
   - `adsCheck.startLike`: «Как при старте забега (2 с на подготовку)»; `adsCheck.startLike.hint`: «Только для межстраничной: не успела за 2 секунды — исход «late».»;
   - `adsCheck.network.off`: «выключена»; `adsCheck.block.off`: «выключен»;
   - `adsCheck.sonarNote`: «Режим AdSonar (тестовый или боевой) задаёт первый показ после запуска игры. Чтобы сменить, перезапусти игру.»;
   - `adsCheck.format.rewarded`: «За награду»; `adsCheck.format.interstitial`: «Межстраничная»;
   - `adsCheck.place.second_chance`: «Второй шанс»; `adsCheck.place.wheel_spin`: «Колесо»; `adsCheck.place.run_double`: «Удвоение награды»; `adsCheck.place.interstitial`: «Межстраничная»; незнакомое место показывается как есть (id);
   - `adsCheck.block.id`: «Блок: {id}»; `adsCheck.block.noId`: «Блок: по ключам сети»;
   - `adsCheck.show`: «Показать»; `adsCheck.showing`: «Показываем…»;
   - `adsCheck.outcome.completed`: «Досмотрел · {sec} с»; `adsCheck.outcome.closed`: «Закрыл · {sec} с»; `adsCheck.outcome.noFill`: «Нет рекламы · {sec} с» (для `failed` с причиной `no_fill`); `adsCheck.outcome.failed`: «Ошибка: {reason} · {sec} с» (остальные причины, `reason` — код как есть: `busy`, `late`, `sdk_error`…).
   В `ru.json` (shared) — две строки пункта: `testers.adsCheck`: «Проверка рекламы», `testers.adsCheck.hint`: «Показать рекламу сети или блока без забега и наград.».
3. **Запросы и запуск, `state/ads-check.ts`.**
   - Zod-схемы ответа каталога (`z` из `zod/mini`, как в `ads-api.ts`):
     `{ networks: [{ network, name, active, keys: record(string,string),
     formats: array(enum["rewarded","interstitial"]) }], blocks: [{ blockId,
     network, place, format, externalId: nullable(string), active,
     platforms: array(string) }] }`. Ответ — граница системы: разбор схемой, не
     `as`.
   - `createAdsCheckApi(request: ApiRequest = apiRequest)`: `catalog()` —
     `GET /api/v1/tools/ads/catalog`; `sendResult(body)` — `POST
     /api/v1/tools/ads/test-results` со схемой `z.unknown()`. Ответ
     отправки не читается: 204 даст `unavailable`, и это не ошибка для экрана.
   - `runAdCheck(deps, block, network, options)`: `deps = { show: AdShow |
     undefined; mute; now; track; api }`. Нет `show` → исход `failed
     "unsupported"` без вызова. Иначе: `startedAt = now()`; `outcome = await
     mute(() => show(request))`; `ms = now() - startedAt`; затем
     `track("ad_tested", testedEventOf(...))` и `void api.sendResult(...)
     .catch(() => undefined)` — отказ отправки показ не ломает и не
     блокирует. Возвращает `{ outcome, ms }`.
   - `browserAdsCheckDeps()` собирает deps из `browserDeps()` из
     `ad-watch.ts` (`show`, `mute`, `track`, `now`) и `createAdsCheckApi()`.
     Файл `ad-watch.ts` не правится.
4. **Экран, `screens/ads-check.tsx`** (`export function AdsCheckScreen`,
   `import "../i18n/team"`, образец — `sound-lab.tsx`; компоненты —
   `design-system/components`).
   - Заголовок `adsCheck.title`, назад — `navigation.pop()`.
   - Без `useToolsAccess().admin` экран сразу возвращает пустое состояние
     «доступа нет» (`navigation.pop()` в эффекте); сервер всё равно проверяет
     право сам, это не защита.
   - Не `adsPlayable()` → одна строка `adsCheck.unsupported`, без кнопок и без
     запроса каталога.
   - Иначе грузит каталог (`createAdsCheckApi().catalog()`): загрузка →
     `adsCheck.loading`; отказ → `ErrorState`/текст `adsCheck.error` и кнопка
     `adsCheck.retry`; пусто → `adsCheck.empty`.
   - Сверху два переключателя (`ListItem` с `toggle`): «Боевой показ»
     (по умолчанию выключен; при включении под ним `adsCheck.live.warning`,
     `InfoNotice`) и «Как при старте забега» (по умолчанию выключен).
   - Группы по `groupCatalog`: заголовок сети (`SectionTitle`: имя, и «выключена»
     при `active === false`); для AdSonar — строка `adsCheck.sonarNote`. В
     строке блока: место, формат, `adsCheck.block.id` / `noId`, метка
     «выключен» при `active === false`, кнопка «Показать», под ней исход
     последнего показа (`outcomeLabel`).
   - Пока идёт показ, **все** кнопки неактивны, на нажатой — `adsCheck.showing`.
     Одновременный второй показ невозможен и на уровне кода: флаг «идёт
     показ» проверяется в обработчике (а `busy` от шоуера — тоже обычный
     исход `failed busy`).
   - Исход живёт только в состоянии экрана (по `blockId`); при повторном показе
     прежняя строка исхода очищается.
   - Вёрстка: переносы строк без обрезания, кнопки не меньше 44 px, отступы от
     выреза — `--app-inset-*` (через `Screen`/`ContentColumn`), горизонтальной
     прокрутки на 320 px нет. Анимируются только `transform`/`opacity`.
5. **Навигация.** `navigation.ts`: `"adsCheck"` в `ScreenId`; `lazy-screens.tsx`:
   `adsCheck: () => import("../screens/ads-check")` и `export const
   AdsCheckScreen = screen(loaders.adsCheck, "AdsCheckScreen")`; `App.tsx`:
   `case "adsCheck": return <AdsCheckScreen />;`; `settings.tsx`: в
   `TestersScreen` под `{access.admin ? ... }` рядом с лабораторией звука
   пункт `ListItem` (`testers.adsCheck`, `testers.adsCheck.hint`,
   `navigation.push("adsCheck")`).
6. **Документ.** `docs/28-diagnostics.md`: в §2 коротким подразделом «Проверка
   рекламы» — где экран, кому открыт (`tools.dev`), что показ идёт мимо
   сессий, тестовый по умолчанию, куда пишется исход (экран, `ad_tested`,
   журнал действий); ссылка на Р165.
7. Гейт из `CLAUDE.md`, затем снимки экрана (раздел «Тесты»).

## Чего не трогаем

- `state/ad-watch.ts` и логику мест рекламы; `state/ads-api.ts`;
- серверную выдачу `POST /ads/sessions` и всё в `backend/` (это T-0333);
- Taddy (креатив по API) и задания сетей, формат `task`;
- глобальную настройку `ads.test-mode`;
- `ad-shower.ts`, `createAdsonar()`: поведение AdSonar не меняется;
- `ANALYTICS_EVENTS` в `state/analytics.ts` и словарь событий — их ведёт T-0333;
- `ru.json` — кроме двух строк пункта списка;
- вайп, воронку, сводку и отчёты рекламы: команду из них не исключаем (Р165).

## Сценарий и интерфейс

Макета нет (`design: null`): экран собирается из существующих компонентов
«Помощи в тестировании», по образцу звуковой лаборатории.

1. Участник с `tools.dev` открывает «Настройки → Помощь в тестировании → Проверка
   рекламы».
2. Видит переключатели и сети с блоками, нажимает «Показать» у нужного блока.
3. Ролик показывается как игроку; после него в строке блока — исход:
   «Досмотрел · 14,2 с», «Закрыл · 3,0 с», «Нет рекламы · 0,8 с», «Ошибка:
   sdk_error · 3,1 с».

Состояния: загрузка каталога; ошибка загрузки (с «Повторить»); пусто; нет
SDK-рекламы на площадке (одна строка); идёт показ (кнопки неактивны); нет сети
при отправке результата (на экране ничего не меняется); у выключенных сетей и
блоков метка «выключена»/«выключен», показать их можно.

## Тесты

Пишутся первым коммитом, до кода.

- `packages/app-shell/test/ads-check-rules.test.ts`:
  - `outcomeLabel({ kind: "completed" }, 14_200)` → «Досмотрел · 14,2 с»;
    `closed` при 3000 → «Закрыл · 3,0 с»; `failed no_fill` при 800 →
    «Нет рекламы · 0,8 с»; `failed sdk_error` при 3100 → «Ошибка: sdk_error ·
    3,1 с»; `failed busy` → «Ошибка: busy · …»;
  - `showRequestOf`: тестовый (`live: false`) → `debug: true`; боевой →
    `debug: false`; `blockId` = `externalId` (в том числе `null`); `keys` из
    сети; `readyWithinMs: 2000` только у `interstitial` при `startLike`, у
    `rewarded` при `startLike` ключа нет, у `interstitial` без `startLike` нет;
  - `testResultOf`/`testedEventOf`: `reason` только у `failed` (без ключа у
    остальных); `ms` 700000 → 600000, -5 → 0, 1234.6 → 1235;
  - `groupCatalog`: порядок сетей и блоков, блок без сети пропущен, сеть без
    блоков остаётся, выключенные не отфильтровываются.
- `packages/app-shell/test/ads-check.test.ts`:
  - `runAdCheck` с поддельными `show`, `mute`, `now`, `track`, `api`: исход
    `completed` → `track("ad_tested", ...)` один раз с нужной нагрузкой и один
    `sendResult` с нужным телом; вызов `show` обёрнут в `mute`; `ms` равен
    разности `now`;
  - `sendResult` отклоняет/возвращает отказ → `runAdCheck` всё равно
    возвращает исход, исключения нет;
  - `show === undefined` → `failed unsupported`, `show` не звался, событие
    отправлено;
  - каталог: `createAdsCheckApi` с подставленным `request` обращается к
    `/api/v1/tools/ads/catalog` (GET) и `/api/v1/tools/ads/test-results`
    (POST); схема каталога отвергает ответ с неизвестным форматом блока;
  - `AdsCheckScreen` не показывает кнопок без `access.admin`, и на площадке
    без `showAd` показывает только строку «Показ SDK-рекламы есть только в
    Telegram» (кнопок «Показать» нет, каталог не запрашивался); если в
    пакете нет подходящего способа отрисовать экран в тесте, это проверяется
    чистой функцией выбора вида (`adsCheckView(admin, playable, load)` в
    `ads-check-rules.ts` → `"denied" | "unsupported" | "loading" | "error" |
    "empty" | "ready"`) — тогда тест на неё.
- `packages/adapter-telegram/test/ads-debug.test.ts` (поддельные SDK по образцу
  `ads.test.ts`):
  - AdsGram: показ с `debug: true`, затем с `debug: false` того же `blockId` →
    `init` вызван дважды: `{ blockId, debug: true }` и `{ blockId, debug:
    false }`; повторный показ в том же режиме `init` не повторяет;
  - AdsGram: сначала боевой, потом тестовый — то же в обратном порядке;
  - RichAds: `initialize` с `debug: true`, затем `debug: false` с теми же
    `pubId:appId` → создано два контроллера, `initialize` вызван дважды с
    нужным `debug`; тот же режим подряд — один раз;
  - обычные показы (режим один и тот же) ведут себя как раньше: существующий
    `ads.test.ts` остаётся зелёным без правок.
- **Снимки экрана** (раздел «Приёмка», блок «Интерфейс» в `tasks/README.md`):
  экран «Проверка рекламы» на 320, 390, 768 и 1440 px, ландшафт 667×375 и
  640×360, состояния: загрузка, ошибка, пусто, не Telegram, готово (с
  выключенной сетью и блоком), боевой показ с предупреждением, идёт показ,
  по одному исходу каждого вида.

## Аналитика

Событие `ad_tested { network, format, live, outcome, reason?, ms }`. Имя
заводит T-0333 (словарь сервера, `ANALYTICS_EVENTS`, `docs/22-analytics-and-metrics.md`
§3.3); здесь оно только отправляется после каждого показа. В метках
Prometheus ничего нового.

## Настройки и окружение

Нет: ни ключей каталога настроек, ни переменных окружения.

## Документы

- `docs/28-diagnostics.md` §2 — подраздел «Проверка рекламы» (шаг 6).
- Схемы `docs/21-diagrams.md`: новых связей между пакетами нет, не меняются.
- Гайдбук игрока не меняется: экран для команды.

## Критерии приёмки

- [ ] Экран «Проверка рекламы» виден только при `access.admin`; без права
      пункта в «Помощи в тестировании» нет.
- [ ] На площадке без `showAd` — строка «Показ SDK-рекламы есть только в
      Telegram», кнопок и запроса каталога нет.
- [ ] Каталог загружается `GET /api/v1/tools/ads/catalog`; группы по сетям,
      выключенные сети и блоки видны с меткой.
- [ ] Показ идёт через `adapter.showAd` с `debug: !live`, `blockId =
      externalId`, `readyWithinMs: 2000` только у межстраничной при галочке;
      `POST /ads/sessions` не вызывается.
- [ ] Боевой показ выключен по умолчанию; при включении виден текст
      предупреждения дословно.
- [ ] Звук игры молчит на время ролика (`mute`); два показа разом невозможны.
- [ ] Исход показан строкой с секундами с одним знаком («3,0 с»), затем
      уходят `POST /api/v1/tools/ads/test-results` и `ad_tested`; ошибка
      отправки показ не ломает.
- [ ] Адаптер: смена режима между вызовами переинициализирует AdsGram (по
      блоку) и RichAds (по паре ключей); тесты на это есть и зелёные;
      существующие тесты адаптера не менялись.
- [ ] Тексты — ключами `adsCheck.*` в `ru-team.json`; в `ru.json` только две
      строки пункта списка.
- [ ] Снимки на 320/390/768/1440 и в ландшафте приложены, ничего не вылезает,
      зоны нажатия не меньше 44 px.
- [ ] Не затронуты `ad-watch.ts`, `backend/`, Taddy, `ads.test-mode`.
- [ ] Ручная проверка владельцем на телефоне (вне автотестов): тестовый и
      боевой показ каждой сети подряд в одном запуске дают разный режим у
      AdsGram и RichAds; для RichAds убедиться, что повторная инициализация
      в другом режиме действительно меняет показ.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Добавить экран проверки рекламы для команды`
- **Метка:** `release: minor`
- **Для игроков:** нет (раздела `## Для игроков` в описании PR нет: экран открыт только команде)
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОБАВИТЬ ЭКРАН ПРОВЕРКИ РЕКЛАМЫ ДЛЯ КОМАНДЫ**

  В «Помощи в тестировании» у права tools.dev появился раздел «Проверка рекламы»: показ выбранной сети, формата и блока одной кнопкой, без забега, наград и записи выдачи.

  🛠 **Что внутри**

  • тестовый показ по умолчанию, боевой — по галочке с предупреждением
  • исход (досмотрел, закрыл, нет рекламы, ошибка, время) на экране, в событии ad_tested и в журнале действий
  • режим тестовый/боевой в AdsGram и RichAds действует на вызов, а не на весь запуск

  ❓ **Нужно от команды**

  • @участник1 — проверить на телефоне по очереди тестовый и боевой показ AdsGram и RichAds
  ```
