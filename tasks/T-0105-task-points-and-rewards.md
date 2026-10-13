---
id: T-0105
title: Очки заданий: полоса дня и недели и награды за ступени очков
epic: E16
priority: P1
status: ready
owner:
author: claude-lead2-16
size: M
depends_on:
  - T-0104
  - T-0098
zones:
  - backend/api/src/modules/tasks/task-points.ts
  - backend/api/src/modules/tasks/task-points.service.ts
  - backend/api/src/modules/tasks/task-points.repository.ts
  - backend/api/src/modules/tasks/tasks.controller.ts
  - backend/api/src/modules/tasks/tasks.module.ts
  - backend/api/src/modules/tasks/tasks.service.ts
  - backend/api/src/modules/tasks/tasks-errors.ts
  - backend/api/test/task-points.test.ts
  - backend/api/test/task-points.integration.test.ts
  - apps/admin/src/api/tasks.ts
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/src/ui/help.ts
  - packages/app-shell/src/state/tasks-api.ts
  - packages/app-shell/src/screens/meta/tasks.tsx
  - packages/app-shell/src/screens/meta/task-row.tsx
  - packages/app-shell/src/screens/meta/task-points.tsx
  - packages/app-shell/src/screens/meta/task-points-rules.ts
  - packages/app-shell/src/i18n/ru-tasks.json
  - packages/app-shell/test/task-points-rules.test.ts
  - packages/app-shell/test/tasks-api.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/src/state/analytics.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
  - docs/30-configuration-map.md
  - docs/39-retention-mechanics.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 1
---

# T-0105. Очки заданий: полоса дня и недели и награды за ступени очков

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0105.json)](README.md#значки-статуса) [![T-0104](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0104.json&label=T-0104)](T-0104-tasks-pool-rotation-new-kinds.md) [![T-0098](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0098.json&label=T-0098)](T-0098-tasks-open-claimable-tab.md)

## Зачем

Пять заданий в день выполняются по одному и ни во что не складываются. После задачи каждое задание даёт очки, на экране «День» и «Неделя» растёт полоса с тремя ступенями, и каждая ступень открывает награду: игрок видит «до следующей награды ещё 10 очков» и делает ещё одно задание. Один понятный ритуал вместо россыпи (`docs/39-retention-mechanics.md` П2, Р102).

## Решения

- **Очки живут в колонке `pass_points`.** Она уже есть в каталоге, в схеме `taskDefSchema`, в `TaskView.passPoints`, в панели («Очки пасса») и у клиента; нигде не использовалась. Новую колонку не заводим и старую не переименовываем (переименование — не «только добавление»). Пропуск сезона (П4) позже берёт те же очки. В панели и подсказках поле называется «Очки заданий».
- **Очки считаются по выполненному, не по забранному:** задание дало очки, когда `completed_at` не пуст. Забирать задание ради очков не нужно.
- **Что считается.** Только строки `daily` и `weekly` без `params` (партнёрские и задания сетей очков не дают). Очки берутся из каталога *сейчас*: правка `pass_points` в панели пересчитывает уже набранное в текущем сроке (записывать очки в прогресс не будем, это сложнее и не нужно).
- **Полоса дня** — сумма очков заданий дня, выполненных в сегодняшние игровые сутки. **Полоса недели** — сумма очков недельных заданий этой недели *и ежедневных, выполненных за эту неделю* («задания дня и недели пересекаются», `docs/39` П2). Игровые сутки и неделя — по Москве, граница в базе (`periodStartSql`).
- **Очки задания по ступени** (миграция выставляет всем строкам со `tier`, T-0104; геймдизайнер калибрует): дневные — лёгкое 10, среднее 20, сложное 40 (набор из 5 даёт 100); недельные — 20 / 40 / 80 (набор из 6 даёт 240). Строки без ступени остаются с их нынешними очками (по умолчанию 0).
- **Ступени и награды** (старт, геймдизайнер калибрует; награда — мягкая валюта, самоцветов нет):

  | Полоса | Очки | Награда |
  |---|---|---|
  | День | 20 | 40 монет |
  | День | 50 | 80 монет |
  | День | 100 | 150 монет и 3 осколка |
  | Неделя | 150 | 150 монет |
  | Неделя | 400 | 300 монет и 5 осколков |
  | Неделя | 700 | 600 монет и 10 осколков |

  Таблица — константа кода (`task-points.ts`), не колонка и не настройка: меняется релизом вместе с балансом. Если это неудобно геймдизайнеру, вынос в панель — отдельная задача.
- **Забор — как у награды задания** (`TasksService.claim`): начисление с ключом, потом отметка. Ключ кошелька `task_points:{accountId}:{period}:{periodStart}:{points}:{resource}`, причина `task_reward` (своя причина потребовала бы свой суточный потолок в кошельке; потолок `task_reward` общий и режет награду — `credited` вернёт меньше), источник `task_points:{period}:{points}`. Отметка — строка в новой таблице `task_points_claim`, `ON CONFLICT DO NOTHING`. Два запроса разом начисляют однажды.
- **Ступень можно забрать только в срок:** строка таблицы ключуется началом срока; прошлые сутки и неделя не забираются.
- **Знак меню и знак вкладки** учитывают готовые ступени: игрок видит «есть что забрать» и там, где задания уже забраны.

## Как сейчас

- `backend/api/src/modules/tasks/tasks.service.ts`: `claim` (стр. 131) начисляет по `REWARD_RESOURCES` (стр. 101) через `wallet.grant` с причиной `rewardReason(def.period)` и ключом идемпотентности вида `task:{accountId}:{taskId}:{periodStart}:{resource}`, потом `markClaimed`; `badge()` (стр. 245) считает `done && !claimed`; `TaskView.passPoints` отдаётся, но нигде не читается.
- `tasks.controller.ts:44` — `@Get()` возвращает `{ data: { tasks, networks } }`; `@Post(":taskId/claim")` — забор задания. Сервис лимитов запросов — `this.limit(accountId)`.
- `tasks.repository.ts`: `progress(accountId, at)` читает прогресс текущих сроков; `periodStartSql` — граница суток и недели. Схема: `task_progress (account_id, task_id, period_start, value, target, completed_at, claimed_at)`, `task_def.pass_points` с комментарием «очки батл-пасса (WP26)».
- `tasks-errors.ts` — ошибки домена (`TaskNotDoneError`: `task_not_done`, 409).
- Клиент: `packages/app-shell/src/screens/meta/tasks.tsx` — вкладки `partner`/`daily`/`weekly`/`achievements`, `claim(task)`, `waiting(tab)` (знак вкладки), `ResetLine` над списком; `task-row.tsx` — строка задания; `task-reward.tsx` — `RewardChips`, `rewardText(reward)`; `state/tasks-api.ts` — Zod-схемы ответов; `state/analytics.ts` — типы клиентских событий (`task_completed`).
- События: `event-dictionary.ts:199` — `task_completed: { version: 1, payload: payload({ task: id, period: z.enum(["daily", "weekly"]), kind: id }) }`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** (после перебазирования, `--create-only` один раз): таблица `task_points_claim (account_id uuid, period "TaskPeriod", period_start date, points int, claimed_at timestamptz(3), PRIMARY KEY (account_id, period, period_start, points))`, внешний ключ на `account` с `ON DELETE CASCADE`, `CHECK (period IN ('daily','weekly'))` и `CHECK (points > 0)`; `UPDATE task_def SET pass_points = … WHERE tier IS NOT NULL` по таблице очков выше. Модель в `schema.prisma` блоком в конце файла; ER в `docs/21-diagrams.md`.
3. **Новый `task-points.ts`** (чистые функции): `POINT_STEPS` (таблица выше, `as const`); `type PointsStepView = { points: number; reward: { coins: number; gems: number; shards: number }; state: "locked" | "ready" | "claimed" }`; `stepStates(period, total, claimed: ReadonlySet<number>)`; `pointsView(totals, claims)`; `readyCount(view)`.
4. **Новый `task-points.repository.ts`** (по образцу `tasks.repository.ts`, сырой SQL, токен `TASK_POINTS_REPOSITORY`): `totals(accountId, at): Promise<{ dayStart: string; weekStart: string; daily: number; weekly: number }>` одним запросом: `task_progress p JOIN task_def d`, `p.completed_at IS NOT NULL`, `d.params IS NULL`, дневные строки — `d.period = 'daily'` и `p.period_start` в неделе (для полосы дня — только сегодняшние), недельные — `p.period_start = weekStart`; `claims(accountId, dayStart, weekStart)`; `markClaimed(…): Promise<boolean>`.
5. **Новый `task-points.service.ts`:** `view(accountId, at)`; `claim(account, period, points, at)`: ступени такой нет — `TaskPointsStepNotFoundError` (404, `task_points_step_not_found`); очков не хватает — `TaskPointsNotReachedError` (409, `task_points_not_reached`, клиент перечитывает задания); уже отмечено — `{ claimed: false, credited: нули, points }` без начисления; иначе `wallet.grant` по трём ресурсам (`coins`, `gems`, `shard_common`, как `REWARD_RESOURCES` в `tasks.service.ts`; нулевые пропускать) и `markClaimed`; в лог `task_points_claimed` с `period`, `points`, `credited`. Все `await` внешних вызовов — с таймаутом (`withTimeout`, как `db()` в `tasks.service.ts`).
6. **Контроллер и модуль:** в `GET /tasks` в `data` добавить `points: PointsView` (`{ daily: { total, steps }, weekly: { total, steps } }`); новый маршрут `POST /tasks/points/:period/:points/claim` (период — `z.enum(["daily","weekly"])`, очки — целое; лимит запросов тот же) → `{ data: { claimed, credited, points } }`. Зарегистрировать провайдеры в `tasks.module.ts`.
7. **`TasksService.badge()`:** к числу готовых наград прибавить `readyCount` обеих полос (через `TaskPointsService`, без цикла зависимостей).
8. **Событие.** Сначала словарь: `docs/22-analytics-and-metrics.md` §3.3 — новая строка `task_points_claimed` (шлёт клиент после ответа сервера; поля `period`, `step`) и у `task_completed` необязательное `tier`. Затем `event-dictionary.ts`: `task_points_claimed: { version: 1, payload: payload({ period: z.enum(["daily","weekly"]), step: z.number().int().min(1).max(100000) }) }` и `tier: z.enum(["easy","medium","hard"]).optional()` у `task_completed`. Затем `state/analytics.ts`.
9. **Панель:** подпись поля `passPoints` — «Очки заданий», подсказка в `ui/help.ts`: «Очки за выполнение: идут в полосу дня или недели. Партнёрским и ручным заданиям без ступени их можно оставить нулём»; сообщение проверки в `api/tasks.ts` («Награда, очки заданий и порядок — целые неотрицательные»); столбец списка «Очки».
10. **Клиент.**
    - `state/tasks-api.ts`: `points` в ответе — `z.optional` (сервер до очков его не отдавал); функция `claimPoints(period, points)`; код ошибки `task_points_not_reached`.
    - `task-points-rules.ts` (чистые): `barFill(total, steps)` — доля 0…1 по самой дальней ступени; `leftToNext(view)` — сколько очков до ближайшей закрытой ступени или `null`, если все пройдены; `readyIn(view)` — число готовых; `markers(steps)` — позиции ступеней на полосе.
    - `task-points.tsx`: `TaskPointsBar({ period, view, claiming, notice, onClaim })`: заголовок («Очки дня» / «Очки недели») и сумма справа, полоса со вставками ступеней, ниже три ячейки ступеней: порог, награда (`RewardChips`), состояние — закрыто, кнопка «Забрать» или «Получено»; под ячейками строка «До награды ещё N очков» или «Все награды дня получены»; у недели строка «В очки недели идут и ежедневные задания». Заполнение полосы — `transform: scaleX` и `opacity`, без размеров и цветов вне токенов; при выключенных анимациях интерфейса (как это делает лесенка появления строк в `task-row.tsx`) полоса встаёт сразу.
    - `tasks.tsx`: на вкладках «День» и «Неделя» блок над списком, под `ResetLine`; `claimPoints` по образцу `claim(task)` (блокировка двойного нажатия, плашка ошибки, `loadWallet()`, `loadBadges()`); `waiting(tab)` у «Дня» и «Недели» прибавляет `readyIn`; событие `task_points_claimed`; в `task_completed` добавить `tier`.
    - `task-row.tsx`: у дневных и недельных строк с `passPoints > 0` рядом с наградой чип «+10 оч.»
11. **Тексты `ru-tasks.json`, дословно:**
    - `"tasks.points.daily": "Очки дня"`, `"tasks.points.weekly": "Очки недели"`
    - `"tasks.points.total": "{points} {points, plural, one {очко} few {очка} many {очков} other {очка}}"`
    - `"tasks.points.task": "+{points} оч."`
    - `"tasks.points.left": "До награды ещё {left} {left, plural, one {очко} few {очка} many {очков} other {очка}}"`
    - `"tasks.points.allDone.daily": "Все награды дня получены"`, `"tasks.points.allDone.weekly": "Все награды недели получены"`
    - `"tasks.points.weeklyHint": "В очки недели идут и ежедневные задания"`
    - `"tasks.points.failed": "Не удалось забрать награду за очки — попробуйте ещё раз"`
    - `"tasks.points.notReached": "Очков пока не хватает — обновили прогресс"`
    Кнопка и «Получено» — существующие `tasks.claim`, `tasks.claimed`; «Получено: …» — `tasks.got`.
12. **Документы:** `docs/27` (строка «Задания»: полоса очков и ступени), `docs/30` (строка «Очки заданий: ступени и награды в `task-points.ts`, очки задания — в каталоге»), `docs/21`, `docs/22`.

## Чего не трогаем

- Ротацию, виды цели, миграции каталога T-0104; выбор вкладки при открытии (T-0098); вкладку «Достижения» и достижения (T-0106 и T-0107).
- Суточные потолки кошелька и причины начисления: используем `task_reward`.
- Сезонный путь и пропуск: очки готовим, самого пути нет.
- Задания рекламных сетей и партнёрские: очков не дают.
- Награду за сами задания: она и её забор как были.

## Сценарий и интерфейс

Макета нет, собираем из имеющихся компонентов дизайн-системы и токенов (`packages/app-shell/src/design-system/`); новых цветов нет, отступы от выреза — через `--app-inset-*`.

- **Загрузка:** блока очков нет, видна строка «Загружаем задания…».
- **Пусто (0 очков):** полоса пуста, все ступени закрыты, «До награды ещё 20 очков».
- **Ступень готова:** ячейка подсвечена, кнопка «Забрать», на вкладке и в меню знак.
- **Забрали:** «Получено», «Получено: 40 монет»; кошелёк обновлён.
- **Ошибка забора:** плашка «Не удалось забрать награду за очки — попробуйте ещё раз», кнопка снова доступна.
- **Нет сети:** как у остальных запросов экрана — «Не удалось загрузить задания — проверьте связь».
- **Без входа:** блока нет, плашка гостя как сейчас.
- **Смена суток во время экрана:** ответ `task_points_not_reached` перечитывает задания; прошлая полоса пропадает.

## Тесты

Первым коммитом.

- `backend/api/test/task-points.test.ts` (чистые функции): в `POINT_STEPS` пороги строго растут, награды не убывают; `stepStates`: 0 очков — три `locked`; ровно на пороге — `ready`; забранная — `claimed` даже при большем счёте; 19 очков — `locked`, 20 — `ready`; `readyCount`.
- `backend/api/test/task-points.integration.test.ts` (живые Postgres и Redis):
  - выполнены дневные задания на 20 очков → `daily.total` 20, шаг 20 `ready`; недельная полоса включает те же 20;
  - выполненное вчера и забранное вчера в полосу дня не входит, а в полосу недели входит (в одной неделе); в полосу следующей недели не входит;
  - партнёрское задание (с `params`) очков не даёт; задание с `pass_points = 0` — 0;
  - забор ступени: монеты на балансе, один `wallet_entry` на ресурс; повторный забор — `claimed: false`, баланс тот же; два одновременных запроса (`Promise.all`) начисляют однажды;
  - забор ступени, до которой не хватает очков → `task_points_not_reached`; несуществующий порог (`30`) → `task_points_step_not_found`;
  - ступень вчерашних суток после полуночи забрать нельзя (фиксированный `at`);
  - суточный потолок кошелька режет награду: `credited` меньше награды, отметка стоит, повтор ничего не даёт;
  - `badge()` растёт на число готовых ступеней и падает после забора;
  - миграция: у строк со `tier` очки 10/20/40 и 20/40/80, у остальных прежние.
- `packages/app-shell/test/task-points-rules.test.ts`: `barFill` на 0, на пороге, между порогами, за последним порогом (не больше 1); `leftToNext` — до ближайшей закрытой ступени, `null` при трёх `claimed`/`ready`; `readyIn`; `markers` — позиции по порогам.
- `packages/app-shell/test/tasks-api.test.ts`: ответ без `points` разбирается; с `points` — тоже; все ключи `tasks.points.*` из раздела «Шаги» есть в `ru-tasks.json`.

## Аналитика

- Новое `task_points_claimed` (`period`, `step`): доля игроков, забирающих награды за очки (`docs/39` §4.6). Сначала словарь `docs/22` §3.3 и Zod-схема, потом код.
- `task_completed` получает необязательное `tier`: видно, какие ступени доходят до награды.

## Настройки и окружение

Нет: таблица ступеней — константа кода, очки заданий — каталог из панели.

## Документы

`docs/21-diagrams.md` (таблица `task_points_claim`), `docs/22` (событие), `docs/27` (строка «Задания»), `docs/30` (строка про ступени), `docs/39-retention-mechanics.md` §3 (строка «Задания»).

## Вопросы к тимлиду

- �Подтверждено `claude-lead-1` 13.10.2026: награды за ступени идут причиной `task_reward`, потолок общий с заданиями. Своя причина в кошельке требует правки лимитов (`wallet-limits.ts`), это задача про деньги.
- �Подтверждено `claude-lead-1` 13.10.2026: недельная полоса включает ежедневные задания недели (так читается «пересекаются» в `docs/39` П2). Если нужно только недельные, меняется один запрос `totals`.
- Геймдизайнеру: пороги и награды таблицы выше — стартовые; итог дня (≈ 270 монет с осколками за все три ступени) сверить с общим доходом из `progress-rules.ts` и потолком `task_reward`.

## Критерии приёмки

- [ ] Тесты из раздела «Тесты» зелёные; таблица и миграция только добавляют.
- [ ] Выполнение задания двигает полосу; ступень забирается один раз, при параллельных запросах тоже.
- [ ] Знак вкладок и меню учитывает готовые ступени; «Забрать» блокируется на время запроса.
- [ ] Чип очков виден на строке дневного и недельного задания; у партнёрских и достижений его нет.
- [ ] Анимация полосы — только `transform`/`opacity` и уважает переключатель анимаций.
- [ ] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Очки заданий и награды за ступени`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: очки за задания — полоса дня и недели с тремя наградами за ступени`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОЧКИ ЗАДАНИЙ И НАГРАДЫ ЗА СТУПЕНИ**

  Каждое задание дня и недели даёт очки; на вкладках «День» и «Неделя» растёт полоса с тремя ступенями, каждая даёт монеты, у верхних ещё осколки. Недельная полоса считает и ежедневные задания.

  🛠 **Задания**

  • забор ступени идемпотентен, награда идёт причиной `task_reward`
  • новое событие `task_points_claimed`, у `task_completed` — `tier`

  ❓ **Нужно от команды**

  • @участник1 — геймдизайнеру откалибровать очки и награды ступеней
  ```
