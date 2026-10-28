---
id: T-0228
title: Отчёт «Нажатия» в панели — что нажимают на каждом экране
epic: E11
priority: P3
status: done
owner: claude-1 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: [T-0227]
zones:
  - backend/api/src/modules/funnel/ui-clicks-report.ts
  - backend/api/src/modules/admin/admin-ui-clicks.controller.ts
  - backend/api/test/ui-clicks-report.test.ts
  - backend/api/test/ui-clicks-report.integration.test.ts
  - apps/admin/src/api/ui-clicks.ts
  - apps/admin/src/screens/funnel/UiClicks.tsx
shared:
  - backend/api/src/modules/admin/admin.module.ts
  - apps/admin/src/routes.ts
  - apps/admin/src/ui/help.ts
  - docs/22-analytics-and-metrics.md
  - docs/29-admin-panel.md
runner: local
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0228. Отчёт «Нажатия» в панели — что нажимают на каждом экране

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0228.json)](README.md#значки-статуса) [![T-0227](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0227.json&label=T-0227)](archive/T-0227-ui-track-ids-all-screens.md)

## Зачем

После T-0227 событие `ui_clicked` приходит со всех экранов. После этой
задачи в панели есть отчёт: на каждом экране — какие кнопки нажимают и
какая доля открывших экран нажала каждую. Так видно, какую кнопку не
замечают и куда игроки идут на самом деле.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р141: отчёты по
нажатиям — в панели и Grafana.

Решения `claude-lead-1` от 24.10.2026:

- **Отчёт** — по выбранному экрану и периоду («7 · 30 · 90 · свой», до 92
  дней): строки — `control`, столбцы — нажатий, игроков нажало (уникальные
  `install_id`), доля от открывших экран (уникальные `install_id` с
  `screen_viewed` этого экрана за период), по площадкам — переключателем.
  Вверху — сколько игроков открыли экран.
- **Список экранов** — с числом открытий, по убыванию: от него
  выбирают экран.
- **Без игроков** — только счётчики; `install_id` наружу не уходит.
- **Grafana** — не в этой задаче: в Prometheus id кнопок нельзя (высокая
  кардинальность, `CLAUDE.md`, «Аналитика»); панель Grafana строится на
  тех же запросах к базе событий отдельно, когда понадобится.
- **Право** — `analytics.gameplay.view`.
- **Запросы** — по `analytics_event` с индексом `(event_type,
  received_at)`; период по `occurred_at` с запасом в сутки по
  `received_at`.

## Как сейчас

- После T-0226/T-0227: событие `ui_clicked { screen, control }` со всех
  экранов; `screen_viewed { screen, stub }` (`event-dictionary.ts:106`).
- `backend/api/prisma/schema.prisma:275–…` — `AnalyticsEvent`.
- Раздел панели «Воронка» — `apps/admin/src/screens/funnel/`.

## Шаги по порядку

1. **`ui-clicks-report.ts`** — сборка строк и долей из счётчиков (чистые
   функции) и запросы.
2. **Контроллер** — `GET /admin/ui-clicks/screens?from=&to=` и
   `GET /admin/ui-clicks?screen=&from=&to=&platform=`.
3. **Панель** — вкладка «Нажатия» рядом с воронкой: список экранов и
   таблица кнопок с полосой доли.
4. **Документы:** `docs/22` — где смотреть нажатия; `docs/29` — вкладка.

## Чего не трогаем

- Grafana и Prometheus.
- Событие и разметку — T-0226, T-0227.

## Сценарий и интерфейс

«Воронка» → «Нажатия» → экран `shop` за 30 дней: «Открыли 4 210 игроков»;
`buy` — 1 930 нажатий, 1 120 игроков, 26,6%; `tabs.gems` — 3 400, 2 050,
48,7%. Состояния: загрузка, пусто («Нажатий за период нет»), ошибка с
повтором.

## Тесты

Первым коммитом.

- `ui-clicks-report.test.ts` — доля: 1 120 из 4 210 → 26,6%; экран без
  открытий → «—», не деление на ноль.
- `ui-clicks-report.integration.test.ts` — два экрана, повторные нажатия
  одного игрока считаются одним игроком и несколькими нажатиями; фильтр
  площадки; в ответе нет `install_id`.
- Снимок вкладки — в PR.

## Аналитика

Нет новых событий: отчёт читает `ui_clicked` и `screen_viewed`.

## Настройки и окружение

Нет.

## Документы

По шагу 4.

## Критерии приёмки

- [x] По каждому экрану видны кнопки, нажатия, игроки и доля от открывших.
- [x] Ни `install_id`, ни других идентификаторов в ответе нет.
- [x] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Отчёт «Нажатия» по экранам`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОТЧЁТ «НАЖАТИЯ»**

  В панели, рядом с воронкой, — вкладка «Нажатия»: на каждом экране видно, какие кнопки нажимают, сколько игроков и какая доля от открывших экран. Без идентификаторов игроков.
  ```
