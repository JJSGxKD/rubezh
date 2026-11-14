---
id: T-0457
title: Журнал учёта в базе — план счетов, запись проводок, остатки и журнал для панели
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0456]
zones:
  - backend/api/src/modules/ledger/**
  - backend/api/src/modules/admin/admin-ledger.controller.ts
  - backend/api/prisma/migrations/
  - backend/api/test/ledger-journal.test.ts
  - backend/api/test/ledger-journal.integration.test.ts
  - backend/api/test/admin-ledger.http.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/package.json
  - backend/api/tsconfig.json
  - backend/api/Dockerfile
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - pnpm-lock.yaml
  - backend/api/src/app.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/test/roles.test.ts
  - backend/api/test/route-permissions.test.ts
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
  - docs/37-accounting.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 4
---

# T-0457. Журнал учёта в базе — план счетов, запись проводок, остатки и журнал для панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0457.json)](../README.md#значки-статуса) [![T-0456](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0456.json&label=T-0456)](T-0456-ledger-core-package.md)

## Зачем

Ядро учёта (T-0456) проверяет проводки, но хранить их негде. Задача заводит
журнал в Postgres: счета, проводки и строки, начальный план счетов по
решению владельца, запись проводки одной транзакцией с идемпотентностью по
ключу источника, остатки и журнал для панели. На этом сервисе проводки из
платежей (T-0458) и экран «Бухгалтерия» (T-0459).

## Решения

- `docs/35-stage4-plan.md`, **Р219**; `docs/37-accounting.md` §2–§3, §11.
- **Начальный план счетов** (Р219, места хранения на старте):

  | id | Тип | Валюта | Название |
  |---|---|---|---|
  | `stars.bot.hold` | asset | XTR | Звёзды бота — в холде |
  | `stars.bot.available` | asset | XTR | Звёзды бота — доступно |
  | `wallet.ton` | asset | GRAM | Кошелёк TON |
  | `exchange.usdt` | asset | USDT | Биржа или USDT |
  | `bank.rub` | asset | RUB | Банк, ₽ |
  | `revenue.shop.telegram` | revenue | XTR | Выручка: магазин, Telegram |
  | `revenue.continue.telegram` | revenue | XTR | Выручка: второй шанс, Telegram |
  | `revenue.vip.telegram` | revenue | XTR | Выручка: VIP, Telegram |
  | `revenue.donation.telegram` | revenue | XTR | Донаты, Telegram |

  Статьи расходов, обязательств и капитала — волна 3 (из панели); здесь не
  заводятся.
- Права: **`ledger.view`** — новое, у владельца (через `PERMISSIONS`) и у
  `finance` (`docs/37` §9: «видеть — финансы и владелец»). Операции — волна 3.
- Проводку пишет только сервер (платежи — T-0458); ручного ввода в этой
  задаче нет.
- Идемпотентность — **уникальный `source_key`** в базе: повтор с теми же
  строками — тот же ответ; повтор с другими строками — ошибка
  `ledger_source_conflict` (не тихая перезапись).

## Как сейчас

- Ядро — `@bh/ledger` (T-0456): `findEntryProblems`, `reverse`,
  `periodOf`, `balances`, `toMinor`/`formatMinor`, типы `LedgerAccount`,
  `EntryDraft`.
- Справочник валют — `CURRENCIES` из `@bh/fx` (`packages/fx/src/currencies.ts`):
  бэкенд передаёт ядру учёта `{ code, decimals }` из него.
- Образец модуля с репозиторием, сервисом и контроллером панели —
  `modules/fx` + `admin/admin-fx.controller.ts`; права — `roles/permissions.ts`.
- Подключение пакета монорепо в бэкенд — `"@bh/fx": "workspace:*"` в
  `backend/api/package.json`.

## Шаги по порядку

1. **Зависимость** `"@bh/ledger": "workspace:*"` в `backend/api/package.json`.
2. **Схема и миграция** `<время>_ledger_journal` (только расширение):

   ```prisma
   enum LedgerAccountType { asset revenue expense liability equity }

   model LedgerAccount {
     accountId  String            @id @map("account_id") @db.VarChar(64)
     type       LedgerAccountType
     currency   String            @db.VarChar(16)
     name       String            @db.VarChar(128)
     createdAt  DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
     archivedAt DateTime?         @map("archived_at") @db.Timestamptz(3)
     lines      LedgerLine[]
     @@map("ledger_account")
   }

   model LedgerEntry {
     entryId    String   @id @map("entry_id") @db.Uuid
     /// ключ идемпотентности источника: «purchase:<id>:paid»
     sourceKey  String   @unique @map("source_key") @db.VarChar(128)
     at         DateTime @db.Timestamptz(3)
     /// «YYYY-MM» по UTC — из at
     period     String   @db.Char(7)
     memo       String   @db.VarChar(500)
     /// сторно: entry_id исходной; у исходной — не больше одного сторно
     reversalOf String?  @unique @map("reversal_of") @db.Uuid
     meta       Json?
     /// кто записал; null — сервер (проводки из платежей)
     createdBy  String?  @map("created_by") @db.Uuid
     createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
     lines      LedgerLine[]
     @@index([period])
     @@index([at])
     @@map("ledger_entry")
   }

   model LedgerLine {
     lineId    String @id @map("line_id") @db.Uuid
     entryId   String @map("entry_id") @db.Uuid
     accountId String @map("account_id") @db.VarChar(64)
     /// минимальные единицы валюты счёта, дебет +, кредит −
     amount    BigInt
     entry     LedgerEntry   @relation(fields: [entryId], references: [entryId], onDelete: Restrict)
     account   LedgerAccount @relation(fields: [accountId], references: [accountId], onDelete: Restrict)
     @@unique([entryId, accountId])
     @@index([accountId, entryId])
     @@map("ledger_line")
   }
   ```

   В миграции — `CHECK (amount <> 0)`, связь `reversal_of → ledger_entry`
   и `INSERT` начального плана счетов (таблица «Решений»). Прямых `UPDATE`
   и `DELETE` журнала код не делает: в базе — триггер, который их запрещает
   у `ledger_entry` и `ledger_line` (сообщение «Журнал учёта не правится —
   исправление сторно»).
3. **Репозиторий** `modules/ledger/ledger.repository.ts`: `accounts()`,
   `entryBySource(sourceKey)`, `insertEntry(entry, lines)` — в транзакции,
   `balances()` — `SUM(amount) GROUP BY account_id` одним запросом,
   `journal(filter, cursor, limit)` — проводки новые сверху со строками,
   фильтры: счёт, валюта, период `from`/`to` («YYYY-MM»), ключ источника
   по префиксу; курсор — `(at, entry_id)`.
4. **Сервис** `modules/ledger/ledger.service.ts`:
   - `post(draft, actor?)`: справочник счетов (кэш в памяти процесса на
     минуту — план счетов меняется редко, а повторная проверка в базе всё
     равно ловит неизвестный счёт внешним ключом); `findEntryProblems` —
     есть проблемы → `LedgerEntryInvalidError` (400, `ledger_entry_invalid`,
     в тексте — первая проблема по-русски); `entryBySource` — есть и строки
     совпадают → вернуть её (`created: false`); есть и не совпадают →
     `LedgerSourceConflictError` (409, `ledger_source_conflict`); нет —
     вставка; гонка двух вставок одного ключа — уникальный индекс, повторное
     чтение и то же сравнение;
   - `reverse(sourceKey, newSourceKey, at, memo, actor?)` — через
     `reverse` ядра и `post`;
   - `balances()` → `{ accountId, name, type, currency, balance: string }[]`
     (строка — `formatMinor`), по нормальной стороне;
   - `journal(filter, cursor)` → проводки со строками, суммы строками.
5. **Права**: `ledger.view` в `PERMISSIONS`; добавить в набор `finance`.
6. **Контроллер** `admin/admin-ledger.controller.ts`,
   `@Controller("admin/ledger")`, охранники сессии и прав и `@RequirePermission("ledger.view")` на
   маршрутах (как в `admin-fx.controller.ts`):
   - `GET /balances` → `{ data: { accounts: […] } }`;
   - `GET /journal?account&currency&from&to&source&cursor&limit` (Zod,
     `.strict()`, `limit` 1…100, по умолчанию 50) →
     `{ data: { entries: […], next: string | null } }`.
7. **Документы**: `docs/21-diagrams.md` — ER: `ledger_account`,
   `ledger_entry`, `ledger_line`; `docs/29-admin-panel.md` — право
   `ledger.view`; `docs/37-accounting.md` §3 — план счетов на старте
   (таблица «Решений») и правило «журнал не правится — сторно» со ссылкой на
   триггер.

## Чего не трогаем

- Проводки из платежей и задание холда — T-0458.
- Экран — T-0459.
- Ручные операции, статьи расходов, займы, периоды — волны 3–4.
- Ядро `@bh/ledger` — только использовать; нашлась нехватка — вопрос в PR,
  правка ядра отдельной задачей.

## Сценарий и интерфейс

- `post({ sourceKey: "purchase:42:paid", at, memo: "Набор «Старт»", lines: [hold +50, revenue.shop −50] })`
  → `{ entryId, created: true }`; повтор того же → `created: false`; тот же
  ключ с 60 ⭐ → 409.
- `GET /admin/ledger/balances` у финансов → «Звёзды бота — в холде: 50»,
  «Выручка: магазин, Telegram: 50».

## Тесты

Первым коммитом:

- `backend/api/test/ledger-journal.test.ts` (сервис на подменённом
  репозитории): невалидная проводка — 400 с текстом; повтор — `created: false`;
  конфликт строк — 409; сторно — обратные знаки и `reversalOf`.
- `backend/api/test/ledger-journal.integration.test.ts` (Postgres,
  `test-env.sh`): план счетов после миграции на месте; две параллельные
  вставки одного `source_key` — одна проводка; `UPDATE`/`DELETE` строки
  журнала — ошибка базы; остатки после оплаты и сторно; журнал с фильтром
  по счёту и периоду, курсор без пропусков и повторов на 120 проводках;
  `amount = 0` — ошибка базы; сумма больше `2^53` (нано-Gram) хранится и
  читается без потерь.
- `backend/api/test/admin-ledger.http.test.ts`: без сессии — 401; участник
  проекта и маркетолог — 403; финансы и владелец — 200; `limit=500` — 400.

## Аналитика

Нет событий: учёт — внутренний журнал команды, его след — сами проводки.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md`, `docs/29-admin-panel.md`, `docs/37-accounting.md`
  (шаг 7).

## Критерии приёмки

- [ ] Журнал в базе: проводка пишется одной транзакцией, повтор по ключу
      источника не задваивает, конфликт строк — 409.
- [ ] Журнал нельзя поправить или удалить ни кодом, ни прямым запросом —
      только сторно.
- [ ] Начальный план счетов из «Решений» на месте после миграции.
- [ ] Остатки и журнал отдаются панели под правом `ledger.view`.
- [ ] Миграция только расширяет схему, ER-диаграмма обновлена.
- [ ] Тесты из раздела «Тесты» есть и зелёные; гейт и `pnpm docs:check`
      зелёные.

## PR

- **Заголовок:** `feat(finance): Журнал учёта и план счетов`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЖУРНАЛ УЧЁТА И ПЛАН СЧЕТОВ**

  У бухгалтерии появился журнал в базе (Р219): проводки двойной записью,
  начальный план счетов — звёзды бота в холде и доступно, кошелёк TON, биржа,
  банк и статьи выручки Telegram.

  🛠 **Что внутри**

  • проводка — одной транзакцией, повтор по ключу источника не задваивает
  • журнал не правится и не удаляется даже прямым запросом — исправление сторно
  • остатки и журнал — для финансов и владельца (право ledger.view)
  ```
