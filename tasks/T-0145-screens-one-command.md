---
id: T-0145
title: Снимки экранов одной командой — `pnpm screens`
epic: E0
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0144]
zones:
  - scripts/screens/**
  - scripts/test/screens.test.ts
  - packages/app-shell/src/state/dev-url.ts
  - packages/app-shell/test/dev-url.test.ts
  - packages/app-shell/src/state/navigation.ts
  - packages/app-shell/src/state/shell.ts
  - packages/app-shell/src/index.tsx
  - apps/web-telegram/src/main.tsx
shared:
  - package.json
  - pnpm-lock.yaml
  - tasks/README.md
  - .claude/skills/take-task/SKILL.md
  - AGENTS.md
  - docs/17-testing-strategy.md
  - docs/20-env-and-ports.md
runner: local
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 3
---

# T-0145. Снимки экранов одной командой — `pnpm screens`

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0145.json)](README.md#значки-статуса) [![T-0144](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0144.json&label=T-0144)](T-0144-dev-login-as-player.md)

## Зачем

Шаг «снимки на 320, 390, 768 и 1440 px» (`tasks/README.md`, «Автопоток», п. 8)
исполнители не выполняют: в T-0006, T-0007 и T-0017 его пропустили. Из-за
этого в T-0007 не заметили обрезку отсчёта на 320 px (`tasks/inbox.md`, 11.10).
Снимать руками долго, а экран открывается только кликами через стек
навигации. Нужна одна команда, которая сама откроет нужные экраны на шести
размерах и сложит PNG в папку. Исполнитель смотрит снимки сам, тимлид делает те
же снимки на приёмке.

## Решения

Решение `claude-lead-1` от 15.10.2026:

- **Браузер — уже установленный Edge или Chrome**, через `playwright-core`
  точной версии (последняя стабильная на момент PR, без `^`) в
  `devDependencies` корня. Пакет `playwright` и скачивание браузеров не берём:
  postinstall в pnpm 10 заблокирован, а Edge есть на каждой Windows-машине
  команды. Выбор — `--browser msedge|chrome`, по умолчанию `msedge` на Windows и
  `chrome` на остальных.
- **Сам скрипт серверы не поднимает.** Нужен запущенный `pnpm dev` (API и
  клиент Telegram на `5173`, `docs/20` §2) с `AUTH_DEV_LOGIN="true"`. Если адрес
  не отвечает, скрипт завершается с кодом 1 и сообщением «Клиент на
  http://localhost:5173 не отвечает — запустите pnpm dev».
- **Экран открывается адресом, только на dev-сервере и только с localhost.**
  Параметры адреса `?screen=<id>` и `?dev-user=<id:Имя>` работают при
  `import.meta.env.DEV` и `location.hostname` `localhost` или `127.0.0.1`.
  Через туннель они не действуют. Неизвестный id экрана пропускается с
  предупреждением в консоли. `run` и `stress` адресом не открываются: забегу
  нужен старт из листа.
- **Кем снимать:** `--as owner` (по умолчанию) — `dev-shots:Снимки`;
  `--as player` — `dev-player-shots:Игрок`, обычный игрок без ролей (T-0144).
- **В гейт CI команда не входит:** ей нужны живые API, база и браузер.
- **Размеры — четыре портрета и два ландшафта** (решение владельца от
  24.10.2026: приёмка экранов смотрит и ландшафт, `tasks/README.md`,
  «Приёмка»): 320×568, 390×844, 768×1024, 1440×900, 667×375 и 640×360.

## Как сейчас

- `packages/app-shell/src/state/navigation.ts:10–34` — `ScreenId` как
  объединение строк. Массива id нет, проверить строку из адреса нечем.
  Стек начинается с `["lobby"]` (строка 56).
- `apps/web-telegram/src/main.tsx:56–59` — `auth.devUser` берётся из
  `VITE_AUTH_DEV_USER`, только при `import.meta.env.DEV`.
- `packages/app-shell/src/state/shell.ts:22` — `ShellCapabilities`, в нём
  `devTools?` (строка 43) и `auth?` (строка 55).
- `packages/app-shell/src/index.tsx:58` — `mountAppShell(options)`.
- Витрина компонентов — экран `gallery`, нужно право администратора
  (`screens/diagnostics.tsx:121`). Лист «Перед забегом» — `screens/pre-run.tsx`,
  открывается кнопкой «Играть» (`lobby.play`), заголовок листа — «Перед
  забегом» (`weapon.select.screen`).
- Playwright в репозитории нет.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`navigation.ts`** — `export const SCREEN_IDS = [ … ] as const;` и
   `export type ScreenId = (typeof SCREEN_IDS)[number];`. Порядок и состав id
   прежние. Этот рефакторинг — отдельным коммитом.
3. **`state/dev-url.ts`** — чистая функция:
   ```ts
   export interface DevUrlOptions { screen: ScreenId | null; devUser: string | null }
   export function readDevUrl(href: string, isDev: boolean): DevUrlOptions
   ```
   - не dev или хост не `localhost`/`127.0.0.1` — `{ screen: null, devUser: null }`;
   - `screen` — из `SCREEN_IDS`, кроме `run` и `stress`; иначе `null` и
     `console.warn("неизвестный экран в адресе: <значение>")`;
   - `dev-user` — строка до 64 символов как есть (формат проверяет бэкенд),
     пустая — `null`.
4. **`shell.ts`** — в `ShellCapabilities` поле `devStartScreen?: ScreenId`.
   **`index.tsx`** — после монтирования, если поле задано,
   `useNavigation.getState().push(devStartScreen)`. Экспортировать из
   `index.tsx` `readDevUrl` и тип `ScreenId`.
5. **`apps/web-telegram/src/main.tsx`** —
   `const devUrl = readDevUrl(location.href, import.meta.env.DEV);`
   `devUser: import.meta.env.DEV ? (devUrl.devUser ?? import.meta.env.VITE_AUTH_DEV_USER ?? "") : ""`,
   `devStartScreen: devUrl.screen ?? undefined`. Комментарий: адресом
   управляет только локальный dev-сервер, чтобы снимки открывали экран
   без кликов.
6. **`scripts/screens/`**:
   - `scenarios.mjs` — сценарии `{ id, screen?, steps? }`:
     - `lobby` — главная;
     - `gallery` — витрина (`screen: "gallery"`);
     - `prerun` — главная, клик по кнопке «Играть», ждать заголовок
       «Перед забегом»;
   - `shoot.mjs` — разбор аргументов и запуск:
     `pnpm screens [сценарий…] [--screen <id>] [--sizes 320x568,390x844,768x1024,1440x900,667x375,640x360] [--as owner|player] [--browser msedge|chrome] [--base http://localhost:5173] [--out var/screens]`.
     Без сценариев снимаются все три; `--screen <id>` — разовый сценарий
     для любого экрана.
     - Размер окна — `<ширина>x<высота>`; по умолчанию шесть размеров из
       «Решений».
     - Контекст: `reducedMotion: "reduce"`, `deviceScaleFactor: 1`.
     - Перед снимком ждать `networkidle` и `document.fonts.ready`.
     - Файл — `<out>/<сценарий>-<ширина>x<высота>.png`.
     - Ошибки консоли страницы печатаются списком в конце, но код выхода от них
       не зависит. Код 1 — если не открылся адрес или шаг сценария не нашёл
       элемент; в сообщении назван сценарий и шаг.
   - Чистые части — `parseArgs(argv)` и `shotPlan(scenarios, sizes, out)` →
     `[{ scenario, width, height, file, url }]` — экспортируются для теста.
7. **`package.json` корня** — скрипт `"screens": "node scripts/screens/shoot.mjs"`
   и `playwright-core` в `devDependencies`.
8. **Документы:**
   - `docs/17` §8 — абзац «Снимки экранов»: команда, сценарии, где лежат PNG,
     что команда не входит в гейт;
   - `docs/20` — рядом с абзацем про вход разработчика: `?screen=` и
     `?dev-user=` на localhost;
   - `tasks/README.md` («Автопоток», п. 8), скилл `take-task` (шаг 4),
     `AGENTS.md` — по строке: «снимки — `pnpm screens` (нужен `pnpm dev`);
     посмотреть PNG самому, в PR перечислить сценарии, размеры и замеченное».

## Чего не трогаем

- `apps/web-max`, `apps/web-vk`: входа разработчика там нет. Помощник лежит в
  оболочке, и подключить его там — одна строка, когда вход появится.
- Сборку: в сборке `readDevUrl` всегда даёт пустой результат, имя разработчика
  в бандл не попадает.
- `ci.yml` и гейт.

## Тесты

- `dev-url.test.ts`:
  - `http://localhost:5173/?screen=shop`, dev → `screen: "shop"`;
  - тот же адрес, не dev → `{ null, null }`;
  - хост туннеля `https://dev-tg.example/?screen=shop`, dev → `{ null, null }`;
  - `?screen=run` → `null`;
  - `?screen=nope` → `null` и предупреждение;
  - `?dev-user=dev-player-a:Игрок` → `devUser: "dev-player-a:Игрок"`;
  - пустой `dev-user` → `null`;
  - строка длиннее 64 символов → `null`.
- `scripts/test/screens.test.ts`:
  - `parseArgs([])` → все сценарии, шесть размеров, `owner`, браузер по
    платформе;
  - `--sizes 390x844` → один размер; `--sizes 0x0`, `--sizes abc` и
    `--sizes 390` → ошибка;
  - `--as player` → `dev-player-shots:Игрок` в адресе;
  - `shotPlan` даёт имя `prerun-320x568.png`, ширину 320 и высоту 568;
  - `--screen tasks` → адрес с `screen=tasks`.
- Ручной прогон на `pnpm dev`: `pnpm screens` даёт 18 PNG. Снимки `lobby-390x844` и
  `prerun-667x375` приложить к PR.

## Аналитика

Нет. `screen_viewed` от экрана, открытого адресом, уходит как обычно.

## Настройки и окружение

Новых переменных нет. Новая зависимость — `playwright-core`, только для
разработки.

## Документы

Шаг 8.

## Критерии приёмки

- [ ] `pnpm screens` при запущенном `pnpm dev` даёт 12 PNG в `var/screens/`.
- [ ] `pnpm screens --screen shop --as player` снимает магазин глазами игрока.
- [ ] Без запущенного клиента — понятная ошибка и код 1.
- [ ] Параметры адреса не действуют в сборке и через туннель (тест).
- [ ] Гейт (`CLAUDE.md`) зелёный, бюджет первой загрузки не вырос больше чем
  на 0,3 КБ.

## PR

- **Заголовок:** `feat(dev): Снимки экранов одной командой`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СНИМКИ ЭКРАНОВ ОДНОЙ КОМАНДОЙ**

  `pnpm screens` снимает главную, витрину и лист «Перед забегом» на 320, 390, 768 и 1440 px и в двух ландшафтах, 667×375 и 640×360, через установленный Edge или Chrome. Любой экран — `--screen <id>`, глазами игрока — `--as player`. Нужен запущенный `pnpm dev`, в гейт CI команда не входит.
  ```
