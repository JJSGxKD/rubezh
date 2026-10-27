---
id: T-0052
title: Сводка панели — плитка и панель рекламы, вехи полосами, периоды — экран
epic: E7
priority: P1
status: ready
owner:
size: M
depends_on: [T-0051, T-0049]
zones:
  - apps/admin/src/screens/overview/OverviewScreen.tsx
  - apps/admin/src/screens/overview/overview-parts.tsx
  - apps/admin/src/api/overview.ts
  - apps/admin/test/overview.test.ts
shared:
  - docs/29-admin-panel.md
  - apps/admin/src/ui/help.ts
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/screens/admin-overview.html
batch: 3
---

# T-0052. Сводка панели — плитка и панель рекламы, вехи полосами, периоды — экран

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0052.json)](README.md#значки-статуса) [![T-0051](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0051.json&label=T-0051)](archive/T-0051-overview-ads-and-periods-api.md) [![T-0049](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0049.json&label=T-0049)](archive/T-0049-admin-shell-responsive.md)

## Зачем

Сервер сводки отдаёт рекламу и периоды (T-0051), а экран их не показывает.
Вехи новичков — строкой текста, где потери не видно. Макет
`design/screens/admin-overview.html` — по решению пользователя от 07.10.2026: в
сводке не хватало рекламы.

## Решения

- **Период** — переключатель «Сегодня · 7 дней · 30 дней» в шапке панели
  «Сегодня»:
  - выбор помнится в `localStorage` (ключ `admin.overview.days`);
  - заголовок панели — по периоду: «Сегодня, 7 октября — с полуночи по
    Москве» или «7 дней — с 1 по 7 октября».
- **Плитки** — пять: «Новые игроки», «Играли», «Забеги», «Звёзды», «Реклама».
  - «Звёзды» — только при `revenue`, «Реклама» — только при `ads`.
  - У «Рекламы»:
    - число — досмотренные;
    - сравнение — к прошлому окну;
    - строка — «досмотрено N% · наград M».
- **Вехи — полосами:**
  - высота — доля от «Вошли в бота»;
  - под полосой — число, название и «N% от прошлого» (у первой — «—»).
- **Панель «Реклама сегодня»** (или «за 7 дней», «за 30 дней»):
  - места строками — предложено, показано, досмотрено, доля досмотра
    полосой, наград, ошибок;
  - строка «Всего»;
  - доля досмотра ниже 60% — тоном предупреждения;
  - под таблицей — доля сетей и пометка, что у показа «Между забегами»
    наград нет;
  - ссылка «В раздел «Реклама» →».
- **Две недели (или 30 дней)** — шесть графиков по три в ряд: новые, играли,
  забеги, звёзды, покупки, показы рекламы. Без права — без своего графика.
- **Телефон:**
  - плитки по две, «Реклама» — во всю ширину;
  - реклама — строками «место, досмотрено, доля» без таблицы;
  - графики — по одному.

## Как сейчас

- **`screens/overview/OverviewScreen.tsx`:**
  - `Attention`;
  - `Today` — плитки `Tile` и `FunnelLine` строкой;
  - `Series` — `DailyBars`;
  - обновление раз в минуту.
- **`api/overview.ts`:**
  - `overviewSchema`;
  - `fetchOverview`;
  - `versusYesterday`, `newAccounts`, `sourcesLine`, `dayTitle`.
- **Подписи мест рекламы** — `PLACE_TITLES` в `api/ads.ts`. Имена сетей в сводке —
  по `networkKey` таблицей в `api/overview.ts`: `adsgram` → AdsGram, `adsonar` →
  AdSonar, `richads` → RichAds, `taddy` → Taddy (ключи — `backend/api/src/modules/ads/ad-networks.ts`);
  незнакомый ключ — сам ключ.
- **Пояснения** — `ui/help.ts`, `HELP.overview.*`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`api/overview.ts`:**
   - схема — `days`, `ads` (`now`, `before`, `places`, `networks`), в `series`
     — `purchases` (может быть `null`) и `adsCompleted`;
   - `fetchOverview(api, days)` — `?days=`;
   - чистые помощники:

     ```ts
     /** Доля досмотра, целым процентом; показов нет — `null`. */
     export function completionPct(totals: { shown: number; completed: number }): number | null;
     /** Ниже порога — тоном предупреждения: сеть не отдаёт ролик или место раздражает. */
     export const LOW_COMPLETION_PCT = 60;
     /** Вехи полосами: доля от первой и от прошлой вехи. */
     export function funnelBars(funnel: Overview["today"]["funnel"]): { key: string; title: string; count: number; ofFirst: number; ofPrev: number | null }[];
     /** Доли сетей от досмотренных, целыми процентами, сумма — 100. */
     export function networkShares(networks: { networkKey: string; completed: number }[]): { networkKey: string; pct: number }[];
     export function periodTitle(days: 1 | 7 | 30, from: string, to: string): string;
     ```

     `versusYesterday` переименовать в `versusBefore`: сравнение — с прошлым
     окном. Вызовы поправить.
3. **Новый `screens/overview/overview-parts.tsx`.** Перенести сюда `Tile`,
   `Attention` и `Chart` из `OverviewScreen.tsx` и добавить:
   - **`PeriodSwitch`** — три кнопки-чипа, как переключатели панели;
   - **`FunnelBars`** — по макету: семь колонок, полоса 44 px, под ней
     число `font-display`, название и «N% от прошлого»;
   - **`AdsPanel`** — таблица мест через `DataTable`:
     - колонка доли — число и полоса 64 px;
     - на телефоне через `phone: "hide"` остаются место, досмотрено и доля;
     - итог — последней строкой;
     - сети — строкой со значками-квадратами цвета сети.
4. **`OverviewScreen.tsx`:**
   - порядок — «Ждёт вас», «Сегодня» (переключатель, плитки, `FunnelBars`),
     `AdsPanel` при `ads !== null`, ряд;
   - сетка плиток: `grid-cols-2 lg:grid-cols-5`, «Реклама» на телефоне —
     `col-span-2`;
   - ряд — `lg:grid-cols-3`, графики — `DailyBars`;
   - обновление раз в минуту сохраняется — с текущим периодом.
5. **`ui/help.ts`:**
   - `HELP.overview.ads` — «Досмотренные показы рекламы за период. Сравнение
     — с прошлым периодом той же длины. Доля досмотра — от показанных»;
   - `HELP.overview.adsPlaces` — «Места, где игра предлагает рекламу. Доля
     досмотра ниже 60% — сеть не отдаёт ролик или место раздражает
     игроков»;
   - `HELP.overview.period` — «Сегодня — с полуночи по Москве против вчера к
     тому же часу; 7 и 30 дней — против предыдущих 7 и 30».

   Тест словаря требует, чтобы каждое пояснение стояло на экране: все три —
   в `Help` у своих заголовков.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- Раздел «Реклама».
- `DailyBars`.
- Сервер — T-0051.

## Сценарий и интерфейс

По макету `design/screens/admin-overview.html`:

- **ПК 1240 px:**
  - «Ждёт вас» из трёх строк;
  - пять плиток, «Реклама» с меткой «новое» — метку не делать, она только в
    макете;
  - вехи полосами;
  - «Реклама сегодня»;
  - шесть графиков.
- **Телефон** — плитки по две, реклама строками.

Пусто:

- рекламы за период нет — панель с текстом «Показов за период не было»;
- без `ads` панели нет.

Снимки на 390, 768 и 1440 px снимают тимлиды.

## Тесты

Первым коммитом, `apps/admin/test/overview.test.ts`:

- `completionPct`: `shown 0` → `null`; 744 / 610 → 82;
- `funnelBars`:
  - 240, 198, 171 → `ofFirst` 1, 0,825, 0,7125;
  - `ofPrev` — `null`, 83, 86;
  - `entered 0` → доли 0, без деления на ноль;
- `networkShares`:
  - 1516 / 706 / 392 → сумма 100;
  - пусто → `[]`;
- `periodTitle` — три периода;
- разбор ответа: `ads: null` и `purchases: null` разбираются.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` §5.2, строка о сводке — что на экране после задачи.

## Критерии приёмки

- [ ] Переключатель «Сегодня · 7 · 30» меняет плитки, вехи, рекламу и ряд;
  выбор помнится.
- [ ] Плитка «Реклама» и панель по местам — при праве `ads.view`. Низкая доля
  досмотра — тоном предупреждения.
- [ ] Вехи — полосами с долей от прошлой.
- [ ] Шесть графиков; без права — без своего.
- [ ] На телефоне — по макету, без горизонтальной прокрутки.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Реклама, периоды и вехи полосами в сводке`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕКЛАМА В СВОДКЕ ПАНЕЛИ**

  В сводке панели появилась реклама: плитка досмотренных показов к прошлому периоду и разбор по местам — где досматривают, где нет. Вехи новичков — полосами, потерю видно с первого взгляда.

  📊 **Что ещё**

  • период — «Сегодня · 7 дней · 30 дней»
  • графики покупок и показов рекламы рядом с остальными
  ```
