---
id: T-0367
title: Граф связей игрока — сервер: игрок и два шага, связи дружбы, приглашения, партнёрки и подарков
epic: E7
priority: P3
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0249, T-0329]
zones:
  - backend/api/src/modules/admin/admin-graph.service.ts
  - backend/api/src/modules/admin/admin-graph.repository.ts
  - backend/api/src/modules/admin/admin-graph.controller.ts
  - backend/api/test/admin-graph.test.ts
  - backend/api/test/admin-graph.integration.test.ts
shared:
  - backend/api/src/modules/admin/admin.module.ts
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0367. Граф связей игрока — сервер: игрок и два шага, связи дружбы, приглашения, партнёрки и подарков

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0367.json)](README.md#значки-статуса) [![T-0249](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0249.json&label=T-0249)](T-0249-vip-gift-server.md) [![T-0329](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0329.json&label=T-0329)](T-0329-appearance-gift-server.md)

## Зачем

Когда разбирают жалобу, спорную выплату партнёру или подозрение на ферму,
нужно видеть, с кем игрок связан. Сейчас связи разбросаны по вкладкам
карточки, и связи связей не видно вовсе. После задачи сервер отдаёт граф:
игрок, его связи и связи этих связей. По нему панель рисует вкладку «Связи»
(T-0368).

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р182. Решения `claude-lead-1`
от 01.11.2026:

- **Маршрут** `GET /admin/players/:accountId/graph` → `{ data: { nodes,
  edges, truncated } }`, право `players.view`.
- **Охват** — центр и два шага: связи центра и связи его связей. Обход в
  ширину, не больше **200 узлов**. Узлы первого шага берутся всегда; сверх
  потолка — `truncated: true`, а обрезаются узлы второго шага с наименьшим
  числом связей.
- **Узлы.**
  - Игрок: `{ kind: "player", id: accountId, name, level, banned }`.
    Имя — `displayName`, как в списке игроков. Юзернейм и ID на площадке не
    отдаются: граф — не способ обойти `players.pii.view`.
  - Партнёр: `{ kind: "partner", id: partnerId, name }`.
- **Связи** — `{ from, to, kind, at }`, `at` — когда связь появилась:
  - `friend` — дружба (`Friendship`);
  - `invite` — привязка по приглашению (`ReferralBinding`), от пригласившего
    к пришедшему;
  - `partner` — привязка к партнёру (`PartnerBinding`), от партнёра к игроку.
    Партнёр — узел; его игроки — второй шаг, без шагов дальше от партнёра:
    у партнёра бывают тысячи игроков;
  - `gift` — подарки, одна связь на пару «от кого → кому» с полем `count`:
    подарки дня (`FriendGift`), VIP в подарок (T-0249), облик в подарок
    (T-0329). В связи — сколько подарков и когда последний.
- **Связи антифрода** — не здесь, а в T-0369. Сервис оставляет для них место:
  у связи есть вид, и источники видов подключаются списком. T-0369 добавит
  свой источник, не трогая обход.
- **Запросы** — пачкой по шагу (`WHERE account_id = ANY($1)`), а не по
  узлу. Таймаут — `READ_TIMEOUT_MS`, как у сводки.
- **Аудит** — открытие графа пишется в аудит панели, как открытие карточки
  с личными данными: кто и чей граф смотрел.

## Как сейчас

- `backend/api/src/modules/admin/admin-social.service.ts` — вкладка «Друзья»
  карточки: друзья, приглашения, партнёр списком.
- Модели — `backend/api/prisma/schema.prisma`: `Friendship` (984),
  `ReferralBinding` (1048), `FriendGift` (1017), `PartnerBinding` (2127).
  Подарки VIP и облика — модели из T-0249 и T-0329.
- `admin-players.controller.ts` — маршруты `admin/players/*`.

## Шаги по порядку

1. Тесты первым коммитом.
2. `admin-graph.repository.ts` — запросы шага по видам связей.
3. `admin-graph.service.ts`:
   - обход, потолок, обрезка;
   - чистая функция `trimGraph(nodes, edges, centerId, max)` — её проверяет
     модульный тест.
4. Контроллер, модуль, аудит.
5. Документы.

## Чего не трогаем

- Вкладку «Друзья» карточки — она остаётся списком.
- Связи антифрода — T-0369.
- Панель — T-0368.

## Тесты

- `admin-graph.test.ts` (модульный, `trimGraph`):
  - 300 узлов → 200; все узлы первого шага на месте; `truncated: true`;
  - меньше потолка → граф как есть, `truncated: false`.
- `admin-graph.integration.test.ts` (живой Postgres):
  - игрок с двумя друзьями, у одного друга свой друг → 4 узла, 3 связи
    `friend`;
  - приглашение → связь `invite` от пригласившего;
  - привязка к партнёру → узел партнёра и связь `partner`; других игроков
    партнёра нет, если центр — игрок; они есть, если обход дошёл до
    партнёра на первом шаге;
  - три подарка дня одной паре → одна связь `gift`, `count: 3`;
  - роль без `players.view` → 403.

## Аналитика

Нет: открытие графа пишется в аудит панели, а не в продуктовую аналитику.

## Настройки и окружение

Нет. Потолок 200 узлов — константа сервиса.

## Документы

- `docs/29-admin-panel.md` — граф связей: охват, виды связей, права.
- `docs/21-diagrams.md` — новый поток «граф связей» в схеме модулей
  панели, если в ней перечислены маршруты.

## Критерии приёмки

- [ ] Граф игрока и двух шагов — с дружбой, приглашениями, партнёром и
      подарками, не больше 200 узлов.
- [ ] Личных данных в графе нет, открытие пишется в аудит.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Граф связей игрока — сервер`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ГРАФ СВЯЗЕЙ: СЕРВЕР**

  Сервер отдаёт граф связей игрока: друзья, приглашения, партнёр и подарки — на два шага от игрока. Вкладка в карточке — следующей задачей.
  ```
