---
id: T-0089
title: Пропуск рекламы VIP — отдельной меткой «Пропуск VIP», не досмотр
epic: E7
priority: P2
status: ready
owner:
author: claude-lead2-9
size: M
depends_on: [T-0052]
zones:
  - backend/api/src/modules/ads/ads-catalog.repository.ts
  - backend/api/src/modules/ads/ads-catalog.service.ts
  - backend/api/src/modules/admin/admin-overview.service.ts
  - backend/api/src/modules/admin-notify/daily-stats.repository.ts
  - backend/api/test/ads-catalog.test.ts
  - backend/api/test/admin-overview.test.ts
  - backend/api/test/ads.integration.test.ts
  - backend/api/test/daily-stats.integration.test.ts
  - apps/admin/src/api/ads.ts
  - apps/admin/src/api/overview.ts
  - apps/admin/src/screens/ads/AdsScreen.tsx
  - apps/admin/src/screens/overview/*.tsx
  - apps/admin/test/ads.test.ts
  - apps/admin/test/overview.test.ts
shared:
  - apps/admin/src/ui/help.ts
  - docs/22-analytics-and-metrics.md
  - docs/29-admin-panel.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 2
---

# T-0089. Пропуск рекламы VIP — отдельной меткой «Пропуск VIP», не досмотр

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0089.json)](README.md#значки-статуса) [![T-0052](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0052.json&label=T-0052)](T-0052-overview-ads-and-periods-screen.md)

## Зачем

VIP получает награду места рекламы без ролика: сервер пишет сессию «пропуска», сразу
выполненную. Сейчас она попадает в досмотры, воронку и сети под именем `vip` — досмотры
завышены. После задачи пропуск нигде не досмотр, а своя метка «Пропуск VIP»: в сводке
панели рядом с досмотрами и в разделе «Реклама».

## Решения

- **Р99 (13.10.2026, пользователь):** сессия пропуска VIP — не досмотр. Из досмотров, выручки
  рекламы, разбивки по сетям и воронки она уходит; считается отдельной меткой «Пропуск VIP».
- **Миграции нет: признак уже записан.** Пропуск — строка `ad_session` с `block_id IS NULL`:
  `schema.prisma:1724`; `CHECK ad_session_pass_check` (миграция `20261001120000_ad_pass`)
  не пускает пустой блок иначе как выполненный показ; блок с показами не удаляется
  (`onDelete: Restrict`, `schema.prisma:1748`); `funnel/flag-split-report.ts:122` уже берёт
  награды рекламы по `block_id IS NOT NULL`. Старые записи считаются правильно сразу.
- **Единица метки — выданная сессия;** в «Рекламе» рядом — игроков и забранных наград.
- **Не меняется:** выдача пропусков (`ads.service.ts:236-254`), кулдаун места (`docs/35` Р44),
  `wheel_spun`, лог `ad_passed`. Метка в сводке — с `ads.view`; видимость ряда — отдельная
  находка (`tasks/inbox.md`, «Приёмка #284: кто видит досмотры в ряду сводки»).

## Как сейчас

- `ads.repository.ts:365-370` `createPassSession`: `block_id NULL`, `network_key` — `vip`,
  `completed`. `ads-catalog.repository.ts:179-189` `funnel(from, to)` считает все строки окна
  `created_at` по сети и месту; `ads-catalog.service.ts`: `AdsCatalogView.funnel` (105), `view()` (132).
- `admin/admin-overview.service.ts`: `AdsTotals` 46-52, `adsOverview` 132-151, `totalsOf`
  199-209, `networksOf` 212-216 — всё из `funnel`, пропуск попадает в `completed` и `networks`.
- `admin-notify/daily-stats.repository.ts:136-138` — ряд досмотров по `completed_at` без
  разбора блока; `DayPoint` 17-29, точки 143-153.
- `apps/admin/src/api/ads.ts:54-58` `PASS_TITLES` (`vip` → «VIP без ролика») и
  `funnelNetworkTitle`; `viewSchema` 150-160. `AdsScreen.tsx:184` `FunnelPanel`.
- **Ловушка:** `adSession` в `daily-stats.integration.test.ts:74-79` создаёт сессию без блока — станет пропуском (шаг 9).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`ads-catalog.repository.ts`:** в `funnel` добавить `AND block_id IS NOT NULL`. Новое:

   ```ts
   /** Пропуск рекламы за окно (Р99): награда места без ролика. Не показ и не досмотр. */
   export interface AdPassRow { passName: string; place: AdPlace; used: number; players: number; claimed: number }
   // в AdsCatalogRepository: passes(from: Date, to: Date): Promise<AdPassRow[]>;
   ```

   `passes` — тот же индекс `created_at`, разбор Zod рядом с `funnelSchema`; комментарий:
   пропуск — строка без блока, отдельной колонки нет.

   ```sql
   SELECT network_key AS pass_name, place::text, count(*) AS used,
          count(DISTINCT account_id) AS players, count(claimed_at) AS claimed
   FROM ad_session WHERE created_at >= ${from} AND created_at < ${to} AND block_id IS NULL
   GROUP BY network_key, place ORDER BY place, network_key
   ```

3. **`ads-catalog.service.ts`:** `AdsCatalogView.passes: AdPassRow[]`; `view()` читает
   `repository.passes` за то же окно в том же `Promise.all`.
4. **`admin-overview.service.ts`:** `AdsTotals.passed: number`; `adsOverview` читает
   `this.ads.passes` за оба окна в том же `Promise.all` (`withTimeout`, «сводка: пропуски
   рекламы»); упало — `ads: null`, как у воронки. `totalsOf(rows, passes)` складывает `used`
   в `passed`. Место входит в `places`, если по нему есть строки воронки **или** пропусков
   (`rows.length === 0 && used.length === 0 ? [] : [...]`). `networks` — по-прежнему из `funnel`.
5. **`daily-stats.repository.ts`:** один запрос ряда вместо обхода таблицы дважды:

   ```sql
   SELECT to_char(completed_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day,
          count(*) FILTER (WHERE block_id IS NOT NULL) AS views,
          count(*) FILTER (WHERE block_id IS NULL) AS passes
   FROM ad_session WHERE completed_at >= ${from} AND completed_at < ${to} GROUP BY 1
   ```

   `DayPoint.adsPassed` под `adsCompleted`; `adsCompleted` берёт `views`; свой Zod-разбор
   (`day`, `views`, `passes`). Индекс не добавляем (`tasks/inbox.md`, «ряд досмотров без индекса»).
6. **`apps/admin/src/api/ads.ts`:** `passSchema`; в `viewSchema`
   `passes: z.array(passSchema).default([])` (старый ответ читается); `PASS_TITLES` →
   `{ vip: "VIP" }`, `passTitle(key): string` (подпись или ключ); из `funnelNetworkTitle`
   убрать подстановку пропуска, докомментарий переписать: пропуски — отдельная таблица.
7. **`AdsScreen.tsx`:** `PassPanel` под `FunnelPanel`, окно то же (`view.days`): заголовок
   «Пропуск VIP», `help={HELP.ads.passes}`, `DataTable` по `view.passes` (ключ
   `${place}:${passName}`), колонки «Место» (`PLACE_TITLES`), «Пропуск» (`passTitle`),
   «Выдано», «Игроков», «Награды» (числа справа); пусто — «Пропусков за это время не было».
8. **`ui/help.ts`:** в `HELP.ads.funnel` фразу «Строки без сети — пропуски VIP: награда места
   без ролика.» заменить на «Пропуски VIP сюда не входят — они в таблице ниже.»; новый
   `HELP.ads.passes`: «Сколько раз игроки с VIP получили награду места без ролика (колесо,
   второй шанс, удвоение за забег). Это не досмотры: в воронку и сети они не входят.
   «Выдано» — сколько раз запросили, «Награды» — сколько забрано. Кулдаун пропуск не отменяет.»
9. **Фикстура `daily-stats.integration.test.ts`:** `adSession` привязать к настоящему блоку —
   свои `ad_network` и `ad_block` в `beforeAll`, как в `ads.integration.test.ts:57-65`
   (сеть `it_…`, место `second_chance`); убирать их после аккаунтов.
10. **Сводка на экране** — плитка «Реклама», `AdsPanel`, `api/overview.ts` из T-0052 (в коде их
    ещё нет, поэтому `depends_on`: читай, что она внесла), её разметку не меняя:
    - `api/overview.ts`: в схеме итогов (`now`, `before`, строки `places`)
      `passed: z.number().int().nonnegative().default(0)`, в точке ряда `adsPassed`;
      помощник `passLine(passed: number): string | null` — «пропусков VIP N» при N > 0,
      иначе `null`;
    - плитка «Реклама»: к «досмотрено N% · наград M» через « · » дописать `passLine(ads.now.passed)`;
    - `AdsPanel`: последняя колонка «Пропуск VIP» (по месту, в «Всего» — сумма, на телефоне
      `phone: "hide"`) и под таблицей, при `now.passed > 0`, пометка «Пропуск VIP — награда
      без ролика у игроков с VIP. В досмотры, доли и сети не входит.»;
    - `HELP.overview.ads`: дописать «Пропуски рекламы по VIP сюда не входят — они отдельной меткой.»

## Чего не трогаем

- Выдачу пропусков (`ads.service.ts`, `ads-passes.ts`, `history()`, `claim()`), `flag-split-report.ts`,
  `schema.prisma`, миграции, индексы, клиент игры, словарь событий, права на ряд.
- Разметку и графики T-0052 и T-0053 — только строки шага 10.

## Сценарий и интерфейс

- **«Реклама»** — под воронкой таблица «Пропуск VIP» за то же окно; загрузка, ошибка, нет
  сети — как у раздела; пусто — «Пропусков за это время не было»; без `ads.view` раздела нет.
- **Сводка** — в плитке после «наград M» «пропусков VIP K» (при K > 0), в панели рекламы
  колонка и пометка; без `ads.view` метки нет. Воронка и сети строк `vip` не содержат.

## Тесты

- `backend/api/test/ads.integration.test.ts` (живой Postgres, окно `Date.UTC(2031, 1, 1, 9)`,
  других тестов там нет): настоящий показ сети (выполнен через `report`) и три пропуска `vip`
  — два на `wheel_spin` у разных игроков (у одного есть `claimed_at`), один на `second_chance`.
  - `funnel` → одна строка сети (`offered: 1`, `completed: 1`), строки `vip` нет;
  - `passes` → `second_chance` (`used: 1, players: 1, claimed: 0`), затем `wheel_spin`
    (`used: 2, players: 2, claimed: 1`), `passName: "vip"`;
  - пропуск, записанный сырым `INSERT` как до задачи (`block_id NULL`, `network_key 'vip'`,
    `view`, `completed`), попадает в `passes`; ровно в `from` считается, в `to` — нет.
- `backend/api/test/daily-stats.integration.test.ts` (после шага 9): сутки `2031-03-14` — один
  настоящий досмотр и два пропуска → `adsCompleted: 1, adsPassed: 2`; у остальных `adsPassed: 0`.
- `backend/api/test/admin-overview.test.ts` (фейк получает `passes`): пропуски `now` —
  `wheel_spin` 4, `run_double` 2; `before` — `wheel_spin` 1 → `ads.now.passed === 6`,
  `ads.before.passed === 1`; `run_double` (в воронке нет) в `places` строкой из нулей с
  `passed: 2`, порядок по `AD_PLACES`; `networks` без `vip`; чтение пропусков упало →
  `ads === null`, остальное цело; без `ads.view` `passes` не зовётся.
- `backend/api/test/ads-catalog.test.ts`: `view` отдаёт `passes` за то же окно, что воронка;
  по HTTP `data.passes` — массив.
- `apps/admin/test/ads.test.ts`: схема читает `passes`, без поля → `[]`; `passTitle("vip")` →
  «VIP», `passTitle("gold")` → «gold»; `funnelNetworkTitle("vip", NETWORKS)` → «vip» (строка 283).
- `apps/admin/test/overview.test.ts`: схема читает `passed`, `adsPassed`, без поля → 0;
  `passLine(0)` → `null`, `passLine(25)` → «пропусков VIP 25». Тест подсказок (`help.test.ts`)
  зелёный: `HELP.ads.passes` стоит у `PassPanel`.

## Аналитика

Новых событий нет: воронка рекламы — таблица `ad_session` (`docs/22`), метка — запрос к ней. Лог `ad_passed` остаётся.

## Настройки и окружение

Нет.

## Документы

- `docs/22-analytics-and-metrics.md`, абзац «Воронка рекламы на сервере»: пропуск VIP (строка
  без блока) в воронку и выручку не входит, считается отдельно (Р99).
- `docs/29-admin-panel.md`, строка «Реклама» и описание сводки: таблица «Пропуск VIP», метка в сводке.
- `docs/35-stage4-plan.md`, §3.7, часть 5, абзац «В базе»: фразу про строку «VIP без ролика»
  в воронке заменить на «пропусков в воронке нет, они отдельной меткой «Пропуск VIP» (Р99)».
  Запись Р99 в таблицу решений делают тимлиды.

## Вопросы к тимлиду

Исполнитель не ждёт ответов. Принято по умолчанию:

- **Ряд:** подтверждено `claude-lead-1` 13.10.2026: `adsPassed` видим так же, как `adsCompleted`.
- **Экран сводки здесь** (шаг 10): подтверждено `claude-lead-1` 13.10.2026; если T-0052 возьмут
  нескоро — шаг 10 вынести новой задачей, остальное от неё не зависит.
- **Строка в плитке только при K > 0; единица — выданная сессия:** подтверждено `claude-lead-1` 13.10.2026.

## Критерии приёмки

- [ ] `funnel`, `completed`, `places`, `networks`, `adsCompleted` без пропусков; `passes`,
  `passed`, `adsPassed` есть; запись «до задачи» считается; миграций нет; сбой чтения даёт `ads: null`.
- [ ] В «Рекламе» таблица «Пропуск VIP» с подсказкой; плитка и панель сводки показывают метку.
- [ ] Дифф только в зонах задачи; документы обновлены; гейт и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Пропуск рекламы VIP — отдельной меткой`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОПУСК РЕКЛАМЫ VIP ОТДЕЛЬНОЙ МЕТКОЙ**

  Награда за рекламу без ролика у VIP больше не считается досмотром: досмотры, воронка и сети рекламы теперь только про настоящие показы.

  🛠 **Панель**

  • раздел «Реклама»: таблица «Пропуск VIP» — сколько раз, у скольких игроков, сколько наград
  • сводка: «пропусков VIP» рядом с досмотрами; прошлые записи считаются сразу, без миграции
  ```
