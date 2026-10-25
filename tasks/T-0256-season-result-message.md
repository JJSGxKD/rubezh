---
id: T-0256
title: Итог сезона в боте картинкой — место и награды тем, кто играл
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0255]
zones:
  - backend/api/src/common/card/season-result-card.ts
  - backend/api/src/modules/seasons/season-result-notifier.ts
  - backend/api/test/season-result-notifier.test.ts
  - backend/api/test/season-result-notifier.integration.test.ts
shared:
  - backend/api/src/modules/seasons/seasons-close.service.ts
  - backend/api/src/modules/seasons/seasons.module.ts
  - backend/api/src/modules/notifications/notification-kinds.ts
  - backend/api/src/modules/notifications-bot/bot-notify-rules.ts
  - backend/api/src/modules/notifications-bot/bot-notify-texts.ts
  - backend/api/src/modules/account-settings/account-settings.catalog.ts
  - packages/app-shell/src/i18n/ru-bot.json
  - packages/app-shell/src/screens/meta/notifications.tsx
  - docs/35-stage4-plan.md
runner: local
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/mockups/bot-images-v2.html
batch: 4
---

# T-0256. Итог сезона в боте картинкой — место и награды тем, кто играл

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0256.json)](README.md#значки-статуса) [![T-0255](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0255.json&label=T-0255)](T-0255-reminders-with-images.md)

## Зачем

Недельный сезон закрывается молча: о месте и наградах игрок узнаёт, только
когда сам зайдёт. После задачи каждому, кто играл в сезоне и разрешил боту
писать, приходит картинка «Сезон 12: 7-е место» с наградами и кнопкой
«Забрать награды».

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- **Р156** — итог сезона картинкой, при закрытии сезона, тем, кто играл;
- **Р51** — писать только тем, кому можно.

Решения `claude-lead-1` от 24.10.2026:

- **Вид уведомления `season_result`** — строка ленты и дубль в бота, как у
  остальных (WP28).
  - Данные: номер сезона, место, размер доски, награды.
  - `dedupeKey` — `season_result:<ключ сезона>`.
  - Кому — строкам `season_result` закрытого сезона.
- **Это не напоминание:** окно «одно в сутки» T-0128 на него не действует.
  Выключается своим выбором игрока в настройках уведомлений бота —
  `bot.season_result`, по умолчанию включён.
- **Отправка — после закрытия, не внутри него.** `seasons-close.service.ts`
  после записи закрытого сезона ставит задание уведомителю. Сбой отправки не
  откатывает и не задерживает закрытие.
  - Очередь — та же `notifications-bot` с лимитером: сотни сообщений разом не
    упрутся в лимиты Telegram.
- **Картинка** — `heroScene` (T-0252) с обликом игрока: место крупно, «Сезон
  N», строка наград. Кнопка — «Забрать награды» (экран сезона). Подпись —
  текст того же содержания.

## Как сейчас

- `seasons/seasons-close.service.ts` — закрытие под локом, событие
  `season_closed`; `season_result` — строки мест.
- После T-0255: картинки в уведомлениях бота, порт `image`.
- Настройки уведомлений бота — `account-settings.catalog.ts`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`season-result-card.ts`** — картинка.
3. **`season-result-notifier.ts`** — задания на каждого из закрытого сезона,
   пачками; вызов после закрытия.
4. **Вид уведомления** — схема, правило бота, тексты, выбор игрока
   `bot.season_result`, строка в ленте (`notifications.tsx`).
5. **`docs/35` §3.10** — итог сезона среди сообщений бота.

## Чего не трогаем

- Закрытие сезона и награды.
- Напоминания T-0128.

## Тесты

Первым коммитом.

- `season-result-notifier.test.ts` — картинка и текст с местом и наградами;
  без наград — без строки наград.
- `season-result-notifier.integration.test.ts`:
  - закрытие сезона с тремя игроками → три уведомления, повтор закрытия — ни одного нового;
  - игрок выключил `bot.season_result` → строка в ленте есть, в бота не уходит;
  - сбой отправки не мешает закрытию.

## Аналитика

Исход доставки — `notification.bot_outcome`; забор наград — существующие
события сезона.

## Настройки и окружение

Выбор игрока `bot.season_result` — в каталоге настроек аккаунта.

## Документы

По шагу 5.

## Критерии приёмки

- [ ] После закрытия сезона каждый игравший получает в ленте и в боте картинку с местом и наградами.
- [ ] Игрок может выключить эти сообщения; закрытие от отправки не зависит.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(seasons): Итог сезона в боте картинкой`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: по итогам недели бот присылает картинку с твоим местом и наградами`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ИТОГ СЕЗОНА В БОТЕ**

  После закрытия недельного сезона каждому, кто играл, приходит картинка «Сезон N: место» с наградами и кнопкой «Забрать награды» — в ленте и в боте. Выключается отдельно в настройках уведомлений.
  ```
