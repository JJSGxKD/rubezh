---
id: T-0077
title: «Повторить» на плашке связи отвечает, даже если код проверки не загрузился
epic: E6
priority: P2
status: done
owner: claude-3 / sonnet-5.5 / medium
author: claude-lead2-5
size: S
depends_on: []
zones:
  - packages/app-shell/src/state/connection.ts
  - packages/app-shell/test/connection.test.ts
  - packages/app-shell/test/connection-check.test.ts
shared:
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
version: v0.8
---

# T-0077. «Повторить» на плашке связи отвечает, даже если код проверки не загрузился

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0077.json)](README.md#значки-статуса)

## Зачем

Приёмка PR #267 (T-0015), 13.10. Проверка связи живёт в отдельном чанке
(`api-request.ts`) и подгружается, только когда связь пропала. Если сеть
оборвалась раньше, чем чанк доехал, динамический импорт падает, и «Повторить»
молча не делает ничего: кнопка не меняется, ошибки нет. Игрок жмёт ещё раз и
не понимает, сломана ли игра. Заодно сама проверка и её таймер не покрыты
тестами. После задачи кнопка всегда отвечает «Проверяем…», а потом либо
плашка уходит, либо кнопка снова «Повторить».

## Решения

- **Тексты не меняются.** Игрок видит сценарий T-0015 (шаг 4 его раздела
  «Сценарий и интерфейс»): «Повторить» → «Проверяем…» → связи нет — плашка
  «Нет связи с сервером» остаётся. Ключи `connection.*` в `i18n/ru.json`
  (строки 275-278) не трогаем.
- **Не загрузился чанк проверки = связи по-прежнему нет.** Отдельного сообщения
  нет: важно, что кнопка отозвалась, а плашка осталась.
- **«Проверяем…» включается с нажатия.** Ожидание чанка ограничено 8 секундами
  (как запросы сессии, `AUTH_TIMEOUT_MS`, `state/auth-api.ts:92`): правило
  «каждый `await` внешнего вызова — с таймаутом», иначе зависший импорт оставил
  бы кнопку «Проверяем…» навсегда.
- **Таймер автопроверки не пропадает:** пока связи нет, загрузка чанка
  повторяется раз в `CONNECTION_PROBE_PERIOD_MS` (20 с).
- Подмена загрузчика `setProberForTests` — в духе `setAdContinueDepsForTests`:
  сбой динамического импорта иначе не воспроизвести. Событий не добавляем.

## Как сейчас

- `packages/app-shell/src/state/connection.ts`:
  - строки 77 и 80 — `void prober().then((module) => module.watchConnection(true | false))`
    без обработки отказа: при упавшем импорте таймер не запустится;
  - строка 102 — `const prober = () => import("./api-request");`;
  - строки 105-107 — `retryConnection()`: `prober().then((module) => module.checkConnection())`.
    Импорт упал → промис отклонён, `checking` не выставлен (он ставится внутри
    `checkConnection`), кнопка не меняется;
  - строки 112-115 — `resetConnectionForTests()` с тем же `void prober().then(…)`.
- `packages/app-shell/src/state/api-request.ts:94-122`: `checkConnection()` выходит,
  если связь не «offline» или уже идёт проверка; ставит `checking`; гость (нет
  `capabilities.auth`) запроса не шлёт и считает связь вернувшейся при
  `navigator.onLine`; вошедший спрашивает `GET /api/v1/me/badges`; `checking`
  снимается в `finally`. `watchConnection(on)` ставит `setInterval` на
  `CONNECTION_PROBE_PERIOD_MS` и слушатель `online`; без `window` ничего не делает.
- `ConnectionBanner.tsx:55` — кнопка: `disabled={checking}`, `onClick` → `void retryConnection()`.
- `test/connection.test.ts`: про `watchConnection` только «без окна не падает»
  (147-155); сессия подменена `vi.mock("../src/state/session", …)` (20-25). Среда
  тестов — `node`: `window` и `navigator` подменяются `vi.stubGlobal`
  (образец — `test/run-loading.test.ts:136`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»). Они падают, пока кода нет.
2. **`connection.ts`: загрузчик чанка.**

   ```ts
   interface ProberModule {
     checkConnection(): Promise<void>;
     watchConnection(on: boolean): void;
   }

   /** Сколько ждать чанк проверки: дольше — считаем, что до сервера не достучаться. */
   export const PROBER_LOAD_TIMEOUT_MS = 8_000;

   const defaultProber = (): Promise<ProberModule> => import("./api-request");
   let prober: () => Promise<ProberModule> = defaultProber;

   /** Подмена загрузчика чанка; `null` — вернуть настоящий. */
   export function setProberForTests(loader: (() => Promise<ProberModule>) | null): void {
     prober = loader ?? defaultProber;
   }
   ```

   Старую строку 102 (`const prober = …`) удалить.
3. **`connection.ts`: `loadProber()`** — чанк или `null`:

   ```ts
   async function loadProber(): Promise<ProberModule | null> {
     let timer: ReturnType<typeof setTimeout> | undefined;
     const late = new Promise<null>((resolve) => {
       timer = setTimeout(() => resolve(null), PROBER_LOAD_TIMEOUT_MS);
     });
     try {
       return await Promise.race([prober(), late]);
     } catch {
       // Импорт упал: сеть оборвалась раньше, чем чанк доехал. Связи по-прежнему
       // нет, плашка остаётся, а следующее нажатие попробует загрузить чанк снова.
       return null;
     } finally {
       clearTimeout(timer);
     }
   }
   ```
4. **`connection.ts`: `retryConnection()`** — заменить строки 105-107:

   ```ts
   export async function retryConnection(): Promise<void> {
     const { status, checking } = useConnection.getState();
     if (status !== "offline" || checking) return;
     // Кнопка говорит «Проверяем…» с нажатия, а не с момента, когда доехал
     // чанк: молчащее нажатие хуже честного «связи нет».
     useConnection.setState({ checking: true });
     const module = await loadProber();
     // Флаг снимается до вызова: у проверки в чанке свой флаг и своя защита от повтора.
     useConnection.setState({ checking: false });
     await module?.checkConnection();
   }
   ```
5. **`connection.ts`: `watchProbe(on)`** вместо трёх мест с `void prober().then(…)`
   (строки 77, 80 и 114):

   ```ts
   let reloadTimer: ReturnType<typeof setTimeout> | null = null;

   /** Включить или выключить таймер проверки, который живёт в чанке. */
   function watchProbe(on: boolean): void {
     prober()
       .then((module) => module.watchConnection(on))
       .catch(() => {
         // Чанк не доехал, а связи нет: без него таймер не заработает, поэтому
         // пока связь не вернулась, грузим чанк снова раз в период проверки.
         // Выключать нечего: таймер, которого нет, уже выключен.
         if (!on || reloadTimer !== null || useConnection.getState().status !== "offline") return;
         reloadTimer = setTimeout(() => {
           reloadTimer = null;
           if (useConnection.getState().status === "offline") watchProbe(true);
         }, CONNECTION_PROBE_PERIOD_MS);
       });
   }
   ```

   В `apply` — `watchProbe(true)` при потере и `watchProbe(false)` при возвращении
   связи; в `resetConnectionForTests` — сначала `clearTimeout(reloadTimer)` и
   `reloadTimer = null`, потом `watchProbe(false)`.
6. **`docs/27-design-system-and-app-shell.md`, строка `ConnectionBanner` таблицы
   компонентов:** после ««Повторить» проверяет сразу, пока связи нет — раз в 20
   секунд.» добавить: «Кнопка говорит «Проверяем…» с нажатия; если код проверки не
   загрузился (сеть оборвалась раньше), через отказ или 8 секунд она снова
   «Повторить», а плашка остаётся.»
7. `connection.ts` едет в первой загрузке: прирост байт из `pnpm budget` записать в PR.
   **Порог не двигать**: не проходит — стоп и вопрос тимлиду.

## Чего не трогаем

- `api-request.ts`, `ConnectionBanner.tsx`, словари, `nextConnection`: поведение
  и тексты прежние, меняется только загрузка чанка в `connection.ts`.
- Абзац про стоимость плашки в `docs/27` §3.4 (арифметика бюджета и порог):
  отдельная находка той же приёмки.
- Обход возможного кеширования сбойного импорта браузером (смена адреса чанка):
  если после возврата сети кнопка не оживает до перезагрузки — новая задача.

## Сценарий и интерфейс

Сеть пропала: под шапкой плашка «Нет связи с сервером» и «Повторить». Нажатие →
кнопка сразу «Проверяем…» и неактивна. Сервер ответил (даже ошибкой) → плашка
гаснет. Сервер молчит или код проверки не загрузился (отказ сразу или через 8
секунд) → снова «Повторить», плашка на месте. Макета нет.

## Тесты

Первым коммитом. Подмена чанка — `setProberForTests` (возврат в `afterEach`:
`setProberForTests(null)`), время — `vi.useFakeTimers()` / `vi.useRealTimers()`,
потеря связи — `reportBrowserOffline()` или два `reportReachability("fail", t)`.
Сама потеря связи тоже грузит чанк: счёт вызовов загрузчика обнулять
(`mockClear()`) после перевода в `offline`.

`packages/app-shell/test/connection.test.ts`, описание «кнопка «Повторить» и
загрузка чанка проверки»:

- чанк упал (`() => Promise.reject(new Error("Failed to fetch"))`): сразу после
  `const pending = retryConnection()` `checking` равен `true`; `await pending` не
  бросает; затем `checking` `false`, статус `"offline"`;
- чанк не отвечает (промис без завершения): после `PROBER_LOAD_TIMEOUT_MS - 1`
  `checking` ещё `true`, после `PROBER_LOAD_TIMEOUT_MS` — `false`, статус
  `"offline"`, `pending` завершён;
- чанк загрузился: `checkConnection` вызван один раз, и в его теле
  `useConnection.getState().checking` равен `false`;
- связь есть, или проверка уже идёт (`useConnection.setState({ checking: true })`):
  загрузчик не вызывается;
- потеря связи при упавшем чанке: ничего не бросает, `connection_lost` один раз,
  загрузчик вызван один раз, через `CONNECTION_PROBE_PERIOD_MS` — второй. Если
  связь вернулась до срока (`reportReachability("reachable", t)`), возвращение
  само зовёт загрузчик (выключить таймер) — это второй вызов, после срока
  третьего нет.

`packages/app-shell/test/connection-check.test.ts` (новый): заглушка сессии как в
`connection.test.ts` (`vi.hoisted` + `vi.mock("../src/state/session", …)`).
`beforeEach`: `resetConnectionForTests()`, затем
`setProberForTests(async () => ({ checkConnection: async () => undefined, watchConnection: () => undefined }))`
(автозапуск таймера мешать не должен); `afterEach`: `watchConnection(false)`,
`setProberForTests(null)`, `vi.unstubAllGlobals()`, `vi.useRealTimers()`. Вошедший:
`initShell({ ...useShell.getState(), capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, auth: { baseUrl: "" } } })`;
гость — то же без `auth`. `navigator` — `vi.stubGlobal("navigator", { onLine: true })`.

- `checkConnection()`:
  - связь есть или `checking: true` → запрос не уходит;
  - вошедший, 200 `{ data: {} }` → `online`, путь `/api/v1/me/badges`; 500 →
    `online` (сервер ответил); 503 и обрыв (`TypeError`) → `offline`; во всех
    `checking` `false`;
  - вошедший без сессии (заглушка вернула `null`): `onLine: true` → `online`,
    `onLine: false` → `offline`;
  - гость: запроса нет; `onLine: true` → `online`, `false` → `offline`;
  - пока запрос висит (отложенный промис), `checking` `true`, второй вызов
    запрос не шлёт;
- `watchConnection()` (окно — `vi.stubGlobal("window", { addEventListener, removeEventListener })`
  на `vi.fn()`; гость, `onLine: true`, `vi.useFakeTimers()`):
  - `watchConnection(true)` дважды → `addEventListener("online", …)` один раз;
  - через `CONNECTION_PROBE_PERIOD_MS - 1` статус `offline`, ещё через 1 мс —
    `online` (`await vi.advanceTimersByTimeAsync(…)`);
  - слушатель `online` (из аргументов `addEventListener`) запускает проверку сразу;
  - `watchConnection(false)` → `removeEventListener("online", тот же слушатель)`;
    после трёх периодов статус, снова переведённый в `offline`, не меняется.

## Аналитика

Нет: `connection_lost` и `connection_restored` уже в словаре
(`docs/22-analytics-and-metrics.md` §3.3), новых событий задача не вводит.

## Настройки и окружение

Нет. Срок 8 секунд — константа в коде, не настройка панели.

## Документы

- `docs/27-design-system-and-app-shell.md` — строка `ConnectionBanner` (шаг 6).

## Вопросы к тимлиду

Подтверждено `claude-lead-1` 13.10.2026: срок ожидания чанка 8 секунд, повтор
загрузки чанка раз в 20 секунд, пока связи нет; арифметика бюджета плашки в
`docs/27` §3.4 (вторая половина находки приёмки #267) в задачу не включена.
Исполнитель ответа не ждёт.

## Критерии приёмки

- [ ] Нажатие «Повторить» при упавшем или зависшем чанке даёт «Проверяем…», а
  затем снова «Повторить»; плашка остаётся; необработанных отказов нет.
- [ ] Таймер проверки при упавшем чанке перезапускается, пока нет связи, и не
  множится (один `reloadTimer`).
- [ ] `checkConnection` и `watchConnection` покрыты тестами из раздела «Тесты».
- [ ] Дифф только в зонах задачи и в одной строке `docs/27`.
- [ ] `pnpm budget` проходит без правки порога; прирост записан в PR.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Ответить на «Повторить» при сбое чанка`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- исправлено: кнопка «Повторить» на плашке «Нет связи с сервером» теперь всегда отзывается — показывает «Проверяем…», даже если связь пропала в момент загрузки игры`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ПОВТОРИТЬ» ПРИ ПОТЕРЕ СВЯЗИ ОТВЕЧАЕТ ВСЕГДА**

  Кнопка «Повторить» на плашке связи молчала, если код проверки не успел загрузиться до обрыва сети. Теперь она сразу показывает «Проверяем…», а при неудаче возвращается, не ломаясь. Проверка связи и её таймер впервые покрыты тестами.

  🛠 **Плашка связи**

  • загрузка кода проверки ограничена по времени и повторяется, пока связи нет
  • тесты checkConnection, таймера и сбоя загрузки
  ```
