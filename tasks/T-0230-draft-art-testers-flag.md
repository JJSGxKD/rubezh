---
id: T-0230
title: Черновой арт — тестерам флагом панели, с выключателем в «Графике»
epic: E12
priority: P1
status: in-progress
owner: claude-13 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: []
zones:
  - packages/app-shell/src/state/flags.ts
  - packages/app-shell/src/state/graphics.ts
  - packages/app-shell/test/flags-state.test.ts
  - packages/app-shell/test/graphics.test.ts
shared:
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/app-shell/src/screens/settings.tsx
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/index.tsx
  - packages/app-shell/src/i18n/ru.json
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0230. Черновой арт — тестерам флагом панели, с выключателем в «Графике»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0230.json)](README.md#значки-статуса)

## Зачем

Черновой арт «Форма-предок» (#461) сейчас включается только в листе
разработчика. Владелец решил вести его к игрокам по шагам: сначала
тестерам, потом всем — по отзывам и замеру кадров на бюджетном Android.
После задачи арт включается флагом в панели: отдельно тестерам и отдельно
всем, а у игрока с доступом в «Графике» есть выключатель «Новый облик боя»,
чтобы сравнить с фигурами.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р143: к игрокам
— в `dev` за флагом разработчика → тестерам флагом панели → всем.

Решения `claude-lead-1` от 24.10.2026:

- **Два ключа флага** в разделе панели «Флаги» (кода в панели не нужно,
  флаги заводятся там же):
  - `art.sprites.testers` — арт получают только тестеры (`tester` в ответе
    входа), доля и площадки — как у любого флага;
  - `art.sprites` — арт получают все, кому флаг включён.

  Доступ = `art.sprites` **или** (`art.sprites.testers` **и** игрок — тестер).
  Так переход «тестерам → всем» — включение второго флага, без релиза.
- **Флаги клиента** — новый `state/flags.ts`: `GET /api/v1/flags` после
  входа, таймаут, Zod-схема `{ data: { flags: Record<string, boolean> } }`;
  ошибка или нет входа → все флаги выключены. Этот модуль — общий: следующие
  флаги клиента берутся из него же.
- **Выключатель «Новый облик боя»** в «Графике» — настройка устройства
  `art` в `state/graphics.ts`, по умолчанию **включён**; строка видна только
  игроку с доступом. Подпись: «Новый облик боя», подсказка: «Тестовый облик
  героя и врагов вместо фигур. Выключи, чтобы сравнить». Старые сохранённые
  настройки читаются с `art: true` — как сделано у `liveBackground`.
- **Движок:** `RunGraphicsOptions` получает `art: boolean`; рендер
  включает арт, если `graphics.art` **или** `dev.visuals.sprites`. Лист
  разработчика продолжает работать как раньше.
- **Аналитика:** `run_ended` получает необязательное поле `art` (булево) —
  как `perf*`: версия события прежняя. По нему сравнивают кадры
  (`perfAvgFps`, `perfP95FrameMs`) с артом и без, а доли удержания — штатным
  сравнением флага в «Воронке».

## Как сейчас

- `backend/api/src/modules/flags/flags.controller.ts:20–23` —
  `GET /api/v1/flags` отдаёт флаги игрока; клиент его не вызывает.
  `flags.service.ts:37` — `forAccount`; правило флага — площадки и доля
  (`flag-rollout.ts:27`).
- `packages/app-shell/src/state/auth-api.ts:30,108` — `tester?: true` в
  ответе входа.
- `packages/core-game/src/run-api.ts:298–305` — `RunGraphicsOptions`
  (`telegraphs`, `weaponEffects`, `damageNumbers`); `RunDevVisuals.sprites`
  — черновой арт.
- `packages/core-game/src/game/render/WorldRenderer.ts` —
  `this.art.setWanted(visuals?.sprites === true, …)`.
- `packages/app-shell/src/state/graphics.ts` — настройки графики,
  `runGraphics()`; `liveBackground` — образец поля, которого нет у старых
  сохранений.
- `packages/app-shell/src/state/run.ts:~805` — `perfFields` в `run_ended`;
  `backend/api/src/modules/events/event-dictionary.ts:70–81` — поля `perf*`
  в схеме `run_ended`.

## Шаги по порядку

1. `docs/22` §3.3 — поле `art` у `run_ended`; `event-dictionary.ts` —
   `art: z.boolean().optional()`.
2. `state/flags.ts` — загрузка, хранилище, `isFlagOn(key)`,
   `draftArtAllowed()`; вызов загрузки — там же, где после входа грузится
   остальное (`index.tsx`).
3. `run-api.ts` — `art` в `RunGraphicsOptions`; `WorldRenderer.ts` —
   `setWanted(graphics.art || visuals?.sprites === true, …)`.
4. `graphics.ts` — поле `art`; `runGraphics()` отдаёт `art:
   draftArtAllowed() && settings.art`.
5. `settings.tsx` — строка в «Графике» только при доступе; тексты — в
   `ru.json`.
6. `run.ts` — `art` в `run_ended` из опций забега.
7. Документы: `docs/27` §7.1 — выключатель «Новый облик боя»;
   `docs/30` — ключи флагов `art.sprites` и `art.sprites.testers`.

## Чего не трогаем

- Сам арт, атласы и рендер кадров (#461).
- Панель флагов и правила флага на сервере.
- Облик врагов в гайдбуке и арсенале.

## Тесты

Первым коммитом.

- `flags-state.test.ts`:
  - ответ `{ "art.sprites.testers": true }` и игрок-тестер → доступ есть;
    тот же ответ, не тестер → нет;
  - `{ "art.sprites": true }` → доступ есть всем;
  - ошибка сети, таймаут, битый ответ → флаги выключены, без падения.
- `graphics.test.ts`:
  - без доступа `runGraphics().art === false` при любой настройке;
  - с доступом по умолчанию `true`, выключатель переживает перезапуск;
  - сохранённое до поля `art` читается с `true`.
- `scripts/test/event-dictionary.test.ts` зелёный.
- Ручная проверка: панель → «Флаги» → `art.sprites.testers` на 100 % →
  тестер видит арт и выключатель, не тестер — фигуры и строки нет; снимок
  в PR.

## Аналитика

Поле `art` в `run_ended` — по шагу 1. Переключение — уже
`settings_changed` (`graphics.art`, `scope: device`).

## Настройки и окружение

Флаги заводятся в панели, переменных окружения нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Флаг `art.sprites.testers` включает арт только тестерам, `art.sprites` — всем.
- [ ] Игрок с доступом может выключить арт в «Графике»; без доступа строки нет.
- [ ] `run_ended` несёт `art`.
- [ ] Без флагов и без сети забег идёт фигурами, как сейчас.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Черновой арт тестерам по флагу`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: тестерам — новый облик героя и врагов, его можно выключить в настройках графики`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЧЕРНОВОЙ АРТ ТЕСТЕРАМ ПО ФЛАГУ**

  Новый облик боя включается флагами панели: art.sprites.testers — только тестерам, art.sprites — всем. У игрока с доступом в «Графике» есть выключатель «Новый облик боя»; run_ended несёт поле art, чтобы сравнить кадры с артом и без.

  ❓ **Нужно от команды**

  • @владелец — после выката завести флаг art.sprites.testers и собрать отзывы тестеров
  ```
