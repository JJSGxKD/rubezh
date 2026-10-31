---
id: T-0237
title: Облики-архетипы — сервер: каталог, кто чем владеет, выбор облика и аватара, облик в списках
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0235, T-0240, T-0105, T-0126]
zones:
  - backend/api/src/modules/appearance/**
  - backend/api/test/appearance-rules.test.ts
  - backend/api/test/appearance.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/app.module.ts
  - backend/api/src/common/public-identity.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/seasons/seasons-view.service.ts
  - backend/api/src/modules/friends/friends.service.ts
  - backend/api/src/modules/achievements/emblems.repository.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - packages/shared-types/src/index.ts
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/39-retention-mechanics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/mockups/identity-v2.html
batch: 4
---

# T-0237. Облики-архетипы — сервер: каталог, кто чем владеет, выбор облика и аватара, облик в списках

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0237.json)](README.md#значки-статуса) [![T-0235](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0235.json&label=T-0235)](T-0235-emblems-server.md) [![T-0240](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0240.json&label=T-0240)](T-0240-public-identity-in-lists.md) [![T-0105](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0105.json&label=T-0105)](T-0105-task-points-and-rewards.md) [![T-0126](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0126.json&label=T-0126)](T-0126-tasks-kinds-bosses-elites-chests-evolutions.md)

## Зачем

Дизайнер нарисовал героя в шести архетипах и трёх окрасах (атласы `atlas-skin-<id>`,
портреты `design/art/out/*-hero-*.svg`), но у игрока облика нет: все — один
Хранитель. После задачи сервер знает каталог обликов и откуда каждый берётся.
Он сам считает, какими обликами владеет игрок, хранит выбранный облик и
выбор «голова облика или фото» в кружке аватара и отдаёт облик в строках
рейтинга, сезона и друзей. Экран — T-0238, облик в забеге — T-0239.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:

- **Р150** — облик — архетип целиком: своя голова и свой предмет на общей
  позе, окрасы — палитры одного архетипа. Пропорции и хитбокс у всех одни.
  Источники — уровень аккаунта, очки заданий недели, достижение, событие,
  VIP, топ сезона. За деньги — только конкретный облик, видный до покупки.
- **Р47** — аватар — голова персонажа.
- Поправки от 24.10.2026:
  - **в кружке аватара по умолчанию — голова облика**, фото из Telegram —
    по выбору игрока;
  - **«Навий страж» — за топ-3 недельного сезона**, навсегда.

Решения `claude-lead-1` от 24.10.2026:

- **Каталог — в коде** (`appearance/appearance-catalog.ts`), а не в базе.
  Облик — это ещё и кадры в атласе: без рисунка строка каталога бессмысленна,
  а рисунок приходит релизом. Id совпадают с именами кадров и портретов
  (`hero-<id>/…`, `portrait-hero-<id>.svg`).

  | id | Облик | Архетип | Редкость | Откуда (числа — стартовые, геймдизайнер калибрует) |
  |---|---|---|---|---|
  | `keeper` | Хранитель | keeper | `common` | у всех с начала |
  | `frost` | Хранитель · иней | keeper | `common` | уровень аккаунта 5 |
  | `herbalist` | Хранитель · травник | keeper | `uncommon` | уровень аккаунта 10 |
  | `gilded` | Хранитель · золото | keeper | `uncommon` | уровень аккаунта 15 |
  | `vityaz` | Витязь | vityaz | `rare` | уровень аккаунта 20 |
  | `vedunya` | Ведунья | vedunya | `rare` | хоть раз забрал верхнюю ступень очков недели (`POINT_STEPS`, T-0105) |
  | `ohotnitsa` | Охотница | ohotnitsa | `epic` | выполнено `ach_elite_50` «Гроза элит» (T-0126) |
  | `skomoroh` | Скоморох | skomoroh | `epic` | событие «Ярмарка» — пока недоступен, придёт с Ярмаркой (Р154) |
  | `knyaz` | Князь | knyaz | `legendary` | VIP активен — пока активен |
  | `navi` | Навий страж | navi | `mythic` | место 1–3 в недельном сезоне при `board_size >= MIN_BOARD` — навсегда |

  Уровни и id достижения — константы каталога рядом с таблицей, строка в
  `docs/30`.
- **Владение не хранится, а вычисляется при чтении** по состоянию аккаунта:
  уровень, VIP, выполненное достижение, забранная ступень недели, место в
  сезоне. VIP истёк — Князя нет, снимать нечего, а вернулся VIP — Князь
  вернулся. Таблицы владения нет, пока нет источника, который выдаёт облик
  разово (событие, покупка) — она придёт с Ярмаркой.
- **Выбор** — `account.appearance_id` (пусто — `keeper`) и
  `account.avatar_photo` (по умолчанию `false`: в кружке голова облика).
  Выбранный, которым игрок больше не владеет, хранится. В ответах вместо
  него отдаётся **действующий** облик — `keeper`. Вернулось владение —
  вернулся и облик.
- **Облик в списках — тем же портом `PublicIdentity`** (T-0240): к
  `PublicMark` добавляются `appearance: string` (действующий id) и
  `avatarPhoto?: true`. Строки рейтинга, сезона и друзей получают оба поля
  тем же единственным вызовом на список.
- **Правила — чистые** (`appearance-rules.ts`): на вход —
  `{ level, vipActive, bestSeasonPlace, doneAchievements, weeklyTopClaimed }`,
  на выход — множество id. Запросы VIP и места в сезоне — **те же методы**,
  что завела T-0235 (метод списка VIP и лучшее место в
  `emblems.repository.ts`); запрос не копировать.

## Как сейчас

- Каталога обликов и выбора нет. Герой в забеге — фигура, в режиме арта —
  кадры `hero/…` атласа `core`. Кадры остальных — у каждого облика свой
  атлас `design/art/out/atlas-skin-<id>.json`: `hero-<id>/idle0…1`, `walk0…3`.
- Портреты: `portrait-hero-<id>.svg` (арсенал), `avatar-hero-<id>.svg`
  (голова в круге), `card-hero-<id>.svg` (карточка) — у всех десяти id.
- После T-0240 есть порт `common/public-identity.ts` и `PublicMark`. Рейтинг,
  сезон и друзья берут его одним вызовом.
- Уровень аккаунта — модуль `progress` (`progress.service.ts`, `ProgressView`).
  VIP — `vip.service.ts`, `isActive`. Место в сезоне — `season_result`.
  Достижения — `task_progress.completed_at`. Ступени очков недели —
  `task_points_claim` и `POINT_STEPS` (`tasks/task-points.ts`, T-0105).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** (`--create-only` один раз): `account.appearance_id
   VARCHAR(24) NULL`, `account.avatar_photo BOOLEAN NOT NULL DEFAULT false`.
   Модель — с комментариями полей, ER — в `docs/21`.
3. **`appearance-catalog.ts`** — таблица «Решений» `as const`; тип
   `AppearanceSource = { kind: "start" } | { kind: "level"; level: number } |
   { kind: "weekly_points" } | { kind: "achievement"; achievementId: string } |
   { kind: "event" } | { kind: "vip" } | { kind: "season"; maxPlace: number }`.
4. **`appearance-rules.ts`** — `heldAppearances(state)` и
   `effectiveAppearance(selected, held)` (не владеет или пусто → `keeper`).
5. **`appearance.repository.ts`** — состояние списка аккаунтов одним
   запросом на источник:
   - уровень, `appearance_id`, `avatar_photo`;
   - выполнено ли `ach_elite_50`;
   - забрана ли верхняя ступень недели;
   - VIP и лучшее место — методами T-0235.

   Таймауты на всё.
6. **`appearance.service.ts`:**
   - `of(accountIds)` → `{ appearance, avatarPhoto? }` на каждого;
   - `viewFor(accountId)` → каталог с `held`, `source` и выбор;
   - `choose(accountId, { id?, avatarPhoto? })`.
7. **`appearance.controller.ts`:**
   - `GET /api/v1/appearance` → `{ data: { selected, effective, avatarPhoto, items: [{ id, archetype, rarity, held, source }] } }`; у источника-достижения — ещё `title` достижения;
   - `PUT /api/v1/appearance`, тело `{ id?: string, avatarPhoto?: boolean }` (Zod, хотя бы одно поле): неизвестный id — 404 `appearance_not_found`; не владеет — 409 `appearance_locked`; повтор — без изменений;
   - лимит запросов — как у соседних контроллеров игрока.
8. **`appearance.module.ts`** и строка в `app.module.ts`. Регистрация в
   `PublicIdentity`: источник порта собирает `PublicMark` из двух сервисов —
   знак (T-0235) и облик. Сбой одного не стирает другой.
9. **`shared-types`:** `PublicMark` и строки рейтинга, сезона и друзей
   получают `appearance?: string` и `avatarPhoto?: true`.
10. **Очистка:** `wipe-plan.ts` — `appearance_id` и `avatar_photo`
    сбрасываются вместе с прогрессом.
11. **Документы:** `docs/21` (ER, связь модуля с портом), `docs/30` (строка
    «Облики: источники и уровни» → `appearance-catalog.ts`), `docs/39` §3.

## Чего не трогаем

- Экран выбора, портреты и аватар в оболочке — T-0238; облик в забеге —
  T-0239.
- Покупку облика, Ярмарку и выдачу из панели — Р154, позже.
- Знаки у имени — T-0235.
- Рамку дивизиона и галочки на аватаре (Р47) — дивизионов пока нет.

## Тесты

Первым коммитом.

- `backend/api/test/appearance-rules.test.ts`:
  - новичок (уровень 1) → только `keeper`;
  - уровень 15 → `keeper`, `frost`, `herbalist`, `gilded`; 20 → и `vityaz`;
  - VIP активен → `knyaz`; истёк → нет;
  - место 3 → `navi`; 4 → нет; `null` → нет;
  - `ach_elite_50` выполнено → `ohotnitsa`; верхняя ступень недели забрана → `vedunya`;
  - `skomoroh` не держится ни при каком состоянии;
  - `effectiveAppearance`: выбранный и держится → он; не держится → `keeper`; пусто → `keeper`.
- `backend/api/test/appearance.integration.test.ts` (живые Postgres и Redis):
  - `GET` у новичка: десять обликов, держится один, `avatarPhoto: false`;
  - `PUT { id: "vityaz" }` на уровне 19 → 409; на 20 → 200, в рейтинге у игрока `appearance: "vityaz"`;
  - Князь при истёкшем VIP: выбор хранится, в строке — `keeper`; VIP продлён — `knyaz`;
  - `PUT { avatarPhoto: true }` → в строках друзей `avatarPhoto: true`;
  - неизвестный id → 404; пустое тело → 400;
  - строка рейтинга несёт и знак (T-0235), и облик; сбой источника обликов не убирает знак;
  - на список рейтинга — по одному запросу на источник, не на строку.

## Аналитика

Серверных событий нет. Смену облика пишет клиент — `appearance_changed`
(T-0238).

## Настройки и окружение

Нет: числа источников — в каталоге, правятся релизом вместе с рисунками.

## Документы

По шагу 11.

## Критерии приёмки

- [ ] Каталог из десяти обликов, владение считается по уровню, VIP, достижению, ступени недели и месту в сезоне.
- [ ] Выбрать можно только облик, которым игрок владеет; потерял владение — в ответах `keeper`, выбор сохранён.
- [ ] Облик и выбор аватара приходят в строках рейтинга, сезона и друзей.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Облики-архетипы — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — до экрана (T-0238) игрок изменений не видит.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБЛИКИ, СЕРВЕР**

  Сервер знает десять обликов героя: Хранитель с тремя окрасами за уровни 5, 10, 15, Витязь за 20-й уровень, Ведунья за верхнюю ступень очков недели, Охотница за «Грозу элит», Князь — пока активен VIP, Навий страж — за топ-3 недельного сезона навсегда, Скоморох — с Ярмаркой. Владение считается само, выбранный облик и голова в кружке аватара уходят в рейтинг, сезон и друзей. Экран — T-0238.
  ```
