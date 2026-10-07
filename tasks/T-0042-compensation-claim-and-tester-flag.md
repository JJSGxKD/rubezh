---
id: T-0042
title: Компенсация после вайпа — выдача по кнопке и признак «Тестер» в ответах
epic: E2
priority: P1
status: ready
owner:
size: M
depends_on: [T-0040]
zones:
  - backend/api/src/modules/wipe/compensation.service.ts
  - backend/api/src/modules/wipe/compensation.repository.ts
  - backend/api/src/modules/wipe/compensation.controller.ts
  - backend/api/src/modules/wipe/wipe.module.ts
  - backend/api/src/app.module.ts
  - backend/api/src/modules/auth/account.repository.ts
  - backend/api/src/modules/auth/auth.controller.ts
  - backend/api/src/modules/runs/runs.repository.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/friends/friends.repository.ts
  - backend/api/test/compensation.test.ts
  - backend/api/test/compensation.integration.test.ts
  - backend/api/test/helpers/memory-auth.ts
  - backend/api/test/admin.integration.test.ts
  - backend/api/test/player-list.test.ts
  - backend/api/test/friends.integration.test.ts
  - backend/api/test/runs.integration.test.ts
  - backend/api/test/auth.test.ts
shared:
  - backend/api/src/modules/wallet/wallet-types.ts
  - packages/app-shell/src/i18n/ru-history.json
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
---

# T-0042. Компенсация после вайпа — выдача по кнопке и признак «Тестер» в ответах

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0042.json)](README.md#значки-статуса) [![T-0040](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0040.json&label=T-0040)](T-0040-tester-compensation-snapshot.md)

## Зачем

После вайпа у тестера есть строка компенсации и знак (T-0040), но получить
компенсацию нельзя, а знака никто не видит. Задача добавляет:

- запрос «что мне положено» и выдачу по кнопке;
- признак «Тестер» в профиле, у друзей и в рейтинге.

Окно «Спасибо за тест» и сам знак на экранах рисует T-0043.

## Решения

Р87, решение пользователя от 07.10.2026:

- **Выдача — окном «Спасибо за тест», по кнопке «Забрать», один раз.**
- **Знак виден в профиле, у друзей и в рейтинге.**

Решения тимлидов:

- **Купленное возвращается тем же ключом, что при покупке:**
  `purchase:<purchaseId>:<resource>`, причина `purchase`. После вайпа этих
  строк в журнале нет, ключ свободен. Если потом за эту покупку вернут звёзды,
  отзыв остатка (T-0023) найдёт начисление по тому же ключу и заберёт его
  как обычно.
- **Бонус — новая причина `wipe_compensation`**, ключ `wipe:<accountId>:bonus`.
  Причина — в `EXCHANGE_REASONS`: ценность уже была у игрока до вайпа, и
  суточный потолок начислений её не касается.
- **Выдача идемпотентна.** Сначала начисления, потом отметка «забрано». Сбой
  между ними безопасен: повтор найдёт строки по ключам и не начислит дважды.
  Повтор после отметки отвечает тем же результатом, а не ошибкой.
- **Признак — только у тестера:** в ответах поле `tester: true`, у остальных
  поля нет вовсе. Так меньше данных в каждой строке рейтинга, а тесты со
  строгими сравнениями остаются прежними.

## Как сейчас

- **Строка компенсации — модель `TesterCompensation` (T-0040):**
  - поля `tester`, `level`, `bonusGems`, `grants` (JSON), `claimedAt`;
  - разбор `grants` — `compensationGrantsSchema` из
    `modules/wipe/compensation-rules.ts`.
- **Знак — `Account.testerAt` (T-0040).**
- **Кошелёк — `wallet.service.ts`:**
  - `grant({ accountId, resource, amount, reason, source, idempotencyKey })`
    (строка 104) → `{ credited, balance, duplicate }`;
  - `balances(accountId)`;
  - причины — `wallet-types.ts`: `EXCHANGE_REASONS = ["purchase", "salvage", "boost_refund"]`.
- **Образец маршрута игрока — `test-notice/test-notice.controller.ts`:**
  `@Controller("me/test-notice")`, `@UseGuards(AuthGuard)`, `accountOf(request)`.
- **Профиль:**
  - `auth/auth.controller.ts:26-33` — `AccountView` (`accountId`,
    `displayName`, `photoUrl`, `createdAt`, `created`);
  - собирает его `view(result)` (строка 136);
  - аккаунт — `Account` из `auth/account.repository.ts`.
- **Рейтинг:**
  - `runs/runs.repository.ts:84-90` — `BestRunRow`;
  - выборки `bestRuns`, `bestRunOf` (строки ~340–395) берут
    `account: { select: { displayName, photoUrl } }`;
  - строки доски собирает `runs-view.service.ts:126-141` и `fromShadow`
    (строка ~162).
- **Друзья — `friends/friends.repository.ts`:**
  - `PEER = { accountId, displayName, photoUrl }` (строка 88);
  - строки собираются разворотом `...row.b`, `...row.from` (строки 121, 135,
    145). Новое поле `testerAt` в `PEER` утекло бы в ответ датой.
- **Кто собирает `Account` руками:**
  - Prisma-реализация в `account.repository.ts`;
  - `test/helpers/memory-auth.ts`;
  - `test/admin.integration.test.ts`;
  - `test/player-list.test.ts`.
- **История имущества:**
  - причина без своей категории попадает в «валюту»
    (`history/history-types.ts`, `walletCategory`);
  - подписи — `packages/app-shell/src/i18n/ru-history.json`, ключи
    `history.reason.<причина>`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`wallet-types.ts`** — в `EXCHANGE_REASONS` добавить `"wipe_compensation"`.
   В комментарии над списком: «…и компенсация после вайпа (Р87): ценность
   была у игрока до него».
3. **`ru-history.json`** — `"history.reason.wipe_compensation": "Спасибо за тест"`.
4. **`modules/wipe/compensation.repository.ts`** — по образцу соседних
   репозиториев, токен `COMPENSATION_REPOSITORY`:

   ```ts
   export interface CompensationRow { accountId: string; tester: boolean; level: number; bonusGems: number; grants: unknown; claimedAt: Date | null }
   export interface CompensationRepository {
     find(accountId: string): Promise<CompensationRow | null>;
     /** `false` — уже отмечено раньше */
     markClaimed(accountId: string, at: Date): Promise<boolean>; // updateMany where claimedAt null
   }
   ```
5. **`modules/wipe/compensation.service.ts`:**

   ```ts
   export interface CompensationView {
     tester: boolean;
     level: number;
     bonusGems: number;
     /** что вернулось из купленного — суммой по ресурсу, в порядке WALLET_RESOURCES */
     restored: { resource: WalletResource; amount: number }[];
   }

   export interface ClaimResult {
     view: CompensationView;
     /** `true` — уже забирал раньше: ничего не начислено */
     alreadyClaimed: boolean;
     balances: Balances;
   }

   pending(accountId: string): Promise<CompensationView | null>; // нет строки или забрано — null
   claim(accountId: string, now = new Date()): Promise<ClaimResult>;
   ```

   **`claim`:**
   1. строки нет → `CompensationNotFoundError` — новый `DomainError`
      (`compensation_not_found`, «Компенсации нет», 404) в том же файле;
   2. `grants` разобрать `compensationGrantsSchema`. Не разобралось →
      `Error` с `accountId`: строку писал наш снимок, это ошибка в коде;
   3. уже забрано (`claimedAt !== null`) → ответ с `alreadyClaimed: true`
      без начислений;
   4. для каждой выдачи —
      `wallet.grant({ accountId, resource, amount, reason: "purchase", source: "wipe:restore", idempotencyKey: \`purchase:${purchaseId}:${resource}\` })`;
   5. `bonusGems > 0` —
      `wallet.grant({ resource: "gems", amount: bonusGems, reason: "wipe_compensation", source: "wipe:tester_bonus", idempotencyKey: \`wipe:${accountId}:bonus\` })`;
   6. `markClaimed(accountId, now)`;
   7. `balances = wallet.balances(accountId)`;
   8. лог `log` `compensation_claimed` с полями `accountId`, `tester`,
      `bonusGems`, `restoredGems` (сумма `gems` из `restored`).

   Комментарий метода — почему начисления до отметки и почему ключ покупки
   прежний (раздел «Решения»).
6. **`modules/wipe/compensation.controller.ts`:**

   ```ts
   @Controller("me/compensation")
   @UseGuards(AuthGuard)
   export class CompensationController {
     @Get() pending(...): Promise<{ data: CompensationView | null }>;
     @Post("claim") claim(...): Promise<{ data: ClaimResult }>;
   }
   ```

   - Лимит на `claim` — `RateLimiter`, область `me:compensation`, 10 в
     минуту на аккаунт. Текст при превышении — «Слишком часто — попробуйте
     через минуту».
   - Тела у `claim` нет.
7. **`modules/wipe/wipe.module.ts`:**
   - контроллер, сервис и `{ provide: COMPENSATION_REPOSITORY, useClass: PrismaCompensationRepository }`;
   - импорт `WalletModule` и того модуля, что даёт `AuthGuard` и
     `RateLimiter`, — как у `test-notice.module.ts`;
   - модуль — в `APP_MODULES` в `app.module.ts`, одной строкой.
8. **Признак «Тестер» в ответах.**
   - **`account.repository.ts`:**
     - в `Account` — `testerAt: Date | null` с комментарием;
     - Prisma-реализация отдаёт его во всех методах, которые возвращают
       `Account`.

     Подмены и тесты, которые собирают `Account` руками, получают
     `testerAt: null`: `memory-auth.ts`, `admin.integration.test.ts`,
     `player-list.test.ts`.
   - **`auth.controller.ts`:**
     - в `AccountView`:

       ```ts
       /** знак «Тестер» (Р87); поля нет — не тестер */
       tester?: true;
       ```
     - в `view(...)` — `...(account.testerAt === null ? {} : { tester: true })`;
     - тип параметра `view` — `testerAt` у `account`.
   - **`runs.repository.ts`:**
     - в `BestRunRow` — `tester?: true`;
     - в выборках `bestRuns` и `bestRunOf` — `account: { select: { displayName: true, photoUrl: true, testerAt: true } }`;
     - в строку — `...(row.account.testerAt === null ? {} : { tester: true })`;
     - сам `testerAt` наружу не отдавать.
   - **`runs-view.service.ts`** — в строку доски и в `own` (тень):
     `...(row.tester ? { tester: true } : {})`. Тип строки доски, если он
     объявлен в файле, — `tester?: true`.
   - **`friends.repository.ts`:**
     - в `FriendPeer` — `tester?: true`;
     - `PEER` += `testerAt: true`;
     - новая функция:

       ```ts
       /** Строка другого игрока: имя, аватар и знак — без даты знака. */
       function peerOf(row: { accountId: string; displayName: string; photoUrl: string | null; testerAt: Date | null }): FriendPeer;
       ```

       Три места с разворотом (`friends`, `incoming`, `outgoing`) собирают
       строку через неё;
     - подмена `test/helpers/memory-friends.ts` не меняется: поле
       необязательное.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Окно и знак на экранах клиента, событие аналитики — T-0043.
- Снимок и вайп — T-0040, T-0041.
- `memory-friends.ts` и тесты, где тестеров нет: признак необязательный.

## Тесты

Первым коммитом.

1. **`backend/api/test/compensation.test.ts`** — юнит, подмены репозитория и
   кошелька:
   - `pending`:
     - нет строки → `null`; забрано → `null`;
     - есть → `restored` суммой по ресурсу: две покупки по 150 и 60
       самоцветов → `[{ resource: "gems", amount: 210 }]`;
   - `claim` у тестера с бонусом 60 и двумя выдачами:
     - три вызова `grant` с ключами `purchase:<p1>:gems`, `purchase:<p2>:gems`
       и `wipe:<accountId>:bonus`;
     - причины `purchase`, `purchase`, `wipe_compensation`;
     - потом `markClaimed`, `alreadyClaimed: false`;
   - не тестер с выдачей → бонус не начисляется (`bonusGems: 0`);
   - повторный `claim` после отметки → `alreadyClaimed: true`, `grant` не
     вызывался;
   - `grant` бросил на второй выдаче → `claim` бросает, `markClaimed` не
     вызван. Повтор после этого начисляет всё, кошелёк отсекает уже
     начисленное по ключу;
   - нет строки → `CompensationNotFoundError`;
   - испорченный `grants` → ошибка, `grant` не вызывался.
2. **`backend/api/test/compensation.integration.test.ts`** — живой Postgres,
   настоящий кошелёк:
   - строка компенсации заведена напрямую (`tx.testerCompensation.create`);
   - `claim` → баланс самоцветов = выдачи + бонус, в журнале строки с
     ключом покупки и бонуса;
   - второй `claim` баланс не меняет.
3. **Признак:**
   - `runs.integration.test.ts` — `bestRuns` у аккаунта с `testerAt` даёт
     `tester: true`, у остальных поля нет;
   - `friends.integration.test.ts` — в списке друзей и заявках у тестера
     `tester: true`, поля `testerAt` в строке нет;
   - `auth.test.ts` — вид сессии тестера с `tester: true`, обычного — без
     поля.
4. Существующие тесты, где тестеров нет, проходят без правок, кроме трёх
   файлов, которые собирают `Account` руками (шаг 8).

## Аналитика

Событие продукта шлёт клиент после «Забрать» — `compensation_claimed`, его
добавляет T-0043. Сервер пишет лог `compensation_claimed`. Выдача видна в
журнале кошелька по причинам `purchase` и `wipe_compensation`.

## Настройки и окружение

Нет.

## Документы

- `docs/30-configuration-map.md` — строка «Бонус тестеру после вайпа: самоцветы
  за уровень и потолок» → `backend/api/src/modules/wipe/compensation-rules.ts`,
  `TESTER_BONUS`; владелец — участник 1.
- `docs/35-stage4-plan.md`, WP33 — «Как сделано, часть 4 — выдача компенсации»:
  - маршруты;
  - ключи;
  - идемпотентность;
  - признак `tester` в профиле, у друзей и в рейтинге.

## Критерии приёмки

- [ ] `GET /api/v1/me/compensation` отдаёт положенное, пока не забрано, иначе
  `null`.
- [ ] `POST /api/v1/me/compensation/claim` начисляет купленное ключами покупок
  и бонус один раз. Повтор ничего не начисляет и отвечает тем же.
- [ ] У тестера `tester: true` в сессии, в строках рейтинга и у друзей. У
  остальных поля нет, даты знака наружу нет.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Компенсация после вайпа и знак тестера`
- **Метка:** `release: minor`
- **Для игроков:** нет — до игрока дойдёт с окном T-0043. Раздела
  `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КОМПЕНСАЦИЯ ПОСЛЕ ВАЙПА НА СЕРВЕРЕ**

  Сервер умеет выдать тестеру компенсацию после вайпа и показать его знак другим. Окно в игре придёт следующей задачей.

  🎁 **Как устроено**

  • купленное возвращается тем же ключом, что при покупке: возврат звёзд потом заберёт остаток как обычно
  • бонус — по уровню, один раз; повторное нажатие ничего не начислит
  • знак «Тестер» приходит в профиле, у друзей и в рейтинге — только у тестеров
  ```
