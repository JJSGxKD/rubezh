---
id: T-0254
title: Карточка игрока картинкой — «Поделиться» из карточки и вход по ссылке прямо в карточку
epic: E5
priority: P3
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0253, T-0251]
zones:
  - backend/api/src/common/card/player-card-image.ts
  - backend/api/test/player-card-image.test.ts
shared:
  - backend/api/src/modules/players/players.controller.ts
  - backend/api/src/modules/players/players.service.ts
  - packages/app-shell/src/screens/meta/player-card.tsx
  - packages/app-shell/src/state/player-card-api.ts
  - packages/app-shell/src/state/navigation.ts
  - packages/app-shell/src/i18n/ru.json
  - docs/24-attribution-and-sharing.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/mockups/bot-images-v2.html
batch: 4
---

# T-0254. Карточка игрока картинкой — «Поделиться» из карточки и вход по ссылке прямо в карточку

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0254.json)](README.md#значки-статуса) [![T-0253](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0253.json&label=T-0253)](T-0253-invite-and-run-share-cards.md) [![T-0251](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0251.json&label=T-0251)](T-0251-vip-seen-by-others.md)

## Зачем

Карточкой игрока (T-0248) пока нельзя поделиться. После задачи в карточке
есть «Поделиться». В чат уходит картинка: облик целиком, имя, знак, уровень,
лучший забег и место. Кнопка «Открыть карточку» открывает игру сразу на
этой карточке, с реферальной меткой.

## Решения

Числа раскладки на 1200×675 — `design/art/meta-v2.md` §3.4 (дизайнер,
31.10.2026); макет — в поле `design`.

Решения владельца — `docs/35-stage4-plan.md`:
- **Р48** — карточкой можно поделиться картинкой и ссылкой, ссылка несёт
  реферальную метку;
- **Р156** — карточка игрока картинкой.

Решения `claude-lead-1` от 24.10.2026:

- **`POST /api/v1/players/:publicId/share`** → подготовленное сообщение с
  картинкой (`heroScene`, T-0252). Поделиться можно любой открытой карточкой,
  не только своей. Скрытого игрока — 404, как у карточки.
- **Ссылка** — `startapp` с парой `card` и публичным id плюс реферальная
  метка делящегося — в том формате пар, что уже разбирает вход
  (`docs/24`). Клиент на старте с такой парой открывает карточку поверх
  главной.
- **Кнопка** «Поделиться» в карточке рядом с действиями; без подготовленных
  сообщений — кнопки нет.

## Как сейчас

- После T-0247 и T-0248 — `players.controller.ts`, `player-card.tsx`; после
  T-0253 — образец маршрута шеринга и клиентского вызова.
- Разбор стартовых параметров — `state/navigation.ts` и `docs/24` (пары
  ключ-значение, T-0179).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`player-card-image.ts`** — картинка на `heroScene`.
3. **Маршрут** в `players.controller.ts`.
4. **Клиент** — кнопка в карточке, разбор пары `card` в `navigation.ts` и
   открытие карточки.
5. **Тексты:** `"playerCard.share": "Поделиться"`, кнопка сообщения —
   «Открыть карточку».
6. **`docs/24`** — пара `card` в стартовом параметре.

## Чего не трогаем

- Карточку и её данные — T-0247, T-0248.

## Тесты

Первым коммитом.

- `player-card-image.test.ts` — картинка с обликом и знаком, хэш меняется
  с местом.
- Маршрут: открытая карточка → сообщение со ссылкой (`card` и метка);
  скрытый → 404.
- Разбор стартового параметра: пара `card` с публичным id → открыть карточку; битый id
  → ничего.

## Аналитика

`share_created` с `kind: "player_card"` (словарь — T-0253).

## Настройки и окружение

Нет.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Из карточки — «Поделиться» картинкой; ссылка открывает игру на этой карточке с реферальной меткой.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Поделиться карточкой игрока`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: карточкой игрока можно поделиться — картинкой со ссылкой прямо на неё`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТОЧКА ИГРОКА КАРТИНКОЙ**

  Из карточки игрока — «Поделиться»: в чат уходит картинка с обликом, знаком, уровнем, лучшим забегом и местом. Кнопка открывает игру прямо на этой карточке, ссылка несёт реферальную метку.
  ```
