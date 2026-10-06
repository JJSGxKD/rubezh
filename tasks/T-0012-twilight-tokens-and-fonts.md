---
id: T-0012
title: Палитра, шрифты и скругления направления «Сумеречный рубеж»
epic: E12
priority: P1
status: done
owner: claude-2 / sonnet-5.5
size: M
depends_on: []
zones:
  - packages/design-tokens/src/tokens.css
  - packages/design-tokens/src/index.ts
  - packages/design-tokens/test/tokens.test.ts
  - packages/app-shell/src/design-system/fonts.css
  - packages/app-shell/test/tokens.test.ts
  - apps/admin/src/styles.css
shared:
  - packages/app-shell/package.json
  - apps/admin/package.json
  - pnpm-lock.yaml
  - scripts/bundle-budget.mjs
  - docs/27-design-system-and-app-shell.md
  - CLAUDE.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/directions/directions-2026-10-c.html
---

# T-0012. Палитра, шрифты и скругления направления «Сумеречный рубеж»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0012.json)](README.md#значки-статуса)

## Зачем

Визуальное направление выбрано (решения пользователя 06.10.2026, `design/README.md`):
- **палитра** — «Сумеречный рубеж»: фиолетово-синие сумерки, оранжевый жар
  очага, бирюза оберегов;
- **шрифты** — Russo One для заголовков и IBM Plex Sans для текста;
- **грани** — строгие, скругления маленькие.

Систему так и строили: направление меняется правкой двух файлов токенов, а не
экранов (`CLAUDE.md`, «Структура и зоны»). Эта задача меняет базовые токены и
шрифты. Срезанные углы — T-0013, вид боя — отдельной задачей.

## Решения

- Палитра — таблица ниже, значения точные. Цвета чужих валют (`stars`,
  `on-stars`) и наши валюты (`coin-*`, `gem-*`) **не меняются**.
- Появляется второй акцент — бирюза оберегов: токены `secondary` и
  `on-secondary`.
- Полоса здоровья становится розово-красной, опыт — лаймовым, как в макете:
  - `hp` — `#ff6f90`, низкое здоровье `hp-low` — `#ff3b5c`;
  - `xp` — `#b6ff4a`.
- Скругления меньше: 4 / 6 / 8 / 10 px вместо 8 / 12 / 18 / 24. `pill`
  остаётся для переключателей и полос.
- Размер среза для T-0013 — тоже токен: `--cut-sm: 8px`, `--cut-md: 10px`.
- **Шрифты** — свои файлы в бандле, как сейчас (`fonts.css`), только кириллица
  и латиница:
  - Russo One — `@fontsource/russo-one` 5.3.0, файлы `russo-one-{cyrillic,latin}-400-normal.woff2`;
  - IBM Plex Sans — `@fontsource-variable/ibm-plex-sans` 5.3.0, файлы `ibm-plex-sans-{cyrillic,latin}-wght-normal.woff2`.

  Вместе около 87 КБ — меньше нынешних Rubik и Inter, бюджет шрифтов (120 КБ)
  не трогаем.
- **У Russo One одно начертание.** Чтобы браузер не рисовал поддельный
  полужирный там, где у заголовков `font-bold`, в `@font-face` указывается
  диапазон `font-weight: 100 900`: все веса берут один и тот же файл.
- **Панель** берёт палитру и гарнитуры из того же пакета (`docs/29-admin-panel.md`
  §4), поэтому она тоже переходит на новые шрифты. Своя система панели — позже,
  эпик E7.

| Токен (`--color-…`) | Было | Стало |
|---|---|---|
| `bg` | `#07090e` | `#1d1c31` |
| `surface` | `#121622` | `#28273f` |
| `surface-raised` | `#1b2130` | `#353452` |
| `surface-sunken` | `#0b0e15` | `#17162a` |
| `border` | `#262e40` | `#43425f` |
| `border-strong` | `#3a4560` | `#5b5980` |
| `text` | `#f3f6fc` | `#f3eee6` |
| `text-muted` | `#a8b2c6` | `#aeaac4` |
| `text-disabled` | `#69738a` | `#6f6c8a` |
| `accent` | `#ffb22e` | `#ff8f3f` |
| `accent-pressed` | `#f09a12` | `#f0782a` |
| `accent-glow` | `#ffd27a` | `#ffb67f` |
| `accent-edge` | `#a85a06` | `#a0582a` |
| `on-accent` | `#1d1102` | `#230f02` |
| `secondary` | — | `#46d9c6` (новый) |
| `on-secondary` | — | `#062b26` (новый) |
| `danger` | `#ff5d5d` | `#ff5d5d` |
| `warning` | `#ff8c42` | `#ffc14d` (иначе сливается с новым акцентом) |
| `success` | `#5fe3a1` | `#8ee86b` (иначе сливается с бирюзой) |
| `info` | `#5ccfff` | `#5ccfff` |
| `hp` | `#5fe3a1` | `#ff6f90` |
| `hp-low` | `#ff5d5d` | `#ff3b5c` |
| `xp` | `#5ccfff` | `#b6ff4a` |
| `elite` | `#ffd36b` | `#ffd15c` |
| `weapon`, `passive` | — | без изменений |

## Как сейчас

- `packages/design-tokens/src/tokens.css`, блок `@theme`: палитра
  `--color-*`, гарнитуры `--font-display` / `--font-text`, шкала текста,
  `--radius-*`, тени, кривые. В шапке файла и у групп — комментарии про
  направление этапа 2 («почти чёрный фон», «янтарь»).
- `packages/design-tokens/src/index.ts`:
  - `COLORS` — те же цвета числами для канвы;
  - `CSS_VAR_BY_COLOR`;
  - `FONT_FAMILY` (`display: "Rubik Variable"`, `text: "Inter Variable"`).
- `packages/design-tokens/test/tokens.test.ts`: цвета CSS и `COLORS`
  совпадают, у каждого цвета CSS есть число.
- `packages/app-shell/src/design-system/fonts.css`: `@font-face` для Rubik
  Variable и Inter Variable из `@fontsource-variable/*`, с `unicode-range` и
  `font-display: swap`.
- `packages/app-shell/package.json`: зависимости
  `@fontsource-variable/inter` и `@fontsource-variable/rubik` 5.3.0.
- `packages/app-shell/src/design-system/tokens.css` (поверхности, кнопки,
  анимации) **не содержит ни одного hex**: всё выводится из базовых токенов.
  Поэтому смена палитры дойдёт до экранов сама.
- `apps/admin/src/styles.css`: `@import "@fontsource-variable/inter"` и
  `"@fontsource-variable/rubik"`.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **`design-tokens/src/tokens.css`:**
   - значения по таблице;
   - новые `--color-secondary` и `--color-on-secondary` — после группы
     «действие», с комментарием «бирюза оберегов — второй акцент: значки
     разделов, обереги, выделение без призыва к действию»;
   - `--radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 10px;`;
   - после радиусов — `--cut-sm: 8px; --cut-md: 10px;` с комментарием, что это
     размер срезанного угла (T-0013, `design/README.md`);
   - `--font-display: "Russo One", "Segoe UI", system-ui, sans-serif;`;
   - `--font-text: "IBM Plex Sans Variable", system-ui, "Segoe UI", Roboto, sans-serif;`;
   - комментарии шапки и групп переписать под «Сумеречный рубеж»: что за
     направление и почему такие цвета, без истории «было — стало».
3. **`design-tokens/src/index.ts`:**
   - `COLORS` и `CSS_VAR_BY_COLOR` — те же значения, включая `secondary` и
     `on-secondary`;
   - `FONT_FAMILY` — `"Russo One"` и `"IBM Plex Sans Variable"`.
4. **Зависимости.**
   - `packages/app-shell/package.json`: убрать `@fontsource-variable/inter` и
     `@fontsource-variable/rubik`, добавить `"@fontsource/russo-one": "5.3.0"` и
     `"@fontsource-variable/ibm-plex-sans": "5.3.0"` — точные версии;
   - `apps/admin/package.json` — то же;
   - `pnpm install`, лок-файл — как его записал pnpm.

   Если Inter или Rubik ещё где-то импортированы (поиск
   `@fontsource-variable/inter` и `rubik` по `packages` и `apps`) — вопрос
   тимлидам: из зон эта задача не выходит.
5. **`app-shell/src/design-system/fonts.css`.** По образцу нынешних
   `@font-face`:
   - **Russo One:** `font-family: "Russo One"`, `font-weight: 100 900` (почему —
     в «Решениях»), два файла `@fontsource/russo-one/files/russo-one-{cyrillic,latin}-400-normal.woff2`;
     `unicode-range` — из `index.css` пакета;
   - **IBM Plex Sans Variable:** `font-weight: 100 700` (диапазон пакета), два
     файла `@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-{cyrillic,latin}-wght-normal.woff2`,
     `unicode-range` — из пакета.

   Комментарии над блоками — «акцидентная: заголовки, кнопки, крупные цифры»
   и «текстовая».
6. **`apps/admin/src/styles.css`.** Вместо двух импортов —
   `@import "@fontsource/russo-one/400.css";` и
   `@import "@fontsource-variable/ibm-plex-sans";`.
7. **Документы.**
   - `docs/27-design-system-and-app-shell.md`:
     - §4.1 — новое направление одним абзацем и ссылкой на `design/README.md`;
     - §4.3 — гарнитуры;
     - строка шрифтов в таблице бюджета §3.4 — новое фактическое значение.
   - `CLAUDE.md`, «Структура и зоны»: фразу «Значения там — направление этапа 2
     (тёмная тема высокой контрастности…) до решения по сеттингу» заменить на
     «Значения там — направление «Сумеречный рубеж» (`design/README.md`)».
8. **Гейт и снимки.** `pnpm budget`: шрифты должны уменьшиться. Снимки на 390
   px до и после — в PR: главная, магазин, забег с HUD, экран смерти,
   настройки. Один снимок панели — сводка.

## Чего не трогаем

- `packages/app-shell/src/design-system/tokens.css` — в нём нет цветов. Если
  после смены палитры что-то стало нечитаемым из-за правила в этом файле — это
  вопрос тимлидам, со снимком.
- Цвета движка в `packages/core-game/src/game/render/looks.ts` — вид боя
  отдельной задачей.
- Экраны и компоненты: ни одного класса в них не меняем.

## Тесты

1. `packages/design-tokens/test/tokens.test.ts`:
   - новый кейс «палитра «Сумеречный рубеж»»: `COLORS.bg === "#1d1c31"`,
     `COLORS.accent === "#ff8f3f"`, `COLORS.secondary === "#46d9c6"`,
     `COLORS.xp === "#b6ff4a"`;
   - `FONT_FAMILY` — `{ display: "Russo One", text: "IBM Plex Sans Variable" }`.

   Существующие кейсы сверки CSS и чисел остаются и должны быть зелёными.
2. `packages/app-shell/test/tokens.test.ts`: если в нём есть ожидания про
   Rubik или Inter, перевести их на новые гарнитуры. Добавить кейс:
   `fonts.css` объявляет `"Russo One"` с `font-weight: 100 900` и
   `"IBM Plex Sans Variable"`.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Шаг 7.

## Критерии приёмки

- [ ] Все цвета — по таблице. `stars`, `coin-*`, `gem-*` не изменились.
- [ ] Шрифты Russo One и IBM Plex Sans грузятся из бандла, Inter и Rubik из зависимостей ушли.
- [ ] Заголовки с `font-bold` не синтезируют поддельный полужирный.
- [ ] `pnpm budget`: шрифты меньше прежнего, порог не тронут.
- [ ] Снимки до и после — в PR.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(design-tokens): Направление «Сумеречный рубеж»`
- **Метка:** `release: minor`
- **Для игроков:** `- изменено: У игры новый облик — сумеречная палитра, новые шрифты и строгие грани.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НАПРАВЛЕНИЕ «СУМЕРЕЧНЫЙ РУБЕЖ»**

  У игры выбрано визуальное направление: фиолетово-синие сумерки, оранжевый жар очага, бирюза оберегов, шрифты Russo One и IBM Plex Sans, строгие грани. Сменились только токены — экраны подхватили облик сами. Срезанные углы и вид боя — следующими задачами.
  ```
