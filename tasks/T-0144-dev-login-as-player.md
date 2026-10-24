---
id: T-0144
title: Вход разработчика игроком без ролей — `dev-player-<id>`
epic: E0
priority: P1
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/auth/dev-login.ts
  - backend/api/src/modules/roles/roles.service.ts
  - backend/api/test/roles.test.ts
  - backend/api/test/auth.test.ts
shared:
  - docs/20-env-and-ports.md
runner: any
executor: sonnet-5.5
effort: medium
release: none
design: null
batch: 2
---

# T-0144. Вход разработчика игроком без ролей — `dev-player-<id>`

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0144.json)](README.md#значки-статуса)

## Зачем

`AUTH_DEV_LOGIN` даёт роль владельца любому `dev-<id>`. Поэтому вид обычного
игрока — без вкладок режимов и инструментов команды — локально не посмотреть
(`tasks/inbox.md`, 11.10). Исполнители проверяют экраны глазами, а видят их
владельцем.

## Решения

Решение `claude-lead-1` от 14.10.2026:

- **`dev-player-<id>`** — вход разработчика обычным игроком: автоматической роли
  владельца нет, роли — как у всех, из базы (выдать можно в панели). Все
  остальные `dev-<id>` — владельцы, как сейчас.
- Новой переменной окружения нет: признак — префикс в самом имени входа,
  `AUTH_DEV_LOGIN` по-прежнему допустим только в development.

## Как сейчас

- `backend/api/src/modules/auth/dev-login.ts:11` — `DEV_ID = /^dev-[a-z0-9-]{1,32}$/`;
  `isDeveloperAccount(account)` (строки 28–30) — Telegram и `DEV_ID`.
- `backend/api/src/modules/roles/roles.service.ts:50` —
  `if (this.config.auth.devLogin && isDeveloperAccount(account)) return ["owner"];`.
- `docs/20-env-and-ports.md:481–485` — как войти разработчиком в браузере.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`dev-login.ts`** — `export function isDeveloperOwner(account): boolean`:
   `isDeveloperAccount(account) && !account.platformUserId.startsWith("dev-player-")`.
   Комментарий: `dev-player-` — вход игроком без ролей, чтобы видеть игру
   глазами игрока.
3. **`roles.service.ts:50`** — `isDeveloperAccount` заменить на `isDeveloperOwner`.
   Остальные места, где проверяется аккаунт разработчика, не менять.
4. **`docs/20`** — в абзаце про вход разработчика: «`dev-player-<id>` — войти
   обычным игроком без ролей».

## Чего не трогаем

- Разбор строки входа (`parseDevUser`), `DEV_ID`, выключение входа вне development.
- Аварийный вход владельца (`isBreakGlassOwner`) и роли из базы.

## Тесты

- `roles.test.ts`: при `devLogin: true`
  - `dev-alex` → `["owner"]`;
  - `dev-player-alex` без ролей в базе → `[]`;
  - `dev-player-alex` с ролью `admin` в базе → `["admin"]`;
  - при `devLogin: false` `dev-alex` → роли из базы, как сейчас.
- `auth.test.ts`: вход `dev-player-alex:Игрок` принимается (формат тот же).

## Аналитика

Нет.

## Настройки и окружение

Нет новых переменных.

## Документы

`docs/20` — шаг 4.

## Критерии приёмки

- [ ] Вход `dev-player-<id>` показывает игру без инструментов команды и вкладок
  режимов.
- [ ] `dev-<id>` по-прежнему владелец.
- [ ] Вне development вход разработчика по-прежнему выключен.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `chore(dev): Вход разработчика игроком без ролей`
- **Метка:** `release: none`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВХОД РАЗРАБОТЧИКА ИГРОКОМ**

  Локально можно войти обычным игроком без ролей: `dev-player-<id>`. Вид игры без инструментов команды теперь видно глазами, как у тестеров.
  ```
