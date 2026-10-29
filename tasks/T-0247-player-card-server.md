---
id: T-0247
title: Карточка игрока — сервер: публичный id, ответ карточки, заявка в друзья по публичному id
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0240, T-0237, T-0113]
zones:
  - backend/api/src/modules/players/**
  - backend/api/test/player-card.test.ts
  - backend/api/test/player-card.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/app.module.ts
  - backend/api/src/common/public-identity.ts
  - backend/api/src/modules/auth/account.repository.ts
  - backend/api/src/modules/friends/friends.controller.ts
  - backend/api/src/modules/friends/friends.service.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/items/items.service.ts
  - backend/api/src/modules/achievements/achievements.service.ts
  - backend/api/src/modules/achievements/emblems.service.ts
  - packages/shared-types/src/index.ts
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/mockups/identity-v2.html
batch: 4
---

# T-0247. Карточка игрока — сервер: публичный id, ответ карточки, заявка в друзья по публичному id

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0247.json)](README.md#значки-статуса) [![T-0240](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0240.json&label=T-0240)](T-0240-public-identity-in-lists.md) [![T-0237](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0237.json&label=T-0237)](T-0237-appearance-server.md) [![T-0113](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0113.json&label=T-0113)](T-0113-boards-by-viewer.md)

## Зачем

Тап по игроку в рейтинге ничего не открывает: у строки нет даже
идентификатора, по которому можно спросить о нём сервер. Внутренние
`accountId` наружу не уходят — и не должны. После задачи у каждого игрока
есть публичный id. Строки рейтинга, сезона и друзей его несут, а по нему
сервер отдаёт карточку: облик, знаки, уровень, мощь, место в сезоне, числа
забегов, витрину и отношение к смотрящему. Из карточки можно позвать в
друзья. Клиент — T-0248.

## Решения

Решение владельца — `docs/35-stage4-plan.md`:
- **Р48** — у каждого публичная карточка, её открывает любой тапом по игроку:
  - персонаж целиком, аватар со знаками;
  - уровень, мощь, лучшее место;
  - статистика забегов, витрина достижений.
- **Р47** — внутренний `accountId` в публичное не попадает, у игрока
  публичный идентификатор.
- Поправка от 24.10.2026: в этом блоке — карточка и VIP в подарок
  (T-0249, T-0250).

Решения `claude-lead-1` от 24.10.2026:

- **Публичный id** — `account.public_id VARCHAR(12)`, 12 шестнадцатеричных
  знаков, уникальный, не меняется.
  - Новому аккаунту id ставит репозиторий при создании; при коллизии — новая попытка, до трёх.
  - Старым — миграция: `substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)`, затем `NOT NULL` и уникальный индекс.
- **Публичный id в строках** — через порт `PublicIdentity` (T-0240):
  `PublicMark.publicId`. Строки рейтинга, сезона и друзей получают его тем
  же вызовом. Свой id — в ответе входа (`publicId`).
- **Карточка** — `GET /api/v1/players/:publicId`; параметр — Zod
  `^[0-9a-f]{12}$`. Ответ:

  ```
  { publicId, name, photoUrl?, appearance, avatarPhoto?, emblem?, emblems: { held, top },
    level, power, season: { place } | null, stats: { runs, totalKills, bestSurvivalSec },
    prestige, favorites: [{ id, title, category }], relation, vip? }
  ```

  - `emblems.top` — до пяти держимых знаков, по редкости сверху (T-0235);
  - `power` — мощь надетого (`items/item-views.ts`, «её видно в профиле и рейтинге»);
  - `relation` — `self`, `friend`, `outgoing`, `incoming` или `none`;
  - `vip` — `true`, если VIP активен (используют T-0250 и T-0251).
- **Числа — по доске смотрящего** (T-0113): лучший забег и место в сезоне
  — те, что смотрящий видит в своём рейтинге. Сам себе игрок виден по
  своей доске. Игрок, которого правило доски смотрящему не показывает, —
  404 `player_not_found`, как несуществующий: карточка не обходит скрытие.
- **Заявка в друзья по публичному id:** `POST /friends/requests` принимает
  `{ publicId }` наравне с `{ accountId }` (Zod — ровно одно из двух).
  Остальное — прежние правила друзей.
- **Нагрузка:** один ответ — фиксированное число запросов, без N+1. Лимит —
  60 карточек в минуту на смотрящего. Таймауты на всё.

## Как сейчас

- `runs/runs-view.service.ts:53–59,186` — `ProfileView` (`runs`, `totalKills`,
  `totalSurvivalSec`, `best`, `recent`) и `profile(accountId, audience)`;
  после T-0113 — профиль и место по доске смотрящего.
- `friends/friends.controller.ts:46–52` — `POST /friends/requests` с
  `{ accountId }`. У друзей `accountId` друга клиенту известен, у рейтинга —
  нет.
- После T-0240 и T-0237 — порт `PublicIdentity` с `emblem`, `appearance`,
  `avatarPhoto`. После T-0235 — `EmblemsService`. После T-0107 —
  `AchievementsService` (престиж, «любимые»).
- Мощь — `items/item-views.ts:41–42`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — `public_id` по «Решениям», ER в `docs/21`.
3. **`account.repository.ts`** — `publicId` в `Account`, создание с
   повтором при коллизии, `byPublicId(id)`.
4. **Порт** — `publicId` в `PublicMark`. `shared-types` — `publicId` в строках
   и в ответе входа.
5. **Модуль `players`** (`players.controller.ts`, `players.service.ts`,
   `players.module.ts`, строка в `app.module.ts`). Карточка собирается из
   сервисов-источников, каждый вызов — с таймаутом. Сбой необязательного
   блока (знаки, витрина) — блок пустой, карточка 200.
6. **Друзья** — `publicId` в теле заявки.
7. **Документы** — `docs/21`: модуль `players` и его источники.

## Чего не трогаем

- Клиент — T-0248. Подарок VIP — T-0249, T-0250.
- Картинку карточки и «Поделиться» — вместе с картинками бота (Р156).
- Жалобу на игрока, рамку дивизиона.

## Тесты

Первым коммитом.

- `player-card.test.ts`: `relation` по состоянию дружбы и заявок; `top`
  знаков — по редкости, не больше пяти; схема `publicId` не пускает 11 и
  13 знаков и заглавные.
- `player-card.integration.test.ts` (живые Postgres и Redis):
  - строки рейтинга, сезона и друзей несут `publicId`; `accountId` чужих нет нигде;
  - `GET /players/:publicId` — облик, знак, уровень, мощь, числа, витрина;
  - скрытый правилом доски игрок → 404, как несуществующий;
  - своя карточка → `relation: "self"`;
  - `POST /friends/requests { publicId }` → заявка; оба поля сразу → 400;
  - 61-я карточка за минуту → 429;
  - у миграции у всех аккаунтов `public_id`, уникальный.

## Аналитика

Открытие карточки пишет клиент (T-0248).

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] У каждого игрока публичный id, строки списков его несут, `accountId` чужих наружу не уходит.
- [ ] Карточка по публичному id — с теми числами, что смотрящий видит в рейтинге; скрытого не показывает.
- [ ] Заявка в друзья по публичному id.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Карточка игрока — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — карточка придёт с клиентом (T-0248).
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТОЧКА ИГРОКА, СЕРВЕР**

  У каждого игрока публичный id — строки рейтинга, сезона и друзей несут его вместо внутренних id. По нему сервер отдаёт карточку: облик, знаки, уровень, мощь, место в сезоне, числа забегов и витрину — по той доске, что видит смотрящий. Из карточки можно позвать в друзья.
  ```
