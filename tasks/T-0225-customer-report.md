---
id: T-0225
title: Отчёт заказчику партнёрских заданий — по дням, без ID, экран и CSV
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0222, T-0223, T-0224]
zones:
  - backend/api/src/modules/tasks/customer-report.ts
  - backend/api/src/modules/tasks/customer-report.repository.ts
  - backend/api/src/modules/admin/admin-customer-report.controller.ts
  - backend/api/test/customer-report.test.ts
  - backend/api/test/customer-report.integration.test.ts
  - apps/admin/src/api/customer-report.ts
  - apps/admin/src/screens/tasks/CustomerReport.tsx
  - apps/admin/test/customer-report.test.ts
shared:
  - backend/api/src/modules/admin/admin.module.ts
  - apps/admin/src/routes.ts
  - apps/admin/src/ui/help.ts
  - docs/07-monetization-and-ads.md
  - docs/29-admin-panel.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0225. Отчёт заказчику партнёрских заданий — по дням, без ID, экран и CSV

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0225.json)](README.md#значки-статуса) [![T-0222](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0222.json&label=T-0222)](T-0222-task-customer-and-pay-model.md) [![T-0223](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0223.json&label=T-0223)](T-0223-subscription-retention-marks.md) [![T-0224](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0224.json&label=T-0224)](T-0224-partner-task-impressions.md)

## Зачем

Заказчик платит за подписчиков и хочет видеть, что получил: сколько
игроков увидели задание, нажали, выполнили и остались в канале через сутки,
трое и неделю, и сколько это стоит по договорённости. После задачи команда
открывает в панели отчёт по заказчику и периоду и отдаёт его CSV-файлом —
без Telegram ID и имён игроков.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р140: сводка по
дням без ID игроков — экран в панели и CSV: день, задание, показы,
нажатия, выполнения, остались на 1-й, 3-й и 7-й день, сумма к оплате.

Решения `claude-lead-1` от 24.10.2026:

- **Строка отчёта** — день (по Москве) × задание заказчика:
  - **показы** — события `task_shown` (T-0224) этого задания за день;
  - **нажатия** — события `task_link_opened`;
  - **выполнения** — заборы награды задания за день (`task_progress`);
  - **остались на 1-й, 3-й и 7-й день** — из отметок окон (T-0223) у
    выполнений этого дня: число `true`; пока отметка не наступила — «ещё
    рано» (пусто в CSV); пустая после закрытия окна — «неизвестно»;
  - **к оплате** — у `cpa`: число оплачиваемых выполнений
    (`paidRetention`, T-0223) × ставка, в долларах; у `rs` — «по отчёту
    заказчика»: долю считает заказчик по своей выручке, мы её не знаем.
- **Итоги** — строка «Всего» по периоду и столбцы конверсий: нажатия /
  показы, выполнения / нажатия, остались на 7-й день / выполнения.
- **Без ID.** В ответе и CSV нет `accountId`, Telegram ID, имён и площадок
  отдельных игроков — только счётчики. Порога малых групп здесь нет: отчёт
  видит команда, а не заказчик напрямую, и счётчик выполнений заказчику
  нужен точным.
- **Доступ** — право `partners.view` (смотреть) и `data.export` (скачать
  CSV), как у других выгрузок.
- **CSV** — собирается в панели из того же ответа, как у промокодов
  (`codesCsv`): UTF-8 с BOM, разделитель `;`, даты `ДД.ММ.ГГГГ`, деньги с
  двумя знаками через запятую — чтобы файл открывался в Excel без настроек.
  Имя — `report-<заказчик латиницей или id>-<с>-<по>.csv`.
- **Период** — пресеты «7 · 30 · 90 · свой», не больше 92 дней.

## Как сейчас

- После T-0222: `TaskDef.customer`, `payModel`, `rate`, `holdDays`.
- После T-0223: отметки `held_d1/d3/d7` у окон и `paidRetention`.
- После T-0224: событие `task_shown`.
- `backend/api/prisma/schema.prisma:275–…` — `AnalyticsEvent` с индексом
  `(event_type, received_at)`.
- `apps/admin/src/api/promo-codes.ts` — `codesCsv`;
  `apps/admin/src/screens/promo-codes/PromoCodeCard.tsx:139` — скачивание
  CSV.

## Шаги по порядку

1. **`customer-report.ts`** — чистая сборка строк, итогов и конверсий из
   счётчиков; суммы в центах.
2. **`customer-report.repository.ts`** — три выборки за период (события по
   двум видам, заборы, окна с отметками) с группировкой по дню МСК и
   заданию; события — по `occurred_at` и индексу `(event_type,
   received_at)` с запасом в сутки по `received_at`.
3. **Контроллер** — `GET /admin/customer-report?customer=&from=&to=` и
   `GET /admin/customer-report/customers` (список заказчиков из заданий).
4. **Панель** — экран `CustomerReport.tsx` во вкладке раздела «Задания»
   («Отчёт заказчику»): выбор заказчика и периода, таблица, итоги,
   «Скачать CSV».
5. **Документы:** `docs/07-monetization-and-ads.md` — абзац об отчёте
   заказчику; `docs/29-admin-panel.md` — вкладка и права.

## Чего не трогаем

- Постбэки заказчику — шаблоны Р96 (T-0070).
- Начисления по RS — нечем считать.
- Экран заданий в игре.

## Сценарий и интерфейс

«Задания» → «Отчёт заказчику» → заказчик «Канал „Игровой угол“», 30 дней:
таблица по дням и заданиям, внизу «Всего: показов 8 400, нажатий 1 260,
выполнений 940, остались на 7-й день 610, к оплате $244,00». Состояния:
загрузка, пусто («У заказчика нет выполнений за период»), ошибка с
повтором, «ещё рано» в столбцах удержания у свежих дней.

## Тесты

Первым коммитом.

- `customer-report.test.ts`:
  - CPA $0,40, срок 3 дня, 10 выполнений, `held_d3: true` у 6 → к оплате
    $2,40;
  - срок 0 → оплачиваются все 10;
  - RS → «по отчёту заказчика», суммы нет;
  - конверсии: показов 0 → «—», а не деление на ноль;
  - отметка дня 7 ещё не наступила → «ещё рано».
- `customer-report.integration.test.ts` — два задания заказчика и одно
  чужое: в отчёте только свои; день считается по Москве (событие в 22:30
  UTC попадает в следующий день); в ответе нет `accountId`.
- `apps/admin/test/customer-report.test.ts` — CSV: BOM, `;`, дата
  `24.10.2026`, сумма `244,00`.
- Снимок экрана отчёта — в PR.

## Аналитика

Нет новых событий: отчёт читает `task_shown`, `task_link_opened`, заборы и
отметки.

## Настройки и окружение

Нет.

## Документы

По шагу 5.

## Критерии приёмки

- [ ] Отчёт по заказчику и периоду: показы, нажатия, выполнения,
  удержание на 1-й, 3-й и 7-й день и сумма к оплате у CPA.
- [ ] CSV открывается в Excel без настроек; ни в ответе, ни в CSV нет ID и
  имён игроков.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Отчёт заказчику партнёрских заданий`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОТЧЁТ ЗАКАЗЧИКУ ПАРТНЁРСКИХ ЗАДАНИЙ**

  В разделе «Задания» — вкладка «Отчёт заказчику»: по дням и заданиям — показы, нажатия, выполнения, сколько осталось в канале на 1-й, 3-й и 7-й день и сколько платить по CPA. Без ID и имён игроков; скачивается CSV, который открывается в Excel.
  ```
