---
id: T-0222
title: Заказчик партнёрского задания — модель оплаты CPA или RS, ставка и срок удержания
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0105, T-0106, T-0126, T-0167, T-0178]
zones:
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/src/modules/tasks/tasks.repository.ts
  - backend/api/test/tasks.test.ts
  - backend/api/test/tasks.integration.test.ts
  - apps/admin/src/api/tasks.ts
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/src/screens/tasks/task-customer-fields.tsx
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - docs/21-diagrams.md
  - docs/07-monetization-and-ads.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0222. Заказчик партнёрского задания — модель оплаты CPA или RS, ставка и срок удержания

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0222.json)](README.md#значки-статуса) [![T-0105](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0105.json&label=T-0105)](T-0105-task-points-and-rewards.md) [![T-0106](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0106.json&label=T-0106)](T-0106-achievements-prestige-server.md) [![T-0126](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0126.json&label=T-0126)](T-0126-tasks-kinds-bosses-elites-chests-evolutions.md) [![T-0167](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0167.json&label=T-0167)](T-0167-admin-sortable-list-tasks-order.md) [![T-0178](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0178.json&label=T-0178)](T-0178-channel-unsubscribe-recheck.md)

## Зачем

Партнёрские задания — подписаться на канал, запустить бота, перейти по
ссылке — мы размещаем за деньги, но в задании не записано, кто платит, за
что и сколько. Без этого не собрать отчёт заказчику (T-0225) и не понять,
окупается ли место в заданиях. После задачи у партнёрского задания есть
заказчик, модель оплаты, ставка и срок, сколько игрок должен продержаться,
чтобы выполнение оплачивалось.

## Решения

Решения владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р138, Р139:

- у задания появляются **заказчик, модель оплаты — CPA, за выполнение, или
  RS, долей, — и ставка**; заводит команда в панели;
- сейчас — прямые заказчики; внешние CPA-сети — потом, поверх той же
  модели;
- CPA начисляется только за тех, кто **продержался до срока заказчика**.

Решения `claude-lead-1` от 24.10.2026:

- **Поля `TaskDef`** (все — только у партнёрской цели, `isCheckedKind`):
  - `customer` — строка до 80 символов, «Канал „Игровой угол“»;
    пусто — задание своё, не продаётся;
  - `payModel` — `cpa` или `rs`; при пустом заказчике пусто;
  - `rate` — у `cpa` — цена одного выполнения в центах доллара (целое, до
    100 000), у `rs` — процент в сотых долях (целое от 1 до 10 000:
    1 250 — это 12,5%);
  - `holdDays` — 0, 1, 3 или 7: после скольких суток удержания выполнение
    оплачивается; 0 — сразу. У видов `link` и `bot` удержание проверить
    нечем — только 0 (`refine` с текстом «Удержание проверяется только у
    подписки на канал»).
- **Заказчик — строкой, а не карточкой.** Карточка заказчика понадобится,
  когда появятся сети и договоры; сейчас отчёт группирует по строке, и
  панель подсказывает уже введённых заказчиков списком.
- **Деньги в центах и сотых процента** — целыми, без дробей в учёте
  (`docs/37-accounting.md`).
- **В игре ничего не меняется**: поля только для команды и отчёта; в ответ
  игроку они не уходят.

## Как сейчас

- `backend/api/src/modules/tasks/task-rules.ts:217–…` — `taskDefSchema`
  (`strict`), поля партнёрской цели: `params`, `limit`, `image`; проверки
  `refine`.
- `backend/api/prisma/schema.prisma:1509–…` — `model TaskDef`.
- `backend/api/src/modules/tasks/tasks.repository.ts` — запись и чтение
  определений.
- `apps/admin/src/screens/tasks/TasksScreen.tsx` — редактор задания;
  `apps/admin/src/api/tasks.ts` — схема.

## Шаги по порядку

1. **Миграция** — четыре колонки `task_def`: `customer varchar(80)`,
   `pay_model varchar(8)`, `rate integer`, `hold_days smallint not null
   default 0`; `CHECK`: `pay_model` пуст ⇔ `customer` пуст; `rate` задан ⇔
   `pay_model` задан; `hold_days in (0, 1, 3, 7)`.
2. **`task-rules.ts`** — поля в `taskDefSchema` с умолчаниями `null`/0
   (панель до этих полей их не слала), `refine` из «Решений».
3. **`tasks.repository.ts`** — запись и чтение полей.
4. **Панель** — блок «Заказчик» в редакторе партнёрской цели
   (`task-customer-fields.tsx`): заказчик с подсказкой прежних, модель,
   ставка («$0,40 за выполнение» или «12,5% дохода»), срок удержания
   списком «сразу · 1 сутки · 3 суток · 7 суток».
5. **Документы:** `docs/21` — колонки в ER `task_def`; `docs/07-monetization-and-ads.md`
   — абзац о продаже места в заданиях: заказчик, CPA и RS, срок удержания.

## Чего не трогаем

- Отметки удержания — T-0223; показы — T-0224; отчёт — T-0225.
- Задания сетей (`network-tasks`).
- Ответ игроку и экран заданий в игре.

## Тесты

Первым коммитом.

- `tasks.test.ts` — схема: заказчик без модели → ошибка; модель без
  заказчика → ошибка; `rs` со ставкой 10 001 → ошибка; `link` с
  `holdDays: 3` → ошибка «Удержание проверяется только у подписки на
  канал»; цель забега с заказчиком → ошибка; старое тело без полей →
  умолчания.
- `tasks.integration.test.ts` — запись и чтение полей; ответ игроку их не
  содержит.
- Снимок блока «Заказчик» в редакторе — в PR.

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет.

## Документы

По шагу 5.

## Критерии приёмки

- [ ] У партнёрской цели можно указать заказчика, модель, ставку и срок
  удержания; у цели забега — нельзя.
- [ ] Игрок этих полей не получает.
- [ ] ER-диаграмма обновлена.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(tasks): Заказчик и модель оплаты у партнёрского задания`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАКАЗЧИК У ПАРТНЁРСКОГО ЗАДАНИЯ**

  У партнёрского задания в панели появился блок «Заказчик»: кто платит, модель оплаты — CPA за выполнение или RS долей, — ставка и срок, сколько игрок должен продержаться в канале, чтобы выполнение оплачивалось. Игрок этого не видит. Отчёт заказчику — следующими задачами.
  ```
