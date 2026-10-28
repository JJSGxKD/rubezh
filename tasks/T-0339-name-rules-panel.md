---
id: T-0339
title: Фильтр имён — экран в панели, проверка на примерах и перечистка ников
epic: E7
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0338]
zones:
  - backend/api/src/modules/name-rules/name-rules-reclean.service.ts
  - backend/api/src/modules/name-rules/name-rules-reclean.job.ts
  - backend/api/src/modules/name-rules/name-rules-reclean-state.ts
  - backend/api/src/modules/name-rules/name-rules.module.ts
  - backend/api/src/modules/admin/admin-name-rules-reclean.controller.ts
  - backend/api/test/name-rules-reclean.test.ts
  - backend/api/test/name-rules-reclean.integration.test.ts
  - apps/admin/src/api/name-rules.ts
  - apps/admin/src/screens/names/**
  - apps/admin/test/name-rules.test.ts
shared:
  - backend/api/src/modules/admin/admin.module.ts
  - apps/admin/src/routes.ts
  - apps/admin/src/screens/sections.tsx
  - apps/admin/src/ui/help.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0339. Фильтр имён — экран в панели, проверка на примерах и перечистка ников

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0339.json)](README.md#значки-статуса) [![T-0338](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0338.json&label=T-0338)](T-0338-name-rules-server.md)

## Зачем

Правила фильтра имён (T-0338) нужно вести руками: видеть список по категориям,
добавлять слово, фразу или регулярку, проверять правило на примерах до
сохранения. После правки старые ники остаются прежними, пока игрок не зайдёт, —
поэтому нужна кнопка «Перечистить» с предпросмотром «затронет N игроков».

## Решения

Решение владельца — `docs/35-stage4-plan.md`, **Р168**. Не пересматриваются:

- Экран: вкладки категорий, список правил, форма «точная фраза / слово целиком /
  регулярка», окно «проверить на примерах», включить и выключить правило.
- **Перечистка — серверное задание пачками в очереди BullMQ, с аудитом, закреплённые
  ники не трогает.** Серверная часть перечистки целиком в этой задаче (новые
  файлы в `modules/name-rules/`), а не в T-0338: ядро правил и ручки CRUD
  остаются отдельным, проверяемым в одиночку PR. Зоны с T-0338 пересекаются
  только файлом `name-rules.module.ts` — поэтому `depends_on`.
- Предпросмотр — это **тот же проход в режиме «сухой прогон»**, а не отдельный
  подсчёт: число «затронет N игроков» честно равно тому, что изменит запуск.
  Запустить перечистку можно только после предпросмотра **при тех же правилах**
  и не старше часа.
- Одновременно идёт одно задание на весь сервер (Redis-замок).
- Права — `names.edit` (T-0338), ничего нового.
- Место в меню панели: группа «Поддержка», раздел `names`, заголовок «Фильтр
  имён».
- Игроку в игре ничего не показывается; «Для игроков» — нет.

## Как сейчас

- Ручки T-0338: `GET /api/v1/admin/name-rules` → `{ data: { rules, limits } }`;
  `POST /`, `PATCH /:ruleId`, `DELETE /:ruleId`, `POST /test` — формы тел и ответов
  в T-0338, раздел 6. Тип `NameRuleView = { ruleId, category, kind, pattern, active,
  note, updatedAt, updatedBy }`, `ProbeResult = { sample, name, verdict,
  candidateHit, saved }`.
- `cleanAll(prisma, args, hooks, rules?)` в `backend/api/src/cli/display-names-clean.ts`
  (T-0338) уже умеет сухой прогон (`args.dryRun`), пропуск закреплённых, пачки по
  500 с курсором по `accountId`, условную запись; крючки `onPage(progress)` и
  `shouldStop()`. Эту функцию и вызываем.
- `loadNameRuleSet(prisma)` (T-0338) — свежий набор из базы мимо кэша.
- Образец повторяющегося задания и очереди: `modules/bot-mention/bot-mention.job.ts`
  (`createQueueConnection(config, "producer" | "worker")`, `new Queue`, `new Worker`,
  `worker.on("failed" | "error")`, `onModuleDestroy` закрывает очередь, воркер
  и соединения); образец замка в Redis: `bot-mention-sweep.service.ts`
  (`redis.set(LOCK_KEY, token, "PX", ttl, "NX")` под `withTimeout`, освобождение
  скриптом сверки токена в `release`).
- Панель: `apps/admin/src/routes.ts` — список групп разделов (группа «Поддержка» с
  `players` и `review`), `screens/sections.tsx` — таблица `id → экран`, `ui/help.ts` —
  словарь подсказок `HELP`, образец экрана со списком и диалогом — `screens/promo-codes/`,
  со схемой формы и `react-hook-form` — `screens/ads/BlockDialog.tsx`, API-слой с
  Zod на границе — `api/promo-codes.ts`, тест такого слоя — `test/promo-codes.test.ts`
  (`AdminApi`, `fakeFetch`, `json` из `test/helpers.ts`). Компоненты — `ui/kit.tsx`
  (`Panel`, `Button`, `Input`, `Select`, `Field`, `Badge`, `DataTable`, `Notice`,
  `ErrorNotice`, `Loading`, `Help`), `ui/dialog.tsx`, `ui/confirm-dialog.tsx`,
  `ui/choice.tsx` (`ChoiceCards`), `ui/toast.tsx`, `ui/use-api.ts`.

## Шаги по порядку

### Часть А. Сервер: перечистка

1. `modules/name-rules/name-rules-reclean-state.ts` — состояние и ключи Redis:

   ```ts
   export const RECLEAN_STATE_KEY = "name-rules:reclean:state";   // JSON, TTL 7 суток
   export const RECLEAN_LOCK_KEY = "name-rules:reclean:lock";     // замок, TTL 120 с, продлевается на каждой пачке
   export const RECLEAN_STOP_KEY = "name-rules:reclean:stop";     // флаг «остановить», TTL 1 час
   export const RECLEAN_PREVIEW_TTL_MS = 3_600_000;
   export type RecleanMode = "preview" | "run";
   export type RecleanStatus = "queued" | "running" | "done" | "failed" | "stopped";
   export interface RecleanState {
     runId: string;                 // uuid
     mode: RecleanMode;
     status: RecleanStatus;
     signature: string;             // подпись набора правил, по которому идёт проход
     scanned: number; planned: number; updated: number; skipped: number; locked: number;
     startedAt: string; finishedAt: string | null;   // ISO UTC
     startedBy: string;             // accountId
     error: string | null;          // русский текст причины, без шаблонов правил
   }
   export const recleanStateSchema: z.ZodType<RecleanState>;     // Zod: состояние читается из Redis
   ```
   Состояние читается и пишется только через эти функции + `recleanStateSchema.safeParse`
   (битое значение в Redis — как «нет состояния»).

2. `modules/name-rules/name-rules-reclean.service.ts` — `NameRulesRecleanService`
   (`@Injectable`), зависимости: `PRISMA`, `REDIS`, `RolesService`, `NameRulesCache`,
   `RecleanQueue` (шаг 3). Методы:
   - `state(actor)`: `names.edit`; возвращает `RecleanState | null`.
   - `startPreview(actor)`: `names.edit`; `startRun`-общая часть: берёт замок
     `SET RECLEAN_LOCK_KEY <token> PX 120000 NX` под `withTimeout(…, 2000)`; занят —
     `NameRuleConflictError("Перечистка уже идёт")`; пишет состояние `queued`
     (`mode: "preview"`), ставит задание в очередь, возвращает состояние. Аудит
     **не пишется** (ничего не меняется).
   - `startRun(actor, { previewRunId })`: `names.edit`; последнее состояние должно
     быть `mode: "preview"`, `status: "done"`, с `runId === previewRunId`, не старше
     `RECLEAN_PREVIEW_TTL_MS`, а `signature` равна подписи **свежего** набора из
     базы (`loadNameRuleSet`). Иначе `NameRuleConflictError` с текстами:
     «Сначала посчитайте, сколько ников затронет перечистка», «Предпросмотр устарел —
     посчитайте заново», «Правила изменились после предпросмотра — посчитайте
     заново». Дальше как в предпросмотре, `mode: "run"`. Аудит
     `names.reclean.start` с `after: { previewRunId, planned, signature }`,
     `target: runId`.
   - `stop(actor)`: `names.edit`; ставит `RECLEAN_STOP_KEY`; возвращает состояние.
     Аудит `names.reclean.stop`.
   - `process(job)` — то, что делает воркер: проход через
     `cleanAll(prisma, { dryRun: mode === "preview" }, { onPage, shouldStop }, rules)`,
     где `rules = await loadNameRuleSet(prisma)` (**свежий набор**, не кэш); если
     `rules.signature` не равна записанной в состоянии — статус `failed`, ошибка
     «Правила изменились — запустите заново». `onPage`: продлевает замок
     (`PEXPIRE` 120 с, только если токен свой), обновляет состояние
     (`running`, итоги), **пауза 100 мс** между пачками (`setTimeout` через
     внедряемую функцию `sleep`, чтобы тест не ждал). `shouldStop`: читает
     `RECLEAN_STOP_KEY`. Итог: `done` или `stopped`; для `mode: "run"` — аудит
     `names.reclean.finish` с `after: итоги` (`actorAccountId = startedBy`). Любое
     исключение: статус `failed`, `error` — «Перечистка прервалась — смотрите
     журнал сервера», в лог `{ module: "name-rules", event: "reclean_failed",
     reason: error.name }` (без шаблонов и ников). Замок и флаг остановки
     снимаются в `finally` (замок — сверкой токена).
   - Параметры времени (`sleep`, `now`) — через конструктор/поле, как `clock` и `pause`
     в `bot-mention-sweep.service.ts`.

3. `modules/name-rules/name-rules-reclean.job.ts` — `RecleanQueue`
   (`OnApplicationBootstrap`, `OnModuleDestroy`): очередь `name-rules-reclean`,
   `Worker(…, job => service.process(job.data), { concurrency: 1 })`, задание —
   `attempts: 1`, `removeOnComplete: 20`, `removeOnFail: 20` (**без автоповтора**:
   повтор записывающего прохода после сбоя решает человек). При
   `databaseUrl === ""` ничего не поднимает. Метод `enqueue(data)` с таймаутом
   2 с; недоступный Redis — `UnavailableError("Очередь недоступна — попробуйте
   позже")`.

4. `modules/name-rules/name-rules.module.ts` (из T-0338): добавить в `providers`
   `NameRulesRecleanService`, `RecleanQueue`; в `exports` — `NameRulesRecleanService`.
   Нужны `PRISMA` и `REDIS` из глобальных `DatabaseModule` и `RedisModule` — как у
   `BotMentionModule` (посмотри его `imports`).

5. `modules/admin/admin-name-rules-reclean.controller.ts` —
   `@Controller("admin/name-rules/reclean")`, те же гарды, `@RequirePermission("names.edit")`
   на каждой ручке:

   | Метод | Тело | Ответ |
   |---|---|---|
   | `GET /` | — | `{ data: RecleanState \| null }` |
   | `POST /preview` | — | `{ data: RecleanState }` |
   | `POST /run` | `{ previewRunId: uuid }` | `{ data: RecleanState }` |
   | `POST /stop` | — | `{ data: RecleanState \| null }` |

   Изменяющие — через `ADMIN_LIMITS.mutate`. Контроллер — в `admin.module.ts` (shared).

6. Аудит-подписи в `apps/admin/src/api/audit.ts` (shared): `"names.reclean.start":
   "Запуск перечистки ников"`, `"names.reclean.stop": "Остановка перечистки ников"`,
   `"names.reclean.finish": "Итог перечистки ников"`; в `auditObject` ветка `names`
   уже есть (T-0338): для `names.reclean.*` — `{ kind: "перечистка", label:
   short(target), route: { section: "names", id: null } }`. Тест — по строке на
   действие.

### Часть Б. Панель

7. `apps/admin/src/api/name-rules.ts` — слой API (образец `api/promo-codes.ts`):
   - константы:

     ```ts
     export const CATEGORY_ORDER = ["brand", "ads", "profanity", "other", "allow"] as const;
     export const CATEGORY_TITLES = {
       brand: "Бренды", ads: "Реклама и ссылки", profanity: "Мат", other: "Прочее", allow: "Исключения",
     };
     export const CATEGORY_ACTIONS = {
       brand: "вырезается из ника", ads: "вырезается из ника", other: "вырезается из ника",
       profanity: "ник заменяется целиком", allow: "не трогается",
     };
     export const KIND_TITLES = { exact: "Точная фраза", word: "Слово целиком", regex: "Регулярное выражение" };
     ```
   - Zod-схемы ответов (`ruleSchema`, `rulesViewSchema`, `probeResultSchema`,
     `recleanStateSchema`) и функции `fetchRules(api)`, `createRule(api, body)`,
     `updateRule(api, ruleId, patch)`, `removeRule(api, ruleId)`,
     `probeRule(api, body)`, `fetchReclean(api)`, `startPreview(api)`,
     `startRun(api, previewRunId)`, `stopReclean(api)` — каждая возвращает
     `ApiResult<…>`;
   - схема формы `ruleFormSchema(limits)`: `category`, `kind`, `pattern`
     (обрезка пробелов; 1…`limits.patternMax`), `note` (≤ `noteMax`), `active`;
     сообщения «Введите слово или фразу», «Не длиннее 100 знаков»;
   - чистые функции: `rulesOf(view, category)` (отбор по вкладке, сортировка:
     включённые выше, затем по `pattern` без учёта регистра), `categoryCounts(view)`,
     `verdictText(result)` — подпись исхода образца: «ник не изменится» /
     «останется: <name>» / «ник будет заменён» (для `verdict: "profanity"`) /
     «ника не останется» (`empty`), `recleanLine(state)` — строка состояния
     перечистки (см. таблицу текстов ниже), `canRun(state, signatureFresh)`.

8. Экран `apps/admin/src/screens/names/NamesScreen.tsx` (+ компоненты в том же
   каталоге):
   - **Шапка:** подзаголовок раздела из `routes.ts` (шаг 9) и блок «Перечистка» (ниже).
   - **Вкладки** — пять категорий в порядке `CATEGORY_ORDER`, на каждой счётчик
     правил («Бренды · 12»); у вкладки подпись действия (`CATEGORY_ACTIONS`).
     Выбранная вкладка запоминается в `localStorage` в `try/catch`, без неё экран
     открывается на первой непустой.
   - **Список** (`DataTable`, строка — правило): колонки «Правило» (шаблон
     моноширинным шрифтом, под ним `KIND_TITLES`), «Заметка», «Статус»
     (`Badge`: «действует» / «выключено»), «Изменено» (`formatDateTime`), действия
     «Править», «Включить / Выключить», «Удалить» (с подтверждением
     `ConfirmDialog`: «Удалить правило? Ники, которые оно вырезало, вернутся при
     следующей перечистке»). На телефоне — `phoneLayout` таблицы, как на других
     экранах.
   - **Кнопка «Добавить правило»** над списком — открывает форму с категорией
     текущей вкладки.
   - **Форма (`RuleDialog`)** — `react-hook-form` + `zodResolver`: поля «Что
     искать» (`Input`), «Как искать» (`ChoiceCards` на три вида: «Точная фраза» —
     «Ищет фразу где угодно в нике»; «Слово целиком» — «Не срабатывает внутри
     других слов»; «Регулярное выражение» — «Для сложных случаев»), «Категория»
     (`Select`), «Заметка» (необязательно), «Действует» (переключатель, по
     умолчанию включено). Для `regex` под полем — `Notice tone="info"` с
     подсказкой: «Допустимо: до 100 знаков, без вложенных повторов, обратных
     ссылок и заглядываний (?=, ?!, ?<=, ?<!). Буквы е и ё — разные, пишите [её]».
     Ошибка сервера (`400`, `409`) выводится под полем «Что искать» дословно из
     ответа. Кнопка «Сохранить» активна, пока форма валидна и запрос не идёт.
     В форме же — кнопка **«Проверить на примерах»** (открывает `TryOutDialog` с
     текущим содержимым формы).
   - **Окно «Проверить на примерах» (`TryOutDialog`)**: многострочное поле «По
     одному нику на строке» (до `limits.samplesMax` строк по `sampleMax` знаков;
     счётчик «5 из 20»), кнопка «Проверить» → `POST /test` с правилом из формы
     (`ruleId` — если правило редактируется). Результат — таблица: «Ник» → «Что
     станет» (`verdictText`) и значок «правило сработало» (`candidateHit`) или
     «спасло исключение» (`saved`). Пустой ввод: «Вставьте несколько ников — покажем,
     что с ними сделает правило вместе с остальными». Правило не сохраняется.
   - **Блок «Перечистка» (`RecleanPanel`)**: показывает `recleanLine(state)`,
     кнопки «Посчитать, кого затронет» → `POST /preview` и «Перечистить» →
     `ConfirmDialog` («Перечистить ники? Будет изменено <N> ников из <M> проверенных.
     Закреплённые модератором не меняются. Отменить нельзя — прежний вид
     останется в поле исходного ника.») → `POST /run`; во время прохода — кнопка
     «Остановить» и опрос `GET /` раз в 2 с (только пока экран открыт и статус
     `queued|running`). «Перечистить» неактивна, пока нет свежего предпросмотра
     (`status: done`, `mode: preview`, не старше часа) или правила менялись
     после него: экран сравнивает `updatedAt` самого свежего правила со временем
     `finishedAt` предпросмотра, а сервер проверяет подпись на самом деле.

   **Тексты `recleanLine(state)`:**

   | Состояние | Строка |
   |---|---|
   | `null` | «Перечистка ещё не запускалась» |
   | предпросмотр идёт | «Считаем: проверено <scanned>, затронет <planned>» |
   | предпросмотр готов | «Затронет <planned> игроков из <scanned> проверенных (закреплённых: <locked>)» |
   | запуск идёт | «Перечищаем: проверено <scanned>, изменено <updated>» |
   | запуск готов | «Готово: изменено <updated>, пропущено <skipped> — игрок успел зайти» |
   | остановлено | «Остановлено: изменено <updated> из <planned>» |
   | `failed` | текст `error` из состояния |

   Числа — `formatNumber`, «игроков/игрока» — `plural` из `src/format.ts`.

   **Состояния экрана:**
   - загрузка — `Loading`; ошибка списка — `ErrorNotice` с «Повторить»;
   - пусто в категории — «В этой категории правил пока нет. Встроенный словарь
     работает и без них»;
   - нет сети при сохранении — ошибка под формой, форма остаётся открытой;
   - нет права `names.edit` — раздел не показывается (проверка в `routes.ts`),
     прямой переход по адресу — `forbidden` из `ErrorNotice`;
   - предел 2000 правил — сообщение сервера под полем.

9. `routes.ts` (shared): в группу «Поддержка» после `review`:
   `{ id: "names", title: "Фильтр имён", hint: "Слова и фразы, которые убираются из ников игроков: бренды, реклама, мат и исключения", permission: "names.edit", icon: Eraser }`
   (`Eraser` из `lucide-react`, добавить в импорт). `sections.tsx` (shared):
   `names: () => <NamesScreen />`. `ui/help.ts` (shared): ключ `names` со
   справкой — `categories` («Категория задаёт, что делать с совпадением: мат
   заменяет ник целиком, бренды, реклама и прочее вырезают найденное, исключения
   защищают от срабатывания. Встроенный словарь работает всегда и идёт первым»),
   `kinds` (чем различаются три вида), `regex` (границы безопасного подмножества),
   `probe` («Проверка идёт по всем действующим правилам вместе с кандидатом; ничего
   не сохраняется»), `reclean` («Ники меняются при входе игрока сами. Перечистка
   применяет правила ко всем остальным разом. Закреплённые не трогаются»).
   `test/help.test.ts` проверяет подсказки — прогнать.

10. Документы: `docs/29-admin-panel.md` — описание раздела в §2 (расширить строку
    T-0338) и абзац про перечистку; `docs/21-diagrams.md` — диаграмма потока
    перечистки (`sequenceDiagram`: панель → `POST /preview` → очередь → воркер →
    `cleanAll` dry-run → состояние в Redis → `POST /run` → аудит → итог);
    `docs/30-configuration-map.md` — строки: пауза между пачками 100 мс, пачка
    500, срок годности предпросмотра 1 час, замок 120 с (все в
    `name-rules-reclean-state.ts` / `cleanAll`).

## Чего не трогаем

- Ядро правил, кэш, таблицу `name_rule`, ручки CRUD и `POST /test` — **T-0338**;
  дополнения к ним только через зону `name-rules.module.ts`.
- `cleanAll`/`display-names-clean.ts` — не менять (крючки уже есть); если их
  не хватает, это вопрос, а не правка.
- Счётчики срабатываний, колонки «сработало» в списке — **T-0340**; вкладка
  «Кандидаты» — **T-0341** (вкладок категорий здесь пять, шестой не оставлять
  «на будущее»).
- Закрепление и ручная смена ника игрока — `admin-players.*`.
- Автозапуск перечистки по расписанию и перечистка «одного игрока» — не делаем.
- Аналитические события — не заводим.

## Сценарий и интерфейс

Сотрудник с `names.edit` открывает «Фильтр имён» → видит вкладки и список →
«Добавить правило» → вводит шаблон, выбирает вид и категорию → «Проверить на
примерах» → вставляет ники и видит, что станет → «Сохранить» → правило действует
у новых входов в течение секунд. Для старых ников: «Посчитать, кого затронет» →
число → «Перечистить» → подтверждение → строка прогресса → «Готово».

Состояния: загрузка, пусто, ошибка (список, сохранение, проба), нет сети, нет
права, идёт перечистка (кнопки заблокированы, виден «Остановить»), перечистка
упала (`failed` с текстом). Проверить вёрстку на 360 px (телефон — `phoneLayout`
таблицы, диалоги на всю ширину), 768 и 1440; тёмная тема панели — токены из
`styles.css`, цвета не вшивать. Макета нет (`design: null`): раскладка по образцу
`screens/promo-codes/`.

## Тесты

Пишутся первым коммитом, до кода.

`backend/api/test/name-rules-reclean.test.ts` (поддельные Redis, Prisma-фасад,
`RolesService`, очередь, `sleep` без ожидания):
- Каждый метод требует `names.edit`.
- Предпросмотр: берёт замок, пишет `queued`, ставит задание; второй вызов при
  занятом замке — `NameRuleConflictError`; **аудит не пишется**.
- `startRun` без предпросмотра / с чужим `previewRunId` / со старым (> часа) /
  при другой подписи набора — конфликт с нужным текстом; с годным — `queued`,
  аудит `names.reclean.start`.
- `process`: предпросмотр не пишет в базу (`updateMany` не вызван), заполняет
  `planned`; запуск пишет; закреплённые попали в `locked`; состояние растёт по
  пачкам; между пачками вызван `sleep(100)`; продлён замок.
- Подпись свежего набора не равна записанной → `failed` «Правила изменились —
  запустите заново», запись не началась.
- `shouldStop`: после флага остановки проход заканчивается статусом `stopped`.
- Исключение внутри прохода → `failed` с общим текстом, в лог нет шаблонов;
  замок снят; чужой замок (токен другой) не снимается.
- Битое состояние в Redis читается как `null`.
- Итог запуска пишет аудит `names.reclean.finish` с итогами от имени `startedBy`.

`backend/api/test/name-rules-reclean.integration.test.ts` (живые Postgres и Redis):
- 1200 аккаунтов (три пачки по 500), часть с исходным ником «пример-бренд…»;
  предпросмотр насчитал N; запуск изменил ровно N; закреплённый аккаунт не
  изменён, его `platformName` цел; второй предпросмотр — `planned: 0`.
- Игрок «вошёл» между чтением и записью (хук `afterRead` из `cleanAll`) — попал
  в `skipped`, не перезаписан.
- Два одновременных запуска — один принят, второй конфликт.
- Контроллер: 401 без сессии, 403 без `names.edit`, 200 с ним; `POST /run` с
  неверным телом — 400.

`apps/admin/test/name-rules.test.ts` (слой API и чистые функции, `fakeFetch`/`json`):
- `fetchRules` разбирает ответ схемой; ответ без поля — ошибка, а не `undefined`.
- `createRule` шлёт `POST /api/v1/admin/name-rules` с телом без лишних полей и
  заголовком CSRF; ответ `400` с текстом попадает в `error`.
- `rulesOf`: отбор по вкладке, включённые выше выключенных, порядок без учёта
  регистра; `categoryCounts` верны.
- `ruleFormSchema`: пустой шаблон, 101 знак, заметка длиннее 200 — ошибки с
  нашими текстами; пробелы по краям обрезаются.
- `verdictText` для четырёх исходов; `recleanLine` для каждой строки таблицы;
  `canRun` — ложь без предпросмотра, при `mode: "run"`, при устаревшем.
- `SECTIONS`: раздел `names` в группе «Поддержка» с правом `names.edit`.
- `test/audit.test.ts` (shared) — подписи трёх действий `names.reclean.*`.

## Аналитика

Нет: действия сотрудников попадают в журнал аудита (`names.reclean.*`), события
игроков не создаются. Метрики Prometheus — нет (`docs/22`: метрик на бэкенде
пока нет). Итоги прохода — в состоянии задания и в логе без ников.

## Настройки и окружение

Нет новых ключей и переменных. Константы — в `name-rules-reclean-state.ts`
(замок 120 с, срок годности предпросмотра 1 час, пауза 100 мс); размер пачки —
`PAGE_SIZE` в `display-names-clean.ts` (в `docs/30` строкой).

## Документы

`docs/29-admin-panel.md`, `docs/21-diagrams.md` (поток перечистки),
`docs/30-configuration-map.md` — см. шаг 10. `pnpm docs:check` зелёный.

## Критерии приёмки

- [ ] Раздел «Фильтр имён» виден только с `names.edit`, пять вкладок с
      счётчиками, список, форма, включение и удаление работают.
- [ ] «Проверить на примерах» показывает исход каждого ника по всем правилам и
      ничего не сохраняет.
- [ ] «Перечистить» недоступна без свежего предпросмотра; число в подтверждении
      равно тому, что изменил запуск (проверено интеграционным тестом).
- [ ] Закреплённые ники и `platformName` не меняются; игрок, вошедший посреди
      прохода, не получает назад стёртое.
- [ ] Одновременно идёт одно задание; остановка работает; сбой не оставляет замок.
- [ ] Аудит: `names.reclean.start|stop|finish` с итогами; предпросмотр не аудируется.
- [ ] Ни шаблонов правил, ни ников в логах.
- [ ] Вёрстка читаема на 360, 768 и 1440 px, в тёмной теме; цвета — из токенов.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(names): Экран фильтра имён и перечистка ников в панели`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЭКРАН ФИЛЬТРА ИМЁН И ПЕРЕЧИСТКА НИКОВ В ПАНЕЛИ**

  В панели появился раздел «Фильтр имён»: правила по категориям, проверка на примерах и перечистка старых ников с предпросмотром.

  🛠 **Панель**

  • Вкладки: бренды, реклама и ссылки, мат, прочее, исключения; точная фраза, слово целиком или регулярка
  • Окно «Проверить на примерах» показывает, что станет с никами, до сохранения правила
  • «Перечистить» сначала считает, сколько игроков затронет, и только потом запускает проход пачками в очереди; закреплённые ники не меняются; всё пишется в журнал действий

  ❓ **Нужно от команды**

  • @участник1 — после выката открыть «Фильтр имён», нажать «Посчитать, кого затронет» и, если число ожидаемо, запустить перечистку
  ```
