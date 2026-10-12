---
id: T-0019
title: Бот больше не пишет о каждой новой версии
epic: E5
priority: P1
status: done
owner: claude-3 / sonnet-5.5
size: S
depends_on: []
zones:
  - backend/api/src/modules/notifications-bot/bot-notify-rules.ts
  - backend/api/src/modules/notifications-bot/bot-notify-texts.ts
  - backend/api/src/modules/account-settings/account-settings.catalog.ts
  - backend/api/test/notifications-bot.test.ts
  - packages/app-shell/src/state/bot-notifications.ts
  - packages/app-shell/src/state/account-settings.ts
  - packages/app-shell/src/i18n/ru-bot.json
  - packages/app-shell/test/bot-notifications.test.ts
shared:
  - docs/35-stage4-plan.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
---

# T-0019. Бот больше не пишет о каждой новой версии

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0019.json)](README.md#значки-статуса)

## Зачем

Сейчас при публикации версии в журнале обновлений бот пишет игроку «Вышло
обновление «Рубежа» — версия X». Версии выходят часто, и сообщение о каждой —
это шум, за который игроки блокируют бота. Тогда до них не доходят и важные
сообщения: заявки друзей, сообщения команды. О крупных обновлениях команда
напишет сама, ручной рассылкой из панели.

## Решения

- **06.10.2026, решение пользователя: убрать из бота совсем, а не выключить по
  умолчанию.** Дубль `app_update` в бота убирается, переключатель «Новые версии
  игры» в разделе «Сообщения в боте» исчезает. О крупных обновлениях — ручная
  рассылка из панели (раздел «Рассылки», он уже есть).
- **Что остаётся:** уведомление `app_update` в ленте игры («Вышло обновление
  0.6.0 — посмотрите, что нового»), знак и экран «Что нового», раздача по
  журналу (`changelog-fanout.ts`). Меняется только дубль в бота.
- **Ключ `bot.updates` уходит из каталога настроек аккаунта** на сервере и в
  клиенте. Сохранённые значения не мешают: сервер при чтении пропускает ключи,
  которых нет в каталоге (`readStored`). Старый клиент, который ещё шлёт ключ,
  тоже ничего не ломает: неизвестные ключи сервер пропускает.
- **Версию набора ключей `ACCOUNT_SETTINGS_VERSION` не поднимаем:** удаление
  ключа совместимо в обе стороны, а версия только записывается и ни на что не
  влияет.

## Как сейчас

Сервер:
- `backend/api/src/modules/notifications-bot/bot-notify-rules.ts:33-36` — правило
  дубля:

  ```ts
  // Выход версии зовёт вернуться тех, кто давно не заходил (WP31). …
  app_update: { setting: "bot.updates", byDefault: true, throttleSec: 3 * 86_400 },
  ```

  В комментарии к файлу (строки 4–9) в списке того, что идёт в бота, есть
  «выход версии».
- `backend/api/src/modules/notifications-bot/bot-notify-texts.ts:39-42` — текст
  сообщения о версии, ветка `case "app_update"`.
- `backend/api/src/modules/account-settings/account-settings.catalog.ts:44-48` —
  ключи `bot.*`. Строка 48 — `"bot.updates"`, в комментарии строки 44 —
  «выход версии (WP31)».
- Вид без правила дубля в очередь бота не ставится вовсе: `enqueue` в
  `bot-notify-queue.ts:85-86` проверяет `botRuleOf`. Если такое задание всё же
  есть в очереди (поставлено до выката), отправитель пропустит его с причиной
  `not_duplicated` — так уже работает `rare_loot`
  (`backend/api/test/notifications-bot.test.ts:190-194`).
- Тест сообщения о версии — `notifications-bot.test.ts:172-188`.

Клиент:
- `packages/app-shell/src/state/bot-notifications.ts` — переключатели, строки
  23, 33, 38, 45, 79, 83: `updates` в `BOT_NOTIFY_DEFAULTS`,
  `BOT_NOTIFY_ACCOUNT_KEYS`, `BOT_NOTIFY_KEYS`, схеме хранилища, чтении и записи.
- `packages/app-shell/src/state/account-settings.ts` — строка 43 в
  `ACCOUNT_SETTING_KEYS`, строки 209–210 и 237–238 — ветки `case "bot.updates"`.
- Раздел настроек (`screens/settings.tsx:136`) строит список по `BOT_NOTIFY_KEYS`,
  поэтому сам экран менять не нужно.
- `packages/app-shell/src/i18n/ru-bot.json:7` — `"settings.bot.updates": "Новые версии игры"`.
- Совпадение ключей и умолчаний клиента и сервера проверяет
  `scripts/test/account-settings-keys.test.ts`. Он перебирает правила `BOT_NOTIFY`
  и сам подстроится, править его не нужно.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. `bot-notify-rules.ts`: удалить правило `app_update` вместе с комментарием
   над ним; в комментарии к файлу убрать «выход версии» из списка того, что
   идёт в бота, и дописать: «О выходе версии бот не пишет: она остаётся в ленте
   и «Что нового», о крупных обновлениях команда пишет рассылкой (решение
   06.10.2026)».
3. `bot-notify-texts.ts`: удалить ветку `case "app_update"`. Если после этого
   `NOTIFICATION_KINDS` или другой импорт файла не нужен — удалить импорт.
4. `account-settings.catalog.ts`: удалить строку `"bot.updates"`, из
   комментария строки 44 убрать «выход версии (WP31)».
5. `bot-notifications.ts`: убрать `updates` из `BOT_NOTIFY_DEFAULTS`,
   `BOT_NOTIFY_ACCOUNT_KEYS`, `BOT_NOTIFY_KEYS`, схемы хранилища, чтения и
   записи. Схема остаётся `z.object` без `.strict`: у сохранённого раньше
   выбора с полем `updates` оно просто отбросится.
6. `account-settings.ts`: убрать `"bot.updates"` из `ACCOUNT_SETTING_KEYS` и
   обе ветки `case "bot.updates"`.
7. `ru-bot.json`: удалить ключ `settings.bot.updates`.
8. Проверка: `rg -n "bot\.updates" backend/api/src packages/app-shell/src`
   ничего не находит, а в `bot-notifications.ts` нет слова `updates`.
   Уведомление `app_update` в ленте и его текст `notification.app_update`
   остаются.
9. `docs/35-stage4-plan.md`, WP31, пункт «**Дубль в бота**» (строка 4274 и его
   продолжение): заменить на «**Дубль в бота** — убран 06.10.2026 (T-0019): о
   выходе версии бот не пишет, она остаётся в ленте и «Что нового»; о крупных
   обновлениях — ручная рассылка из панели». В абзаце строк 4190–4191 «и, по
   выбору игрока, в бота (новый ключ `bot.updates`, механизм WP28)» заменить на
   «(в бота не дублируется — T-0019)».
10. `docs/21-diagrams.md`, §4.19 «Выход версии»: убрать участника
    `B as notifications-bot` и строку `N-)B: новые строки: дубль в бота по выбору игрока`.
    Под схемой, перед абзацем «Игрок спрашивает…», добавить строку: «В бота
    выход версии не дублируется: о крупных обновлениях команда пишет
    рассылкой (§4.18, T-0019)».

## Чего не трогаем

- Ленту уведомлений, вид `app_update`, раздачу `changelog-fanout.ts` и экран
  «Что нового».
- Остальные переключатели бота: заявки, подарки, сообщения команды.
- Рассылки (`modules/broadcasts/`): они уже умеют писать нужному сегменту.
- `ACCOUNT_SETTINGS_VERSION` на сервере и в клиенте.
- `screens/settings.tsx`: список строится по `BOT_NOTIFY_KEYS` сам. Этот файл —
  зона T-0010.

## Сценарий и интерфейс

- Игрок открывает «Настройки» → «Сообщения в боте»: три переключателя —
  «Заявки в друзья», «Подарки друзей», «Сообщения команды». «Новых версий игры»
  нет.
- Команда публикует версию в панели: в ленте игры у игрока появляется «Вышло
  обновление…», в бота ничего не приходит.

## Тесты

Первым коммитом.

- `backend/api/test/notifications-bot.test.ts` — кейс «выход версии…»
  (строки 172–188) заменить: задание `app_update` с версией `0.6.0` →
  `{ status: "skipped", reason: "not_duplicated" }`, `s.messenger.sent` пуст.
- `backend/api/test/notifications-bot.test.ts` — `botRuleOf("app_update")` →
  `undefined`.
  Очередь бота фильтрует виды той же `botRuleOf` (`bot-notify-queue.ts:86`),
  поэтому отдельный тест очереди не нужен: в тестах BullMQ без Redis не
  создаётся, и такой тест ничего бы не проверял.
- `packages/app-shell/test/bot-notifications.test.ts`:
  - функцию `choice` и кейсы строк 37–50 переписать на три ключа. Кейс
    «выбор, сохранённый до «новых версий»…» и кейс «переключатель «новые
    версии» сохраняется…» удалить;
  - новый кейс: в хранилище `{ friendRequest: false, friendGift: true, teamMessage: false, updates: false }` →
    выбор читается без сброса к умолчаниям: `{ friendRequest: false, friendGift: true, teamMessage: false }`;
  - новый кейс: из того же хранилища `toggle("teamMessage")` → в
    `bh.bot-notifications.v1` записано `{ friendRequest: false, friendGift: true, teamMessage: true }`,
    поля `updates` нет;
  - `BOT_NOTIFY_KEYS` → `["friendRequest", "friendGift", "teamMessage"]`.
- `scripts/test/account-settings-keys.test.ts` — без правок, должен остаться
  зелёным.

## Аналитика

Нет: новых действий нет. Пропуск дубля уже пишется в лог отправителя с
причиной `not_duplicated`.

## Настройки и окружение

Нет. Ключ каталога настроек аккаунта `bot.updates` удаляется.

## Документы

- `docs/35-stage4-plan.md`, WP31 — шаг 9.
- `docs/21-diagrams.md`, §4.19 — шаг 10: схема меняется в том же PR (`CLAUDE.md`, «Схемы»).

## Критерии приёмки

- [ ] Задание `app_update` в очереди бота пропускается с причиной
  `not_duplicated`, сообщение не уходит.
- [ ] В настройках три переключателя бота, «Новых версий игры» нет.
- [ ] Сохранённый раньше выбор с полем `updates` читается без сброса остальных
  переключателей.
- [ ] Уведомление о версии в ленте игры осталось.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(notifications): Бот не пишет о каждой версии`
- **Метка:** `release: patch`
- **Для игроков:** `- изменено [telegram]: Бот больше не пишет о каждой новой версии — что нового, видно в игре.`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — БОТ НЕ ПИШЕТ О КАЖДОЙ ВЕРСИИ**

  Бот больше не присылает игрокам сообщение о каждой новой версии: версии выходят часто, и такие сообщения быстрее всего приводят к блокировке бота. Обновление по-прежнему видно в ленте игры и в «Что нового».

  📣 **Как теперь сообщать об обновлениях**

  • о крупных обновлениях — рассылкой из панели, раздел «Рассылки»
  • переключатель «Новые версии игры» из настроек игрока убран
  ```
