---
id: T-0330
title: Облик в подарок другу — клиент: «Подарить облик» в карточке друга, витрина Ярмарки глазами друга, подтверждение с ценой, уведомление получателю
epic: E1
priority: P2
status: draft
owner:
author: claude-lead-1
size: M
depends_on: [T-0329, T-0265, T-0248, T-0250]
zones:
  - packages/app-shell/src/state/fair-gift.ts
  - packages/app-shell/src/screens/meta/fair-gift-sheet.tsx
  - packages/app-shell/test/fair-gift.test.ts
shared:
  - packages/app-shell/src/screens/meta/player-card.tsx
  - packages/app-shell/src/screens/meta/player-card-rules.ts
  - packages/app-shell/src/screens/meta/notifications.tsx
  - packages/app-shell/src/state/notifications-api.ts
  - packages/app-shell/src/state/fair-api.ts
  - packages/app-shell/src/screens/meta/appearance-art.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/gallery.tsx
  - backend/api/src/modules/fair/fair.controller.ts
  - backend/api/src/modules/fair/fair.service.ts
  - backend/api/test/fair.integration.test.ts
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0330. Облик в подарок другу — клиент: «Подарить облик» в карточке друга, витрина Ярмарки глазами друга, подтверждение с ценой, уведомление получателю

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0330.json)](README.md#значки-статуса) [![T-0329](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0329.json&label=T-0329)](T-0329-appearance-gift-server.md) [![T-0265](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0265.json&label=T-0265)](T-0265-fair-shell.md) [![T-0248](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0248.json&label=T-0248)](T-0248-player-card-shell.md) [![T-0250](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0250.json&label=T-0250)](T-0250-vip-gift-shell.md)

> **Черновик до Ярмарки** — вместе с T-0329 и T-0265.

## Зачем

Сервер умеет дарить облик с Ярмарки (T-0329), а у игрока нет кнопки. После
задачи в карточке друга есть «Подарить облик». Лист показывает Ярмарку этой
недели глазами друга — что у него уже есть, а что можно подарить. Подарок
подтверждается окном с ценой, получатель видит уведомление.

## Решения

Решения владельца — `docs/35-stage4-plan.md` Р162: из карточки друга, за
самоцветы, с Ярмарки, по образцу VIP в подарок.

Решения `claude-lead-1` от 25.10.2026:

- **Где кнопка** — карточка игрока (T-0248), только у друга, рядом с
  «Подарить VIP» (T-0250), второй кнопкой. Ярмарка выключена
  (`fair.enabled`) — кнопки нет.
- **Лист «Подарить облик»** (`fair-gift-sheet.tsx`):
  - позиции Ярмарки этой недели — тем же видом, что в магазине (T-0265):
    портрет, цена, «уйдёт через N дней»;
  - что у друга уже есть — «Уже есть», не нажимается;
  - нужен признак «есть у друга»: `GET /api/v1/fair?for=<publicId>`
    отдаёт `recipientOwns` у позиции — только другу, иначе 409
    `gift_not_friend` (правка `fair.controller.ts` и `fair.service.ts`).
- **Подтверждение** — окно: портрет, «Подарить {name} — {appearance}», цена
  самоцветом, «У вас N». Мало самоцветов — кнопка выключена, «Не хватает N»
  и ссылка в магазин (здесь забега нет, уходить можно).
- **Успех** — тост «Подарок отправлен», позиция в листе становится «Уже
  есть», баланс из ответа.
- **Ошибки** — подписи по кодам T-0329: «Уже есть у друга», «Подарков на
  сегодня хватит», «Эта позиция ушла с Ярмарки».
- **Получатель** — уведомление `appearance_gift`: «{fromName} подарил вам
  {appearance}», нажатие ведёт в арсенал на облик.
- **Аналитика** — `fair_gifted` при успехе (словарь — T-0329).

## Как сейчас

- **После T-0248** — карточка игрока `player-card.tsx`, правила кнопок —
  `player-card-rules.ts`.
- **После T-0250** — «Подарить VIP»: `vip-gift-sheet.tsx`, `state/vip-gift.ts`
  — образец листа, подтверждения и ошибок.
- **После T-0265** — Ярмарка в магазине: `fair.tsx`, `state/fair-api.ts`,
  портреты — `appearance-art.ts`.
- **После T-0329** — `POST /fair/:appearanceId/gift`, вид уведомления.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Сервер** — `recipientOwns` в `GET /fair?for=`.
3. **`state/fair-gift.ts`** — витрина для друга, подарок, ошибки.
4. **Лист и окно** — `fair-gift-sheet.tsx`; кнопка в карточке; витрина
   (`gallery.tsx`) — лист с купленным и некупленным, нехватка.
5. **Уведомление** — текст и переход.

## Чего не трогаем

- Сервер подарка — T-0329.
- Ярмарку себе — T-0265.

## Сценарий и интерфейс

- Загрузка листа — заглушки карточек той же высоты; ошибка — «Повторить».
- 320 px — портреты в два столбца, цена под портретом.
- Скилл `ui-design`: контраст, зона касания, материал окна v2.

## Тесты

Первым коммитом.

- `fair-gift.test.ts`:
  - кнопка — только у друга и при включённой Ярмарке;
  - «Уже есть» у позиций друга не нажимается;
  - нехватка самоцветов — кнопка выключена, ссылка в магазин;
  - успех → позиция «Уже есть», баланс обновлён;
  - 409 `gift_owned` → подпись, без повтора.
- `fair.integration.test.ts` — `for=<publicId>` не друга → 409.

## Аналитика

`fair_gifted { appearance, price }` при успехе.

## Настройки и окружение

Нет.

## Документы

Нет: экран описывает `docs/07` из T-0329.

## Критерии приёмки

- [ ] В карточке друга — «Подарить облик»; лист показывает Ярмарку глазами друга.
- [ ] Подарок — после подтверждения с ценой; нехватка видна до нажатия.
- [ ] Получатель видит уведомление с переходом к облику.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Облик в подарок другу`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: облик с Ярмарки можно подарить другу из его карточки`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБЛИК В ПОДАРОК**

  В карточке друга появилась кнопка «Подарить облик»: Ярмарка этой недели глазами друга, что у него уже есть — видно, подарок — после окна с ценой. Получатель видит уведомление и облик в арсенале.
  ```
