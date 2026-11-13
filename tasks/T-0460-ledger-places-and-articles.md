---
id: T-0460
title: Места хранения и статьи учёта — сервер
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0457]
zones:
  - backend/api/src/modules/ledger/ledger-chart.ts
  - backend/api/src/modules/ledger/ledger-chart.service.ts
  - backend/api/src/modules/ledger/ledger-chart.repository.ts
  - backend/api/prisma/migrations/
  - backend/api/test/ledger-chart.test.ts
  - backend/api/test/ledger-chart.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/src/modules/ledger/ledger.module.ts
  - backend/api/src/modules/ledger/ledger.service.ts
  - backend/api/src/modules/admin/admin-ledger.controller.ts
  - backend/api/test/admin-ledger.http.test.ts
  - docs/21-diagrams.md
  - docs/37-accounting.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0460. Места хранения и статьи учёта — сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0460.json)](README.md#значки-статуса) [![T-0457](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0457.json&label=T-0457)](T-0457-ledger-journal-backend.md)

## Зачем

Ручные операции волны 3 (Р220) списывают деньги с места хранения на статью
расхода, переводят между местами, принимают поступления. В плане счетов
волны 2 есть только места на старте и статьи выручки Telegram. Задача даёт
серверу места хранения со своим шаблоном комиссии, статьи расходов и
поступлений из панели и счета под них в любой валюте — без правки кода на
каждую новую статью.

## Решения

- `docs/35-stage4-plan.md`, **Р220**; `docs/37-accounting.md` §3, §6, §11.
- **Место хранения** — счёт-актив в одной валюте с необязательным шаблоном
  комиссии: процент (сотые доли процента), фикса и её валюта (может быть
  другой, `docs/37` §6). Звёзды бота — одно место в двух состояниях:
  `stars.bot.hold` и `stars.bot.available` группируются полем `place`.
- **Статья** — расход или поступление, без валюты. Счёт статьи в валюте
  создаётся при первой проводке: `expense.<статья>.<валюта>`,
  `income.<статья>.<валюта>`; так одна статья «Сервер (VPS)» принимает и
  рубли, и доллары.
- **Статьи на старте** (Р220): расходы — `vps` «Сервер (VPS)», `cdn` «CDN
  Bunny», `ai` «ИИ-инструменты», `domains` «Домены», `ads_purchase`
  «Закупка рекламы», служебные `fee_withdrawal` «Комиссия вывода»,
  `fee_exchange` «Комиссия обмена», `fx_difference` «Курсовая разница»,
  `tax` «Налог (уплата)», `other` «Прочее»; поступления — `ads_adsgram`
  «Реклама: AdsGram», `ads_richads` «Реклама: RichAds», `ads_taddy`
  «Реклама: Taddy», `other_income` «Прочие поступления».
- Служебные статьи (`fee_*`, `fx_difference`, `tax`) не архивируются.
- Право — `finance.entry.create` (владелец и финансы).

## Как сейчас

- План счетов волны 2 (T-0457): `ledger_account` (`account_id`, `type`,
  `currency`, `name`, `archived_at`), места на старте: `stars.bot.hold`,
  `stars.bot.available`, `wallet.ton` (GRAM), `exchange.usdt` (USDT),
  `bank.rub` (RUB).
- `LedgerService.post` проверяет счета по справочнику (кэш на минуту).
- Валюты — `CURRENCIES` из `@bh/fx`.

## Шаги по порядку

1. **Схема и миграция** `<время>_ledger_chart` (только расширение):
   - у `ledger_account` — `place varchar(64) null` (группа места:
     `stars.bot`, у остальных мест — свой id), `fee_percent_bp int null`
     (0…10 000), `fee_fixed bigint null`, `fee_fixed_currency varchar(16) null`,
     `article_id varchar(64) null` (у счетов статей);
   - новая таблица `ledger_article`: `article_id varchar(64) pk`,
     `kind` (`expense` | `income`), `name varchar(128)`, `system boolean`,
     `archived_at`, `created_at`;
   - `INSERT` статей на старте; у мест на старте — `place`.
2. **Чистые правила** `ledger-chart.ts`: `slugify(name)` для новых id
   (латиница, точки и дефисы, 3…48 знаков; кириллица — транслитом);
   `articleAccountId(article, kind, currency)`; `feeOf(amount, template, spec)`
   — процент от суммы в минимальных единицах (округление вверх до единицы —
   комиссию не занижаем) и фикса отдельной строкой в её валюте.
3. **Репозиторий и сервис** `ledger-chart.*`:
   - места: `places()` — счета-активы с `place`, остатками и шаблоном;
     `createPlace({ name, currency, fee })`; `updatePlace(id, { name?, fee? })`;
     `archivePlace(id)` — только при нулевом остатке, иначе
     `ledger_place_not_empty` (409);
   - статьи: `articles()`, `createArticle({ name, kind })`,
     `renameArticle`, `archiveArticle` — служебные нельзя
     (`ledger_article_system`, 409);
   - `ensureArticleAccount(article, currency)` — создаёт счёт статьи в
     валюте, если его нет (`INSERT … ON CONFLICT DO NOTHING`), и сбрасывает
     кэш справочника `LedgerService`;
   - аудит: `ledger.place.create|update|archive`, `ledger.article.create|rename|archive`.
4. **Маршруты** в `admin-ledger.controller.ts` (право `finance.entry.create`
   на изменение, `ledger.view` на чтение): `GET /places`, `POST /places`,
   `PATCH /places/:id`, `POST /places/:id/archive`, `GET /articles`,
   `POST /articles`, `PATCH /articles/:id`, `POST /articles/:id/archive`.
   Тела — Zod `.strict()`; валюта — из `CURRENCIES`.
5. **Документы**: `docs/21-diagrams.md` — ER (`ledger_article`, новые поля
   `ledger_account`); `docs/37-accounting.md` §3 — места, статьи и счета
   статей в валюте.

## Чего не трогаем

- Операции, второй ключ, шаблоны расходов — T-0461–T-0463.
- Экраны — T-0465.
- Статьи выручки Telegram и места на старте — только добавить им `place`.

## Сценарий и интерфейс

- Финансы заводят место «Карта Т-Банка», RUB, комиссия 0 → `bank.karta-t-banka`.
- Первый расход «Сервер (VPS)» в долларах создаёт счёт `expense.vps.USD`.

## Тесты

Первым коммитом:

- `backend/api/test/ledger-chart.test.ts`: `slugify` («Карта Т-Банка» →
  «karta-t-banka», пустое и 200 знаков — исключение); `feeOf` — 2 % от
  1 000 000 нано-Gram = 20 000; процент даёт дробь — вверх; фикса в другой
  валюте — отдельная строка; без шаблона — пусто.
- `backend/api/test/ledger-chart.integration.test.ts` (Postgres): статьи на
  старте на месте; новый счёт статьи в валюте создаётся один раз при двух
  параллельных вызовах; архив места с остатком — 409; служебную статью — 409.
- `backend/api/test/admin-ledger.http.test.ts`: маркетолог — 403 на
  `POST /places`; финансы — 200; валюта «ABC» — 400.

## Аналитика

Нет: справочник учёта, след — аудит.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md`, `docs/37-accounting.md` §3 (шаг 5).

## Критерии приёмки

- [ ] Места хранения и статьи заводятся, переименовываются и архивируются
      из API с аудитом; место с остатком и служебные статьи не архивируются.
- [ ] Счёт статьи в нужной валюте появляется сам при первой проводке.
- [ ] Шаблон комиссии места считается процентом, фиксой или обоими.
- [ ] Миграция только расширяет схему; ER обновлена; тесты и гейт зелёные.

## PR

- **Заголовок:** `feat(finance): Места хранения и статьи учёта`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МЕСТА ХРАНЕНИЯ И СТАТЬИ УЧЁТА**

  Учёт умеет заводить места хранения и статьи расходов и поступлений без
  правки кода (Р220): счёт статьи в нужной валюте появляется сам.

  🛠 **Что внутри**

  • статьи на старте: сервер, CDN, ИИ-инструменты, домены, закупка рекламы, комиссии, налог, прочее, реклама по сетям
  • у места хранения — шаблон комиссии: процент, фикса или оба
  • место с остатком и служебные статьи не архивируются
  ```
