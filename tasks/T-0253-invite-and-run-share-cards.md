---
id: T-0253
title: Приглашение и итог забега картинкой — «Поделиться» несёт облик и рекорд
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0252]
zones:
  - backend/api/src/common/card/invite-card.ts
  - backend/api/src/common/card/run-share-card.ts
  - backend/api/test/share-cards.test.ts
  - backend/api/test/invite-message-run.integration.test.ts
shared:
  - backend/api/src/modules/friends/friends.controller.ts
  - backend/api/src/modules/friends/friend-invite.service.ts
  - backend/api/src/modules/friends/friends.module.ts
  - packages/app-shell/src/state/run-share.ts
  - packages/app-shell/src/state/friends-api.ts
  - packages/app-shell/test/run-share.test.ts
  - packages/app-shell/src/state/analytics.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/24-attribution-and-sharing.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: design/art/mockups/bot-images-v2.html
batch: 4
---

# T-0253. Приглашение и итог забега картинкой — «Поделиться» несёт облик и рекорд

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0253.json)](README.md#значки-статуса) [![T-0252](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0252.json&label=T-0252)](T-0252-bot-cards-foundation.md)

## Зачем

Приглашение друга и «Поделиться» на итогах уходят в чат простым текстом, и
в ленте их не видно. После задачи у обоих есть картинка мира с обликом
игрока:
- у приглашения — «{Имя} зовёт тебя на рубеж» и подарок новичку;
- у итога — время забега, место и облик.

Кнопка ведёт в игру с реферальной меткой, как сейчас.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- **Р156** — приглашение и итог забега для «Поделиться» — с картинкой мира
  и облика;
- **Р63** — подготовленное сообщение, отправляет игрок;
- **Р48** — ссылка шеринга всегда несёт реферальную метку
  (`docs/24-attribution-and-sharing.md`).

Решения `claude-lead-1` от 24.10.2026:

- **Приглашение** — та же подготовка, что сейчас (`friends.controller.ts:43`,
  `invites.preparedMessage`), с `imageUrl` (T-0252). На картинке:
  - облик пригласившего (действующий, T-0237);
  - заголовок «{Имя} зовёт тебя на рубеж»;
  - строка подарка новичку — по правилам рефералки, если подарок есть, иначе строки нет;
  - строка «Выстоять 10 минут — и Рубеж твой».
- **Итог забега идёт тем же путём, что сейчас** (`state/run-share.ts`,
  `docs/24` §7): подготовленное сообщение приглашения со ссылкой дружбы.
  Позванный по итогу засчитывается, как позванный из «Друзей».
  - `POST /friends/invite-message` принимает необязательное `{ runId }`.
  - С ним картинка — итог этого забега, текст — строка о забеге.
  - Только свой и записанный забег, иначе — обычное приглашение.

  На картинке итога:
  - время крупно;
  - место в сезоне, если есть;
  - «Рубеж удержан», если победа (T-0121);
  - облик.

  Разбора по осям (Р152) пока нет — придёт с рейтингом эффективности.
- **Клиент** — `run-share.ts` передаёт `runId` в подготовку приглашения.
  Остальной путь прежний, включая запасной для площадок без подготовленных
  сообщений.
- **Кэш:** картинка — по хэшу видимого (T-0252), повторный «Поделиться» того
  же забега не рисует заново.

## Как сейчас

- `friends/friends.controller.ts:39–44` — `POST /friends/invite-message` →
  `invites.preparedMessage(account)`.
- `packages/app-shell/src/state/run-share.ts` — «Поделиться» на итогах
  путём приглашения: ссылка дружбы и строка о забеге (`RunShareInput {
  survivalSec, record }`); тест — `test/run-share.test.ts`. Кнопка —
  `screens/run/DeathNext.tsx`.
- После T-0252: `heroScene`, `card-store`, `imageUrl` у подготовленного
  сообщения.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`invite-card.ts`, `run-share-card.ts`** — картинки на `heroScene`.
3. **Приглашение** — `imageUrl` в подготовке.
4. **Подготовка с `runId`** (`friend-invite.service.ts`, `friends.controller.ts`):
   проверка владельца и статуса забега, картинка итога.
5. **Клиент** — `runId` из `run-share.ts` в `friends-api.ts`.
6. **Событие** `share_created` — клиентское, поле `kind` (`invite`, `run`).
   Сначала `docs/22` §3.3 и Zod, потом `state/analytics.ts`.
7. **`docs/24`** — приглашение и итог с картинкой.

## Чего не трогаем

- Реферальные правила и метку ссылки.
- Карточку игрока — T-0254.

## Тесты

Первым коммитом.

- `share-cards.test.ts`:
  - приглашение без подарка — без строки подарка;
  - итог с победой — строка «Рубеж удержан»;
  - разный облик — разный хэш.
- `invite-message-run.integration.test.ts`:
  - без `runId` → приглашение с картинкой пригласившего;
  - свой записанный забег → картинка итога, ссылка дружбы;
  - чужой или незаписанный забег → обычное приглашение.
- `run-share.test.ts` (оболочка) — `runId` уходит в подготовку; запасной путь
  прежний.

## Аналитика

`share_created` — по шагу 6. Вход по ссылке — атрибуция `docs/24`.

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Приглашение и «Поделиться» на итогах уходят с картинкой облика и рекорда.
- [ ] Без подготовленных сообщений — прежний путь.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Приглашение и итог забега картинкой`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: приглашение друга и «Поделиться» рекордом — с картинкой твоего облика`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРИГЛАШЕНИЕ И РЕКОРД КАРТИНКОЙ**

  Приглашение друга и «Поделиться» на итогах забега уходят в чат с картинкой мира и облика игрока: «Имя зовёт тебя на рубеж» и время забега с местом. Кнопка ведёт в игру с реферальной меткой. Событие share_created считает, чем делятся.
  ```
