---
id: T-0255
title: Напоминания бота картинкой — «тебя обогнали», сезон закрывается, награда дня ждёт, колесо снова крутится
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0252, T-0128]
zones:
  - backend/api/src/common/card/reminder-cards.ts
  - backend/api/test/reminder-cards.test.ts
  - backend/api/test/reminders-images.integration.test.ts
shared:
  - backend/api/src/modules/reminders/**
  - backend/api/src/modules/notifications/notification-kinds.ts
  - backend/api/src/modules/notifications-bot/bot-notify-rules.ts
  - backend/api/src/modules/notifications-bot/bot-notify-sender.ts
  - backend/api/src/modules/notifications-bot/bot-notify-texts.ts
  - backend/api/src/platforms/ports/messenger.ts
  - backend/api/src/platforms/telegram/telegram-messenger.ts
  - backend/api/src/modules/wheel/wheel.service.ts
  - packages/app-shell/src/i18n/ru-bot.json
  - docs/35-stage4-plan.md
  - docs/22-analytics-and-metrics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/mockups/bot-images-v2.html
batch: 4
---

# T-0255. Напоминания бота картинкой — «тебя обогнали», сезон закрывается, награда дня ждёт, колесо снова крутится

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0255.json)](README.md#значки-статуса) [![T-0252](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0252.json&label=T-0252)](T-0252-bot-cards-foundation.md) [![T-0128](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0128.json&label=T-0128)](T-0128-bot-reminders.md)

## Зачем

Напоминания T-0128 уходят текстом и теряются в ленте. После задачи каждое
напоминание — картинка мира с обликом и коротким текстом:
- «Мирон обогнал тебя: 4-е место»;
- «Сезон закрывается завтра»;
- «День 5 — 150 монет ждут»;
- «Колесо снова крутится» — новый, четвёртый вид, самый нижний по
  приоритету.

## Решения

Числа раскладки на 1200×675 — `design/art/meta-v2.md` §3.4 (дизайнер,
31.10.2026); макет — в поле `design`.

Решение владельца — `docs/35-stage4-plan.md` Р156:
- напоминания «тебя обогнали» (раз в сутки, по выбору игрока), «награда дня
  ждёт», «колесо снова крутится» — с картинкой;
- напоминания — только тем, кому можно писать (Р51).

Решения `claude-lead-1` от 24.10.2026:

- **Доставка — та же, что T-0128:** виды уведомлений, дубль в бота, одно
  напоминание в сутки на все виды, тихие часы, отписка кнопкой, ключ
  `bot.reminders`. Меняется только то, что уходит: **фото с подписью**
  вместо текста, если у вида есть картинка. Подпись — прежний текст вида.
  Нет картинки или фото не ушло — прежний текст.
- **Порт:** у `OutgoingMessage` необязательное `image: { key, render: () =>
  Buffer }`.
  - Telegram берёт `file_id` из кэша T-0252 по `key` или рисует и шлёт `sendPhoto`.
  - Площадка без фото шлёт текст.
- **Картинки** (`reminder-cards.ts`, на `heroScene`):

  | Вид | На картинке |
  |---|---|
  | `season_overtaken` | облик игрока и облик того, кто теперь выше; «{имя} обогнал тебя», место крупно |
  | `season_closing` | облик игрока, «Сезон закрывается завтра», место |
  | `daily_reward_ready` | горсть монет, «День {N} — {монет} монет ждут» |
  | `wheel_ready` | колесо, «Колесо снова крутится» |

  Чтобы показать, кто обогнал, данные `season_overtaken` получают имя и
  облик игрока строкой выше на момент отправки. Это публичные данные, как в
  строке рейтинга; id наружу не уходит.
- **Новый вид `wheel_ready`:** бесплатная крутка этих суток доступна и не
  использована.
  - Приоритет — после `daily_reward_ready`: в сутки всё равно одно напоминание.
  - Тот же ключ `bot.reminders`, `dedupeKey` — `wheel_ready:<игровой день>`.
- **Строка в `docs/35` §3.10** — четвёртый вид и картинки.

## Как сейчас

- После T-0128: модуль `reminders` (планировщик и приоритет видов), виды
  уведомлений `season_overtaken`, `season_closing`, `daily_reward_ready`,
  отправка — `notifications-bot` (`bot-notify-sender.ts`, тексты —
  `bot-notify-texts.ts`), порт `messenger.ts` (`OutgoingMessage`, `action`).
- После T-0252: `heroScene`, `card-cache.ts`.
- Колесо — `wheel/wheel.service.ts` (бесплатная крутка суток).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`reminder-cards.ts`** — четыре картинки.
3. **Порт и Telegram** — `image` у сообщения, `sendPhoto` с подписью и
   кнопками, кэш `file_id`.
4. **Отправитель** — картинка по виду; сбой фото → текст.
5. **`wheel_ready`** — вид, правило в планировщике, тексты в
   `bot-notify-texts.ts` и `ru-bot.json`.
6. **`season_overtaken`** — имя и облик строки выше в данных.
7. **Документы:** `docs/35` §3.10, `docs/22` (у `bot_message_sent` — `kind`
   включает `wheel_ready`, если событие уже есть в словаре; иначе — сначала в
   словарь).

## Чего не трогаем

- Правила доставки T-0128: окно, тихие часы, отписку.
- Рассылки из панели.

## Тесты

Первым коммитом.

- `reminder-cards.test.ts`: четыре картинки рисуются; разные места — разные
  хэши; длинное имя переносится.
- `reminders-images.integration.test.ts`:
  - напоминание уходит `sendPhoto` с подписью и кнопками;
  - второй раз — по `file_id`;
  - сбой загрузки фото → текст;
  - `wheel_ready` — только когда бесплатная крутка не использована и в сутки нет другого напоминания.

## Аналитика

Существующий учёт исхода в `notification.bot_outcome`; новый вид —
`wheel_ready`.

## Настройки и окружение

Нет новых ключей: работает под ключами T-0128.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Все четыре напоминания уходят картинкой с подписью; без фото — текстом.
- [ ] «Колесо снова крутится» — под теми же правилами и тем же ключом.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Напоминания бота картинкой`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: напоминания бота — с картинкой; новое напоминание «колесо снова крутится»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НАПОМИНАНИЯ КАРТИНКОЙ**

  Напоминания бота уходят картинкой мира с обликом: «тебя обогнали» с тем, кто теперь выше, «сезон закрывается», «награда дня ждёт» и новое «колесо снова крутится». Правила прежние: одно напоминание в сутки, тихие часы, отписка кнопкой.
  ```
