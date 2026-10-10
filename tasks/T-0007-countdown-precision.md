---
id: T-0007
title: Точные и тикающие отсчёты «через сколько» на главной и в награде дня
epic: E6
priority: P1
status: in-progress
owner: claude-3 / sonnet-5.5
size: S
depends_on: []
zones:
  - packages/app-shell/src/screens/home-widget-rules.ts
  - packages/app-shell/src/screens/home-widgets.tsx
  - packages/app-shell/src/screens/meta/daily.tsx
  - packages/app-shell/test/home-widgets.test.ts
  - packages/app-shell/test/meta-schedule.test.ts
shared: []
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
---

# T-0007. Точные и тикающие отсчёты «через сколько» на главной и в награде дня

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0007.json)](README.md#значки-статуса)

## Зачем

Виджеты главной пишут «через 5 ч», когда до награды 5 ч 50 мин: часы
округляются вниз. Игрок возвращается раньше и видит, что ещё рано. На экране
награды дня отсчёт на кнопке не тикает: он посчитан один раз при отрисовке.

## Решения

- **Одно правило точности для всех отсчётов** — то, что уже делает
  `formatCountdown` в `screens/meta/schedule.ts`:
  - меньше часа — «12 мин», с округлением вверх, минимум 1 мин;
  - меньше суток — «5 ч 50 мин» или «5 ч», если минут ровно ноль;
  - дальше — «2 д 3 ч».
- **Вниз не округляем никогда:** «через 0 мин» и «через 5 ч» вместо 5 ч 50 мин —
  неправда.
- **Отсчёт тикает,** пока виден, тем же хуком `useClock`. Виджеты — раз в 30
  секунд (`CLOCK_STEP_MS` уже есть), экран награды дня — так же.
- `roughCountdown` больше не нужен — удалить.

## Как сейчас

- `packages/app-shell/src/screens/home-widget-rules.ts:154`, `roughCountdown(ms)`:
  часы — `Math.floor(ms / HOUR_MS)`, минуты — вверх.
- `packages/app-shell/src/screens/home-widgets.tsx`, около строки 334:
  `inTime(ms)` → `roughCountdown` → `t("widget.in", { time: … })`.
- `packages/app-shell/src/screens/meta/schedule.ts:39`, `formatCountdown(ms)` —
  нужное правило; `useClock(active, stepMs)` (строка 62) — часы, пока отсчёт на
  экране.
- `packages/app-shell/src/screens/meta/daily.tsx`, около строки 72: на кнопке
  `formatCountdown(msUntilReset(Date.now(), "daily"))` — `Date.now()` прямо в
  отрисовке, без часов.
- `packages/app-shell/test/home-widgets.test.ts:138-140` закрепляет нынешнее
  `roughCountdown` («5 ч 50 мин → 5 ч»).

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. `home-widgets.tsx`: `inTime(ms)` → `t("widget.in", { time: formatCountdown(ms) })`
   с импортом из `./meta/schedule`. Комментарий над функцией — про общее
   правило точности.
3. `home-widget-rules.ts`: удалить `roughCountdown` и всё, что осталось без
   использования из-за этого (константы, импорты).
4. `daily.tsx`: `const now = useClock(ready !== null && !ready.canClaim, CLOCK_STEP_MS)`
   — шаг тот же, что у виджетов, константу взять оттуда или объявить в файле.
   На кнопке — `msUntilReset(now, "daily")`.
5. **Проверить вёрстку.** «через 23 ч 59 мин» — самая длинная строка; она должна
   влезть в плитку виджета на 320 px. Если плитка обрезает строку — перенос на
   вторую строку тем же стилем, а не обрезка с многоточием. Снимок на 320 и
   390 px — в описание PR.
6. Гейт.

## Чего не трогаем

- `formatCountdown` и тексты `time.*`: правило уже верное.
- Колесо (`wheel.tsx`) — его кнопку правит T-0006.
- Раскладку и состав виджетов — это отдельная задача по макету E9.

## Тесты

1. `packages/app-shell/test/home-widgets.test.ts`: кейсы `roughCountdown`
   (строки 138–140) заменить кейсом «отсчёт виджета — общее правило точности»
   через экспортированную из `home-widgets.tsx` функцию отсчёта или через
   `formatCountdown`:
   - 5 ч 50 мин → «5 ч 50 мин»;
   - ровно 1 ч → «1 ч»;
   - 59 мин 30 с → «60 мин»;
   - 20 с → «1 мин».

   Если `inTime` не экспортирована, тестируй `formatCountdown` и проверь, что
   `inTime` её использует.
2. `packages/app-shell/test/meta-schedule.test.ts` — добавить, если таких кейсов
   ещё нет:
   - 26 ч → «1 д 2 ч»;
   - 24 ч ровно → «1 д».

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Нет.

## Критерии приёмки

- [ ] На виджетах и в награде дня отсчёт не округляется вниз: 5 ч 50 мин так и пишется.
- [ ] Отсчёт на кнопке награды дня меняется без перезахода на экран.
- [ ] `roughCountdown` удалён.
- [ ] Самая длинная строка отсчёта влезает в плитку на 320 px (снимок в PR).
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Точные отсчёты на главной и в награде дня`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено: Время до следующей награды на главной больше не округляется вниз, а отсчёт в награде дня идёт без перезахода.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ТОЧНЫЕ И ТИКАЮЩИЕ ОТСЧЁТЫ «ЧЕРЕЗ СКОЛЬКО» НА ГЛАВНОЙ И В НАГРАДЕ ДНЯ**

  Виджеты главной писали «через 5 ч» вместо «5 ч 50 мин», а отсчёт в награде дня стоял на месте. Теперь везде одно правило точности, и отсчёт тикает.
  ```
