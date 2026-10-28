---
id: T-0211
title: Колокольчик обновляется сразу после экрана друзей, предмета и журнала
epic: E5
priority: P1
status: done
owner: claude-16 / haiku-5.5 / medium
author: claude-lead-1
size: S
depends_on: [T-0210]
zones:
  - packages/app-shell/src/screens/meta/friends.tsx
  - packages/app-shell/src/state/items-api.ts
  - packages/app-shell/src/state/changelog-api.ts
  - packages/app-shell/test/notifications.test.ts
  - packages/app-shell/test/changelog-api.test.ts
shared: []
runner: any
executor: haiku-5.5
effort: medium
release: patch
design: null
batch: 3
---

# T-0211. Колокольчик обновляется сразу после экрана друзей, предмета и журнала

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0211.json)](README.md#значки-статуса) [![T-0210](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0210.json&label=T-0210)](T-0210-notifications-read-by-action.md)

## Зачем

После T-0210 сервер гасит уведомление, когда игрок открыл экран друзей,
лист предмета или журнал обновлений. Но клиент перечитывает знаки только при
входе, на возврате в приложение и после действий на экране друзей — число на
колокольчике отстаёт до следующего захода. После задачи клиент перечитывает
знаки сразу после этих трёх событий.

## Решения

- Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р135:
  колокольчик показывает непрочитанное, и гаснет оно там, где игрок сделал
  то, о чём уведомление.
- Решение `claude-lead-1` от 24.10.2026: перечитывать знаки целиком
  (`loadBadges`), а не вычитать на клиенте. Сколько уведомлений погасил
  сервер, клиент не знает, и угадывать число хуже, чем один запрос знаков.
  Перечитывать — только после ответа сервера на свой запрос: иначе знаки
  придут раньше, чем сервер погасит уведомление.

## Как сейчас

- `packages/app-shell/src/screens/meta/friends.tsx:52–59` — `load()` при
  открытии экрана; `loadBadges()` зовётся только в `act` (строка 75) после
  действий.
- `packages/app-shell/src/state/items-api.ts:110–126` — `markItemsSeen`:
  гасит знак арсенала у себя и шлёт `seen`; знаки не перечитывает.
- `packages/app-shell/src/state/changelog-api.ts:50–58` — `markChangelogSeen`:
  по ответу ставит `changelog`, колокольчик не трогает.
- `packages/app-shell/src/state/badges-api.ts:38–45` — `loadBadges(api?)`;
  без входа (нет `capabilities.auth`) ничего не делает.

## Шаги по порядку

1. **`friends.tsx`.** В `load()` после успешного ответа — `void
   loadBadges()`. Повторный `load()` из `act` знаки уже перечитывает —
   второго вызова в `act` не добавлять: перечитывание остаётся одно на
   действие (вынести вызов из `act` в `load` или оставить в `act` и звать из
   эффекта открытия — на выбор, но один вызов на одно событие).
2. **`items-api.ts`.** `markItemsSeen(itemIds, api?, refresh = loadBadges)`:
   после ответа `seen` с `ok` — `void refresh()`. Нет ответа или ошибка — не
   звать.
3. **`changelog-api.ts`.** `markChangelogSeen(page, api, refresh =
   loadBadges)`: после `ok` — `useBadges.setState({ changelog: … })`, как
   сейчас, и `void refresh()`.
4. Импорт `loadBadges` — статический. Если сборка или линт покажут цикл
   модулей — динамический, как в `progress-api.ts:120`.

## Чего не трогаем

- Сервер — T-0210.
- Ленту уведомлений и её `read`.
- Подсчёт знака арсенала на клиенте.

## Сценарий и интерфейс

Игрок видит на колокольчике «2» (заявка и редкий предмет), открывает экран
друзей — после загрузки экрана на колокольчике «1»; открывает лист редкого
предмета — колокольчик гаснет. Без сети знаки остаются прежними (как сейчас
у `loadBadges`).

## Тесты

Первым коммитом.

- `notifications.test.ts` (там уже тестируется `markItemsSeen`):
  `markItemsSeen` с ответом `ok` вызывает `refresh` один раз; с ошибкой
  сервера — ни разу; с пустым списком — ни разу.
- `changelog-api.test.ts`: `markChangelogSeen` с ответом `ok` ставит
  `changelog` и вызывает `refresh`; при `latestAt: null` — не вызывает.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Нет: поведение описано в Р135.

## Критерии приёмки

- [ ] После открытия экрана друзей, листа предмета и журнала знаки
  перечитываются один раз и только после ответа сервера.
- [ ] Ошибка сервера знаки не трогает.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Колокольчик обновляется после просмотра`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- исправлено: число на колокольчике меняется сразу, как только вы открыли друзей, предмет или «Что нового»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КОЛОКОЛЬЧИК ОБНОВЛЯЕТСЯ ПОСЛЕ ПРОСМОТРА**

  Клиент перечитывает знаки сразу после экрана друзей, листа предмета и журнала обновлений: уведомления, которые погасил сервер (T-0210), пропадают с колокольчика без перезахода.
  ```
