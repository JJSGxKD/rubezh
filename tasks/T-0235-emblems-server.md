---
id: T-0235
title: Знаки у имени — сервер: каталог, статусные и сезонные знаки, выбор знака
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0106, T-0107, T-0126]
zones:
  - backend/api/src/modules/achievements/emblem-rules.ts
  - backend/api/src/modules/achievements/emblems.repository.ts
  - backend/api/src/modules/achievements/emblems.service.ts
  - backend/api/src/modules/achievements/emblems.controller.ts
  - backend/api/test/emblem-rules.test.ts
  - backend/api/test/emblems.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/achievements/achievements.module.ts
  - backend/api/src/modules/achievements/achievements.service.ts
  - backend/api/src/modules/achievements/achievement-rarity.job.ts
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/src/modules/tasks/tasks.service.ts
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/src/api/tasks.ts
  - apps/admin/src/ui/help.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - docs/21-diagrams.md
  - docs/39-retention-mechanics.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: design/art/mockups/identity-v2.html
batch: 4
---

# T-0235. Знаки у имени — сервер: каталог, статусные и сезонные знаки, выбор знака

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0235.json)](README.md#значки-статуса) [![T-0106](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0106.json&label=T-0106)](T-0106-achievements-prestige-server.md) [![T-0107](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0107.json&label=T-0107)](T-0107-achievements-showcase-shell.md) [![T-0126](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0126.json&label=T-0126)](T-0126-tasks-kinds-bosses-elites-chests-evolutions.md)

## Зачем

Игрок не может показать другим, чего добился: в рейтинге и у друзей рядом с
именем видна только метка «Тестер». После задачи у части достижений есть
знак, который носят у имени («Гроза боссов», «Последний рубеж»). Статусы
(VIP, Тестер, Меценат, Команда) и места в недельном сезоне («Чемпион · сезон
3») — знаки того же каталога. Игрок выбирает, какой знак носить. В строки
рейтинга, сезона и друзей знак кладёт T-0240, клиент — T-0236.

## Решения

Решения владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р149:

- знак у имени — это достижение, которое носят: каталог достижений (T-0106,
  T-0107) получает знак;
- статусные и сезонные знаки — виды того же каталога, статусные выдаёт только
  сервер;
- в профиле видны все знаки, в списках — один выбранный, витрина — до трёх
  закреплённых;
- поправка того же дня: **знак есть только у отобранных достижений** — у
  верхних ступеней лестниц, у скрытых и у «Мастеров оружия», плюс статусные и
  сезонные; у остальных знака нет.

Решения `claude-lead-1` от 24.10.2026:

- **Знак — колонка `emblem_tier` у `task_def`.** Это редкость по шкале
  предметов: `common`, `uncommon`, `rare`, `epic`, `legendary`, `mythic`
  (`ITEM_RARITIES`, `items/item-catalog.ts:16`), плюс `team` — отдельный тон
  для знака «Команда» (бирюза оберегов, `meta-v2.md` §1.5). Пусто — у
  достижения знака нет. Редкость знака стоит в каталоге и не плавает вместе с
  «есть у N %»: цвет знака у имени не должен меняться сам.
- **Статусные и сезонные знаки — строки того же `task_def`** с
  `period = 'achievement'`, новыми категориями `status` и `season` и новыми
  видами цели `status` и `season`. Поэтому они попадают в витрину и в
  «любимые» T-0106 без второго каталога. Прогресса у них нет: держит ли игрок
  знак, сервер **вычисляет при чтении** по состоянию аккаунта. VIP истёк —
  знака нет, ничего не нужно снимать.
- **Кто держит знак** (чистые правила в `emblem-rules.ts`):

  | id | Название | Держит, если | Редкость |
  |---|---|---|---|
  | `emb_vip` | VIP | VIP активен сейчас (`vip.service.ts`, `isActive`) | `legendary` |
  | `emb_tester` | Тестер | `account.tester_at` не пуст | `rare` |
  | `emb_supporter` | Меценат | `account.supporter_at` не пуст (T-0157, T-0161) | `epic` |
  | `emb_team` | Команда | у аккаунта есть хоть одна строка `account_role` | `team` |
  | `emb_season_champion` | Чемпион | в `season_result` есть строка с `place = 1` и `board_size >= MIN_BOARD` (`seasons/season-rules.ts:104`) | `mythic` |
  | `emb_season_top10` | Топ-10 | то же с `place <= 10` | `legendary` |
  | `emb_season_top100` | Топ-100 | то же с `place <= 100` | `epic` |

  Номер сезона у сезонного знака — порядковый номер **последнего** такого
  сезона среди закрытых: `count(*)` строк `season` с `season_key <=` его
  ключа. «Партнёр» появится, когда у партнёра будет аккаунт (кабинет,
  T-0217); здесь его нет.
- **Отобранные достижения со знаком** (стартовые редкости, геймдизайнер
  калибрует в панели):

  | Что | id | Редкость |
  |---|---|---|
  | Верхние ступени лестниц T-0106 | `ach_kills_100k`, `ach_time_100h`, `ach_account_50` | `legendary` |
  | | `ach_xp_500k`, `ach_survive_20`, `ach_level_40`, `ach_runs_200`, `ach_hard_5`, `ach_friends_25` | `epic` |
  | | `ach_boost_50` | `rare` |
  | Верхние ступени лестниц T-0126 | `ach_elite_200`, `ach_boss_25` | `legendary` |
  | | `ach_chest_200`, `ach_crystal_100k`, `ach_evolution_25` | `epic` |
  | Скрытые | `ach_hidden_hard_7`, `ach_hidden_marathon` | `mythic` |
  | | `ach_hidden_level_60` | `legendary` |
  | Мастера оружия | `ach_weapon_spark`, `ach_weapon_knife`, `ach_weapon_wardstone`, `ach_weapon_hearth`, `ach_weapon_storm`, `ach_weapon_sting` | `uncommon` |

  Обычное достижение со знаком держит тот, у кого оно выполнено
  (`completed_at` не пуст), забирать награду не нужно — как престиж T-0106.
- **Выбранный знак** — колонка `account.shown_emblem_id` (ссылка на
  `task_def`, пусто — «по умолчанию»). Если не выбран или выбранный больше не
  держится (VIP истёк), показывается знак **по умолчанию**: первый из
  статусных, которые игрок держит, в порядке Команда → VIP → Меценат →
  Тестер; иначе знака нет. Так тестеры и меценаты после выката видят у себя
  то же, что и сейчас.
- **Знак для списков** готовит `EmblemsService.of(accountIds)` — один
  запрос на список; в строки его кладёт T-0240.
- **«Есть у N %» для статусных и сезонных** считает тот же проход редкости
  T-0106 (`achievement-rarity.job.ts`), их держателей — по правилам выше
  среди того же населения. VIP — на момент прохода.
- **Подделать нельзя:** статусные и сезонные строки не двигаются забегом, их
  нельзя забрать (`claim` — 404 `task_not_found`, как у чужого), выбрать
  можно только то, что игрок держит. В панели у таких строк меняются только
  название, подсказка, редкость знака, порядок и «включено».

## Как сейчас

- Достижения после T-0106 и T-0126 — строки `task_def` с `period =
  'achievement'`, колонки `category` (CHECK на четыре значения), `ladder`,
  `rung`, `hidden`, `hint`, `prestige`. Есть модуль `achievements`:
  витрина, `percentOf`, «любимые», проход редкости
  `achievement-rarity.job.ts`. Есть `STATE_KINDS` для видов, которые не
  двигает забег (`task-rules.ts`).
- `backend/api/src/modules/badges/*` — **знаки меню** (числа на вкладках),
  к знакам у имени отношения не имеют. Новый код называется `emblem`, чтобы
  не путать.
- Метка «Тестер» в строках: `runs/runs-view.service.ts:138,169`
  (`tester: true`), `seasons/seasons-view.service.ts:93`,
  `friends/friends.repository.ts:92–99` (`PEER` с `testerAt`). После T-0161 —
  так же `supporter: true` в рейтинге и сезонах.
- `season_result (season_key, account_id, difficulty, place, board_size)` —
  `schema.prisma:2255`, индекс `(season_key, difficulty, place)`; `MIN_BOARD
  = 10`.
- `account_role (account_id, role)` — `schema.prisma:386`, индекс по `role`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** (`--create-only` один раз, папка одна):
   - `task_def.emblem_tier VARCHAR(16)` с `CHECK (emblem_tier IS NULL OR emblem_tier IN ('common','uncommon','rare','epic','legendary','mythic','team'))` и `CHECK (emblem_tier IS NULL OR period = 'achievement')`;
   - CHECK категории T-0106 пересоздать с `status` и `season`;
   - `account.shown_emblem_id VARCHAR(48) NULL REFERENCES task_def(task_id) ON DELETE SET NULL`;
   - `UPDATE task_def SET emblem_tier = …` по таблице отобранных;
   - `INSERT … ON CONFLICT (task_id) DO NOTHING` семи строк статусов и сезонов: `period 'achievement'`, категория, вид `status` или `season`, цель 1, награда 0, престиж 0, `hidden false`, `title` и `hint` по таблицам ниже, `sort` с 900 шагом 10.

   Подсказки (`hint`) — условие для закрытого знака:
   - `emb_vip` — «Оформить VIP»;
   - `emb_tester` — «Играть в закрытом тесте»;
   - `emb_supporter` — «Поддержать проект»;
   - `emb_team` — «Работать в команде игры»;
   - `emb_season_champion` — «Занять первое место в недельном сезоне»;
   - `emb_season_top10` — «Войти в десятку недельного сезона»;
   - `emb_season_top100` — «Войти в сотню недельного сезона».

   Модели в `schema.prisma` — поля со своими комментариями. ER — в `docs/21`.
3. **`task-rules.ts`:** виды `status` и `season` добавить в `TASK_KIND_IDS`.
   - Они не входят ни в `RUN_KINDS`, ни в `STATE_KINDS`: `onRun` и
     `applyState` их не трогают.
   - `taskDefSchema` принимает `emblemTier` (только у достижений) и
     категории `status` и `season` (только с одноимённым видом).
4. **`tasks.service.ts`:**
   - `view` не отдаёт строки видов `status` и `season`: это не задания.
   - `claim` для них — `TaskNotFoundError`.
5. **`emblem-rules.ts`** — чистые функции без базы:
   - `STATUS_ORDER = ["emb_team", "emb_vip", "emb_supporter", "emb_tester"]`;
   - `heldStatus(state)` → множество id: `state` — это `{ vipActive, testerAt, supporterAt, hasRole }`;
   - `heldSeason(bestPlace: number | null)` → множество из трёх сезонных по порогам 1 / 10 / 100;
   - `shownEmblem(chosen, held)` → выбранный, если держится, иначе первый держимый из `STATUS_ORDER`, иначе `null`.
6. **`emblems.repository.ts`** — запросы на список аккаунтов, каждый — один
   запрос на весь список, без N+1:
   - статусы: `tester_at`, `supporter_at`, `shown_emblem_id`, есть ли роль (`EXISTS` по `account_role`);
   - лучшее место и номер последнего такого сезона: по `season_result` с `board_size >= MIN_BOARD`, `MIN(place)` и для каждого порога — последний сезон;
   - выполненные достижения со знаком: `task_progress` по `task_def` с непустым `emblem_tier`.

   VIP — тем же способом, каким `vip.service.ts` решает «активен»; метод
   списка добавить в VIP, если его нет. Все запросы — с таймаутом.
7. **`emblems.service.ts`:**
   - `of(accountIds)` → карта `PublicMark` (только выбранный знак: id,
     название из каталога, редкость, категория, номер сезона у сезонного);
   - `listFor(accountId)` → все знаки каталога с `held`, `shown`, `season`,
     `percent` (из `achievement_rarity`, `percentOf` T-0106) — для профиля.
8. **`emblems.controller.ts`:**
   - `GET /api/v1/achievements/emblems` → `{ data: { shown: string | null, auto: boolean, items: [{ id, title, hint, category, tier, held, season?, percent }] } }`;
   - `PUT /api/v1/achievements/emblem`, тело `{ id: string | null }` (Zod): `null` — вернуть «по умолчанию»; знака нет в каталоге — 404 `emblem_not_found`; не держится — 409 `emblem_not_held`; повтор того же — без изменений;
   - лимит запросов — тем же приёмом, что `achievements.controller.ts`.
9. **«Любимые» T-0106** принимают статусные и сезонные знаки по правилу
   «держит» вместо «выполнено» — правка проверки в `achievements.service.ts`.
10. **Проход редкости:** держатели статусных и сезонных знаков — по тем же
    правилам, одним запросом на вид.
11. **Панель** (`TasksScreen.tsx`, `api/tasks.ts`, `help.ts`): поле «Знак у
    имени» в форме достижения — «нет» или редкость. У строк видов `status` и
    `season` меняются только название, подсказка, знак, порядок и
    «включено»; вид, цель и награда — только чтение.
12. **Очистка:** `wipe-plan.ts` — `account.shown_emblem_id` сбрасывается
    вместе с прогрессом достижений.
13. **Документы:** `docs/21` (ER), `docs/39` §3
    (строка «Знаки у имени»).

## Чего не трогаем

- Клиент: витрину знаков, выбор и знак в строках — T-0236.
- Знак в строках рейтинга, сезона и друзей — T-0240.
- Облики — T-0237.
- Знаки событий («Ярмарка-2026») и выдачу из панели — вместе с Ярмаркой
  (Р154).
- Знак «Партнёр» — после кабинета партнёра (T-0217).
- Знаки меню (`modules/badges`).

## Тесты

Первым коммитом.

- `backend/api/test/emblem-rules.test.ts`:
  - VIP активен → `emb_vip`; истёк → нет;
  - тестер и меценат вместе → оба;
  - есть роль → `emb_team`;
  - лучшее место 1 → все три сезонных; 7 → `top10` и `top100`; 101 → ни одного; `null` → ни одного;
  - `shownEmblem`: выбран и держится → он; выбран и не держится → первый держимый из `STATUS_ORDER`; ничего не держит → `null`; Команда важнее VIP.
- `backend/api/test/emblems.integration.test.ts` (живые Postgres и Redis):
  - миграция: у 24 отобранных `emblem_tier` по таблице, семь новых строк есть, CHECK не пускает знак у задания дня;
  - `GET /achievements/emblems`: держимые и закрытые, `shown` и `auto`;
  - `PUT /achievements/emblem`: держит → 200, не держит → 409, нет такого → 404, `null` → «по умолчанию»;
  - `EmblemsService.of`: у тестера без выбора — `emb_tester`; выбранный «Последний рубеж» — он; VIP истёк — выбранный `emb_vip` сменяется знаком по умолчанию; на список — по одному запросу на источник;
  - сезонный знак: место 3 в сезоне с `board_size` 12 → `emb_season_top10`, `season` — номер этого сезона; та же строка с `board_size` 8 → нет;
  - `GET /tasks` не отдаёт строк `status` и `season`; `POST /tasks/emb_vip/claim` → 404;
  - «любимые» принимают держимый `emb_tester` и не принимают недержимый `emb_vip` (409);

## Аналитика

Серверных событий нет (отложены, `docs/22` §3). Смену знака пишет клиент —
`emblem_shown_changed` (T-0236).

## Настройки и окружение

Нет. Редкости знаков меняются в панели, как остальное у достижений.

## Документы

По шагу 13.

## Критерии приёмки

- [ ] У 24 отобранных достижений и у семи статусных и сезонных есть знак с редкостью.
- [ ] Держит ли игрок статусный и сезонный знак, считается при чтении; истёкший VIP знак не держит.
- [ ] Выбранный или знак по умолчанию считается для списка аккаунтов одним запросом на источник.
- [ ] Выбрать или закрепить знак, которого игрок не держит, нельзя.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Знаки у имени — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — до клиента (T-0236) игрок изменений не видит.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗНАКИ У ИМЕНИ, СЕРВЕР**

  У 24 достижений появился знак, который носят у имени: верхние ступени лестниц, скрытые и «Мастера оружия». Статусы VIP, Тестер, Меценат, Команда и места недельного сезона (Чемпион, Топ-10, Топ-100) — знаки того же каталога, их держит тот, кому положено сейчас. Игрок выбирает знак через API; в строки списков его положит T-0240, клиент — T-0236.
  ```
