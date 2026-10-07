---
id: T-0041
title: Команда вайпа — подсчёт, снимок и стирание одной транзакцией
epic: E2
priority: P1
status: ready
owner:
size: M
depends_on: [T-0040, T-0036]
zones:
  - backend/api/src/modules/wipe/wipe-runner.ts
  - backend/api/src/cli/wipe.ts
  - backend/api/package.json
  - backend/api/test/wipe-runner.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/20-env-and-ports.md
  - docs/21-diagrams.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: extra
release: none
design: null
---

# T-0041. Команда вайпа — подсчёт, снимок и стирание одной транзакцией

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0041.json)](README.md#значки-статуса) [![T-0040](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0040.json&label=T-0040)](T-0040-tester-compensation-snapshot.md) [![T-0036](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0036.json&label=T-0036)](T-0036-backup-before-deploy.md)

## Зачем

Вайп перед лончем (Р87) делается один раз и на проде — ошибиться нельзя.
Нужна команда, которая:

- сначала показывает, сколько строк уйдёт и сколько вернётся тестерам;
- потом одной транзакцией делает снимок компенсаций и стирает ровно то, что
  велит план (T-0039);
- после — пересобирает рейтинг.

Запускает её человек, по шагам из документа.

## Решения

- **Р87 и план T-0039** определяют, что стирается. Команда берёт порядок из
  `WIPE_ORDER` и сама ничего не решает.
- **Снимок и стирание — одна транзакция.** Упало что угодно — не стёрто
  ничего и снимка нет.
- **Только `deleteMany`, без `TRUNCATE`.** `TRUNCATE run CASCADE` стёр бы
  журнал покупок.
- **Ссылка покупки на стёртый забег обнуляется** (Р87). Связь `purchase.run`
  переходит на `onDelete: SetNull`, и стирание забегов само обнуляет
  `run_id` у покупок второго шанса. Звёзды, номер продолжения и оплата
  остаются. Уникальность `(run_id, continue_no)` не мешает: в Postgres `NULL`
  не равен `NULL`.
- **Защита от случайного запуска:**
  - запуск — только с `--run --confirm <сегодняшняя дата UTC, ГГГГ-ММ-ДД>`;
  - без этого команда только считает (`--plan`) и ничего не меняет.
- **Бэкап — до команды**, отдельным шагом человека:
  `./backup.sh --before-deploy wipe` (T-0036). Из контейнера команда бэкапов
  не видит, поэтому шаг — в инструкции, а не в коде.
- **Redis.** От стираемых таблиц зависит только рейтинг
  (`runs/leaderboard.store.ts`). После транзакции команда пересобирает его
  существующей `rebuildLeaderboard` — доски станут пустыми. Блокировки,
  сессии, лимиты и кеш ограничений не трогаются: ограничения остаются.

## Как сейчас

- **План вайпа — `modules/wipe/wipe-plan.ts` (T-0039):** `WIPE_PLAN`,
  `WIPE_ORDER` — 18 моделей.
- **Снимок — `modules/wipe/tester-snapshot.ts` (T-0040):**
  `takeTesterSnapshot(tx, now, { write })` → `SnapshotTotals`.
- **Связь покупки с забегом** — `schema.prisma`, модель `Purchase`:
  `run Run? @relation(fields: [runId], references: [runId], onDelete: Restrict)`.
- **Образец команды — `src/cli/runs-rebuild-leaderboard.ts`:**
  - `configFromEnvironment`, `createPrisma`, `createRedis`;
  - `rebuildLeaderboard(new PrismaRunsRepository(prisma), new RedisLeaderboardStore(redis), excluded)`;
  - `finally` закрывает Prisma и Redis;
  - скрипт в `backend/api/package.json` — `runs:rebuild-leaderboard`;
  - в контейнере — `node dist/cli/runs-rebuild-leaderboard.js`.
- **Бэкап перед выкатом — `infra/prod/backup.sh --before-deploy <версия>`
  (T-0036)**, файлы `rubezh-pre-*`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема и миграция.**
   - У `Purchase`: `run Run? @relation(fields: [runId], references: [runId], onDelete: SetNull)`.
   - Комментарий над связью — почему `SetNull`: вайп стирает забеги (Р87), а
     покупка остаётся.
   - Миграция — по правилу «Общие файлы»:
     - `--create-only` на отдельной базе, один раз;
     - в ней только пересоздание внешнего ключа `purchase_run_id_fkey` с
       `ON DELETE SET NULL`.
3. **Новый `modules/wipe/wipe-runner.ts`:**

   ```ts
   export interface WipeCounts {
     /** сколько строк в каждой модели сейчас — для `--plan` */
     rows: Record<Prisma.ModelName, number>;
     snapshot: SnapshotTotals;
   }

   export interface WipeResult {
     deleted: Partial<Record<Prisma.ModelName, number>>;
     snapshot: SnapshotTotals;
   }

   /** Посчитать и ничего не менять: строки по моделям и итоги снимка без записи. */
   export async function planWipe(prisma: PrismaClient, now: Date): Promise<WipeCounts>;

   /** Снимок и стирание одной транзакцией. Бросает — ничего не изменено. */
   export async function runWipe(prisma: PrismaClient, now: Date, deleter: Deleter = deleteAll): Promise<WipeResult>;

   /** Стереть все строки модели; параметром — чтобы тест проверил откат на сбое посреди. */
   export type Deleter = (tx: Prisma.TransactionClient, model: Prisma.ModelName) => Promise<{ count: number }>;
   ```

   - **`planWipe`:**
     - строки — `count()` по каждой модели плана;
     - снимок — `takeTesterSnapshot(tx, now, { write: false })` внутри
       транзакции только для чтения: `prisma.$transaction(fn)`, в которой
       ничего не пишется.
   - **`runWipe`:**
     - `prisma.$transaction(async (tx) => { … }, { timeout: 10 * 60_000, maxWait: 30_000 })`:
       1. `snapshot = await takeTesterSnapshot(tx, now, { write: true })`;
       2. для каждой модели из `WIPE_ORDER` по порядку —
          `deleted[model] = (await deleter(tx, model)).count`;
     - вернуть `{ deleted, snapshot }`.
   - **`deleteAll(tx, model)`** — явный `switch` по 18 моделям
     (`case "Run": return tx.run.deleteMany({})` и т. д.). В `default` —
     проверка `never`: модель, добавленная в план без ветки, не соберётся.
   - Комментарий файла:
     - запрет `TRUNCATE` и почему;
     - одна транзакция и почему;
     - ссылка на инструкцию в `docs/20-env-and-ports.md`.
4. **Новый `src/cli/wipe.ts`** по образцу `runs-rebuild-leaderboard.ts`:
   - **без аргументов или `--plan`** → `planWipe`. Вывод:
     - модели по строке: `стереть  Run  12 345` и `оставить  Purchase  321` —
       сначала стираемые в порядке `WIPE_ORDER`, затем оставляемые по
       алфавиту;
     - итоги снимка: тестеров, строк компенсации, бонус в самоцветах, звёзды
       второго шанса к переводу в самоцветы (`continueStars`), что
       вернётся по ресурсам;
     - последняя строка — `Ничего не изменено. Запуск: wipe --run --confirm <сегодня UTC>`;
   - **`--run --confirm <дата>`:**
     - дата не равна сегодняшней по UTC или аргументы другие → сообщение
       «Подтвердите сегодняшней датой UTC: --confirm ГГГГ-ММ-ДД», код 2;
     - иначе `runWipe`, потом пересборка рейтинга, как в
       `runs-rebuild-leaderboard.ts`: с исключением ограниченных;
     - вывод — удалённые строки по моделям, итоги снимка, итог пересборки;
   - ошибка → текст и код 1, как в образце.
5. **`backend/api/package.json`** — скрипт `"wipe": "node --conditions=source --import @swc-node/register/esm-register src/cli/wipe.ts"`.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- План и снимок — T-0039 и T-0040: команда их только вызывает.
- Выдачу компенсации — T-0042.
- `infra/prod/*`: бэкап — шаг человека по инструкции.
- Сам вайп на проде — его делает человек перед лончем, не исполнитель.

## Тесты

Первым коммитом, `backend/api/test/wipe-runner.integration.test.ts`. Нужен
живой Postgres — сервис CI (`TEST_DATABASE_URL`); пересборку рейтинга
проверяет её собственный тест, Redis здесь не нужен.

**База тестов общая: вайп по ней не запускать.** Тест создаёт свою
временную базу и прогоняет на ней все миграции:

- имя — `rubezh_wipe_<случайное>`;
- `CREATE DATABASE` через подключение к `TEST_DATABASE_URL`;
- `prisma migrate deploy` с адресом новой базы;
- в `afterAll` — `DROP DATABASE`.

Если создать базу нельзя — кейс пропускается с сообщением, а не падает. На
этой базе:

- **данные:**
  - тестер с уровнем 12, забегом, предметом, балансом самоцветов, наградой
    дня и уведомлением;
  - его покупка набора на 150 самоцветов с выдачей в журнале кошелька;
  - покупка второго шанса с `runId` его забега;
  - его друг, ограничение рейтинга и VIP-период;
- **`planWipe`** → строки по моделям сходятся с заведёнными, снимок:
  1 тестер, бонус 60, вернётся 150 самоцветов, `continueStars` — звёзды
  покупки второго шанса. Ничего не изменилось;
- **`runWipe`:**
  - 18 стираемых моделей пусты;
  - аккаунт, дружба, ограничение, VIP-период и обе покупки на месте;
  - у покупки второго шанса `runId = null`, номер продолжения прежний;
  - строка компенсации с `bonusGems: 60` и выдачей 150, у аккаунта
    `testerAt`;
- **сбой посреди транзакции** — `runWipe(prisma, now, (tx, model) => model === "Item" ? Promise.reject(new Error("сбой")) : deleteAll(tx, model))`
  бросает, и не изменилось ничего: забеги на месте, снимка нет, у покупки
  второго шанса `runId` прежний. Этот кейс — до кейса успешного вайпа;
- **повторный `runWipe`** → ошибка снимка, ничего не стёрто повторно;
- **разбор аргументов CLI** — функция `parseWipeArgs(argv, today)`, вынести
  её из `main` и проверить юнитом в том же файле:
  - пусто → `plan`;
  - `--plan` → `plan`;
  - `--run --confirm 2026-10-07` при `today = 2026-10-07` → `run`;
  - вчерашняя дата → ошибка;
  - `--run` без `--confirm` → ошибка;
  - лишний аргумент → ошибка.

## Аналитика

Нет. Итог вайпа — в выводе команды, его сохраняет человек по инструкции.

## Настройки и окружение

Нет.

## Документы

- `docs/20-env-and-ports.md` §5.4 — инструкция «Вайп перед лончем (Р87)»,
  шагами:
  1. объявить игрокам время работ — решение команды;
  2. `./backup.sh --before-deploy wipe` на сервере, проверить, что файл есть;
  3. `docker compose exec -T api node dist/cli/wipe.js --plan`, сверить итоги;
  4. `docker compose exec -T api node dist/cli/wipe.js --run --confirm <сегодня UTC>`;
  5. сохранить вывод команды в задаче вайпа;
  6. проверить в игре:
     - у тестера окно «Спасибо за тест» (T-0043);
     - рейтинг пуст, покупки в панели на месте.

  Отдельной строкой — откат: восстановление из файла бэкапа, по существующему
  разделу о восстановлении.
- `docs/21-diagrams.md` — у связи `PURCHASE }o--o| RUN` пометка «обнуляется
  вайпом», если у связей есть подписи.
- `docs/35-stage4-plan.md`, WP33 — «Как сделано, часть 3 — команда вайпа»:
  - план, снимок и стирание одной транзакцией;
  - защита датой;
  - `SetNull` у покупки;
  - пересборка рейтинга.

## Критерии приёмки

- [ ] `wipe --plan` показывает строки по моделям и итоги снимка и ничего не
  меняет.
- [ ] `wipe --run --confirm <сегодня>` делает снимок и стирает ровно 18
  моделей плана одной транзакцией. Журнал покупок, аккаунты, друзья, VIP и
  ограничения остаются.
- [ ] Сбой посреди — ничего не изменено. Повторный запуск отказывается.
- [ ] У покупок второго шанса обнуляется только `run_id`.
- [ ] Рейтинг после вайпа пересобран.
- [ ] Инструкция вайпа — в `docs/20-env-and-ports.md`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `chore(api): Команда вайпа перед лончем`
- **Метка:** `release: none` — до игрока не доходит, пока вайп не запущен
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КОМАНДА ВАЙПА**

  Готова команда вайпа перед лончем. Она сначала показывает, что уйдёт и что вернётся тестерам, а запускается только с подтверждением сегодняшней датой.

  🧹 **Как устроено**

  • снимок компенсаций и стирание — одной транзакцией: сбой посреди не стирает ничего
  • стирается ровно то, что в плане вайпа; журнал покупок, друзья, VIP и ограничения остаются
  • после вайпа рейтинг пересобирается пустым
  • инструкция по шагам, с бэкапом до запуска, — в docs/20-env-and-ports.md
  ```
