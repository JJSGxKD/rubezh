---
id: T-0359
title: Панель — счётчик «Ждёт вас» на пункте «Сводка» в меню; лёгкий запрос `/admin/attention`
epic: E7
priority: P2
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - apps/admin/src/api/attention.ts
  - apps/admin/src/state/use-attention.ts
  - apps/admin/test/attention.test.ts
shared:
  - docs/29-admin-panel.md
  - design/art/direction-v2.md
  - apps/admin/src/screens/Shell.tsx
  - backend/api/src/modules/admin/admin-overview.service.ts
  - backend/api/src/modules/admin/admin-overview.controller.ts
  - backend/api/test/admin-overview.test.ts
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: design/art/direction-v2.md
batch: 4
---

# T-0359. Панель — счётчик «Ждёт вас» на пункте «Сводка» в меню; лёгкий запрос `/admin/attention`

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0359.json)](../README.md#значки-статуса)

## Зачем

«Ждёт вас» — черновики рассылок коллег и свежие забеги на разбор — видно
только на экране «Сводка». Кто работает в «Игроках» или «Ссылках», не знает,
что его ждёт рассылка на подпись. После задачи у пункта «Сводка» в меню —
число в кружке, и оно видно с любого экрана.

## Решения

Находка AD-10 аудита дизайнера (`design/art/direction-v2.md` §4.6).
Решения `claude-lead-1` от 01.11.2026:

- **Отдельный лёгкий запрос** `GET /admin/attention` → `{ data: { items:
  AttentionItem[] } }`. Тяжёлую сводку ради счётчика гонять нельзя: в ней
  ряды за 30 дней и реклама.
- **Что внутри запроса.** Тот же список, что «Ждёт вас» в сводке:
  `AdminOverviewService.attention` становится публичным
  `attentionFor(actor)`, права пересчитывает сам. Сводка зовёт тот же
  метод, поэтому список в двух местах не разойдётся.
- **Права.** Только `AdminSessionGuard`, без отдельного права: каждый пункт
  списка уже проверяет своё право (`broadcast.send`, `players.view`), и
  чужого человек не увидит.
- **Опрос.** Раз в 60 с, пока вкладка видна (`document.visibilityState`).
  Сразу при входе и при возврате во вкладку. Не ответил — число прежнее,
  ошибку не показываем: это подсказка, а не экран.
- **Число** — сумма `count` по пунктам. Ноль — знака нет. Больше 99 —
  «99+».
- **Знак** — как `TabBadge` клиента (`packages/app-shell`, вкладки):
  число в кружке с обводкой цвета фона меню. Тон — `warning`, как у чисел в
  «Ждёт вас» (`overview-parts.tsx:37`). Панель `app-shell` не импортирует:
  знак — свой маленький компонент в `Shell.tsx`.
- **Где знак.** У пункта «Сводка» в меню, справа от подписи. На телефоне —
  ещё и на кнопке меню в шапке: точка без числа, иначе в свёрнутом меню
  знака не видно. Нет доступа к «Сводке» — знака нет.
- **Подпись для чтения с экрана**: «Ждёт вас: 3».

## Как сейчас

- `backend/api/src/modules/admin/admin-overview.service.ts:196` — приватный
  `attention(actor, can, now)`; `:126` — вызывается в `overview`.
- `admin-overview.controller.ts` — `GET /admin/overview` с
  `analytics.gameplay.view`.
- `apps/admin/src/api/overview.ts:83` — схема `attention`.
- `apps/admin/src/screens/Shell.tsx:200–223` — пункты меню; `:78–82` —
  кнопка меню на телефоне.
- Тест сервиса — `backend/api/test/admin-overview.test.ts:271–290`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Сервер:** `attentionFor(actor)` и маршрут `GET /admin/attention` в том
   же контроллере. Сводка переходит на `attentionFor`.
3. **Панель:**
   - `api/attention.ts` — запрос и Zod-схема;
   - `state/use-attention.ts` — опрос по «Решениям» и сумма;
   - `Shell.tsx` — знак у пункта и точка на кнопке меню.

## Чего не трогаем

- Состав «Ждёт вас» — какие пункты бывают: здесь только показ.
- Пульс в шапке — T-0360.

## Сценарий и интерфейс

- **Коллега сохранил черновик рассылки** — у вас через минуту у «Сводки» в
  меню «1».
- **Открыли «Сводку», разобрали** — после следующего опроса знак пропал.
- **Телефон** — на кнопке меню точка, в листе меню у «Сводки» «1».
- **Сервер не ответил** — знак прежний, ошибки нет.

## Тесты

Первым коммитом:

- `backend/api/test/admin-overview.test.ts`:
  - `GET /admin/attention` у роли с `broadcast.send` возвращает пункт
    рассылок;
  - роль без него этого пункта не получает;
  - сводка и `/admin/attention` отдают одинаковый список.
- `apps/admin/test/attention.test.ts`:
  - схема разбирает ответ;
  - `attentionTotal([])` → `0`;
  - `attentionTotal([{ count: 2 }, { count: 1 }])` → `3`;
  - `badgeText(0)` → `null`, `badgeText(7)` → `"7"`, `badgeText(120)` →
    `"99+"`.

## Аналитика

Нет: служебный опрос панели.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` — «Ждёт вас» виден в меню; маршрут
  `/admin/attention`.
- `docs/21-diagrams.md` — схема модулей не меняется: маршрут в том же
  контроллере.
- `design/art/direction-v2.md` §4.6, строка AD-10: статус «сделано, T-0359».

## Критерии приёмки

- [ ] У «Сводки» в меню — число «Ждёт вас», обновляется раз в минуту.
- [ ] Чужого по правам в числе нет.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Счётчик «Ждёт вас» в меню`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ЖДЁТ ВАС» В МЕНЮ**

  Число «Ждёт вас» теперь видно у пункта «Сводка» с любого экрана панели: черновики рассылок коллег и свежие забеги на разбор не потеряются.
  ```
