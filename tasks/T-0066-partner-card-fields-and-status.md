---
id: T-0066
title: Карточка партнёра — TG id, статус, страна, валюта и способ выплаты, процент
epic: E14
priority: P1
status: done
owner: claude-6 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/partners/**
  - backend/api/src/modules/admin/admin-partners.controller.ts
  - backend/api/src/modules/promo-codes/promo-codes.repository.ts
  - backend/api/test/partners.test.ts
  - backend/api/test/partners.integration.test.ts
  - apps/admin/src/api/partners.ts
  - apps/admin/src/screens/partners/**
  - apps/admin/test/partners.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/21-diagrams.md
  - docs/23-referral-and-partner-program.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
version: v0.9
---

# T-0066. Карточка партнёра — TG id, статус, страна, валюта и способ выплаты, процент

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0066.json)](README.md#значки-статуса)

## Зачем

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р96): с
партнёрами надо работать уже сейчас, до их кабинета. Для этого карточка
партнёра должна хранить всё, о чём договорились.

Сейчас в ней только имя, контакт и заметка.

## Решения

- **Новые поля партнёра:**

  | Поле | Что | Как вводится |
  |---|---|---|
  | TG id | Telegram ID партнёра — для будущего входа в его кабинет | число до 20 цифр, необязательно, уникально среди партнёров |
  | Статус | `applied` заявка · `active` активен · `paused` приостановлен · `rejected` отклонён | выбор; у прежних партнёров — `active` |
  | Страна | где партнёр получает выплаты | ISO-код из двух букв, необязательно |
  | Валюта выплаты | в чём он получает | код валюты из ядра курсов (`USD`, `RUB`, `USDT`, `GRAM`…), необязательно |
  | Способ выплаты | реквизиты словами: «USDT TRC-20 на …», «карта Тинькофф» | до 200 знаков, необязательно |
  | Процент | доля от платежей приведённых игроков | 0–100, два знака после запятой, необязательно |

- **Процент записывается, но не начисляется.** От чего он считается и в
  какой валюте копится — О44, решится в модели бухгалтерии
  (`docs/37-accounting.md`). До тех пор карточка показывает рядом
  «начисления — после модели учёта».
- **Статус решает, привязывает ли партнёр новых игроков.**
  - Новая привязка — только к партнёру `active`. Код партнёра в любом
    другом статусе даёт свою награду, но игрока к партнёру не записывает.
  - Уже привязанные игроки остаются за партнёром при любом статусе: смена
    статуса не отнимает приведённых.
- **Смена статуса** — с причиной, в аудит «было → стало». Заявки (`applied`)
  появятся с формы на лендинге; пока их заводит команда.
- **Смена валюты и страны** — тоже с аудитом: выплаты будут считаться по
  тому, что стояло на дату начисления (О44).

## Как сейчас

- **`backend/api/prisma/schema.prisma`** — `model Partner`: `partnerId`,
  `name`, `contact`, `note`, `createdBy`, `createdAt`, `updatedAt`.
- **`backend/api/src/modules/partners/`:**
  - `partner-rules.ts` — `partnerInputSchema` (`name`, `contact`, `note`),
    `PartnerRow`, `PARTNER_RULES.bindWindowDays`;
  - `partners.service.ts` — `catalog`, `detail`, `create`, `update`,
    `bindingOf`;
  - `partners.repository.ts`.
- **Привязка по коду партнёра** — `promo-codes.repository.ts`: активация
  кода кампании партнёра → `partner_binding` под `lockSourceSlot`
  (`attribution/source-slot.ts`).
- **`admin-partners.controller.ts`** — `partners.view`, `partners.edit`.
- **Панель** `screens/partners/`:
  - `PartnersScreen.tsx` — список;
  - `PartnerCard.tsx`;
  - `PartnerDialog.tsx` — форма.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** — у `Partner`:
   - `telegramId String? @unique @map("telegram_id") @db.VarChar(20)`;
   - `status String @default("active") @db.VarChar(16)` с комментарием о
     четырёх значениях;
   - `country String? @db.VarChar(2)`;
   - `payoutCurrency String? @map("payout_currency") @db.VarChar(8)`;
   - `payoutMethod String? @map("payout_method") @db.VarChar(200)`;
   - `sharePercent Decimal? @map("share_percent") @db.Decimal(5, 2)`;
   - индекс `@@index([status])`.

   Миграция только добавляет: колонки с умолчанием или `NULL`.
3. **`partner-rules.ts`:**
   - `PARTNER_STATUSES = ["applied", "active", "paused", "rejected"] as const`;
   - `partnerInputSchema` += поля из таблицы:
     - `telegramId` — `^[0-9]{1,20}$`;
     - `country` — `^[A-Z]{2}$`;
     - `payoutCurrency` — один из кодов `CURRENCIES` (`@bh/fx`);
     - `sharePercent` — строка `^\d{1,3}(\.\d{1,2})?$`, не больше 100;
     - пустые строки → `null`, как у `contact`;
   - статус меняется отдельно (шаг 5) — в общей форме его нет;
   - `export function bindsNewPlayers(status: PartnerStatus): boolean` —
     только `active`.
4. **`promo-codes.repository.ts`** — привязка по коду партнёра: партнёр не
   `active` → награда кода как есть, привязки нет. Проверка — в той же
   транзакции, где `lockSourceSlot`.
5. **`partners.service.ts`:**
   - `setStatus(actor, partnerId, status, reason)` — `partners.edit`,
     причина 3…200, аудит `partners.status`;
   - `update` — аудит изменённых полей «было → стало»;
   - TG id занят другим партнёром → 409 «Этот TG id уже у партнёра «…»».
6. **`admin-partners.controller.ts`** — `PUT /api/v1/admin/partners/:id/status`;
   в ответах — новые поля.
7. **Панель:**
   - **`PartnerDialog`** — поля из таблицы, группами:
     - «Связь» — контакт, TG id;
     - «Выплаты» — страна, валюта, способ, процент;
     - заметка;

     у процента — подсказка «Начисления — после модели учёта
     (`docs/37-accounting.md`), сейчас только запись договорённости»;
   - **список** — колонка «Статус» значком с тоном:
     - активен — успех;
     - заявка — сведения;
     - приостановлен — предупреждение;
     - отклонён — приглушённый;

     фильтр по статусу, по умолчанию — все, кроме отклонённых;
   - **карточка:**
     - статус с кнопкой «Сменить статус…» — окно с причиной;
     - блок «Выплаты» — страна, валюта, способ, процент;
     - у статуса не `active` — строка «Новые игроки к партнёру не
       привязываются».
8. **Документы** — раздел «Документы».

## Чего не трогаем

- Ссылки партнёра — T-0067.
- Начисления и выплаты — после О44.
- Кабинет партнёра и форму заявки на лендинге.

## Тесты

Первым коммитом.

- **`backend/api/test/partners.test.ts`:**
  - схема:
    - TG id с буквами, страна `ru`, процент `100.01` и `abc`, неизвестная
      валюта — отказ;
    - пустые строки → `null`;
  - `bindsNewPlayers`: только `active` → `true`;
  - `setStatus`:
    - без `partners.edit` — отказ;
    - причина короче 3 — отказ;
    - аудит «было → стало»;
  - TG id у второго партнёра — 409.
- **`backend/api/test/partners.integration.test.ts`** (Postgres):
  - код партнёра `paused` — награда начислена, `partner_binding` нет;
  - `active` — привязка есть;
  - смена статуса на `paused` прежних привязок не трогает.
- **`apps/admin/test/partners.test.ts`** — разбор новых полей; тон статуса.

## Аналитика

Нет новых событий: смена статуса и полей — в аудите.

## Настройки и окружение

Нет.

## Документы

- **`docs/23-referral-and-partner-program.md`:**
  - поля карточки;
  - статусы и правило «привязывает только активный»;
  - процент — запись до модели учёта.
- **`docs/21-diagrams.md`** — ER: новые поля `partner`.

## Критерии приёмки

- [ ] В карточке партнёра — TG id, статус, страна, валюта и способ
  выплаты, процент; всё правится с аудитом.
- [ ] Новые игроки привязываются только к активному партнёру; прежние
  привязки статус не трогает.
- [ ] Список фильтруется по статусу.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(api): Статус и условия партнёра в карточке`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТОЧКА ПАРТНЁРА**

  В карточке партнёра теперь хранится всё, о чём договорились: TG id для будущего кабинета, статус (заявка, активен, приостановлен, отклонён), страна, валюта и способ выплаты, процент. Новых игроков привязывает только активный партнёр. Начисления по проценту — после модели учёта.
  ```
