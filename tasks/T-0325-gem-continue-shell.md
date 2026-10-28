---
id: T-0325
title: Второй шанс за самоцветы — экран смерти: кнопка с ценой и балансом, нехватка видна до нажатия, ролик раз в сутки
epic: E1
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0324]
zones:
  - packages/app-shell/src/state/gem-continue.ts
  - packages/app-shell/src/screens/run/GemContinue.tsx
  - packages/app-shell/test/gem-continue.test.ts
shared:
  - packages/app-shell/src/screens/run/SecondChance.tsx
  - packages/app-shell/src/screens/run/DeathOverlay.tsx
  - packages/app-shell/src/state/second-chance-offers.ts
  - packages/app-shell/src/state/wallet.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/screens/gallery.tsx
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/test/second-chance.test.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/07-monetization-and-ads.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0325. Второй шанс за самоцветы — экран смерти: кнопка с ценой и балансом, нехватка видна до нажатия, ролик раз в сутки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0325.json)](README.md#значки-статуса) [![T-0324](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0324.json&label=T-0324)](archive/T-0324-gem-continue-server.md)

## Зачем

Сервер умеет продавать второй шанс за самоцветы (T-0324), а на экране
смерти — только ролик и звёзды. После задачи на шаге второго шанса есть
третья кнопка «за самоцветы». Цена и баланс видны до нажатия, нехватка — тоже.

## Решения

Решения владельца — `docs/35-stage4-plan.md` Р162: дальше рекламы —
самоцветы или звёзды на выбор, цена видна заранее.

Решения `claude-lead-1` от 25.10.2026:

- **Какие кнопки:**
  - **VIP** — одна «Продолжить с VIP», как сейчас: платить за бесплатное
    незачем.
  - **Ролик есть** (первый за сутки) — ролик главной кнопкой, самоцветы и
    звёзды — второй строкой.
  - **Ролика нет** — самоцветы главной кнопкой, звёзды — второй.
  - Сервер ответил `unavailable` по самоцветам — кнопки нет, как у
    отпавшего способа.
- **Кнопка самоцветов:**
  - подпись — «Продолжить», цена значком самоцвета и числом
    (`GemIcon`, `CurrencyIcons.tsx`);
  - под ней — «У вас N»;
  - самоцветов меньше цены — кнопка выключена, подпись «Не хватает N
    самоцветов». В магазин с экрана смерти не ведём: уход закрыл бы забег.
- **Нажатие:**
  - `POST /runs/:runId/continues/gems` с номером и секундой забега;
  - пока ждём — кнопка в загрузке, остальные выключены;
  - успех — `continueRun()` движку, как у ролика и звёзд; баланс кошелька
    обновляется из ответа;
  - 409 `continue_taken` или `insufficient_funds` — способ отпадает с
    подписью, забег ждёт остальных (`second-chance-offers.ts`);
  - сеть упала — повтор тем же номером: сервер не спишет дважды.
- **Предложения** — `ContinueOffer` получает `"gems"`: забег закрывается
  смертью, только когда отпали все три.
- **Аналитика:**
  - `continue_offered` — новое поле `gems: boolean`;
  - `continue_used` — `source: "gems"`.

  Сначала словарь `docs/22` §3.3, потом Zod.
- **Тексты** — ключи `run.continue.gems`, `run.continue.gems-balance`,
  `run.continue.gems-short` в `ru.json`.

## Как сейчас

- **Шаг второго шанса** — `screens/run/SecondChance.tsx`: `visibleWays`,
  `waysAnswered`, `continueOfferedPayload`; кнопки — `AdContinue.tsx`,
  `PaidContinue.tsx`.
- **Предложения** — `state/second-chance-offers.ts` (`ContinueOffer = "stars" | "ad"`).
- **Состояния способов** — `state/ad-continue.ts`, `state/continue-purchase.ts`:
  образец для `state/gem-continue.ts`.
- **Кошелёк** — `state/wallet.ts`.
- **События** — `continue_offered`, `continue_used` в `event-dictionary.ts:172`.
- **После T-0324** — `GET` и `POST /api/v1/runs/:runId/continues/gems`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`state/gem-continue.ts`** — состояние: проверка, готово с ценой,
   покупка, отпал; таймаут запросов — как у соседей.
3. **`GemContinue.tsx`** — кнопка, баланс, нехватка; витрина
   (`gallery.tsx`) — три состояния.
4. **`SecondChance.tsx`** — порядок кнопок; `visibleWays` и
   `continueOfferedPayload` знают самоцветы.
5. **Аналитика** — словарь, Zod, отправка.
6. **`docs/07`** §8 — экран: три способа.

## Чего не трогаем

- Сервер — T-0324.
- Окно оплаты звёздами и ролик.

## Сценарий и интерфейс

- Загрузка — кнопка-заглушка той же высоты, без прыжка.
- Нехватка — выключенная кнопка с подписью, а не скрытая: игрок видит, что
  способ есть.
- 320 px — цена и «У вас N» в одну строку не влезают — баланс второй строкой.
- Проверка — скилл `ui-design`: контраст подписей, зона касания 44 px.

## Тесты

Первым коммитом.

- `gem-continue.test.ts`:
  - ответ `available` → цена и баланс; баланс меньше цены → выключено,
    «Не хватает N»;
  - покупка → `continueRun`, баланс из ответа;
  - 409 `insufficient_funds` → способ отпал, забег ждёт звёзды;
  - обрыв сети → повтор с тем же номером.
- `second-chance.test.ts`:
  - есть ролик — он первый; нет ролика — самоцветы первые;
  - VIP — одна кнопка;
  - отпали все три — забег закрыт смертью;
  - `continue_offered` несёт `gems`.

## Аналитика

`continue_offered.gems` и `continue_used.source = "gems"` — по шагу 5.

## Настройки и окружение

Нет.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] На шаге второго шанса — кнопка самоцветов с ценой и балансом; нехватка видна до нажатия.
- [ ] Без ролика самоцветы — главная кнопка; VIP — одна кнопка.
- [ ] Забег закрывается смертью, только когда отпали все способы.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Второй шанс за самоцветы`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: второй шанс за самоцветы — цена видна до нажатия`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВТОРОЙ ШАНС ЗА САМОЦВЕТЫ**

  На экране смерти появилась кнопка второго шанса за самоцветы: цена и баланс видны до нажатия, нехватка тоже. Ролик — раз в сутки и главной кнопкой, без него главная — самоцветы, звёзды остаются. В аналитике — новый способ gems.
  ```
