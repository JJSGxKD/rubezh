---
id: T-0148
title: Счётчик онлайна — клиент и панель: шапка, кнопка «Играть», разбивка
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0147, T-0176]
zones:
  - packages/app-shell/src/state/online.ts
  - packages/app-shell/src/app/OnlinePill.tsx
  - packages/app-shell/test/online-state.test.ts
  - packages/adapter-telegram/src/ui-telegram.ts
  - packages/adapter-telegram/test/ui-telegram-button-bar.test.ts
  - apps/admin/src/screens/online.tsx
  - apps/admin/src/api/online.ts
shared:
  - packages/shared-types/src/index.ts
  - packages/app-shell/src/app/AppHeader.tsx
  - packages/app-shell/src/screens/home.tsx
  - packages/app-shell/src/i18n/ru.json
  - apps/admin/src/routes.ts
  - apps/admin/src/ui/help.ts
  - docs/27-design-system-and-app-shell.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/mockups/planned-meta-2.html
batch: 3
---

# T-0148. Счётчик онлайна — клиент и панель: шапка, кнопка «Играть», разбивка

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0148.json)](README.md#значки-статуса) [![T-0147](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0147.json&label=T-0147)](archive/T-0147-online-counter-backend.md) [![T-0176](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0176.json&label=T-0176)](T-0176-live-feed-client.md)

## Зачем

Клиентская половина Р107 (`docs/35-stage4-plan.md`) поверх API T-0147.

## Решения

Из Р107 (15.10.2026):

- пинг — раз в `nextPingSec` из ответа, только пока приложение видимо;
  пропускается, если за промежуток был другой запрос в API; в забеге — всегда,
  с `inRun: true`;
- игроку — `online` в шапке по центру между кнопками площадки (полный экран
  Telegram, полоса кнопок поверх приложения), иначе — строкой под шапкой;
  `online: null` — «сегодня играли N»;
- `inRun` — подписью на кнопке «Играть», `null` — подписи нет;
- панель — разбивка по площадкам и рекорд, обновление раз в 15 с.

Решение claude-lead-1 от 19.10.2026: T-0148 зависит от T-0176: обе задачи правят `home.tsx`, и
место под кнопкой «Играть» сначала занимает лента событий.

Решения владельца от 24.10.2026 — макет дизайнера принят
(`design/art/mockups/planned-meta-2.html`, раздел T-0148): открытые вопросы
1, 3 и 4 закрыты им; вопрос 2 решил `claude-lead-1`.

- **Облик** (вопрос 1, по макету):
  - Telegram во весь экран — плашка «● 128 онлайн» в полосе кнопок
    Telegram по центру, между «Закрыть» и меню; на 320–359 px — только
    «● 128», полное — в `aria-label` «128 игроков онлайн»;
  - без полосы кнопок (MAX, VK, веб, Telegram не во весь экран) — та же
    плашка строкой под шапкой по центру, шапку не раздвигает;
  - на ПК (от 1024 px, широкая шапка) — плашка в шапке по центру, между
    аватаром и валютами;
  - `online: null` — «👥 сегодня играли 3,4 тыс.» без точки: точка значит
    «сейчас»; `inRun: null` — у «Играть» подписи нет;
  - чисел нет вовсе (сеть, первый запуск) — плашки нет, без заглушки «—»;
  - точка — зелёная (`success`), медленный пульс 2 с; при «меньше
    движения» стоит.
- **Тексты** (вопрос 3): «{n} онлайн» — слово не склоняется; «сегодня
  играли {n}»; «{n} в забеге» — подписью на «Играть» под словом. Числа —
  `formatCompact` (`i18n/index.ts`): до тысячи как есть, «1,2 тыс.» до
  десяти тысяч, дальше «12 тыс.».
- **Настройка** (вопрос 4): без выключателя — это сведения, а не украшение.
- **Полоса кнопок площадки** (вопрос 2, решение `claude-lead-1`): в этой
  задаче. `PlatformUi` получает необязательное `buttonBar: { top: number;
  height: number } | null` и `onButtonBarChange` — у Telegram во весь экран
  из `contentSafeAreaInsets.top` (полоса кнопок — это контентная зона над
  приложением), иначе `null`; у VK, MAX и браузера — свойства нет, оболочка
  читает его как `null`. Отступы `--app-inset-*` не меняются.
- **Пинг** — `POST /api/v1/online/ping` с `{ inRun }` (T-0147): ответ
  `{ online, inRun, todayPlayed, nextPingSec }`, разбор Zod-схемой; таймаут;
  ошибка — числа прежние до следующего пинга, три ошибки подряд — плашки
  нет.
- **Панель** — раздел «Онлайн» (`apps/admin/src/screens/online.tsx`) под
  правом `analytics.gameplay.view`: таблица площадок «в приложении · в
  забеге · сегодня», итог и рекорд с датой; `GET /admin/online` раз в 15 с,
  пока раздел открыт.

## Как сейчас

- `backend/api/src/modules/online/online.controller.ts:28–34` — пинг;
  `:39–48` — `GET /admin/online`; ответ пинга — `PingResult`
  (`online.service.ts:18–27`): `online`, `inRun`, `todayPlayed`,
  `nextPingSec`, пороги — ключи `online.min-shown`, `online.run-min-shown`.
- `packages/adapter-telegram/src/ui-telegram.ts:50–64` — `pushInsets`
  складывает системную и контентную зоны в один отступ; оболочка полосы
  кнопок не знает.
- `packages/shared-types/src/index.ts:344–…` — `PlatformUi`.
- `packages/app-shell/src/app/AppHeader.tsx` — шапка;
  `packages/app-shell/src/screens/home.tsx` — «Играть» (после T-0176 под
  ней лента событий).
- `packages/app-shell/src/i18n/index.ts:100` — `formatCompact`.

## Шаги по порядку

1. `shared-types` — `buttonBar` и `onButtonBarChange` у `PlatformUi`
   (необязательные), `createNoopPlatformUi` — без них.
2. `ui-telegram.ts` — `buttonBar` из `contentSafeAreaInsets.top` во весь
   экран, событие при смене режима и отступов.
3. `state/online.ts` — пинг по правилам Р107 из «Решений» выше, хранилище
   `{ online, inRun, todayPlayed }`, сброс после трёх ошибок.
4. `app/OnlinePill.tsx` — плашка в трёх местах по макету; `AppHeader.tsx`
   и полоса кнопок — точки монтажа; `home.tsx` — подпись на «Играть».
5. Панель — `api/online.ts`, `screens/online.tsx`, пункт в `routes.ts`,
   справка в `ui/help.ts`.
6. Документы: `docs/27` — плашка онлайна в шапке и на главной;
   `docs/29` — раздел «Онлайн».

## Чего не трогаем

- Сервер онлайна (T-0147) и его пороги.
- Ленту событий под «Играть» (T-0176).
- Отступы `--app-inset-*`.

## Сценарий и интерфейс

Telegram во весь экран, 390 px: в полосе кнопок по центру — «● 128
онлайн», на «Играть» — «37 в забеге». На 320 — «● 128». В браузере на
1440 — плашка в шапке. Состояния: онлайн, «сегодня играли», нет чисел.
Проверить 320, 390, 768, 1440, ландшафт 667×375 и 640×360
(`tasks/README.md`, «Приёмка»).

## Тесты

Первым коммитом.

- `online-state.test.ts`:
  - пинг раз в `nextPingSec`, только пока приложение видимо; пропуск, если
    за промежуток был другой запрос в API; в забеге — всегда, с
    `inRun: true`;
  - `online: null` → `todayPlayed`; все `null` → плашки нет;
  - три ошибки подряд → плашки нет, удачный ответ — возвращает;
  - битый ответ → как ошибка.
- `ui-telegram-button-bar.test.ts` — во весь экран `buttonBar` из
  контентной зоны; обычный режим — `null`; смена режима → событие.
- Снимки на ширинах из «Сценария» — в PR.

## Аналитика

Нет новых событий: пинг — служебный запрос, онлайн считает сервер.

## Настройки и окружение

Нет: пороги — ключи каталога настроек T-0147.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Плашка онлайна — по макету во всех трёх местах и состояниях.
- [ ] «N в забеге» на «Играть»; без числа — без подписи.
- [ ] Раздел «Онлайн» в панели с разбивкой и рекордом.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Счётчик онлайна в шапке и на «Играть»`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: видно, сколько игроков сейчас в игре и сколько в забеге`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЧЁТЧИК ОНЛАЙНА**

  Игрок видит «● 128 онлайн» — в полосе кнопок Telegram, под шапкой или в шапке на ПК — и «37 в забеге» на «Играть»; когда онлайн мал — «сегодня играли N». В панели — раздел «Онлайн»: площадки, итог и рекорд.
  ```
