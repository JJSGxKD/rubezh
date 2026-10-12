---
id: T-0051
title: Сводка панели — реклама, периоды 7 и 30 дней, покупки в ряду — сервер
epic: E7
priority: P1
status: in-progress
owner: claude-5 / sonnet-5.5 / high
size: M
depends_on: []
zones:
  - backend/api/src/modules/admin/admin-overview.service.ts
  - backend/api/src/modules/admin/admin-overview.controller.ts
  - backend/api/src/modules/admin-notify/daily-stats.repository.ts
  - backend/api/src/modules/ads/ads.module.ts
  - backend/api/test/admin-overview.test.ts
  - backend/api/test/daily-stats.integration.test.ts
shared:
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/screens/admin-overview.html
version: v0.8
---

# T-0051. Сводка панели — реклама, периоды 7 и 30 дней, покупки в ряду — сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0051.json)](README.md#значки-статуса)

## Зачем

Пользователь 07.10.2026: в сводке панели не хватает данных по рекламе. Сейчас
о показах можно узнать только в разделе «Реклама», и сводка о них молчит.
Макет `design/screens/admin-overview.html` добавляет:

- плитку «Реклама»;
- разбор по местам показа;
- графики показов и покупок;
- переключатель «Сегодня · 7 дней · 30 дней».

Задача — данные на сервере, экран — T-0052.

## Решения

- **Реклама — из той же воронки показов, что в разделе «Реклама»:**
  `ads-catalog.repository.ts`, `funnel(from, to)` — предложено, показано,
  нажато, досмотрено, награда, ошибки по сети и месту.
- **Видна тем, у кого есть `ads.view`**, как выручка — тем, у кого
  `analytics.revenue.view`. Без права — `ads: null`.
- **Денег от сетей в базе нет** — сводка о деньгах рекламы молчит, а не
  выдумывает.
- **Периоды:**
  - `days=1` — как сейчас: сегодня с полуночи по Москве против вчера к тому
    же часу;
  - `days=7` и `days=30` — последние N суток, сегодняшние включительно,
    против предыдущих N суток той же длины.
- **Ряд** — не короче 14 суток, при `days=30` — 30. В нём ещё два числа:
  покупки (число живых оплат) и досмотренная реклама.

## Как сейчас

- **`admin-overview.service.ts:64-91`, `overview(actor, now)`:**
  - окно сегодня — `dayWindow(day).from` … `now`; вчера — тот же отрезок,
    сдвинутый на сутки;
  - `stats.day({ day, from, to })` для обоих окон;
  - `stats.series(from, now)` за `OVERVIEW_DAYS = 14`;
  - `attention`;
  - выручка — только при `analytics.revenue.view`.
- **`admin-notify/daily-stats.repository.ts`:**
  - `day(window)` принимает любое окно `[from, to)`;
  - `series(from, to)` — четыре запроса на весь период, сутки по Москве;
    `DayPoint` — `day`, `newAccounts`, `active`, `finishedRuns`, `stars`.
- **`ads/ads-catalog.repository.ts:179-190`, `funnel(from, to)`:**
  - группировка по `network_key, place`;
  - токен `ADS_CATALOG_REPOSITORY` (строка 56);
  - `AdsModule` его не экспортирует.
- **`admin-overview.controller.ts:14-17`** — `GET admin/overview` без
  параметров.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`daily-stats.repository.ts`:**
   - `DayPoint` += `purchases: number` (живые оплаты за сутки) и
     `adsCompleted: number` (досмотренные показы — `ad_session.completed_at` в
     сутках);
   - в `series` — ещё два запроса в том же `Promise.all`, по образцу соседних:
     - `count(*)` из `purchase` при `mode = 'live' AND paid_at` в окне;
     - `count(*)` из `ad_session` при `completed_at` в окне;
   - сутки без событий — нули.
3. **`ads.module.ts`** — `ADS_CATALOG_REPOSITORY` в `exports`.
4. **`admin-overview.service.ts`:**
   - `overview(actor, days: 1 | 7 | 30, now)`;
   - **окна:**
     - `days = 1` — как сейчас;
     - иначе `from = start − (days − 1) суток`, `to = now`; прошлое окно —
       то же, сдвинутое назад на `days` суток;
   - `day` в `stats.day` — сутки начала окна;
   - **ряд** — от `start − (max(14, days) − 1) суток` до `now`;
   - **реклама** — при `ads.view`:
     - `funnel(now-окно)` и `funnel(прошлое окно)` с таймаутом, как соседние
       чтения;
   - **ответ:**

     ```ts
     export interface AdsTotals { offered: number; shown: number; completed: number; claimed: number; failed: number }
     export interface OverviewAds {
       now: AdsTotals;
       before: AdsTotals;
       /** места показа — суммой по сетям, в порядке AD_PLACES */
       places: ({ place: string } & AdsTotals)[];
       /** доля досмотренных по сетям, по убыванию */
       networks: { networkKey: string; completed: number }[];
     }
     // в Overview:
     days: 1 | 7 | 30;
     ads: OverviewAds | null;
     ```

     `series` — с `purchases` и `adsCompleted`. Без `analytics.revenue.view` —
     `purchases: null`, как `stars`;
   - **сбой чтения рекламы** — `ads: null` и лог `warn`; сводка без рекламы
     лучше пустого экрана. Так уже устроен `safely` у «Ждёт вас».
5. **`admin-overview.controller.ts`:**
   - query `days` — `z.enum(["1", "7", "30"])`, по умолчанию `"1"`;
   - чужое значение — 400 с текстом «Период — 1, 7 или 30 дней»;
   - число передаётся в сервис.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- Ежедневный отчёт в чат (`daily-stats.reporter.ts`): он берёт `day`, а
  новые поля ряда ему не нужны.
- Раздел «Реклама» и его воронку.
- Экран сводки — T-0052.

## Тесты

Первым коммитом, `backend/api/test/admin-overview.test.ts` — на подменах
репозиториев, как в нём уже устроено:

- `days = 1`:
  - окна прежние;
  - `ads` суммирует места по сетям;
  - `networks` по убыванию досмотренных;
- `days = 7`:
  - `stats.day` получает `[start − 6 суток, now)` и `[start − 13 суток, now − 7 суток)`;
  - ряд — 14 точек;
- `days = 30` → ряд — 30 точек;
- без `ads.view` → `ads: null`, репозиторий рекламы не зовётся;
- без `analytics.revenue.view` → `purchases` и `stars` в ряду — `null`;
- чтение рекламы бросило → `ads: null`, остальная сводка на месте;
- HTTP: `?days=14` → 400.

`backend/api/test/daily-stats.integration.test.ts` — существующий кейс «ряд
по суткам» на живом Postgres: в ожидаемых точках — `purchases` и
`adsCompleted` (шаг 2). Покупки считаются по тем же правилам, что `stars`:
только живые оплаты, тестовая не в счёт. Для `adsCompleted` — хотя бы один
досмотренный показ в одних из суток окна и один за его границей. Ответ
claude-lead2-1 на красный `gate` PR #284, 12.10.2026: шаг 2 меняет форму
`DayPoint`, а тест ряда в зоны не входил.

## Аналитика

Нет — это чтение данных для панели.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` §5.2 (дашборды), строка о сводке:
  - периоды «Сегодня · 7 · 30»;
  - реклама по местам и сетям — с правом `ads.view`;
  - ряд — с покупками и досмотренной рекламой.

## Критерии приёмки

- [ ] `GET /api/v1/admin/overview?days=1|7|30` сравнивает окно с прошлым той
  же длины.
- [ ] В ответе — реклама по местам и сетям при `ads.view`, иначе `null`.
- [ ] Ряд — не короче 14 суток, с покупками и досмотренной рекламой.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Реклама и периоды в сводке панели — сервер`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕКЛАМА В СВОДКЕ ПАНЕЛИ: СЕРВЕР**

  Сервер сводки отдаёт данные рекламы: показы, досмотры и награды по местам и сетям, за сегодня, 7 или 30 дней, с прошлым периодом для сравнения. Экран придёт следующей задачей.
  ```
