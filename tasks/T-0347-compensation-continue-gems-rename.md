---
id: T-0347
title: Компенсация тестерам — своё имя пересчёта звёзд второго шанса в самоцветы
epic: E1
priority: P3
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0324]
zones:
  - backend/api/src/modules/wipe/compensation-rules.ts
  - backend/api/src/modules/wipe/compensation.service.ts
  - backend/api/test/compensation-rules.test.ts
  - backend/api/test/compensation.test.ts
shared: []
runner: any
executor: haiku-5.5
effort: low
release: patch
design: null
batch: 3
---

# T-0347. Компенсация тестерам — своё имя пересчёта звёзд второго шанса в самоцветы

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0347.json)](README.md#значки-статуса) [![T-0324](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0324.json&label=T-0324)](T-0324-gem-continue-server.md)

## Зачем

После #538 (T-0324) функция с именем `continueGems` есть в двух модулях и
значит разное:

- `payments/continue-price.ts` — `continueGems(elapsedSec, rules)`: цена
  продолжения в самоцветах по времени забега;
- `wipe/compensation-rules.ts:30` — `continueGems(stars)`: сколько самоцветов
  вернуть тестеру за второй шанс, купленный за звёзды.

Одно имя для двух смыслов однажды приведёт к импорту не той функции. Плюс
`compensation-rules.ts:27` реэкспортирует `CONTINUE_RATE`, хотя её дом —
`continue-price.ts`. Это рефакторинг: поведение не меняется.

## Решения

Решение `claude-lead-1` от 28.10.2026 по ревью #538:

- В компенсации функция называется `compensationGemsForStars(stars)`.
- Реэкспорт `CONTINUE_RATE` из `compensation-rules.ts` убирается; кому он
  нужен — импортирует из `payments/continue-price.ts`.
- Поле `continueGems` в представлении компенсации
  (`compensation.service.ts:29`) и в логе `compensation_claimed` **не
  переименовывается**: это поле ответа и лога, его читают панель и дашборды.

## Как сейчас

- `backend/api/src/modules/wipe/compensation-rules.ts:2` — импорт
  `CONTINUE_RATE, starsToGems`; строка 27 — `export { CONTINUE_RATE }`;
  строка 30 — `export function continueGems(stars: number): number`.
- `backend/api/src/modules/wipe/compensation.service.ts:6` — импорт
  `continueGems`; строка 127 — `continueGems: continueGems(row.continueStars)`.
- Тесты — `backend/api/test/compensation-rules.test.ts`,
  `backend/api/test/compensation.test.ts`.

## Шаги по порядку

1. `compensation-rules.ts`: переименовать `continueGems` →
   `compensationGemsForStars`; удалить `export { CONTINUE_RATE }` (импорт
   `CONTINUE_RATE` оставить, если он нужен внутри файла, иначе убрать).
2. `compensation.service.ts`: импорт и вызов — новое имя. Поле `continueGems`
   в типе и ответе не трогать.
3. Тесты: имена в импортах и описаниях `it`; ожидания чисел не меняются.
4. `pnpm typecheck` из корня: найти и поправить все остальные импорты старого
   имени из `compensation-rules.ts` — если они вне зон, остановиться и задать
   вопрос черновиком PR.

## Чего не трогаем

- `payments/continue-price.ts` и его `continueGems`.
- Поле `continueGems` в ответе компенсации и в логе.
- Числа и правила компенсации.

## Тесты

Новых тестов нет: прежние зелёные с новым именем, ожидания чисел те же.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Нет.

## Критерии приёмки

- [ ] Имени `continueGems` в `wipe/compensation-rules.ts` нет, есть `compensationGemsForStars`.
- [ ] `CONTINUE_RATE` из `compensation-rules.ts` не экспортируется.
- [ ] Поле `continueGems` в ответе и логе компенсации не изменилось.
- [ ] Ожидания чисел в тестах не менялись.

## PR

- **Заголовок:** `refactor(wipe): Своё имя пересчёта звёзд в самоцветы`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  🧹 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОДНО ИМЯ — ОДИН СМЫСЛ**

  В компенсации тестерам функция пересчёта звёзд второго шанса в самоцветы называется `compensationGemsForStars`: имя `continueGems` осталось только у цены продолжения. Поведение не менялось.
  ```
