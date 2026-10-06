---
id: T-0015
title: Общая плашка «Нет связи с сервером»
epic: E6
priority: P1
status: ready
owner:
size: M
depends_on: []
zones:
  - packages/app-shell/src/state/connection.ts
  - packages/app-shell/src/state/api-request.ts
  - packages/app-shell/src/design-system/components/ConnectionBanner.tsx
  - packages/app-shell/src/design-system/components/Layout.tsx
  - packages/app-shell/src/app/AppHeader.tsx
  - packages/app-shell/test/connection.test.ts
shared:
  - packages/app-shell/src/i18n/ru.json
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
  - docs/30-configuration-map.md
  - scripts/bundle-budget.mjs
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/screens/home.html
---

# T-0015. Общая плашка «Нет связи с сервером»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0015.json)](README.md#значки-статуса)

## Зачем

Когда нет связи с API, игрок узнаёт об этом, только открыв конкретный экран:
каждый экран показывает свою ошибку, и непонятно, что сломалось и что ещё
работает (замечание пользователя от 02.10, `tasks/inbox.md`; аудит 06.10). После
задачи потеря связи видна сразу: одна плашка на всё приложение объясняет, что
работает (забег), что нет (награды, магазин, друзья), и даёт «Повторить».

## Решения

- **Одна плашка на всё приложение.** Её рисует общий компонент экрана
  `Screen`, первой строкой прокрутки: на экранах разделов — под шапкой, на
  внутренних — под заголовком. Плашка прилипает (`sticky`) и не уезжает при
  прокрутке. Экраны ничего для этого не делают. В забеге плашки нет: забег
  работает без сети.
- **Что считается «нет связи»:**
  - обрыв сети или таймаут — `apiRequest` возвращает `offline`;
  - ответ шлюза 502, 503 или 504: сервер API недоступен;
  - событие браузера `offline`.

  **Любой другой ответ сервера, даже ошибка 4xx или 500, — связь есть**:
  сервер ответил, и у экрана своя ошибка.
- **Порог.** «Нет связи» — после двух сбоев подряд в пределах 30 секунд или
  сразу по событию `offline`. Один сбой — это ещё не потеря связи: так плашка
  не мигает от одного медленного запроса.
- **Возвращение связи.**
  - любой успешный ответ или ответ с ошибкой от сервера — сразу «связь есть»;
  - пока связи нет, раз в 20 секунд идёт проверочный запрос;
  - событие браузера `online` и кнопка «Повторить» запускают проверку
    немедленно.

  Проверка — `GET /api/v1/me/badges` через `apiRequest`: он лёгкий, лимит —
  600 в час на аккаунт. У гостя без сессии проверочного запроса нет, гостю
  достаточно `navigator.onLine`.
- **Шапка.** Пока связи нет, фишки валют приглушены (`opacity-60`): числа
  последние известные, а не текущие.
- **Тексты** (в `ru.json`: плашка нужна с первого кадра и без сети, а не из
  ленивого словаря — исключение из правила «Общие файлы» для этого компонента):
  - `connection.offline.title` — «Нет связи с сервером»;
  - `connection.offline.text` — «Забег работает. Награды, магазин и друзья —
    когда связь вернётся.»;
  - `connection.retry` — «Повторить»;
  - `connection.checking` — «Проверяем…»: подпись кнопки, пока идёт проверка.
- **Вид** — по макету `design/screens/home.html`, состояние 4 и компонент
  «Плашка связи»:
  - фон `warning` на 10 % прозрачности;
  - рамка `warning` на 45 %;
  - значок-треугольник `warning` слева;
  - кнопка `secondary` размера `m` справа;
  - скругление `--radius-lg`, отступы 10 × 12 px.

  Появляется и скрывается анимацией прозрачности `--duration-base` (правило
  §3.3 `docs/27`).

## Как сейчас

- `packages/app-shell/src/state/api-request.ts`:
  - `apiRequest` — единая точка запросов игрока к API;
  - сбой `fetch` → `{ ok: false, failure: "offline" }`;
  - статус → `failureOf(status)` (около строки 107): 502, 503 и 504 сейчас
    попадают в `unavailable`.
- `packages/app-shell/src/design-system/components/Layout.tsx`, `Screen` (строка
  24): `TopBar`, затем прокрутка
  `px-4 pt-[var(--app-header-h)] pb-4`, затем `footer`.
  `--app-header-h` — высота шапки разделов, внутри раздела — 0.
- `packages/app-shell/src/app/AppHeader.tsx` — шапка разделов с фишками валют.
- Состояние в оболочке — сторы zustand в `state/*.ts`. Образец маленького
  стора — `state/feedback.ts`.
- Аналитика: `track(…)` из `state/telemetry.ts`. Отчёты копятся в очереди и
  уходят, когда связь есть.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **Аналитика — сначала словарь.**
   - `docs/22-analytics-and-metrics.md` §3.3: строка `connection_lost`,
     `connection_restored` — потеря и возвращение связи с API, поле
     `downtimeSec` у возвращения;
   - `event-dictionary.ts`:

     ```ts
     connection_lost: { version: 1, payload: payload({}) },
     connection_restored: { version: 1, payload: payload({ downtimeSec: z.number().int().nonnegative() }) },
     ```

     По образцу соседних событий; если `payload` и числа устроены иначе —
     повторить устройство соседей.
3. **Новый `state/connection.ts`.**
   - Стор `{ status: "online" | "offline"; since: number | null; checking: boolean }`.
   - Чистая функция переходов, тестируемая без таймеров:

     ```ts
     export type Signal = { kind: "fail"; at: number } | { kind: "reachable"; at: number } | { kind: "browser_offline"; at: number } | { kind: "browser_online"; at: number };
     export function nextConnection(state: ConnectionState, signal: Signal): ConnectionState
     ```

     В состоянии — счётчик сбоев и время первого из них. Правила — из
     «Решений»: два сбоя за 30 с или `browser_offline` → `offline`;
     `reachable` → `online`, счётчик сброшен.
   - `reportReachability(kind, at = Date.now())` — вызывает `nextConnection` и
     на переходах шлёт `track("connection_lost", {})` и
     `track("connection_restored", { downtimeSec })`.
   - Проверка при `offline`:
     - таймер раз в 20 с — `apiRequest("/api/v1/me/badges", схема без полей, { method: "GET" })`.
       Результат сам дойдёт сюда через шаг 4, разбирать его не нужно;
     - `retryConnection()` — проверить сейчас, `checking: true` на время запроса.
   - Подписка на `window` `online` и `offline` — один раз, при первом
     импорте стора. Таймер живёт, только пока `offline`.
4. **`api-request.ts`.** В `apiRequest`:
   - сбой `fetch` → `reportReachability("fail")`;
   - ответ со статусом 502, 503 или 504 → `reportReachability("fail")`;
   - любой другой ответ сервера (включая 4xx и 500) → `reportReachability("reachable")`;
   - `response === null` (нет сессии) — ничего.

   Модуль `connection.ts` подключается статически: он маленький и нужен с
   первого кадра. `failureOf` не менять.
5. **Новый `design-system/components/ConnectionBanner.tsx`:**
   - читает `useConnection`;
   - при `offline` рисует плашку из «Решений», при `online` — ничего;
   - кнопка — `retryConnection()`, при `checking` — подпись «Проверяем…» и
     состояние загрузки;
   - `role="status"` и `aria-live="polite"`.
6. **`Layout.tsx`, `Screen`.** Первой строкой внутри прокрутки —
   `<ConnectionBanner />`. Обёртка с прилипанием — внутри самого компонента:
   `<div className="sticky top-0 z-10 -mx-4 px-4 pb-3">…</div>`. Пока связь
   есть, компонент возвращает `null` и места не занимает. Прилипает под
   шапкой разделов: у прокрутки уже есть отступ `--app-header-h`. Если
   `sticky` с этим отступом ведёт себя иначе — подобрать по снимку и описать
   в PR.
7. **`AppHeader.tsx`.** При `offline` — `opacity-60` и
   `transition-opacity` на фишках валют.
8. **Бюджет.** Стор и плашка — в первой загрузке. Порог «Первая загрузка» в
   `scripts/bundle-budget.mjs` разрешено поднять **не больше чем на 0,6 КБ**:
   с объяснением рядом с порогом и строкой в таблице бюджета
   `docs/27-design-system-and-app-shell.md` §3.4. Если нужно больше — вопрос
   тимлидам.
9. **Документы:**
   - `docs/27` §4.6 (компоненты) — строка о `ConnectionBanner`: одна плашка на
     приложение, когда показывается и что значит;
   - `docs/30-configuration-map.md` — строка: порог два сбоя за 30 с и
     проверка раз в 20 с — константы в `state/connection.ts`.
10. **Гейт и снимки.** Снимки на 320 и 390 px — в PR:
    - главная без сети;
    - внутренний экран без сети (например, магазин);
    - главная, когда связь вернулась.

    Без сети проще всего проверить, остановив API в dev.

## Чего не трогаем

- Собственные ошибки экранов (`ErrorState`, `SyncProblem`): они остаются для
  ошибок, когда сервер ответил. Общие компоненты загрузки и пустых состояний —
  отдельная задача E6.
- Очередь отчётов и забегов: они и так ждут связь.
- Забег и экраны без `Screen` (заставка, ворота).

## Сценарий и интерфейс

1. Игрок на главной, сеть пропала.
2. После двух неудачных запросов или по событию браузера под шапкой
   появляется плашка «Нет связи с сервером». Валюты в шапке приглушены.
3. Игрок переходит в магазин — плашка там же, под заголовком.
4. «Повторить» → «Проверяем…» → связи нет — плашка остаётся. Связь есть —
   плашка исчезает, валюты снова яркие.
5. «Играть» работает всё это время.

## Тесты

Первым коммитом, `packages/app-shell/test/connection.test.ts`. Таймеры не
нужны: тестируется `nextConnection` и обвязка с подменами.

- **`nextConnection`:**
  - один `fail` → `online`;
  - два `fail` за 10 с → `offline`;
  - два `fail` с разницей 40 с → `online`;
  - `browser_offline` → сразу `offline`;
  - из `offline` по `reachable` → `online`, счётчик сброшен;
  - `browser_online` сам по себе статус не меняет (только запускает
    проверку).
- **Классификация ответа в `apiRequest`** (подмена `authorizedFetch` по образцу
  существующих тестов `api-request`, если они есть, иначе — новая):
  - `fetch` бросает → сигнал `fail`;
  - 503 → `fail`;
  - 500 → `reachable`;
  - 404 → `reachable`;
  - 200 → `reachable`.
- **События:** переход в `offline` — один `connection_lost`; возвращение
  через 90 с — `connection_restored` с `downtimeSec: 90`; повторные `fail` в
  `offline` событий не шлют.

## Аналитика

`connection_lost` и `connection_restored` — шаг 2. По ним видно, как часто у
игроков пропадает связь и на сколько.

## Настройки и окружение

Нет. Пороги — константы `state/connection.ts`, строка в `docs/30` — шаг 9.

## Документы

Шаг 9, плюс строка в `docs/22` — шаг 2.

## Критерии приёмки

- [ ] Без связи плашка видна на любом экране с `Screen` сразу, без захода на конкретный экран.
- [ ] Ответ сервера с ошибкой (4xx, 500) плашку не показывает; обрыв, таймаут, 502–504 и событие `offline` — показывают.
- [ ] Один медленный запрос плашку не включает: нужен второй сбой за 30 с.
- [ ] «Повторить» проверяет связь сразу; связь вернулась — плашка исчезает сама.
- [ ] События `connection_lost` и `connection_restored` есть в словаре и пишутся.
- [ ] Первая загрузка выросла не больше чем на 0,6 КБ, порог поднят с объяснением.
- [ ] Снимки — в PR.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Общая плашка «Нет связи с сервером»`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: Если пропала связь с сервером, игра сразу скажет об этом и объяснит, что работает, а что вернётся вместе со связью.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПЛАШКА «НЕТ СВЯЗИ С СЕРВЕРОМ»**

  Потерю связи с API игрок теперь видит сразу: одна плашка на всё приложение говорит, что забег работает, а награды, магазин и друзья вернутся вместе со связью, и даёт «Повторить». Ошибка сервера при этом не путается с потерей связи. События connection_lost и connection_restored показывают, как часто у игроков пропадает связь.
  ```
