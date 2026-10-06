---
id: T-0032
title: Роли владельца и администратора выдаются только с подтверждением в Telegram
epic: E4
priority: P1
status: ready
owner:
size: M
depends_on: [T-0020]
zones:
  - backend/api/src/modules/admin/role-confirmations.ts
  - backend/api/src/modules/admin/admin-roles.service.ts
  - backend/api/src/modules/admin/admin-roles.controller.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/platforms/telegram/role-confirm.command.ts
  - backend/api/src/platforms/telegram/telegram-panel-login.module.ts
  - backend/api/src/platforms/telegram/welcome.command.ts
  - backend/api/test/role-confirmations.test.ts
  - backend/api/test/role-confirm-command.test.ts
  - backend/api/test/admin.test.ts
  - apps/admin/src/api/roles.ts
  - apps/admin/src/screens/roles/RolesScreen.tsx
  - apps/admin/test/roles.test.ts
shared:
  - docs/29-admin-panel.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
---

# T-0032. Роли владельца и администратора выдаются только с подтверждением в Telegram

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0032.json)](README.md#значки-статуса) [![T-0020](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0020.json&label=T-0020)](T-0020-bot-texts-and-reply.md)

## Зачем

По `docs/29-admin-panel.md` §3.4 выдача ролей `owner` и `admin` — действие с
правилом двух ключей. Сейчас её делает одно нажатие в панели, и сессия
панели, забытая открытой на чужом компьютере, может раздать полный доступ.
Второго владельца, который подтвердил бы выдачу, в команде нет.

## Решения

Решение пользователя от 06.10.2026: **второй ключ — подтверждение в Telegram
тем, кто выдаёт.** Без доступа к его Telegram роль не выдать, а забытая сессия
панели только откроет запрос.

Решения тимлидов:

- **Под подтверждение попадают только роли `owner` и `admin`.** Остальные
  роли выдаются сразу, как сейчас. Снятие любой роли — тоже сразу: оно
  убирает доступ, а не даёт его.
- **Как устроено — по образцу входа в панель через бота** (`docs/29` §8,
  `panel-login.service.ts` и `panel-login.command.ts`):
  1. панель получает ссылку `t.me/<бот>?start=role-<запрос>`;
  2. бот показывает, кому и какую роль выдают, с кнопками «Выдать» и «Отмена»;
  3. нажать может только тот, кто открыл запрос: Telegram ID сверяется.
- **Запрос живёт 10 минут** и подтверждается один раз.
- **Права проверяются в момент подтверждения:** у того, кто выдаёт, к
  этому времени может уже не быть права `roles.assign`.
- **Машина разработчика** (`config.auth.devLogin`) — роль выдаётся сразу:
  там владелец и игрок — один человек, а бота может не быть.

## Как сейчас

- `backend/api/src/modules/admin/admin-roles.controller.ts`:
  - строки 36–42 — `POST /admin/roles/grant` → `this.roles.grant(actor, target)` → `{ granted }`;
  - строки 44–50 — `revoke`, лимит `this.limit(actor.accountId)`.
- `backend/api/src/modules/admin/admin-roles.service.ts:116-119` — `grant`:
  `resolve(target)` → `RolesService.grant(actor, accountId, role)`.
  `RolesService.grant` (`roles/roles.service.ts:83-90`):
  - проверяет `roles.assign`;
  - запрещает выдачу себе;
  - пишет аудит `roles.assign`.
- **Образец запроса через бота — `modules/admin/panel-login.service.ts`:**
  - `PANEL_LOGIN_PREFIX = "panel-"`;
  - `REQUEST_ID = /^[A-Za-z0-9_-]{22}$/` — 16 случайных байт в base64url;
  - хранилище в Redis с TTL, `withTimeout` на обращения;
  - `this.links.chat("telegram", "<префикс><id>")` — ссылка на бота, `null`,
    пока бот не представился, тогда `UnavailableError`;
  - `prompt`, `confirm`, `decline`.
- **Образец команды бота — `platforms/telegram/panel-login.command.ts`:**
  - разбор `/start panel-<id>`, только в личном чате;
  - кнопки с `callback_data` `panel:ok:<id>` / `panel:no:<id>`;
  - проверка, что кнопку нажали в личном чате её получателя;
  - `editMessageText` с итогом;
  - зарегистрирован в `telegram-panel-login.module.ts`.
- `platforms/telegram/welcome.command.ts:38` и `:137` — `PANEL_LOGIN_START`:
  `/start panel-…` не считается приходом игрока. Такое же исключение нужно
  для `/start role-…`.
- Панель:
  - `apps/admin/src/api/roles.ts:123-125` — `grantRole` со схемой `{ granted }`;
  - `apps/admin/src/screens/roles/RolesScreen.tsx:122-160` — `GrantDialog`:
    после выдачи `toast.success(…)` и `onGranted()`.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **Новый `modules/admin/role-confirmations.ts`** — `RoleConfirmations`:
   - константы:
     - `ROLE_CONFIRM_PREFIX = "role-"` (экспорт);
     - `ROLE_CONFIRM_TTL_SEC = 600`;
     - `CONFIRMED_ROLES: readonly Role[] = ["owner", "admin"]`;
   - хранилище в Redis — ключ `admin:role-confirm:<id>`, значение JSON, чтение
     через Zod-схему:

     ```ts
     { actorAccountId: string; actorPlatformUserId: string; targetAccountId: string; role: Role; createdAtMs: number }
     ```

   - `open(actor: AccountRef, targetAccountId: string, role: Role, nowMs?)` →
     `{ link: string; expiresAtMs: number }`:
     1. `actor.platform !== "telegram"` → `ForbiddenError("Подтвердить выдачу можно только через Telegram — войдите в панель через бота")`;
     2. `requestId` — `randomBytes(16).toString("base64url")`;
     3. ссылка — `links.chat("telegram", ROLE_CONFIRM_PREFIX + requestId)`;
        `null` → `UnavailableError`, как во входе;
     4. запись в Redis с TTL.
   - `prompt(requestId, fromPlatformUserId)`: возвращает
     `{ roleTitle, targetName, targetPlatformUserId, expiresAtMs }` |
     `"expired"` | `"foreign"`:
     - id не по формату или записи нет → `"expired"`;
     - Telegram ID не совпал с `actorPlatformUserId` → `"foreign"`;
     - имя цели и её Telegram ID — из `AccountRepository.byId`;
     - название роли — из каталога ролей, тот же источник, что у панели;
   - `confirm(requestId, fromPlatformUserId)` →
     `"granted" | "already" | "expired" | "foreign" | "no_right"`:
     1. запись забирается атомарно (`GETDEL`). Её нет → `"expired"`;
     2. Telegram ID не совпал → запись вернуть обратно с оставшимся TTL и
        ответить `"foreign"`. Чужое нажатие не должно сжигать запрос;
     3. `RolesService.grant(actorRef, targetAccountId, role)`:
        - `actorRef` — `{ accountId, platform: "telegram", platformUserId }`;
        - `ForbiddenError` → `"no_right"`;
        - `false` → `"already"`, `true` → `"granted"`;
     4. лог `role_grant_confirmed` с полями `actorAccountId`,
        `targetAccountId`, `role`;
   - `decline(requestId, fromPlatformUserId)` → `boolean`: свой запрос
     удаляется, чужой не трогается.
3. **`admin-roles.service.ts`, `grant`:**
   - роль в `CONFIRMED_ROLES` и `!config.auth.devLogin` →
     `confirmations.open(actor, accountId, role)` →
     `{ granted: false, confirm: { link, expiresAtMs } }`;
   - иначе как сейчас, `{ granted, confirm: null }`.

   Запрет выдачи себе проверяется до `open`, тем же `ensureNotSelf`: если он
   недоступен вне `RolesService`, сравнить `actor.accountId` с целью и бросить
   `ForbiddenError("Выдать роль себе нельзя")`.
4. **`admin-roles.controller.ts`** — тип ответа `grant`:
   `{ data: { granted: boolean; confirm: { link: string; expiresAtMs: number } | null } }`.
   Изменение аддитивное.
5. **`admin.module.ts`** — `RoleConfirmations` в `providers` и `exports`.
   Зависимости — `REDIS`, `ACCOUNT_REPOSITORY`, `RolesService`, `AppLinks`,
   как у `PanelLoginService`.
6. **Новый `platforms/telegram/role-confirm.command.ts`** —
   `RoleConfirmCommand`, по образцу `PanelLoginCommand`:
   - `/start role-<22 знака>` в личном чате:
     - `prompt`;
     - `"expired"` → «Запрос на выдачу роли истёк или уже решён. Откройте выдачу в панели заново.»;
     - `"foreign"` → «Этот запрос открыт другим человеком — подтвердить его может только он.»;
     - иначе:

       ```
       Выдать роль «<roleTitle>» аккаунту <targetName> (Telegram ID <targetPlatformUserId>)?
       Запрос открыт из вашей сессии панели. Если вы его не открывали — нажмите «Отмена» и выйдите из панели везде.
       ```

       Кнопки: `{ text: "Выдать", callback_data: "role:ok:<id>" }`,
       `{ text: "Отмена", callback_data: "role:no:<id>" }`;
   - в группе → «Выдачу роли подтверждают в личном чате с ботом.»;
   - нажатие кнопки:
     - проверка «личный чат того, кто нажал» — как у входа;
     - итог — `editMessageText` и `answerCallbackQuery`:
       - `granted` → «✅ Роль выдана. Права действуют сразу.»;
       - `already` → «У аккаунта уже есть эта роль.»;
       - `expired` → тот же текст, что выше;
       - `foreign` → тот же текст, что выше;
       - `no_right` → «У вас больше нет права выдавать роли.»;
       - отказ → «Выдача отменена.»;
   - регистрация в `telegram-panel-login.module.ts`, рядом с `PanelLoginCommand`.
7. **`welcome.command.ts`** — рядом с `PANEL_LOGIN_START`:

   ```ts
   /** Подтверждение роли (`role-confirm.command.ts`) — не приход игрока. */
   const ROLE_CONFIRM_START = new RegExp(`^/start(?:@\\w+)?\\s+${ROLE_CONFIRM_PREFIX}`);
   ```

   и `if (ROLE_CONFIRM_START.test(message.text)) return false;` рядом со строкой 137.
8. **Панель:**
   - `apps/admin/src/api/roles.ts` — схема ответа `grantRole`:
     `{ granted: z.boolean(), confirm: z.object({ link: z.string().url(), expiresAtMs: z.number() }).nullable() }`;
   - `RolesScreen.tsx`, `GrantDialog`, при `confirm !== null` — вместо
     `toast.success` содержимое диалога:
     - заголовок «Подтвердите в Telegram»;
     - текст «Роль «<роль>» для <имя> выдаётся только после подтверждения в личном чате с ботом. Ссылка действует 10 минут.»;
     - главная кнопка «Открыть бота» → `confirm.link` в новой вкладке;
     - вторая «Готово» → `onGranted()` и закрыть диалог: список перечитается.

     Компоненты — из UI-кита панели, которыми уже собран `GrantDialog`.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- `RolesService` и права ролей.
- Снятие ролей и выдачу остальных ролей.
- Вход в панель через бота (`panel-login.*`).
- Ответ на обычное сообщение (T-0020): `/start role-…` берёт новый
  обработчик раньше обработчика по умолчанию.

## Тесты

Первым коммитом.

- Новый `backend/api/test/role-confirmations.test.ts` (Redis — подмена или
  тестовый Redis, как у соседних тестов входа в панель):
  - `open` от аккаунта Telegram → ссылка с `role-`, запись с TTL 600;
  - `open` не от Telegram → `ForbiddenError`;
  - `prompt` своим Telegram ID → имя и роль; чужим → `"foreign"`; после
    TTL → `"expired"`;
  - `confirm` своим → `granted`, аудит `roles.assign` записан, повторно →
    `"expired"`;
  - `confirm` чужим → `"foreign"`, после этого свой `confirm` → `granted`:
    запрос не сгорел;
  - у выдающего забрали `roles.assign` до подтверждения → `"no_right"`;
  - у цели уже есть роль → `"already"`;
  - `decline` своим → `true`, затем `confirm` → `"expired"`.
- `backend/api/test/admin.test.ts`, HTTP:
  - `POST /admin/roles/grant` с ролью `admin` → `granted: false`, `confirm`
    со ссылкой; роли у цели нет;
  - с ролью `marketer` → `granted: true`, `confirm: null`;
  - при `devLogin` → `admin` выдаётся сразу.
- Новый `backend/api/test/role-confirm-command.test.ts` — по образцу тестов
  `PanelLoginCommand`:
  - `/start role-<id>` в личке → сообщение с двумя кнопками;
  - в группе → отказ без данных;
  - нажатие «Выдать» → `confirm` вызван, текст сообщения заменён;
  - нажатие из чужого чата → `confirm` не вызван.
- `backend/api/test/welcome.test.ts` в зоны не входит. Исключение для
  `/start role-` проверяется в `role-confirm-command.test.ts`:
  `ROLE_CONFIRM_START` совпадает с `/start role-abc` и не совпадает с
  `/start`. Регулярное выражение для этого экспортируется из
  `welcome.command.ts`.
- `apps/admin/test/roles.test.ts`: схема ответа `grantRole` принимает
  `confirm: null` и `confirm` со ссылкой.

## Аналитика

Нет событий продукта: это действие команды, оно пишется в журнал аудита
(`roles.assign`) и в лог `role_grant_confirmed`.

## Настройки и окружение

Нет. Время жизни запроса — `ROLE_CONFIRM_TTL_SEC` в `role-confirmations.ts`.

## Документы

- `docs/29-admin-panel.md` §3.4, пункт «Правило двух ключей», подпункт «выдача
  ролей `owner` и `admin`» — дописать: «— второй ключ: подтверждение в личном
  чате с ботом тем, кто выдаёт (T-0032, решение 06.10.2026); ссылка живёт
  10 минут, снятие ролей подтверждения не требует».
- `docs/21-diagrams.md`, после §4.16 «Вход в панель…» — короткий раздел
  следующим свободным номером «Выдача роли владельца или администратора
  (этап 4)». Sequence:
  - панель → `POST /admin/roles/grant` → ссылка;
  - администратор → бот `/start role-<id>`;
  - бот → `prompt`;
  - «Выдать» → `confirm` → `RolesService.grant` → аудит.

## Критерии приёмки

- [ ] Роли `owner` и `admin` из панели выдаются только после «Выдать» в
  личном чате с ботом того, кто выдаёт.
- [ ] Чужой Telegram запрос не подтвердит и не сожжёт.
- [ ] Через 10 минут запрос истекает.
- [ ] Остальные роли и снятие ролей — сразу, как раньше.
- [ ] На машине разработчика `owner` и `admin` выдаются сразу.
- [ ] `/start role-…` не даёт карточки приветствия.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Роли владельца и админа — с подтверждением`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РОЛИ ВЛАДЕЛЬЦА И АДМИНА С ПОДТВЕРЖДЕНИЕМ**

  Роли «владелец» и «администратор» теперь выдаются только после подтверждения в Telegram тем, кто их выдаёт. Забытая открытой сессия панели больше не может раздать полный доступ.

  🔑 **Как это выглядит**

  • в панели после «Выдать» — кнопка «Открыть бота»; в личном чате бот спрашивает, кому и какую роль выдать
  • подтвердить может только тот, кто открыл запрос; ссылка живёт 10 минут
  • остальные роли и снятие ролей — сразу, как раньше
  ```
