---
id: T-0324
title: Второй шанс за самоцветы — сервер: цена от начатых минут по курсу звёзд, списание и выдача одной транзакцией, книга продолжений; реклама — одно продолжение в сутки
epic: E1
priority: P1
status: done
owner: claude-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/runs/run-gem-continue.service.ts
  - backend/api/src/modules/runs/run-gem-continue.controller.ts
  - backend/api/src/modules/runs/run-gem-continues.repository.ts
  - backend/api/test/run-gem-continue.test.ts
  - backend/api/test/run-gem-continue.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/runs/runs.module.ts
  - backend/api/src/modules/runs/runs-limits.ts
  - backend/api/src/modules/runs/run-continue-errors.ts
  - backend/api/src/modules/runs/run-ad-continue.service.ts
  - backend/api/src/modules/runs/run-ad-continues.repository.ts
  - backend/api/test/run-ad-continue.test.ts
  - backend/api/test/run-ad-continue.integration.test.ts
  - backend/api/src/modules/payments/continue-price.ts
  - backend/api/src/modules/wipe/compensation-rules.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/07-monetization-and-ads.md
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/37-accounting.md
  - backend/api/src/modules/payments/purchases.repository.ts
  - packages/app-shell/src/i18n/ru-history.json
  - docs/35-stage4-plan.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0324. Второй шанс за самоцветы — сервер: цена от начатых минут по курсу звёзд, списание и выдача одной транзакцией, книга продолжений; реклама — одно продолжение в сутки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0324.json)](../README.md#значки-статуса)

## Зачем

Второй шанс сейчас — за ролик (до пяти в сутки) или за звёзды. Самоцветы на
него не тратятся, хотя компенсация после вайпа их обещает (Р87, О43), а в
MAX и VK звёзд нет вовсе. После задачи:
- за рекламу — одно продолжение в игровые сутки;
- дальше — самоцветы или звёзды на выбор;
- цена в самоцветах видна до нажатия и считается так же, как в звёздах.

Кнопку на экране смерти делает T-0325.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- Р162 (25.10.2026, меняет Р4, закрывает О43):
  - за рекламу — одно продолжение в игровые сутки, дальше — самоцветы или
    звёзды на выбор;
  - цена в самоцветах — цена в звёздах от начатых минут по курсу 60
    самоцветов за 50 ⭐ (`CONTINUE_RATE`), видна заранее;
- Р4 — первое продолжение у VIP без ролика; один номер продолжения двумя
  способами не берётся;
- Р5.1, Р5.2 (`docs/34`) — цена от начатых минут, сверка итога с оплатой.

Решения `claude-lead-1` от 25.10.2026:

- **Цена** — `continueGems(elapsedSec, rules)` в `payments/continue-price.ts`:
  `ceil(continuePrice(elapsedSec, rules) × 6 / 5)`. Те же `starsPerMinute` и
  `maxStars` из конфигурации, что у звёзд: потолок звёзд даёт потолок
  самоцветов.
  - `CONTINUE_RATE` и перевод звёзд в самоцветы переезжают из
    `wipe/compensation-rules.ts` в `continue-price.ts`: это теперь правило
    товара, а не компенсации. Компенсация импортирует их оттуда, числа те же.
- **Какие продолжения** — любое, которое ещё не взято другим способом
  (`RunContinues.taken`), в пределах `CONTINUES_PER_RUN`. Площадка не важна:
  самоцветы есть везде, в отличие от звёзд.
- **Реклама — одно в сутки:**
  - `AD_CONTINUES_PER_DAY` становится ключом панели `continue.ad-per-day`,
    умолчание **1** (было 5);
  - VIP с пропуском — своим ключом `continue.vip-per-day`, умолчание **5**:
    VIP платит за «без ролика», урезать ему прежнее незачем;
  - `todayCount` делит строки: с сетью показа — реклама, с именем пропуска
    VIP (`network_key` из `AdPasses`) — VIP.
- **Ответ для экрана смерти** — `GET /api/v1/runs/:runId/continues/gems?elapsedSec=<n>`:
  - `{ status: "available", continueNo, priceGems, balance }`;
  - или `{ status: "unavailable", reason }`: `unverified`, `finished`,
    `used_up` — как у рекламы.

  Не хватает самоцветов — всё равно `available`: кнопка покажет цену и
  нехватку, решать игроку.
- **Покупка** — `POST /api/v1/runs/:runId/continues/gems { continueNo, elapsedSec }`:
  - проверки — как у звёзд (`payments.service.ts:224`): свой забег, старт
    виден серверу, не закончен, `elapsedSec` не больше часов сервера с
    допуском, предыдущее продолжение взято;
  - **одной транзакцией** — строка `run_gem_continue` и списание
    `priceGems` причиной `continue`, ключ `continue:<runId>:<continueNo>`
    (образец — покупка бустов, `boosts.repository.ts`, `activate`);
  - повтор с тем же номером — тот же ответ, без второго списания;
  - номер взят рекламой или звёздами — 409 `continue_taken`;
  - мало самоцветов — 409 `insufficient_funds` с нехваткой (как у бустов).
- **Книга продолжений** — `RunGemContinueService` реализует `ContinueLedger`
  и регистрируется в `RunContinues`, как рекламная и звёздная книги:
  - `check` — `paid` по числу строк, `underpaid` — если секунда продолжения
    в итоге даёт цену выше уплаченной (как `continue-ledger.ts`);
  - вердикт (`unpaid_continue`, `underpaid_continue`) не меняется: он уже
    суммирует книги.
- **Таблица** `run_gem_continue (run_id, continue_no, account_id,
  elapsed_sec, price_gems, granted_at)`, ключ `(run_id, continue_no)`,
  каскад с забегом и аккаунтом — по образцу `RunAdContinue`.
  - ER — `docs/21`.
  - Вайп — забеги стираются, строки уходят каскадом; строка в
    `wipe-plan.ts`.
- **Кошелёк** — причина `continue` в `SPEND_REASONS`; трата, а не
  начисление, потолка не нужно. `docs/37` — строка причины.
- **Лимит запросов** — `runs:continue-gems`, как у рекламного продолжения
  (`runs-limits.ts`).

## Как сейчас

- **Цена в звёздах** — `continuePrice`, `startedMinutes`
  (`payments/continue-price.ts`); проверки предложения — `payments.service.ts:224`.
- **Курс** — `CONTINUE_RATE = { gems: 6, stars: 5 }`,
  `wipe/compensation-rules.ts:27`.
- **Рекламное продолжение** — `run-ad-continue.service.ts`: `AD_CONTINUES_PER_DAY = 5`
  (стр. 27), `view`, `claim`, книга `check`/`granted`; таблица
  `run_ad_continue`, `todayCount` — `run-ad-continues.repository.ts:72`.
- **Сверка итога** — `run-continues.ts` (`ContinueLedger`, `RunContinues.taken`).
- **Продолжений в забеге** — `CONTINUES_PER_RUN = 1` (`runs/run-rules.ts:25`).
- **Списание с проверкой баланса** — `boosts.repository.ts` (`activate`),
  ошибка — `InsufficientBalance` → `InsufficientFundsError`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`continue-price.ts`** — `CONTINUE_RATE`, `continueGems`; компенсация
   импортирует их.
3. **Миграция** — `run_gem_continue`; ER; `wipe-plan.ts`.
4. **Репозиторий и сервис** — `view`, `buy`, книга.
5. **Контроллер** — `GET` и `POST /runs/:runId/continues/gems`, Zod на
   входе, лимит.
6. **Реклама** — ключи `continue.ad-per-day` и `continue.vip-per-day`,
   раздельный `todayCount`.
7. **Кошелёк** — причина `continue`.
8. **Документы:**
   - `docs/07` §8 — третий способ и «одно рекламное в сутки»;
   - `docs/30` — два ключа;
   - `docs/37` — причина `continue`;
   - `docs/21` — ER.

## Чего не трогаем

- Кнопку и экран смерти — T-0325.
- Покупку за звёзды — она остаётся как есть.
- Число продолжений в забеге (`CONTINUES_PER_RUN`).

## Тесты

Первым коммитом.

- `run-gem-continue.test.ts` (чистые):
  - `continueGems`: 1 минута при 1 ⭐ за минуту → 2 самоцвета; 10 ⭐ → 12;
    потолок звёзд → потолок самоцветов;
  - компенсация после вайпа считает то же, что до переезда курса.
- `run-gem-continue.integration.test.ts` (живые Postgres и Redis):
  - `GET` — цена и баланс; чужой забег — `unverified`;
  - покупка → самоцветы списаны, строка есть, `continues.taken` знает номер;
  - повтор `POST` — без второго списания;
  - номер уже взят рекламой → 409 `continue_taken`, баланс не тронут;
  - мало самоцветов → 409 `insufficient_funds`, строки нет;
  - `elapsedSec` больше часов сервера → отказ;
  - два `POST` разом — одно списание;
  - итог забега с продолжением за самоцветы — вердикт без
    `unpaid_continue`; секунда в итоге на минуту позже оплаченной —
    `underpaid_continue`.
- `run-ad-continue.integration.test.ts`:
  - второе рекламное продолжение за сутки → `daily_cap`;
  - VIP — пять за сутки;
  - ключ `continue.ad-per-day` = 3 → три.

## Аналитика

Сервер пишет лог `run_gem_continued` (модуль, аккаунт, забег, цена) — как
`run_ad_continued`. `continue_used` с `source: "gems"` шлёт клиент (T-0325).

## Настройки и окружение

Ключи `continue.ad-per-day` (1) и `continue.vip-per-day` (5).

## Документы

По шагу 8.

## Критерии приёмки

- [x] Второй шанс за самоцветы: цена от начатых минут по курсу звёзд, списание и выдача — один раз.
- [x] Итог забега с продолжением за самоцветы сверяется, как со звёздами.
- [x] За рекламу — одно продолжение в сутки, VIP — пять; оба числа — в панели.
- [x] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Второй шанс за самоцветы`
- **Метка:** `release: minor`
- **Для игроков:** пусто — кнопка появится с T-0325.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВТОРОЙ ШАНС ЗА САМОЦВЕТЫ, СЕРВЕР**

  Второй шанс теперь можно купить за самоцветы: цена считается от начатых минут, как у звёзд, по курсу 60 самоцветов за 50 ⭐. За рекламу — одно продолжение в сутки (было пять), у VIP — пять; оба числа в панели. Самоцветы работают на любой площадке.

  🛠 **Настройки**

  • continue.ad-per-day — рекламных продолжений в сутки, по умолчанию 1
  • continue.vip-per-day — продолжений VIP без ролика в сутки, по умолчанию 5
  ```
