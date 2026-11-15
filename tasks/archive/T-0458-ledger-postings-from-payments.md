---
id: T-0458
title: Проводки из платежей — оплата, выход из холда, возврат; досоздание за прошлое
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0457, T-0453]
zones:
  - backend/api/src/modules/ledger/payment-postings.ts
  - backend/api/src/modules/ledger/payment-postings.repository.ts
  - backend/api/src/modules/ledger/ledger-sync.job.ts
  - backend/api/test/payment-postings.test.ts
  - backend/api/test/payment-postings.integration.test.ts
shared:
  - backend/api/src/modules/ledger/ledger.module.ts
  - backend/api/src/infra/queues.ts
  - docs/37-accounting.md
  - docs/22-analytics-and-metrics.md
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - backend/api/test/ledger-journal.integration.test.ts
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 4
---

# T-0458. Проводки из платежей — оплата, выход из холда, возврат; досоздание за прошлое

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0458.json)](../README.md#значки-статуса) [![T-0457](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0457.json&label=T-0457)](T-0457-ledger-journal-backend.md) [![T-0453](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0453.json&label=T-0453)](T-0453-my-project-revenue-server.md)

## Зачем

Журнал учёта есть (T-0457), но пуст. Задача проводит в нём каждую живую
оплату звёздами, её выход из холда и возврат — автоматически и без единой
ручной цифры (`docs/37-accounting.md` §4, §8). После неё остатки «Звёзды
бота — в холде / доступно» и выручка по статьям — правда, включая всё, что
оплачено до выката.

## Решения

- `docs/35-stage4-plan.md`, **Р219**; `docs/37-accounting.md` §4, §5, §8.
- **Не хуки, а сверка таблицы с журналом.** `PaymentsHooks.onPaid` —
  слушатель в памяти процесса: упал — проводка потеряна навсегда. Задание
  `ledger-sync` по расписанию находит в `purchase` то, чего ещё нет в
  журнале, и досоздаёт; идемпотентность — ключ источника проводки (T-0457).
  Так же переживаются перезапуск, сбой базы и выкат посреди оплаты.
- **Только живые оплаты** (`mode = 'live'`); тестовые в учёт не идут.
- **Срок холда фиксируется в проводке оплаты** (`meta.releaseAt`) по
  настройке `payments.hold-days.telegram` на момент проводки (T-0453):
  `docs/37` §5 — «у прошлых срок уже записан в проводке». Для досоздания за
  прошлое срок берётся тот же, что сейчас.
- **Порядок холда и возврата решают даты, а не то, когда сработало
  задание**: `refunded_at < releaseAt` — возврат из холда, выхода из холда
  нет никогда; `refunded_at ≥ releaseAt` — сначала выход, потом возврат из
  доступного.
- Статья выручки — по виду покупки: `shop_item` → `revenue.shop.telegram`,
  `continue_run` → `revenue.continue.telegram`, `vip` →
  `revenue.vip.telegram`, `donation` → `revenue.donation.telegram`
  (`docs/37` §3, донат — своя статья). Площадка пока одна — Telegram;
  оплата с другой площадки — проводка не создаётся, предупреждение в лог
  (`ledger_unsupported_platform`), до появления её статей.

## Как сейчас

- `model Purchase` (`schema.prisma`): `purchase_id`, `charged_stars`, `mode`,
  `paid_at`, `refunded_at`, `product`, `account_id`; индекс
  `@@index([mode, paidAt])`.
- `LedgerService.post`/`reverse` (T-0457) — запись с идемпотентностью по
  `source_key`.
- Настройка холда — `SETTINGS.paymentsHoldDaysTelegram` (T-0453), чтение —
  `settings.get(...)`.
- Образец задания по расписанию — `bot-mention/bot-mention.job.ts`:
  `queue.upsertJobScheduler(SCHEDULER_ID, { every: … }, { name, opts })`;
  BullMQ держит одно задание расписания на очередь — двух проходов
  одновременно не будет.

## Шаги по порядку

1. **Чистые правила** `modules/ledger/payment-postings.ts`:
   - вход — покупка `{ purchaseId, product, chargedStars, paidAt, refundedAt, platform }`,
     `holdDays`, `now`, что уже проведено (`{ paid?: { releaseAt }, release: boolean, refund: boolean }`);
   - выход — список `EntryDraft` (ядро `@bh/ledger`), которые нужно
     провести **сейчас**, в правильном порядке:
     - **оплата** `purchase:<id>:paid`, `at = paidAt`:
       `stars.bot.hold +N`, `revenue.<статья>.telegram −N`,
       `meta: { purchaseId, product, releaseAt }`;
     - **выход из холда** `purchase:<id>:release`, `at = releaseAt`, только
       если `releaseAt ≤ now` и (`refundedAt` нет или `refundedAt ≥ releaseAt`):
       `stars.bot.hold −N`, `stars.bot.available +N`;
     - **возврат** `purchase:<id>:refund`, `at = refundedAt`:
       до выхода — сторно оплаты (`reversalOf` = оплата: `hold −N`,
       `revenue +N`); после — `stars.bot.available −N`,
       `revenue.<статья>.telegram +N`;
   - `releaseAt` берётся из уже проведённой оплаты, если она есть, иначе
     `paidAt + holdDays`.
2. **Репозиторий** `payment-postings.repository.ts` — три выборки по `LIMIT`
   (500) с антисоединением по `ledger_entry.source_key`:
   - живые оплаты без проводки оплаты;
   - проведённые оплаты без выхода из холда, у которых `meta.releaseAt ≤ now`;
   - возвращённые без проводки возврата.
   Каждая — одним запросом, без запросов в цикле.
3. **Задание** `ledger-sync.job.ts`: очередь `ledger`, расписание каждые
   10 минут; проход — три выборки, правила шага 1, `LedgerService.post` по
   одной проводке (каждая — своя транзакция). Ошибка одной покупки не
   останавливает проход: предупреждение в лог (`purchaseId`, причина) и
   метрика. Если выборка вернула ровно `LIMIT` — следующий проход сразу
   (догоняем прошлое), а не через 10 минут.
4. **Метрики** (Prometheus, низкая кардинальность): `ledger_postings_total{kind="paid|release|refund",result="created|exists|failed"}`
   и `ledger_sync_duration_seconds`. Строки — в `docs/22-analytics-and-metrics.md`
   раздел метрик.
5. **Досоздание за прошлое** — это первый проход того же задания после
   выката: отдельного скрипта нет. Числа проверки — в описании PR: сколько
   оплат, выходов и возвратов проведено на копии базы, и что остаток
   «доступно» минус «в холде» сходится с суммой оплат без возвратов.
6. **Документы**: `docs/37-accounting.md` §8 — строка «Платежи и возвраты
   в игре» и «Ежедневное задание»: как устроено (сверка таблицы с журналом
   раз в 10 минут, ключи источника, порядок холда и возврата по датам).

## Чего не трогаем

- Модуль платежей и его хуки — только читаем `purchase`.
- Выписка Telegram, выводы, отчисления программе — волна 5.
- Ручные операции и экран — волна 3 и T-0459.

## Сценарий и интерфейс

- Оплата набора за 50 ⭐ 1 ноября: проход в 00:10 проводит
  `hold +50 / revenue.shop −50`, `releaseAt` = 22 ноября. 22 ноября —
  `hold −50 / available +50`.
- Возврат 5 ноября: сторно оплаты, выхода из холда не будет.
- Возврат 25 ноября: выход 22-го уже проведён (или проводится этим же
  проходом первым), затем `available −50 / revenue.shop +50`.

## Тесты

Первым коммитом:

- `backend/api/test/payment-postings.test.ts` (правила шага 1):
  - оплата без проводок — только «оплата», `releaseAt` по `holdDays`;
  - оплата, срок прошёл — «выход»; не прошёл — ничего;
  - возврат до срока — сторно оплаты, «выхода» нет ни сейчас, ни после
    срока;
  - возврат после срока, «выход» не проведён — в выдаче «выход», затем
    «возврат из доступного», в этом порядке;
  - `releaseAt` из проведённой оплаты важнее нынешнего `holdDays`
    (настройку поменяли — старые оплаты не сдвигаются);
  - донат — статья `revenue.donation.telegram`; тестовая оплата — ничего;
    не Telegram — ничего и признак предупреждения;
  - все проводки проходят `findEntryProblems` без проблем.
- `backend/api/test/payment-postings.integration.test.ts` (Postgres,
  `test-env.sh`): 3 оплаты (одна возвращена до срока, одна после), проход
  задания — остатки `hold`, `available` и выручка по статьям точны; второй
  проход ничего не создаёт; два прохода одновременно — проводок не больше,
  чем нужно; 1 200 оплат — догоняются за несколько проходов подряд без
  пропусков.

## Аналитика

Продуктовых событий нет: это бухгалтерия, не игрок. Метрики — шаг 4.

## Настройки и окружение

Нет новых: срок холда — ключ из T-0453.

## Документы

- `docs/37-accounting.md` §8, `docs/22-analytics-and-metrics.md` (метрики).

## Критерии приёмки

- [ ] Каждая живая оплата, её выход из холда и возврат проводятся ровно
      один раз, в том числе после перезапуска и при двух проходах сразу.
- [ ] Порядок холда и возврата определяется датами; возврат до срока не
      даёт выхода из холда.
- [ ] Прошлые оплаты проводятся первым проходом после выката; сверка
      остатков приложена к PR.
- [ ] Тесты из раздела «Тесты» есть и зелёные; гейт и `pnpm docs:check`
      зелёные.

## PR

- **Заголовок:** `feat(finance): Проводки из платежей и выход из холда`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОВОДКИ ИЗ ПЛАТЕЖЕЙ**

  Учёт сам проводит каждую живую оплату звёздами, её выход из холда через
  21 день и возврат (Р219). Прошлые оплаты проводятся первым проходом после
  выката.

  🛠 **Как устроено**

  • задание раз в 10 минут сверяет покупки с журналом и досоздаёт недостающее
  • срок холда записывается в проводку оплаты — смена настройки не сдвигает старые
  • возврат до конца холда — сторно оплаты, после — списание из «доступно»
  ```
