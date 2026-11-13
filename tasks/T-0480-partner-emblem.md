---
id: T-0480
title: Знак «Партнёр» у имени — держит активный партнёр с кабинетом
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0235, T-0217]
zones:
  - backend/api/src/modules/achievements/emblem-rules.ts
  - backend/api/src/modules/achievements/emblems.repository.ts
  - backend/api/src/modules/achievements/emblems.service.ts
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/test/emblem-rules.test.ts
  - backend/api/test/emblems.integration.test.ts
  - apps/admin/src/api/tasks.ts
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - design/art/src/emblem-glyphs.mjs
  - design/art/mockups/emblems-v2.html
  - packages/app-shell/src/screens/meta/emblem-glyphs.tsx
  - packages/app-shell/test/emblem-glyphs.test.ts
shared:
  - backend/api/prisma/migrations/**
  - docs/21-diagrams.md
  - docs/35-stage4-plan.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 4
---

# T-0480. Знак «Партнёр» у имени — держит активный партнёр с кабинетом

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0480.json)](README.md#значки-статуса) [![T-0235](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0235.json&label=T-0235)](T-0235-emblems-server.md) [![T-0217](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0217.json&label=T-0217)](archive/T-0217-partner-role-and-account.md)

## Зачем

Р149 называет пять статусных знаков: VIP, Тестер, Меценат, Команда, Партнёр.
T-0235 сделала четыре, а внешнему партнёру с кабинетом знак «Команда»
не положен: он не член команды игры (`EXTERNAL_ROLES` в
`emblem-rules.ts`). Пятый знак «Партнёр» отдаёт партнёру своё место в
рейтинге: его аудитория узнаёт его рядом с командой, а не среди
игроков без знака.

## Решения

Владелец, 13.11.2026 (вопросы к PR #725). Исполнитель их не пересматривает.

- **Кто держит:** аккаунт с ролью `partner` (кабинет открыт, T-0217),
  чья карточка партнёра (`partner.account_id`) в статусе `active`.
  Приостановили партнёра, отклонили или сняли роль — знак уходит сам при
  следующем чтении, как VIP по истечении. Снимать ничего не нужно.
- **Облик:** своя редкость знака `partner`, как отдельная `team` у
  «Команды»: это не заслуга и не покупка. Тон на клиенте — `accent`, его
  ставит T-0236. Значок рисует эта задача по правилам дизайнера, а не
  заимствует чужой.
- **По умолчанию:** «Партнёр» идёт сразу после «Команды»:
  `STATUS_ORDER = [team, partner, vip, supporter, tester]`. Партнёр без
  выбора носит «Партнёр»; другой знак он вправе выбрать сам.
- **«Команду» партнёр по-прежнему не получает.** Исключение
  `EXTERNAL_ROLES` остаётся как есть.
- **Вайп** выбранный знак физически не сбрасывает: выбор, который игрок
  больше не держит, при чтении и так игнорируется (решение владельца по
  PR #725, вопрос 1). Код вайпа не трогаем.

## Как сейчас

- `backend/api/src/modules/achievements/emblem-rules.ts`:
  - `EMBLEM_IDS` (стр. 15) — семь id, `partner` нет;
  - `STATUS_ORDER` (стр. 30) — `[team, vip, supporter, tester]`;
  - `EXTERNAL_ROLES = ["partner"]` (стр. 43);
  - `StatusState` (стр. 49) — `vipActive`, `testerAt`, `supporterAt`, `hasRole`;
  - `heldStatus` (стр. 66).
- `emblems.repository.ts`:
  - `statuses()` (стр. ~72) одним запросом читает `tester_at`,
    `supporter_at`, `shown_emblem_id` и `has_role` с исключением внешних
    ролей; строка разбирается `statusSchema`, тип — `AccountEmblemRow`
    (стр. 20);
  - `emblemHoldersSql(now)` (стр. ~170) — те же правила для прохода
    редкости, по строке `UNION ALL` на знак.
- `emblems.service.ts:149` собирает `heldStatus({ … hasRole: account.hasRole })`.
- `backend/api/src/modules/tasks/task-rules.ts:78` —
  `EMBLEM_TIERS = [...ITEM_RARITIES, "team"]`; схема строки каталога —
  `z.enum(EMBLEM_TIERS)` (стр. ~436).
- Миграция `20261113200000_emblems`:
  - `CHECK task_def_emblem_tier_check` — список редкостей с `team`;
  - строки `emb_vip` … `emb_team` с `sort` 900–930 (стр. 76–80) — образец
    для новой строки.
- Партнёры: `partner-rules.ts` — `PARTNER_STATUSES`, `bindsNewPlayers(status)`
  (истина только у `active`); таблица `partner`, колонка `account_id`
  (уникальна, T-0217); роль `partner` — строка `account_role`.
- Панель: `apps/admin/src/api/tasks.ts:124` — свой `EMBLEM_TIERS` и
  `EMBLEM_TIER_TITLES`; `TasksScreen.tsx:598` — `Badge` редкости (`team` →
  тон `info`).
- Значки: `design/art/src/emblem-glyphs.mjs` (карта, стр. ~72–82) пишет
  `packages/app-shell/src/screens/meta/emblem-glyphs.tsx` и лист
  `design/art/mockups/emblems-v2.html`. Запуск —
  `node design/art/src/emblem-glyphs.mjs`.
- Тесты: `backend/api/test/emblem-rules.test.ts` (`heldStatus`,
  `STATUS_ORDER` на стр. 115, `shownEmblem`),
  `emblems.integration.test.ts`:
  - каталог строк (стр. 92);
  - партнёр без знака (стр. 364–366);
  - сверка прохода редкости с подсчётом SQL (стр. 664–700);
  - `packages/app-shell/test/emblem-glyphs.test.ts` — список статусных id
    (стр. 18).

## Шаги по порядку

Пункт — коммит; тесты (1) — первым.

1. **Тесты** (раздел «Тесты») — первым коммитом, падают до кода.
2. **Редкость `partner`.**
   - `task-rules.ts`: `EMBLEM_TIERS = [...ITEM_RARITIES, "team", "partner"]`;
     комментарий над ним — «и отдельный тон `partner` для знака
     „Партнёр“».
   - Панель, `apps/admin/src/api/tasks.ts`: `partner` в `EMBLEM_TIERS` и
     `EMBLEM_TIER_TITLES.partner = "Партнёр"`.
   - `TasksScreen.tsx`: тон `Badge` — `team` → `info`, `partner` →
     `warning`, остальные `neutral`.
3. **Правила** (`emblem-rules.ts`):
   - `EMBLEM_IDS.partner = "emb_partner"`;
   - `STATUS_ORDER = [team, partner, vip, supporter, tester]`;
   - в `StatusState` — `partnerActive: boolean` (комментарий: «роль
     `partner` и карточка партнёра в статусе `active`»);
   - `heldStatus`: `if (state.partnerActive) held.add(EMBLEM_IDS.partner)`.
4. **Запросы** (`emblems.repository.ts`):
   - `statuses()`: колонка `partner_active` — `EXISTS (SELECT 1 FROM partner
     p JOIN account_role r ON r.account_id = p.account_id AND r.role::text =
     'partner' WHERE p.account_id = a.account_id AND p.status = 'active')`.
     Имена роли и статуса — параметрами из констант, а не строками в SQL:
     роль — из `EXTERNAL_ROLES`, статус — `"active"` из `PARTNER_STATUSES`
     через одну константу в `emblem-rules.ts`;
   - `statusSchema` и `AccountEmblemRow` — поле `partnerActive`;
   - `emblemHoldersSql`: строка `UNION ALL` для `EMBLEM_IDS.partner` с тем же
     условием по `pop`. Комментарий над функцией — добавить «Партнёр».
   - Запросов не прибавляется: всё в том же `statuses()`.
5. **Сборка** (`emblems.service.ts:149`) — передать `partnerActive` в
   `heldStatus`.
6. **Миграция** — один раз, по `tasks/README.md`, «Общие файлы» (без базы,
   `prisma migrate diff`, или `--create-only` на отдельной базе), после
   влития свежего `dev`. Схема Prisma не меняется, поэтому SQL пишется руками
   в папке `<метка UTC>_emblem_partner`:
   - `ALTER TABLE "task_def" DROP CONSTRAINT "task_def_emblem_tier_check"`, затем
     `ADD CONSTRAINT` с тем же списком плюс `'partner'`;
   - `INSERT INTO "task_def"` — строка по образцу `emb_team`:
     `('emb_partner', 'achievement', 'status', 1, 'Партнёр', 'Быть партнёром
     игры', 'status', 'partner', false, 0, 0, 0, 0, 0, 940, now(), now())`.
   - Проверка — `gate` («миграции дают ровно схему») и
     `ls backend/api/prisma/migrations | tail`: папка одна.
7. **Значок** `emb_partner` в `design/art/src/emblem-glyphs.mjs` (скилл
   `game-art`): две сцепленные петли-звена — знак связи и общего дела.
   Правила файла: сетка 24, контур 2, одна главная форма и не больше одной
   детали, читается на 16 px. Слои — `f` у главной петли, `s` у второй.
   Запустить `node design/art/src/emblem-glyphs.mjs`, закоммитить
   сгенерированные `emblem-glyphs.tsx` и `emblems-v2.html`. В листе значок
   встаёт в группу «Статус и сезон».
8. **Документы** (раздел «Документы»).

## Чего не трогаем

- Знак «Команда» и `EXTERNAL_ROLES`: партнёр «Команду» не получает.
- Код вайпа (`wipe-plan.ts`, `wipe-runner.ts`): сброс выбора не нужен.
- Клиент знаков — чип, экран, тон редкости `partner` → `accent`: это
  T-0236.
- Строки рейтинга и списков — T-0240.
- Кабинет партнёра и его роль (T-0217, T-0218): знак лишь читает их.

## Тесты

Пишутся первым коммитом, до кода.

- `backend/api/test/emblem-rules.test.ts`:
  - `heldStatus({ …NOTHING, partnerActive: true })` → `{"emb_partner"}`;
  - все флаги сразу → пять статусных знаков, ни одного сезонного;
  - `STATUS_ORDER` → `["emb_team", "emb_partner", "emb_vip", "emb_supporter", "emb_tester"]`;
  - `shownEmblem(null, {"emb_partner", "emb_vip"})` → `"emb_partner"`;
  - `shownEmblem(null, {"emb_team", "emb_partner"})` → `"emb_team"`;
  - `shownEmblem("emb_vip", {"emb_partner", "emb_vip"})` → `"emb_vip"`:
    выбор сильнее порядка.
- `backend/api/test/emblems.integration.test.ts` — Postgres, `rubezh_test`:
  - каталог (стр. 92) — строка `emb_partner`, «Партнёр», `status`, `partner`;
  - роль `partner` и карточка `active` → знак `emb_partner`, «Команды» нет;
  - роль `partner`, карточка `paused` → без знака (`null`);
  - карточка `active`, роли нет (кабинет закрыт) → без знака;
  - сотрудник с ролью команды и партнёр сразу → `emb_team` по умолчанию;
  - сверка прохода редкости (стр. 664–700) — партнёр с активной карточкой
    считается в `emb_partner`, ожидание SQL дополнено той же колонкой;
  - строка каталога с `emblem_tier = 'partner'` принимается, с
    неизвестной редкостью — отклоняется `CHECK`.
- `packages/app-shell/test/emblem-glyphs.test.ts` — `emb_partner` в списке
  статусных id со своим значком.

## Аналитика

Нет: выбор знака пишет событие T-0236, новых действий игрока задача не
добавляет.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md`, абзац «Знаки у имени»:
  - восемь строк вместо семи, `emb_partner` в списке;
  - правило «Партнёр» — роль `partner` и `PARTNER.status = active`;
  - порядок по умолчанию: Команда → Партнёр → VIP → Меценат → Тестер.
- `docs/35-stage4-plan.md`, Р149 — в скобки «(T-0235, T-0236)» добавить
  T-0480, а после списка статусных — «Партнёр — пока партнёр активен и
  кабинет открыт (13.11.2026)».

## Критерии приёмки

- [ ] Активный партнёр с открытым кабинетом носит «Партнёр» по умолчанию;
      приостановленный или с закрытым кабинетом — нет.
- [ ] Партнёр не получает «Команду»; сотрудник и партнёр в одном
      аккаунте — «Команда» по умолчанию.
- [ ] Проход редкости считает держателей «Партнёра» так же, как
      `heldStatus`: интеграционный тест сверяет.
- [ ] Строка каталога `emb_partner` есть, `CHECK` пускает `partner`,
      миграция одна.
- [ ] Значок `emb_partner` в карте и в листе, по правилам файла значков.
- [ ] Панель показывает редкость «Партнёр» в каталоге заданий.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Знак «Партнёр» у имени`
- **Метка:** `release: minor`
- **Для игроков:** нет: знак увидят после клиента T-0236.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗНАК «ПАРТНЁР» У ИМЕНИ**

  Пятый статусный знак: его носит активный партнёр с открытым кабинетом.
  У партнёра без выбора он стоит по умолчанию сразу после «Команды».

  🤝 **Как работает**

  • приостановили партнёра или закрыли кабинет — знак уходит сам
  • «Команду» партнёр по-прежнему не получает
  • своя редкость «Партнёр»: в панели видна в каталоге заданий, тон в игре ставит клиент знаков
  ```
