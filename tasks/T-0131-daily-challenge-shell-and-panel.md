---
id: T-0131
title: Испытание дня — вход с главной, лист испытания, таблица дня, расписание в панели
epic: E10
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0130, T-0166, T-0190, T-0196]
zones:
  - packages/app-shell/src/screens/challenge.tsx
  - packages/app-shell/src/screens/challenge-rules.ts
  - packages/app-shell/src/api/challenge-api.ts
  - packages/app-shell/src/screens/home-widget-rules.ts
  - packages/app-shell/src/screens/home-widgets.tsx
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/i18n/ru-challenge.json
  - packages/app-shell/test/challenge-rules.test.ts
  - packages/app-shell/test/challenge-api.test.ts
  - packages/app-shell/test/home-widgets.test.ts
  - apps/admin/src/api/challenge.ts
  - apps/admin/src/screens/challenge/**
  - apps/admin/test/challenge.test.ts
shared:
  - packages/app-shell/src/i18n/index.ts
  - apps/admin/src/routes.ts
  - apps/admin/src/screens/sections.tsx
  - docs/27-design-system-and-app-shell.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0131. Испытание дня — вход с главной, лист испытания, таблица дня, расписание в панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0131.json)](README.md#значки-статуса) [![T-0130](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0130.json&label=T-0130)](T-0130-daily-challenge-server.md) [![T-0166](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0166.json&label=T-0166)](T-0166-narrow-screen-leftovers.md) [![T-0190](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0190.json&label=T-0190)](T-0190-single-difficulty-shell.md) [![T-0196](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0196.json&label=T-0196)](T-0196-player-power-pressure-wiring.md)

## Зачем

Испытание дня (`docs/39-retention-mechanics.md` §4.1 Б9, Р105) — один забег на
всех на игровые сутки: те же seed, оружие и модификатор, два захода, награда за
участие и таблица дня. Движок (T-0129) и сервер (T-0130) готовят его целиком,
но игрок его не видит. После задачи на главной есть виджет «Испытание дня», из
него открывается лист испытания с набором, заходами и таблицей, а команда
правит расписание в панели.

## Решения

**Поправка `claude-lead-1` от 20.10.2026 (Р126, единая сложность).** Сложность испытания у игрока не показывается — она одна; колонка сложности в таблице суток панели остаётся как история.

- **Р105** и `docs/39` Б9 — что такое испытание; T-0130 — контракт API (шаги 5
  и 6 её спецификации), T-0129 — как движок принимает набор
  (`RunOptions.challenge`).
- **Вход — виджет главной** рядом с «Наградой дня» и колесом
  (`home-widget-rules.ts`): готов, пока есть свободный заход или награда к
  получению. Выключено на сервере (`enabled: false`) — виджета нет.
- **Лист испытания — по образцу листа «Перед забегом»** (`pre-run.tsx`): набор
  без выбора — оружие, модификатор, сложность читаются, но не меняются. Второй
  заход — за рекламу, как второй шанс (`AdContinue`, `SecondChance.tsx`),
  после завершённого первого.
- **Таблица дня** — в том же листе вкладками «Сегодня» и «Вчера», до 50 строк и
  своё место.
- **Панель** — раздел «Испытания» в группе «Вовлечение», право `challenge`
  (заводит T-0130), 14 будущих суток с предпросмотром генератора и 7 прошлых со
  счётчиками.
- **Подтверждено `claude-lead-1` 14.10.2026 по умолчанию:** бустов в испытании
  нет — лист их не предлагает (набор у всех одинаковый, иначе сравнение
  нечестное).

## Как сейчас

- **Старт забега** — `packages/app-shell/src/screens/pre-run.tsx:103–122`:
  `useRun.getState().intend({ kind: "new", boosts })`, затем
  `navigation.push("run")`. Тип намерения — `RunIntent` в
  `packages/app-shell/src/state/run.ts:56`: `new` и `resume`; набора испытания
  в нём нет.
- **Виджеты главной** — `packages/app-shell/src/screens/home-widget-rules.ts:22`:
  `WidgetId = "daily" | "wheel" | "tasks" | "record" | "friends"`, порядок —
  `READY_ORDER` и `REST_ORDER` (строки 39–40), раскладка — `arrangeWidgets`;
  облики — `home-widgets.tsx`.
- **Реклама за заход** — образец получения `adSessionId` у второго шанса:
  `packages/app-shell/src/screens/run/AdContinue.tsx`.
- **Разделы панели** — `apps/admin/src/routes.ts` (строка раздела «Задания»:
  `id: "tasks"`, `permission: "tasks.edit"`) и `apps/admin/src/screens/sections.tsx`.
- **Сервер** (после T-0130): `GET /api/v1/challenge`, `POST /api/v1/challenge/attempts`,
  `POST /api/v1/challenge/reward/claim`, `GET /api/v1/challenge/board?day=`;
  панель — `GET|PUT|DELETE /api/v1/admin/challenge/plans…`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`api/challenge-api.ts`** — клиент по образцу соседних клиентов оболочки:
   Zod-схемы ответов T-0130 дословно по полям, функции `fetchChallenge()`,
   `issueAttempt(attemptNo, adSessionId?)`, `claimChallengeReward(dayKey)`,
   `fetchChallengeBoard(day)`. Отказы `disabled`, `taken`, `order`,
   `ad_required`, `no_ads` — кодами, не текстом.
3. **`challenge-rules.ts`** — чистые функции:
   - `challengeWidget(view)` → `null` (выключено), `{ state: "ready" | "reward" | "done", attemptsLeft, secondsLeft }`;
   - `attemptButton(view)` → какой заход предложить: `{ no: 1, cost: "free" }`,
     `{ no: 2, cost: "ad" }` или `null`;
   - `boardRows(board, meId)` — строки с отметкой «вы».
4. **`state/run.ts`** — `RunIntent` += `{ kind: "challenge"; set: DailyChallengeSet; runId: string }`.
   Тип набора берётся из `core-game` (T-0129, через `index.ts`). Запуск забега с
   таким намерением передаёт набор в `RunOptions.challenge`; бусты и выбор
   оружия не применяются.
5. **Виджет** — `home-widget-rules.ts`: `WidgetId` += `"challenge"`, в
   `READY_ORDER` — после `"wheel"`; облик в `home-widgets.tsx` из существующих
   элементов виджетов: заголовок «Испытание дня», подпись — «Осталось заходов: N»,
   «Награда ждёт» или «Сегодня пройдено», отсчёт до новых суток тем же
   `formatCountdown`.
6. **Лист — `screens/challenge.tsx`** (`Modal` снизу, как «Перед забегом»):
   - набор: плитки оружия и модификатора без выбора, сложность строкой;
   - кнопка «В бой» — первый заход; после завершённого первого — «Ещё заход за
     рекламу» (реклама — как у второго шанса), заходов нет — кнопки нет;
   - «Забрать награду» при `reward.state = "ready"`;
   - вкладки «Сегодня» и «Вчера» — таблица дня, своё место и «из N игроков»;
   - отказ сервера — текстом по коду; нет сети — плашка связи уже есть (T-0015).
7. **Тексты — `i18n/ru-challenge.json`** (подключить в `i18n/index.ts`):
   «Испытание дня», «Один забег на всех: одинаковое оружие и правила»,
   «В бой», «Ещё заход за рекламу», «Осталось заходов: {n}», «Награда ждёт»,
   «Забрать награду», «Сегодня пройдено», «Сегодня», «Вчера», «Ваше место: {place} из {total}»,
   «Испытания сегодня нет», «Заходы на сегодня закончились», «Сначала завершите
   первый заход», «Реклама сейчас недоступна».
8. **Панель — `apps/admin/src/api/challenge.ts`** и
   **`screens/challenge/`**: раздел «Испытания» (группа «Вовлечение», право
   `challenge`) — таблица суток: дата, оружие, модификатор, сложность, источник
   («расписание» или «генератор»), для прошлых — игроков, заходов, лучшее
   время; форма суток — оружие из списка сервера, модификатор (нет или один),
   сложность, `seed` (пусто — генератор); «Сбросить к генератору». Сутки с
   выданными заходами — только чтение (ответ 409 сервера показывается текстом).
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Сервер и движок испытания — T-0129, T-0130.
- Обычный старт забега, лист «Перед забегом» и его бусты.
- Награды и правила второго шанса.
- Таблицы сезона и вечного рейтинга (`rating.tsx`).

## Сценарий и интерфейс

Главная → виджет «Испытание дня» → лист испытания → «В бой» → забег с набором
дня → экран смерти, как обычно → снова главная, виджет показывает «Осталось
заходов: 1» или «Награда ждёт».

Проверка глазами на 320, 390, 768 и 1440 px и в ландшафте: лист без
прокрутки вбок, таблица дня читается, длинное имя переносится.

## Тесты

- `challenge-rules.test.ts`: `challengeWidget` — выключено → `null`; заход 1
  свободен → `ready`, `attemptsLeft: 2`; первый завершён, второй доступен за
  рекламу → `ready`, `attemptsLeft: 1`; оба сделаны, награда ждёт → `reward`;
  награда забрана → `done`; `attemptButton` для каждого состояния заходов;
  `boardRows` отмечает своё место.
- `challenge-api.test.ts`: разбор ответа `GET /` по схеме, `seed` в нём не
  ожидается; `issueAttempt` отдаёт набор с `seed`; коды отказов доходят как
  коды; кривой ответ — ошибка разбора, а не падение.
- `home-widgets.test.ts`: виджет испытания встаёт после колеса, когда готов, и
  пропадает при `enabled: false`.
- `apps/admin/test/challenge.test.ts`: разбор списка суток (расписание и
  генератор), форма отправляет `PUT` с полями, `seed` пустой не отправляется,
  ответ 409 — текст «Сутки уже начались: заходы выданы».

## Аналитика

Новых событий нет: заходы, награда и таблица пишутся сервером (T-0130), забег
— обычными событиями забега с `challenge` в итоге.

## Настройки и окружение

Нет: включение — ключ сервера из T-0130.

## Документы

- `docs/27` — строка экрана «Испытание дня» в каталоге экранов и виджет главной.
- `docs/29` — раздел «Испытания» и право `challenge` в матрице.

## Критерии приёмки

- [ ] Виджет «Испытание дня» есть на главной, пока у игрока свободный заход или
  награда к получению; при выключенном испытании его нет.
- [ ] Лист показывает набор без выбора; «В бой» запускает забег с набором дня;
  второй заход — только за рекламу и после первого.
- [ ] Награда забирается из листа; таблица «Сегодня» и «Вчера» показывает своё
  место.
- [ ] Бустов в испытании нет.
- [ ] Раздел панели «Испытания»: 14 будущих суток и 7 прошлых, правка будущих,
  начатые — только чтение.
- [ ] Тексты — ключами i18n, визуальные значения — токенами, анимации — только
  transform/opacity.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Испытание дня — виджет, лист и таблица`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: испытание дня — один забег на всех с одинаковым оружием, два захода и таблица дня`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ИСПЫТАНИЕ ДНЯ НА ГЛАВНОЙ**

  Испытание дня появилось у игрока: виджет на главной, лист с набором дня, два захода (второй за рекламу), награда за участие и таблица дня. Команда правит расписание в панели, раздел «Испытания».

  ❓ **Нужно от команды**

  • @участник1 — включить испытание ключом в настройках, когда будет готово
  ```
