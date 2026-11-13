---
id: T-0459
title: Раздел «Бухгалтерия» в панели — остатки по местам хранения и журнал проводок
epic: E15
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / medium
author: claude-lead-1
size: M
depends_on: [T-0457, T-0458, T-0453]
zones:
  - backend/api/src/modules/ledger/ledger-valuation.ts
  - backend/api/test/ledger-valuation.test.ts
  - apps/admin/src/api/ledger.ts
  - apps/admin/src/screens/ledger/**
  - apps/admin/test/ledger.test.ts
shared:
  - backend/api/src/modules/admin/admin-ledger.controller.ts
  - backend/api/src/modules/ledger/ledger.module.ts
  - backend/api/test/admin-ledger.http.test.ts
  - apps/admin/src/routes.ts
  - apps/admin/src/screens/sections.tsx
  - apps/admin/test/routes.test.ts
  - docs/29-admin-panel.md
runner: local
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: null
batch: 5
---

# T-0459. Раздел «Бухгалтерия» в панели — остатки по местам хранения и журнал проводок

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0459.json)](README.md#значки-статуса) [![T-0457](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0457.json&label=T-0457)](T-0457-ledger-journal-backend.md) [![T-0458](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0458.json&label=T-0458)](T-0458-ledger-postings-from-payments.md) [![T-0453](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0453.json&label=T-0453)](T-0453-my-project-revenue-server.md)

## Зачем

Журнал учёта наполняется сам (T-0458), но увидеть его можно только запросом.
Финансам и владельцу нужен раздел «Бухгалтерия»: где сейчас деньги проекта и
в каком состоянии — сколько звёзд в холде, сколько доступно, что в кошельке,
на бирже и в банке, — и журнал проводок, чтобы найти, откуда взялась любая
цифра.

## Решения

- `docs/35-stage4-plan.md`, **Р219**; `docs/37-accounting.md` §9 («Остатки»,
  «Журнал проводок»; бюджеты, операции и отчёт — волны 3–4);
  `docs/29-admin-panel.md` §6.
- Право раздела — `ledger.view` (финансы и владелец, T-0457).
- Оценка в долларах и рублях (О45, О46): звёзды — по курсу выплаты звезды,
  остальные валюты — по рыночному курсу ядра курсов; курс текущий, с датой.
  Нет курса — суммы только в родной валюте.

## Как сейчас

- `GET /admin/ledger/balances` и `GET /admin/ledger/journal` (T-0457):
  счета с остатками строками по нормальной стороне; проводки со строками,
  курсор.
- `FxService.peek(now)` (T-0453) — снимок курсов без записи: `rates`
  (рыночные, `usdPerUnit`) и `payout` (выплата звезды).
- Разделы панели — `apps/admin/src/routes.ts`, группа «Доход»; экраны —
  `screens/sections.tsx`.

## Шаги по порядку

1. **Сервер, оценка** `modules/ledger/ledger-valuation.ts` — чистая функция
   `valueOf(balance: string, currency: string, snapshot): { usd: string; rub: string } | null`:
   XTR — по `payout`, остальные — по `rates`; доллары — вниз до цента, рубли
   — вниз до копейки; нет нужного курса — `null`. В
   `GET /admin/ledger/balances` у каждого счёта — поле `value`, а у ответа —
   `rates: { at: string } | null` и итоги: `totalUsd`/`totalRub` по активам
   (только если у всех активов есть оценка, иначе `null`).
2. `apps/admin/src/api/ledger.ts` — Zod-схемы ответов, `loadBalances()`,
   `loadJournal(filter, cursor)`.
3. `routes.ts`: раздел
   `{ id: "ledger", title: "Бухгалтерия", hint: "Где деньги проекта сейчас и журнал проводок", permission: "ledger.view", icon: <например BookText> }`
   в группе «Доход» после «Мой проект».
4. `screens/ledger/LedgerScreen.tsx`, две вкладки (`TabBar`, как у карточки
   игрока, #768):
   - **«Остатки»**: сверху итог активов в $ (крупно) и ₽; ниже — места
     хранения карточками: «Звёзды бота» — две строки «в холде» и «доступно»
     (звёзды, ≈ $), «Кошелёк TON», «Биржа или USDT», «Банк, ₽» — сумма в
     родной валюте и ≈ $; затем таблица выручки по статьям (звёзды, ≈ $) с
     подписью «за всё время» (по периодам — волна 4); курс и его дата —
     мелко внизу;
   - **«Журнал»**: проводки новые сверху — дата, описание, ключ источника
     (у оплаты — ссылка на карточку платежа, если раздел «Платежи» есть),
     строки «счёт — сумма» с цветом дебета и кредита, метка «сторно» со
     ссылкой на исходную; фильтры — счёт, валюта, месяц с/по; «Показать
     ещё» по курсору.
5. Состояния: журнал пуст — «Проводок пока нет: оплаты появятся здесь после
   первого прохода сверки (раз в 10 минут)»; ошибка — текст и «Повторить».
6. `docs/29-admin-panel.md` §6 — раздел «Бухгалтерия» волны 2 (остатки и
   журнал), остальное — волны 3–5.

## Чего не трогаем

- Запись проводок, план счетов — T-0457, T-0458.
- Операции руками, бюджеты периода, отчёт — волны 3–4.
- Кабинет «Мой проект» — T-0455.

## Сценарий и интерфейс

- Финансы открывают «Бухгалтерия → Остатки»: «≈ 1 240 $ · 114 576 ₽»;
  «Звёзды бота: в холде 61 200 ⭐ (≈ 795,60 $), доступно 34 100 ⭐ (≈ 443,30 $)»;
  кошелёк, биржа, банк — 0.
- «Журнал»: «1 ноября · Набор «Старт» · purchase:…:paid · Звёзды бота — в
  холде +50 · Выручка: магазин, Telegram −50».

## Тесты

Первым коммитом:

- `backend/api/test/ledger-valuation.test.ts`: XTR по курсу выплаты; GRAM и
  RUB по рыночному; нет курса — `null`; округление вниз; итог активов —
  `null`, если хотя бы у одного актива нет оценки.
- `backend/api/test/admin-ledger.http.test.ts` — ответ `balances` с полями
  `value` и `rates`.
- `apps/admin/test/ledger.test.ts`: разбор ответов схемами; группировка
  остатков по местам хранения; знак и цвет строк журнала; метка сторно;
  курсор «Показать ещё» без повторов.
- `apps/admin/test/routes.test.ts`: раздел виден с `ledger.view`, не виден
  участнику проекта.
- Снимки на 390 и 1440 px: остатки с курсами и без, журнал с фильтром и
  сторно, пустой журнал — приложить к PR.

## Аналитика

Нет: чтение панели.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` §6 (шаг 6).

## Критерии приёмки

- [ ] Остатки по местам хранения в родной валюте и ≈ $/₽, звёзды бота — в
      холде и доступно отдельно.
- [ ] Журнал с фильтрами и курсором показывает строки проводок и сторно.
- [ ] Без курсов экран не ломается — суммы только в родной валюте.
- [ ] Тесты и снимки из раздела «Тесты» есть; гейт и `pnpm docs:check`
      зелёные.

## PR

- **Заголовок:** `feat(admin): Раздел «Бухгалтерия» — остатки и журнал`
- **Метка:** `release: minor`
- **Для игроков:** `нет`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РАЗДЕЛ «БУХГАЛТЕРИЯ» В ПАНЕЛИ**

  В группе «Доход» появился раздел «Бухгалтерия» (Р219): где деньги проекта
  сейчас и журнал проводок.

  🛠 **Что внутри**

  • «Остатки»: звёзды бота в холде и доступно, кошелёк, биржа, банк — в родной валюте и ≈ $/₽
  • «Журнал»: проводки с фильтрами, сторно связаны с исходными
  • видят финансы и владелец; операции руками — следующей волной
  ```
