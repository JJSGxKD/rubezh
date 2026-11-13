---
id: T-0469
title: Подтверждение отчёта участниками, выплаты и сообщения в боте
epic: E15
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0468]
zones:
  - backend/api/src/modules/ledger/payouts/**
  - backend/api/test/ledger-payouts.test.ts
  - backend/api/test/ledger-payouts.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/ledger/ledger.module.ts
  - backend/api/src/modules/ledger/periods/periods.service.ts
  - backend/api/src/modules/ledger/operations/builders.ts
  - backend/api/src/modules/ledger/operations/operations.service.ts
  - backend/api/src/modules/admin/admin-ledger.controller.ts
  - backend/api/src/modules/admin/admin-my-project.controller.ts
  - backend/api/test/admin-ledger.http.test.ts
  - backend/api/src/modules/notifications/**
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/37-accounting.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0469. Подтверждение отчёта участниками, выплаты и сообщения в боте

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0469.json)](README.md#значки-статуса) [![T-0468](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0468.json&label=T-0468)](T-0468-ledger-periods-close.md)

## Зачем

Закрытие месяца (T-0468) начисляет долги участникам, но дальше — тишина:
участник не знает, что отчёт готов, не может его подтвердить, а выплата
нигде не записывается. Задача доводит цикл `docs/11-revenue-split.md` §4 до
конца (Р222): сообщение участнику, подтверждение или спор, выплата
операцией после подтверждения или по решению владельца, сообщение «выплачено».

## Решения

- `docs/35-stage4-plan.md`, **Р222**; `docs/37-accounting.md` §13.
- **Подтверждение** — `ledger_confirmation`: месяц, аккаунт участника,
  `confirmed` или `disputed` (комментарий обязателен, 3…1000), время. Пока
  месяц закрыт и участнику выплачено не было, решение можно поменять.
- **Выплата** — новый вид операции `payout` (сборщик в `builders.ts`):
  кому (`stakeholder:<аккаунт>`, `owner`, `tax`, `loan:<id>`), с какого
  места, сумма в валюте места; строки — `место −сумма`, долг `+сумма`
  (`liability.stakeholder.<аккаунт>.RUB`, `liability.tax.RUB`,
  `liability.loan.<…>`) или у владельца `equity.owner_draw.<валюта> +сумма`.
  Валюта места и долга должна совпадать (участникам и налог — в рублях);
  выплата больше остатка долга — проблема сборки.
- Выплата участнику: только после `confirmed`; если подтверждения нет
  дольше `finance.confirm-days` (5) с закрытия — владелец может выплатить с
  причиной (`override_reason`); при `disputed` — только владелец с причиной.
  Выплата владельцу — по желанию, без подтверждений.
- Выплаты проводятся сразу (это владелец; правило второго ключа T-0462 —
  только для финансов, и `payout` у финансов всегда ждёт владельца).
- Первая выплата по месяцу запрещает снятие закрытия (хук в
  `periods.service.ts`); снятие закрытия сбрасывает подтверждения.
- **Сообщения участнику** — через уведомления игрока (`NotificationsService.deliver`,
  как сообщение команды из карточки игрока, `admin-players.service.ts`),
  новые виды `finance_report` и `finance_payout`, ключи дедупликации
  `finance:report:<месяц>:<аккаунт>:<N>` и `finance:payout:<операция>`:
  - отчёт: «Отчёт за ноябрь готов: твоя часть — 15 980,40 ₽. Подтверди в
    панели — без подтверждения выплата ждёт.» и ссылка на «Мой проект»;
  - выплата: «Выплачено 15 980,40 ₽ за ноябрь.»;
  - снятие закрытия: «Отчёт за ноябрь отозван на пересчёт: <причина>.»
  Тексты — на «ты» (`player-address.test.ts`), без повелительного «нужно».

## Как сейчас

- Месяцы, закрытие, долги в рублях — T-0468; операции — T-0461; второй ключ
  — T-0462; кабинет участника — T-0453/T-0455.
- Уведомления игроку — модуль `notifications` (`deliver({ accountId, kind, payload, dedupeKey, at })`).

## Шаги по порядку

1. **Схема и миграция** `<время>_ledger_payouts`: `ledger_confirmation`
   (`period`, `account_id`, `status`, `comment`, `decided_at`,
   `@@id([period, account_id])`); у `ledger_operation` — `payee varchar(96) null`,
   `payout_period char(7) null`, `override_reason varchar(500) null`.
2. **Сборщик** `payout` в `operations/builders.ts` и проверки из «Решений».
3. **Сервис** `payouts/payouts.service.ts`:
   - `confirm(actor, period, decision, comment?)` — только участник с долгом
     за этот месяц; аудит `ledger.period.confirm|dispute`; споры — в поток
     `notify.chat.finance`;
   - `payout(owner, input)` — правила подтверждения и срока;
   - `status(period)` — по каждому участнику: долг, подтверждение, выплачено,
     можно ли платить и почему нет;
   - хуки для `periods.service.ts`: `hasPayouts(period)` и
     `resetConfirmations(period)`.
4. **Сообщения**: при закрытии — участникам с долгом `finance_report`;
   после выплаты — `finance_payout`; при снятии закрытия — отзыв.
   Отправка не блокирует ответ (очередь уведомлений).
5. **Маршруты**: для участника — `GET /admin/my-project/periods/:p` (свой
   отчёт закрытого месяца: водопад из снимка, своя строка, статус) и
   `POST /admin/my-project/periods/:p/confirm` `{ decision, comment? }`; для
   владельца — `GET /admin/ledger/periods/:p/payouts` и выплата через
   `POST /operations` с `kind: "payout"`.
6. **Настройки и документы**: `finance.confirm-days` (5) —
   `docs/30-configuration-map.md`; ER; `docs/37-accounting.md` §13; виды
   уведомлений — в словаре `docs/22-analytics-and-metrics.md`, если виды
   уведомлений там перечислены.

## Чего не трогаем

- Закрытие и водопад — T-0468. Экраны — T-0470, T-0471.
- Выплаты партнёрам (Р137) — отдельная задача после начислений партнёрам.

## Сценарий и интерфейс

- Ноябрь закрыт → участнику в бот «Отчёт за ноябрь готов: твоя часть —
  15 980,40 ₽…» → он подтверждает в кабинете → владелец проводит выплату с
  «Карты» → участнику «Выплачено 15 980,40 ₽ за ноябрь».
- Второй участник молчит 6 дней → владелец выплачивает с причиной «уехал,
  договорились устно».

## Тесты

Первым коммитом:

- `backend/api/test/ledger-payouts.test.ts`: сборщик `payout` — каждому
  получателю; больше долга — проблема; валюта не та — проблема; правила
  «можно ли платить»: подтверждён, молчит меньше и больше срока, оспорил,
  владелец без подтверждений.
- `backend/api/test/ledger-payouts.integration.test.ts` (Postgres): после
  выплаты снятие закрытия — 409; снятие закрытия до выплат сбрасывает
  подтверждения; повтор выплаты по тому же ключу операции не задваивает;
  сообщения уходят один раз (ключи дедупликации).
- `backend/api/test/admin-ledger.http.test.ts`: участник подтверждает только
  свой месяц; чужой — 403.

## Аналитика

Нет продуктовых событий; уведомления — существующей очередью.

## Настройки и окружение

- `finance.confirm-days` — `docs/30-configuration-map.md`.

## Документы

- `docs/21-diagrams.md`, `docs/30-configuration-map.md`, `docs/37-accounting.md` §13.

## Критерии приёмки

- [ ] Участник получает сообщение о готовом отчёте, подтверждает или
      оспаривает в кабинете.
- [ ] Выплата участнику — только после подтверждения, после срока или при
      споре — решением владельца с причиной; владельцу — по желанию.
- [ ] Первая выплата запрещает снятие закрытия; снятие сбрасывает
      подтверждения и отзывает отчёт сообщением.
- [ ] Тесты и гейт зелёные.

## PR

- **Заголовок:** `feat(finance): Подтверждение отчёта и выплаты участникам`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОДТВЕРЖДЕНИЕ ОТЧЁТА И ВЫПЛАТЫ**

  Цикл месяца доведён до конца (Р222): участник получает сообщение об
  отчёте, подтверждает или оспаривает его, владелец проводит выплату, а
  участнику приходит «выплачено».

  🛠 **Что внутри**

  • выплата участнику — после подтверждения; молчит больше 5 дней — по решению владельца с причиной
  • выплата владельцу — по желанию, незабранное остаётся в бюджете
  • после первой выплаты месяц уже не открыть — только поправка в следующем
  ```
