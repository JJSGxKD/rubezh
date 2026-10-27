---
id: T-0203
title: Сводка «чего достигли» в панели — итоги за всё время и рекорды DAU/WAU/MAU
epic: E7
priority: P2
status: ready
owner:
author: claude-lead2-1
size: M
depends_on: [T-0052, T-0115]
zones:
  - backend/api/src/modules/admin/admin-all-time.controller.ts
  - backend/api/src/modules/admin/admin-all-time.service.ts
  - backend/api/src/modules/admin/admin-all-time.repository.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/admin-notify/activity-snapshot.job.ts
  - backend/api/src/modules/admin-notify/activity-snapshot.ts
  - backend/api/src/modules/admin-notify/admin-notify.module.ts
  - backend/api/test/admin-all-time.test.ts
  - backend/api/test/activity-snapshot.test.ts
  - backend/api/test/admin-all-time.integration.test.ts
  - apps/admin/src/api/all-time.ts
  - apps/admin/src/screens/overview/AllTimePanel.tsx
  - apps/admin/src/screens/overview/OverviewScreen.tsx
  - apps/admin/test/all-time.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/wipe/wipe-plan.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0203. Сводка «чего достигли» в панели — итоги за всё время и рекорды DAU/WAU/MAU

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0203.json)](README.md#значки-статуса) [![T-0052](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0052.json&label=T-0052)](archive/T-0052-overview-ads-and-periods-screen.md) [![T-0115](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0115.json&label=T-0115)](T-0115-board-label-in-reports.md)

## Зачем

Сводка панели показывает «сегодня против вчера» и две недели. Ответить на вопрос
«чего мы достигли за всё время» нельзя: сколько у нас аккаунтов и на каких
площадках, скольким из них можно писать, сколько денег принёс проект, сколько
человек играло и каков рекорд суточной, недельной и месячной аудитории. Задача
добавляет на экран «Сводка» панель «Чего достигли».

## Решения

Запрос пользователя от 15.10.2026 (`tasks/inbox.md`, строка «Аналитика: сводные и
исторические цифры»). Пункты ниже, кроме первого, — **предложения
claude-lead2-1, тимлид проверяет** (заведены без записанного решения; исполнитель
исполняет их как написано, а спорное — вопрос по `tasks/README.md`, «Если что-то
неясно»).

1. **Источник цифр — база и снимки по дням, не Prometheus** (там низкая
   кардинальность и короткая история, `docs/22-analytics-and-metrics.md`). Решение
   пользователя.
2. **Где.** Новая панель «Чего достигли» на экране «Сводка» (`overview`), ниже
   «Две недели по суткам». Отдельного раздела меню нет. Отдельный запрос
   `GET /admin/overview/all-time`: ежеминутное обновление сводки (60 с) его не
   перезапрашивает — панель грузится при открытии экрана и по кнопке «Обновить» в
   своём заголовке.
3. **Права.** Панель целиком — `analytics.gameplay.view` (как сводка). Плитка
   дохода — только с `analytics.revenue.view`; без права сервер отдаёт `revenue:
   null`, а клиент плитку не рисует (как «Звёзды» в «Сегодня»).
4. **Что считаем «аккаунтом».** Все строки `account`, включая команду и
   заблокированных (`banned_at`): так сходится с ежедневным отчётом в чат и с
   «Играли» в сводке, они тоже считают всех. Для прозрачности в подписи плитки
   «Аккаунтов» — «из них заблокировано N». Команду (есть строка в `account_role`)
   отдельно не вычитаем.
5. **«Доступно для рассылки»** — `account_messaging.can_message = true`
   (`docs/35-stage4-plan.md` §3.10), по площадкам тем же разрезом. Аккаунт без
   строки в `account_messaging` — писать нельзя. Заблокированных банном не
   вычитаем (рассылка сама их отсеивает, это не задача панели).
6. **«Доход проекта» — звёзды живых оплат за всё время, за вычетом возвратов.**
   `purchase.mode = 'live'`; оплачено — `sum(charged_stars)` по `paid_at is not
   null`, возвращено — `sum(charged_stars)` по `refunded_at is not null`; доход =
   оплачено − возвращено, плюс число покупок. Пересчёта в доллары и рубли нет:
   бухгалтерия (`docs/37-accounting.md`, Р98) в статусе черновика, курс звезды на
   дату оплаты нигде не хранится, а «по текущему курсу» исказило бы историю.
   Реклама: денег от сетей в базе нет — панель так и говорит, цифру не выдумывает
   (так же, как сводка, `admin-overview.service.ts`, `OverviewAds`). Когда
   появится бухгалтерия, плитка переедет на неё отдельной задачей.
7. **«Играл»** — аккаунт хотя бы с одним законченным забегом без читов
   (`run.status = 'finished' AND NOT cheats`), как «Забеги» в сводке и отчёте.
   «Забегов» — число таких забегов. Вайп стирает забеги (`WIPE_PLAN`, Р87), поэтому
   эти две цифры считаются **с последнего вайпа**; аккаунты, покупки и сессии
   вайп не стирает. Это написано в подсказке «?» плитки.
8. **DAU/WAU/MAU и рекорды.** Сессии запуска (`account_session`) вайп не стирает и
   нигде не удаляет, из них история и берётся. Сутки — московские (`teamDay`,
   `docs/22`). DAU — разных `account_id` с запуском в сутках; WAU — за 7 суток,
   заканчивающихся этими сутками включительно; MAU — за 30. «Играли» по смыслу —
   любой запуск, как «Играли» в сводке (не обязательно забег).
   - Таблица-снимок `activity_daily`: по строке на закрытые московские сутки.
     Скользящее окно каждый раз не пересчитываем.
   - **Рекорд** — максимум по снимкам и по сегодняшним (ещё не закрытым) живым
     цифрам, с датой; при равенстве — более ранняя дата. Сегодняшние сутки
     считаются запросом на лету (три `count(DISTINCT)` по индексу
     `account_session(started_at)`), результат — в кеше панели.
9. **Кеш.** Тяжёлые агрегаты (всё, кроме сегодняшних DAU/WAU/MAU) — в Redis одним
   ключом `admin:all-time:v1`, JSON, TTL 300 с. Пересчёт одним запросом, с
   замком `SET NX EX 30` на ключе `admin:all-time:v1:lock`: пока замок у соседней
   реплики, остальные ждут результата до 5 с с опросом раз в 250 мс, а не бегут в
   базу. Не дождались — считают сами. Доход режется по праву **после** кеша: в
   кеш кладётся полный ответ, права смотрятся на каждый запрос.
10. **Задание ночного снимка.** BullMQ-расписание (как `online.job.ts`: постоянный
    id планировщика `activity-snapshot`, `concurrency: 1` — одно задание на тик на
    все реплики, это и есть распределённый лок) с cron `20 0 * * *` в зоне
    `Europe/Moscow` — после отчёта 00:10. Задание закрывает все сутки от
    последней записи + 1 до вчерашних включительно. Пустая таблица — **бэкфилл**:
    от суток первой сессии (`min(started_at)`), не больше 400 суток за один запуск
    (остальное доберёт следующий запуск или перезапуск API); каждые сутки — свои
    три запроса и один `INSERT … ON CONFLICT (day) DO NOTHING`, повтор безопасен.
    Бэкфилл идёт и при старте API (`onApplicationBootstrap`), если таблица пуста
    или отстаёт больше чем на сутки — не дожидаясь ночи.

Вопросов к пользователю нет: всё, что не записано выше, считается кодом или
документом. Если тимлид не согласен с пп. 4, 6 или 7 — правится только текст и
формула соответствующей плитки, остальная спецификация не зависит.

## Как сейчас

- `backend/api/src/modules/admin/admin-overview.controller.ts` — образец контроллера
  панели: `@UseGuards(AdminSessionGuard, PermissionGuard)`,
  `@RequirePermission("analytics.gameplay.view")`, `parse(...)` из
  `admin-parse.ts`. Сервис `admin-overview.service.ts` проверяет права ещё и сам
  (`roles.require`, `permissionsOf(...).has("analytics.revenue.view")`) и скрывает
  выручку полем `null` — повторяем эту схему.
- `backend/api/src/modules/admin-notify/daily-stats.repository.ts` — «сырой» SQL по
  `account`, `account_session`, `run`, `purchase`; результаты разбираются Zod-схемами
  (`z.coerce.number()`), сутки — `AT TIME ZONE 'Europe/Moscow'`. Те же приёмы и те
  же определения «играли», «забеги», «выручка» здесь нужны. `teamDay`, `dayWindow`,
  `previousDay` — в `daily-stats.ts`.
- `backend/api/src/modules/online/online.job.ts` — образец задания BullMQ с
  `upsertJobScheduler`; `daily-stats.reporter.ts` — образец отметки суток в Redis
  (`SET … NX EX`).
- `backend/api/src/modules/admin/admin.module.ts` — сюда добавляются контроллер и
  сервис; `admin-notify.module.ts` — модуль, куда ложится задание снимка (он уже
  владеет сутками и отчётом) и откуда экспортируется репозиторий снимка.
- Схема: `backend/api/prisma/schema.prisma`, модели `Account` (платформа,
  `bannedAt`), `AccountSession` (`startedAt`, индекс `startedAt`), `AccountMessaging`
  (`canMessage`, индекс), `Purchase` (`mode`, `paidAt`, `refundedAt`,
  `chargedStars`, индекс `mode, paidAt`), `Run`. Последняя миграция —
  `20261020192407_account_platform_name`.
- Экран: `apps/admin/src/screens/overview/OverviewScreen.tsx` (плитки `Tile`,
  `Panel`, `Help` из `ui/kit.tsx`), клиент `apps/admin/src/api/overview.ts` (схема
  Zod + `api.request`), формат — `apps/admin/src/format.ts` (`formatNumber`,
  `formatDateTime`, `plural`). Подсказки «?» лежат в `ui/help.ts`, но этот файл
  в зонах чужих задач — **тексты подсказок этой задачи лежат константами в
  `AllTimePanel.tsx`** (приём T-0181).
- `docs/22-analytics-and-metrics.md` §«Витрины»: `mart_dau` описана как будущая
  витрина по разрезам. `activity_daily` — её первая реализация без разрезов.
- Платформы: `Platform` = `telegram | max | vk | web`. Названия для людей —
  «Telegram», «MAX», «VK», «Веб».

## Шаги по порядку

1. **Схема и миграция.** В конец `schema.prisma` блоком с заголовком-комментарием
   «Снимки аудитории по суткам (tasks/T-0203)»:
   ```prisma
   /// Закрытые московские сутки: сколько разных аккаунтов запускало игру в них,
   /// за 7 и за 30 суток, заканчивая ими. Рекорды DAU/WAU/MAU — максимум по строкам.
   model ActivityDaily {
     day        String   @id @db.VarChar(10)   // «2026-10-01», сутки по Москве
     dau        Int
     wau        Int
     mau        Int
     computedAt DateTime @default(now()) @map("computed_at") @db.Timestamptz(3)

     @@map("activity_daily")
   }
   ```
   Миграция — `prisma migrate dev --create-only` один раз на отдельной базе после
   перебазирования на свежий `dev` (`tasks/README.md`, «Общие файлы»). Проверить
   `ls backend/api/prisma/migrations | tail`: папка одна. В `modules/wipe/wipe-plan.ts` добавить ровно одну строку
   `ActivityDaily: keep("снимки аудитории по суткам — история, вайп её не стирает")`,
   иначе упадёт `test/wipe-plan.test.ts`.
2. **Чистая логика снимка** — `admin-notify/activity-snapshot.ts`:
   `daysToClose(lastClosed: string | null, firstSession: Date | null, now: Date, limit = 400): string[]`
   — какие сутки закрыть (от последней записи + 1 или от суток первой сессии до
   вчерашних включительно, не больше `limit`; нет сессий — пусто);
   `windowOf(day: string, length: 1 | 7 | 30): { from: Date; to: Date }` —
   `[полночь (day − length + 1), полночь day + 1)` по `dayWindow`;
   `pickRecord(points: {day, value}[]): {value, day} | null` — максимум, при
   равенстве более ранний день. Без Prisma и Redis.
3. **Репозиторий** — `admin/admin-all-time.repository.ts`, интерфейс
   `AllTimeRepository` + токен + `Prisma…` реализация (сырой SQL, Zod на выходе):
   - `accounts()`: `SELECT platform::text, count(*) AS total, count(*) FILTER (WHERE banned_at IS NOT NULL) AS banned, count(*) FILTER (WHERE m.can_message) AS reachable FROM account a LEFT JOIN account_messaging m USING (account_id) GROUP BY 1`;
   - `runs()`: `count(*)` и `count(DISTINCT account_id)` по `run WHERE status = 'finished' AND NOT cheats`;
   - `revenue()`: по `purchase WHERE mode = 'live'` — `sum(charged_stars) FILTER (WHERE paid_at IS NOT NULL)`, `sum(charged_stars) FILTER (WHERE refunded_at IS NOT NULL)`, `count(*) FILTER (WHERE paid_at IS NOT NULL)`;
   - `records()`: `SELECT day, dau, wau, mau FROM activity_daily` — только максимумы: три запроса `ORDER BY <поле> DESC, day ASC LIMIT 1`;
   - `activeNow(window)`: `count(DISTINCT account_id)` из `account_session` по окну — для сегодняшних DAU/WAU/MAU;
   - для задания: `lastClosedDay()`, `firstSessionAt()`, `insertDay(day, dau, wau, mau)` (`ON CONFLICT (day) DO NOTHING`).
   Каждый вызов базы из сервиса — через `withTimeout(…, 20_000, "…")`.
4. **Сервис** — `admin/admin-all-time.service.ts`: `allTime(actor, now = new Date()): Promise<AllTime>`.
   Проверяет `roles.require(actor, "analytics.gameplay.view")`, берёт полный
   ответ из кеша (п. 9 «Решений») или считает, обнуляет `revenue`, если нет права
   `analytics.revenue.view`. Форма ответа:
   ```ts
   interface AllTime {
     at: string;                 // ISO — когда посчитано (кеш старше минуты это видно)
     accounts: { total: number; banned: number; byPlatform: { platform: "telegram"|"max"|"vk"|"web"; total: number }[] };
     reachable: { total: number; byPlatform: { platform: …; total: number }[] };
     played: { players: number; runs: number };
     revenue: { stars: number; paid: number; refunded: number; purchases: number } | null;
     records: Record<"dau"|"wau"|"mau", { value: number; day: string; now: number } | null>; // now — сегодняшнее живое
   }
   ```
   `records[k].value` = максимум из снимков и сегодняшнего живого, `day` — его
   сутки (сегодняшние — `teamDay(now)`); `null` — снимков нет и сегодня никого.
5. **Контроллер** — `admin/admin-all-time.controller.ts`: `@Controller("admin/overview")`,
   `@Get("all-time")`, `@RequirePermission("analytics.gameplay.view")`, лимит частоты
   как у соседних чтений панели (`ADMIN_LIMITS`, проверить, что для чтений он есть;
   нет — не вводить, `GET` кеширован). Ответ `{ data: AllTime }`. Регистрация — в
   `admin.module.ts`.
6. **Задание снимка** — `admin-notify/activity-snapshot.job.ts` по образцу
   `online.job.ts`: очередь `activity-snapshot`, планировщик `activity-snapshot`
   с `{ pattern: "20 0 * * *", tz: "Europe/Moscow" }`, воркер `concurrency: 1`,
   `onApplicationBootstrap` ещё и запускает один проход сразу (пусто или отстаёт).
   Проход: `daysToClose` → для каждых суток три `count(DISTINCT)` (окна 1/7/30) →
   `insertDay`. Один сбой суток — запись в лог одной JSON-строкой
   (`event: "activity_snapshot_failed"`, `day`, `reason`), остальные сутки не
   пропускаются, но проход останавливается на первой ошибке (дальше окно уйдёт
   дырой). Итог прохода — строка лога `activity_snapshot_done` с числом закрытых
   суток. Включение — как у `online.job.ts` (`databaseUrl !== ""`). Подключить в
   `admin-notify.module.ts`.
7. **Клиент панели** — `apps/admin/src/api/all-time.ts`: Zod-схема ответа и
   `fetchAllTime(api)`; чистые функции `platformLine(rows)` («Telegram 1 200 · VK 340»,
   платформы с нулём пропускаются, крупные первыми, пусто — «пока никого»),
   `recordLine(record)` («рекорд 5 421 — 14 октября», дата словами через `dayTitle`
   из `api/overview.ts`; год добавлять, если не текущий — по полю `at`),
   `starsLine(revenue)`.
8. **Экран** — `screens/overview/AllTimePanel.tsx` и одна строка в
   `OverviewScreen.tsx`: `<AllTimePanel />` после `<Series …/>`. Своё состояние
   через `useApi` (загрузка / ошибка с повтором / данные), без автообновления.
   Тексты — раздел «Сценарий и интерфейс».
9. **Документы** — см. раздел «Документы».

## Чего не трогаем

- `admin-overview.service.ts`, `api/overview.ts`, `ui/help.ts`, `ui/kit.tsx` — в зонах
  T-0052, T-0179, T-0188 и других; сводка сегодня/вчера не меняется.
- Ежедневный отчёт в чат (`daily-stats.*`) — формат и цифры прежние.
- Prometheus и метки метрик — не используем и не добавляем.
- Деньги: ни пересчёта в валюты, ни рекламной выручки, ни холдов — это
  бухгалтерия (`docs/37-accounting.md`).
- Сессии, аккаунты, покупки, забеги — таблицы не меняются и не архивируются.
- Разрезы DAU по платформам, источникам и странам (`mart_dau` целиком) — отдельная
  задача; здесь одна цифра на сутки.

## Сценарий и интерфейс

Человек с правом «Аналитика игры» открывает «Сводка» и ниже двух недель видит
панель **«Чего достигли»** (заголовок панели, справа кнопка «Обновить» и серая
подпись «посчитано в {время}»).

Плитки (сетка как у «Сегодня»: 2 колонки на узком экране, 4 на широком — доход
вместе с остальными):

| Плитка | Значение | Подпись |
|---|---|---|
| «Аккаунтов всего» | `accounts.total` | платформы по убыванию (`platformLine`) и, если есть, « · заблокировано N» отдельной строкой |
| «Можно писать в бота» | `reachable.total` | платформы по убыванию; рядом доля: «N% от всех» |
| «Играло людей» | `played.players` | «забегов {runs}» |
| «Доход, звёзд» | `revenue.stars` | «оплачено {paid} · возвращено {refunded} · покупок {purchases}»; плитки нет без права `analytics.revenue.view` |

Ниже ряд «Рекорды аудитории» — три плитки **«Рекорд DAU»**, **«Рекорд WAU»**,
**«Рекорд MAU»**: значение, подпись «{дата словами}» и вторая строка «сейчас {now}».
Если `record.day` сегодняшний — подпись «сегодня, ещё идёт».

Подсказки «?» (дословно):

- Панель: «Итоги за всё время из базы. Цифры кешируются на пять минут, поэтому могут отставать от сводки выше. Рекламные выплаты сетей в них не входят: денег от сетей в базе нет.»
- «Аккаунтов всего»: «Все аккаунты, в том числе команды и заблокированные: так же считает ежедневный отчёт в чат. Аккаунты на разных площадках — разные, одного человека на двух площадках мы не склеиваем.»
- «Можно писать в бота»: «Аккаунты, которым бот может написать: игрок вошёл в канал площадки или разрешил сообщения и не заблокировал бота. Это аудитория рассылок.»
- «Играло людей»: «Игроки хотя бы с одним законченным забегом без читов. Забеги стирает вайп, поэтому и игроки, и забеги считаются с последнего вайпа.»
- «Доход, звёзд»: «Звёзды живых оплат за всё время минус возвраты, тестовые оплаты не считаются. В рубли и доллары не пересчитываем: курс на дату оплаты не хранится.»
- «Рекорд DAU/WAU/MAU»: «Лучшие сутки по числу разных игроков, запускавших игру: за сутки (DAU), за 7 суток (WAU) и за 30 суток (MAU), считая сутки по Москве. История — по сессиям запуска, вайп её не стирает. Сегодняшние сутки учитываются сразу, пока не закончились.»

Состояния:

- **Загрузка** — общий `Loading` внутри панели, остальная сводка не ждёт.
- **Пусто** (новая база): «Пока никого» у платформ, значения «0», у рекордов «рекордов пока нет» вместо даты.
- **Ошибка** — `ErrorNotice` с кнопкой повтора внутри панели, соседние панели живут.
- **Нет сети** — то же, что ошибка (`ErrorNotice` показывает сообщение клиента).
- **Нет права на доход** — плитка «Доход» не рисуется, сетка перестраивается на 3 колонки (как у «Сегодня»).
- **Узкий экран** — плитки в две колонки, подписи переносятся, горизонтального скролла нет.

## Тесты

Пишутся первым коммитом, до кода.

- `backend/api/test/activity-snapshot.test.ts` (чистая логика):
  - `daysToClose(null, 1 октября, 4 октября)` → 1, 2, 3 октября (вчерашние — последние);
  - `daysToClose("2026-10-02", …, 4 октября)` → только 3 октября;
  - последняя запись — вчерашняя → пусто; нет сессий и записей → пусто;
  - `limit = 2` → два первых дня;
  - `windowOf("2026-10-07", 7)` → с московской полночи 1 октября до полночи 8 октября;
  - `windowOf` для 30 через границу месяца и года;
  - `pickRecord`: максимум; при равенстве — ранний день; пусто → `null`.
- `backend/api/test/admin-all-time.test.ts` (сервис и маршрут на памяти, образец
  `test/admin-overview.test.ts`):
  - без права `analytics.gameplay.view` → 403;
  - с `gameplay`, но без `revenue` → `revenue: null`, остальное на месте;
  - с обоими → доход считается: оплачено 500, возвращено 120 → `stars: 380`;
  - рекорд: снимки 100/120, сегодня живое 130 → рекорд 130 и сегодняшние сутки; сегодня 90 → 120 и его дата;
  - второй запрос в пределах TTL не ходит в репозиторий (счётчик вызовов), доход режется по праву после кеша: кеш наполнил админ с доходом, второй запрос без права отдаёт `null`;
  - сбой одного чтения репозитория → 500-ответ без частичных данных (панель не врёт неполной цифрой);
  - замок кеша: пока ключ замка занят, запрос ждёт и берёт результат соседа, не вызывая репозиторий.
- `backend/api/test/admin-all-time.integration.test.ts` (живой Postgres, в далёких
  сутках, как `daily-stats.integration.test.ts`; без базы — пропуск):
  - три платформы, у одной аккаунт с `can_message = true`, у другой без строки
    `account_messaging`, один заблокирован → разрезы «всего» и «можно писать» верны;
  - покупки: `live`/`paid` 50, `live`/`refunded` 30 (и `paid_at` тоже), `test` 1,
    `pending` без `paid_at` → оплачено 80, возвращено 30, покупок 2;
  - забеги: `finished` без читов — считается; с `cheats = true` и `status` не
    `finished` — нет; два забега одного аккаунта — один игрок, два забега;
  - сессии в 23:59 и 00:00 по Москве попадают в соседние сутки; WAU за семь суток
    включает сутки-границу и не включает восьмые; MAU — тридцатые;
  - бэкфилл: пустая таблица + сессии за три дня → три строки; второй запуск
    ничего не меняет; сутки без сессий — строка с нулями, а не дыра.
- `apps/admin/test/all-time.test.ts`: `platformLine` (порядок, нули пропущены,
  пусто → «пока никого»); `recordLine` (дата словами, год у прошлого года, `null`
  → «рекордов пока нет»); разбор ответа схемой, `revenue: null` принимается.
- `test/wipe-plan.test.ts` (существующий) остаётся зелёным с новой строкой плана.

## Аналитика

Новых событий нет: задача только читает уже записанное и ничего не делает с
игроком, деньгами или трафиком. Данные, которых раньше не было, — суточный снимок
аудитории `activity_daily`; он и есть начало витрины `mart_dau`
(`docs/22-analytics-and-metrics.md`, §«Витрины»). Задание пишет в лог строки
`activity_snapshot_done` / `activity_snapshot_failed` (JSON, как `online.job.ts`);
в Prometheus метрик не добавляется.

## Настройки и окружение

Нет. Константы в коде, не меняются без релиза: TTL кеша (300 с), замок (30 с),
ожидание соседа (5 с), расписание `20 0 * * *` Europe/Moscow, потолок бэкфилла
(400 суток). Они записываются в `docs/30-configuration-map.md` (§5 «Аналитика»,
строкой в конце таблицы). Новых переменных окружения, ключей `setting-catalog.ts`,
прав и портов нет.

## Документы

- `docs/21-diagrams.md` — в `erDiagram` сущность `ACTIVITY_DAILY` (в конец блока).
- `docs/22-analytics-and-metrics.md` — в описании `mart_dau`: «первая реализация —
  `activity_daily` без разрезов (tasks/T-0203)».
- `docs/29-admin-panel.md` §5.2 — панель «Чего достигли» на «Сводке»: что в ней, откуда цифры, кто видит доход.
- `docs/30-configuration-map.md` — строка про константы (см. выше).
- `tasks/inbox.md` — строку «Аналитика: сводные и исторические цифры» тимлид
  снимает при слиянии, не исполнитель.

## Критерии приёмки

- [ ] Экран «Сводка» показывает панель «Чего достигли» с плитками из таблицы, тексты и подсказки дословно.
- [ ] Без `analytics.revenue.view` ответ сервера содержит `revenue: null`, плитки дохода нет; проверено тестом после кеша.
- [ ] Доход = оплаченные живые минус возвращённые; тестовые и неоплаченные не входят.
- [ ] «Можно писать» считается по `can_message`, аккаунт без строки — нельзя.
- [ ] Рекорды DAU/WAU/MAU берутся из `activity_daily` и сегодняшних живых цифр, дата верна по Москве; сессии у границы суток попадают в нужные сутки.
- [ ] Бэкфилл на пустой таблице строит историю из сессий, повторный запуск безвреден; задание одно на все реплики.
- [ ] Тяжёлые агрегаты в кеше Redis с замком; повторный запрос в пределах TTL не ходит в базу.
- [ ] Миграция одна, `WIPE_PLAN` содержит `ActivityDaily`, `test/wipe-plan.test.ts` зелёный.
- [ ] Схемы и документы из раздела «Документы» обновлены в этом PR.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; интеграционные тесты прогнаны на живых Postgres и Redis.

## PR

- **Заголовок:** `feat(admin): Сводка «Чего достигли» с рекордами аудитории`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СВОДКА «ЧЕГО ДОСТИГЛИ» С РЕКОРДАМИ АУДИТОРИИ**

  В панели на экране «Сводка» появилась панель итогов за всё время: аккаунты по площадкам, сколько из них можно писать в боте, сколько человек играло и сколько забегов, доход в звёздах и рекорды DAU/WAU/MAU с датами.

  🛠 **Как считается**

  • Рекорды — из суточных снимков аудитории (ночное задание 00:20 по Москве; история достроена из сессий запуска)
  • Доход — живые оплаты звёздами минус возвраты, видит только тот, у кого открыта выручка
  • Играло людей и забегов считаются с последнего вайпа

  ❓ **Нужно от команды**

  • @владелец — свериться с цифрами панели, прежде чем выкладывать их в посты
  ```
