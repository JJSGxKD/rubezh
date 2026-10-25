---
id: T-0263
title: Серия дней — клиент: огонёк у аватара в шапке и строка серии в награде дня
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0262, T-0244]
zones:
  - packages/app-shell/src/screens/meta/streak-flame.tsx
  - packages/app-shell/test/streak-flame.test.ts
shared:
  - packages/app-shell/src/state/daily-api.ts
  - packages/app-shell/src/screens/meta/daily.tsx
  - packages/app-shell/src/app/AppHeader.tsx
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/gallery.tsx
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/meta-v2.md
batch: 4
---

# T-0263. Серия дней — клиент: огонёк у аватара в шапке и строка серии в награде дня

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0263.json)](README.md#значки-статуса) [![T-0262](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0262.json&label=T-0262)](T-0262-daily-streak-server.md) [![T-0244](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0244.json&label=T-0244)](T-0244-reward-ads-shell.md)

## Зачем

Серия дней (T-0262) работает, только если её видно. После задачи:
- в шапке у аватара — огонёк с числом дней серии;
- на экране награды дня — «Серия 7 дней · +35 %» и подсказка, что
  пропуск снимет две ступени.

## Решения

Решения владельца — `docs/35-stage4-plan.md` Р154 (серия видна огоньком у
аватара, `design/art/meta-v2.md` §6.4) и поправка 24.10.2026 (правила серии).

Решения `claude-lead-1` от 24.10.2026:

- **Огонёк** `streak-flame.tsx` — значок пламени тоном `accent` и число дней
  справа снизу у аватара в шапке.
  - Серия 0 — огонька нет.
  - Сегодня ещё не забрано — огонёк тусклый (прозрачность 0,5) с подписью для диктора «Серия {N} дней — заберите награду дня, чтобы продлить».
  - Нажатие ведёт на экран награды дня.
- **Строка в награде дня:** «Серия {N} дней · +{P} %», под ней мелко
  «Завтра: +{P2} %. Пропуск снимет две ступени».
- **Без нового движения:** огонёк не «дышит» — шапка во время меню и так
  живая; появление — существующим `fade-in`.

## Как сейчас

- `app/AppHeader.tsx` — шапка с аватаром; `screens/meta/daily.tsx` — награда
  дня; `state/daily-api.ts` — схема ответа.
- После T-0262 в ответе `streak: { days, bonusPercent, next }`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`daily-api.ts`** — необязательное `streak` в схеме.
3. **`streak-flame.tsx`** и шапка; **`daily.tsx`** — строка серии.
4. **Витрина** — огонёк 0, 3, 10, тусклый.
5. **Событие** — `daily_reward_claimed` получает необязательное `streak`:
   сначала `docs/22` §3.3 и Zod, потом `state/analytics.ts`.
6. **Тексты `ru.json`:**
   - `"daily.streak": "Серия {days} дней · +{percent} %"`;
   - `"daily.streak.next": "Завтра: +{percent} %. Пропуск снимет две ступени"`;
   - `"streak.flame": "Серия {days} дней"`;
   - `"streak.flame.pending": "Серия {days} дней — заберите награду дня, чтобы продлить"`.
7. **`docs/27`** — огонёк серии в шапке.

## Чего не трогаем

- Сервер — T-0262.

## Тесты

Первым коммитом, `streak-flame.test.ts`:
- серия 0 → огонька нет;
- серия 4, забрано → яркий с «4»;
- не забрано → тусклый и подпись для диктора;
- ответ без `streak` (старый сервер) → огонька нет.

Снимки шапки и награды дня на 320 и 390 — в PR.

## Аналитика

По шагу 5.

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Огонёк серии у аватара в шапке, тусклый, пока награда дня не забрана.
- [ ] Экран награды дня показывает серию, прибавку и цену пропуска.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Огонёк серии дней`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: серия дней — каждый день подряд +5 % к награде дня, до +50 %; огонёк у аватара`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЕРИЯ ДНЕЙ**

  У аватара в шапке — огонёк серии дней, тусклый, пока награда дня не забрана. Экран награды дня показывает «Серия N дней · +P %» и что пропуск снимет две ступени.
  ```
