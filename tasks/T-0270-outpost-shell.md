---
id: T-0270
title: Застава — клиент: экран с тремя постройками, улучшение за монеты и забор дохода башни
epic: E16
priority: P3
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0269, T-0268]
zones:
  - packages/app-shell/src/state/outpost-api.ts
  - packages/app-shell/src/screens/meta/outpost.tsx
  - packages/app-shell/test/outpost.test.ts
shared:
  - packages/app-shell/src/app/MainMenu.tsx
  - packages/app-shell/src/state/navigation.ts
  - packages/app-shell/src/app/lazy-screens.tsx
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/gallery.tsx
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 5
---

# T-0270. Застава — клиент: экран с тремя постройками, улучшение за монеты и забор дохода башни

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0270.json)](README.md#значки-статуса) [![T-0269](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0269.json&label=T-0269)](T-0269-outpost-server.md) [![T-0268](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0268.json&label=T-0268)](T-0268-clans-shell.md)

## Зачем

Сервер Заставы (T-0269) готов, а экрана нет. После задачи из главного меню
открывается «Застава»:
- три постройки с уровнем, эффектом и ценой следующего уровня;
- улучшение — одной кнопкой;
- у башни — накопленные монеты и «Забрать».

## Решения

Решения владельца — Р154 и поправка 24.10.2026 (монеты, без новой валюты).

Решения `claude-lead-1` от 24.10.2026:

- **Вход** — пункт «Застава» в главном меню; у пункта знак-точка, когда
  башня накопила не меньше половины потолка.
- **Экран** `outpost.tsx` — три карточки:
  - заголовок «Кузня · ур. 2», эффект «Урон +2 % → +3 %»;
  - кнопка «Улучшить · 6 000» с отключением и причиной «Не хватает монет»;
  - уровень 5 — «Наибольший уровень».

  У башни — «Накоплено: 140 · копится до 8 ч» и «Забрать».

  Облик постройки — значком из набора проекта, пока дизайнер не нарисует
  Заставу.
- **Отклик** — начисление и трата монет откликом счёта (#460).

## Как сейчас

- Главное меню — `app/MainMenu.tsx`; экраны — `state/navigation.ts`,
  `app/lazy-screens.tsx`.
- После T-0269 — `GET /api/v1/outpost`, улучшение, забор.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`state/outpost-api.ts`** — схемы, вызовы, коды ошибок.
3. **`outpost.tsx`**, пункт меню и экран в навигации.
4. **Витрина** — экран на нулевых уровнях и на пятом.
5. **События** `outpost_built { building, level }`, `outpost_collected { coins }`
   — сначала `docs/22` §3.3 и Zod, потом `state/analytics.ts`.
6. **Тексты `ru.json`:**
   - экран и постройки: «Застава», «Кузня», «Капище», «Сторожевая башня»;
   - уровни и эффекты: «ур. {level}», «Урон +{from} % → +{to} %», «Здоровье +{from} % → +{to} %», «{coins} монет в час»;
   - кнопки: «Улучшить · {price}», «Не хватает монет», «Наибольший уровень»;
   - башня: «Накоплено: {coins} · копится до 8 ч», «Забрать».
7. **`docs/27`** — «Застава» в карте экранов.

## Чего не трогаем

- Сервер — T-0269.

## Сценарий и интерфейс

Меню → «Застава» → «Кузня · ур. 0 → Урон +1 %» → «Улучшить · 1 000» → ур. 1.
Башня — «Накоплено: 160» → «Забрать» → +160 со счётом. Проверить 320, 390,
768, ландшафт 667×375. Состояния: загрузка, ошибка, нет сети, гость (пункта
нет).

## Тесты

Первым коммитом, `outpost.test.ts`:
- разбор ответа;
- кнопка выключена при нехватке монет и на пятом уровне;
- 409 `insufficient_funds` → перечитать и показать причину.

## Аналитика

По шагу 5.

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Экран Заставы: три постройки, улучшение за монеты, забор дохода башни.
- [ ] Знак на пункте меню, когда башня накопила половину.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Застава`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: Застава — кузня и капище дают постоянные прибавки, башня копит монеты, пока вы не в игре`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАСТАВА**

  В главном меню — «Застава»: кузня (+урон), капище (+здоровье) и сторожевая башня, которая копит монеты до 8 часов вне игры. Улучшения — за монеты.
  ```
