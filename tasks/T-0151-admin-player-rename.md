---
id: T-0151
title: Ник в панели — исходник, ручная смена с закреплением, длинные ники в списке
epic: E7
priority: P2
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: M
depends_on: [T-0150]
zones:
  - backend/api/src/modules/admin/admin-players.service.ts
  - backend/api/src/modules/admin/admin-players.controller.ts
  - backend/api/src/modules/admin/admin-player-names.ts
  - backend/api/test/admin-players.test.ts
  - apps/admin/src/api/players.ts
  - apps/admin/src/screens/players/PlayerActions.tsx
  - apps/admin/src/screens/players/PlayerCardView.tsx
  - apps/admin/src/screens/players/PlayerHeader.tsx
  - apps/admin/src/screens/players/PlayerList.tsx
shared:
  - docs/29-admin-panel.md
  - apps/admin/src/api/audit.ts
  - backend/api/src/modules/auth/account.repository.ts
  - backend/api/test/helpers/memory-auth.ts
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0151. Ник в панели — исходник, ручная смена с закреплением, длинные ники в списке

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0151.json)](README.md#значки-статуса) [![T-0150](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0150.json&label=T-0150)](archive/T-0150-display-name-on-login.md)

## Зачем

После T-0150 у аккаунта есть исходный ник (`platformName`) и закрепление
(`nameLockedAt`). Панели нужно три вещи: показать исходник, дать модератору
сменить ник и закрепить его, и не растягивать строку списка ником-рисунком,
как на снимке от 15.10.2026.

## Решения

Решение пользователя от 15.10.2026: ручная смена с закреплением. Уточнения
`claude-lead-1` от того же дня:

- **Право — `players.ban`**: смена ника — модерация того же уровня, что
  блокировка. Отдельного права не заводим.
- **Ник от модератора проходит `cleanName`** (T-0149): иначе ручная смена
  обходит чистку. `name: null` → 400 «Ник не прошёл проверку: <empty |
  profanity>».
- **Снять закрепление** — ник снова берётся с площадки:
  `displayNameFor(platformName ?? displayName, username, accountId)`.
- **Аудит:** `players.rename` (`before`, `after`) и `players.rename.unlock`
  (`before`, `after`).
- **Список:** ник в ячейке — одной строкой с «…» и обрезкой по высоте. Это
  защита на случай, если чистка что-то пропустит.

## Как сейчас

- `backend/api/src/modules/admin/admin-players.controller.ts:51–66` — образец:
  `@Post(":accountId/ban")`, `@RequirePermission("players.ban")`,
  `this.limit(actor.accountId)`, тело — Zod через `parse(…)`.
- `backend/api/src/modules/admin/admin-players.service.ts` — 227 строк;
  `ban`/`unban` (181–193), `row(accountId)` (194), аудит —
  `this.roles.audit({ actorAccountId, action, target, after })`; `PlayerRow`
  с `displayName` (строка 46).
- `apps/admin/src/api/players.ts:14, 96` — `playerRowSchema`,
  `playerCardSchema`.
- `apps/admin/src/api/audit.ts:85–89` — подписи действий `players.*`.
- `apps/admin/src/screens/players/PlayerList.tsx:192` — колонка «Имя»:
  `render: (player) => player.displayName`, без обрезки.
- `apps/admin/src/screens/players/PlayerActions.tsx` — панели действий
  (`WalletAdjustPanel`, `MessagePanel`) — образец формы с итогом.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Сервис:** в `PlayerRow` — `platformName: string | null`,
   `nameLocked: boolean`. Методы:
   - `rename(actor, accountId, name, now)` — `cleanName(name)`; `null` →
     `ValidationError`; иначе `displayName` и `nameLockedAt = now` одним
     `update`, аудит `players.rename`, ответ — новая строка;
   - `unlockName(actor, accountId, now)` — `nameLockedAt = null`, ник через
     `displayNameFor`, аудит `players.rename.unlock`.

   Сервис перевалит за 300 строк — вынести методы ника в
   `admin-player-names.ts` рядом и звать оттуда.
3. **Контроллер:** `POST :accountId/name` (тело `z.object({ name: z.string().min(1).max(64) })`)
   и `POST :accountId/name/unlock`. Право `players.ban`, тот же лимит частоты.
4. **Клиент панели:**
   - `players.ts` — поля в схемах, `renamePlayer(api, id, name)`,
     `unlockPlayerName(api, id)`;
   - `audit.ts` — «Смена ника» и «Снятие закрепления ника»;
   - `PlayerCardView.tsx` — под ником, если `platformName` есть и отличается:
     «На площадке: <platformName>» (тоже с обрезкой), значок «закреплён»;
   - `PlayerActions.tsx` — `NamePanel`: поле с нынешним ником, кнопка
     «Сменить и закрепить»; при закреплении — кнопка «Снять закрепление»;
     ошибка проверки — текстом сервера;
   - `PlayerList.tsx` — ячейка имени: `truncate` (одна строка, «…»),
     `max-w-[16rem]`, `overflow-hidden`; признак «ник почищен» (есть
     `platformName` и он отличается) — точкой с подсказкой «ник изменён
     чисткой».
5. **`docs/29`** — раздел «Игроки»: исходный ник, смена с закреплением, право,
   аудит.

## Чего не трогаем

- Правила чистки (T-0149) и вход (T-0150).
- Права и роли: новых прав нет.

## Тесты

`backend/api/test/admin-players.test.ts`:
- `rename` с «Тимур» → `displayName` «Тимур», `nameLocked: true`, запись
  аудита с `before`/`after`;
- `rename` с ником из U+0489 → `ValidationError`, аудита нет;
- `rename` с матом → `ValidationError`;
- `unlockName` → ник с площадки через `displayNameFor`, `nameLocked: false`;
- маршрут без права `players.ban` → 403.

Панель — снимки `pnpm screens` (T-0145), если она уже есть, иначе руками: 390 и
1440 px, карточка с исходником и закреплением, список с длинным ником.

## Аналитика

Нет: действия модератора — в аудите.

## Настройки и окружение

Нет.

## Документы

Шаг 5.

## Критерии приёмки

- [ ] Модератор с правом `players.ban` меняет ник, ник закрепляется, действие
  есть в аудите.
- [ ] Ник, не прошедший чистку, не сохраняется — ошибка с причиной.
- [ ] Снятие закрепления возвращает ник с площадки.
- [ ] Длинный ник в списке — одной строкой с «…», строка не растягивается.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `feat(admin): Смена ника с закреплением и исходник`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НИК В ПАНЕЛИ**

  В карточке игрока виден исходный ник с площадки, модератор с правом блокировки меняет ник и закрепляет его — вход больше не перезапишет. Ручной ник проходит ту же чистку. Длинные ники в списке обрезаются одной строкой.
  ```
