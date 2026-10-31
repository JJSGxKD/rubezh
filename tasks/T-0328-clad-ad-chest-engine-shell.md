---
id: T-0328
title: Второй сундук в кладе за ролик — движок и окно: кнопка «Ещё сундук за ролик» в окне сундука клада, команда в записи забега, сундук из своего потока
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0327, T-0258, T-0260]
zones:
  - packages/core-game/test/ad-chest.test.ts
  - packages/app-shell/src/state/ad-chest.ts
  - packages/app-shell/test/ad-chest.test.ts
shared:
  - packages/core-game/src/game/sim/chests.ts
  - packages/core-game/src/game/sim/secrets.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/game/diagnostics/replay.ts
  - packages/core-game/test/**
  - packages/shared-types/src/index.ts
  - packages/app-shell/src/screens/run/ChestOverlay.tsx
  - packages/app-shell/src/screens/run/chest-rules.ts
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/state/runs.ts
  - packages/app-shell/src/state/ads-api.ts
  - packages/app-shell/src/i18n/ru-run.json
  - packages/app-shell/src/screens/gallery.tsx
  - packages/app-shell/test/**
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/28-diagnostics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0328. Второй сундук в кладе за ролик — движок и окно: кнопка «Ещё сундук за ролик» в окне сундука клада, команда в записи забега, сундук из своего потока

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0328.json)](README.md#значки-статуса) [![T-0327](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0327.json&label=T-0327)](T-0327-clad-ad-chest-server.md) [![T-0258](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0258.json&label=T-0258)](archive/T-0258-secrets-engine-core.md) [![T-0260](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0260.json&label=T-0260)](T-0260-secrets-look-and-blessing.md)

## Зачем

Сервер выдаёт второй сундук клада по показу (T-0327), а в игре его нет.
После задачи в окне сундука, открытого кладом, есть кнопка «Ещё сундук за
ролик». Игрок смотрит ролик и получает второй сундук того же размера сразу,
в том же окне. Раз за забег.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р162: второй сундук в кладе
за ролик, раз за забег, в общий дневной кап роликов.

Решения `claude-lead-1` от 25.10.2026 — механика по образцу рекламного
переброса T-0199:

- **Когда видна кнопка** — в окне сундука, только если одновременно:
  - сундук открыт **кладом** (не элитой и не боссом);
  - второй сундук за ролик в этом забеге ещё не брали;
  - сервер ответил `available` (`GET /runs/:runId/chests/ad`).

  Нет рекламы, кап исчерпан, нет входа — кнопки нет, без объяснений.
- **VIP** — та же кнопка с подписью «Ещё сундук с VIP», без ролика.
- **Нажатие:**
  1. показ ролика (общий `watchAd`, место `clad_chest`);
  2. `POST /runs/:runId/chests/ad { sessionId }`;
  3. ответ сервера → `RunSession.openAdChest()`;
  4. второй сундук открывается в том же окне: награды второго набора
     поверх первого, «Забрать» закрывает окно.

  Связь оборвалась после записи на сервере — сундук пропадает (сервер
  скажет «уже взят»). Принято, как у переброса: защита от повторов важнее.
- **Движок:**
  - команда `~adchest` в логе выбора — рядом с `~adreroll`; принимается,
    только если окно сундука клада открыто и `adChests` ещё 0, иначе запись
    «не ложится на забег»;
  - размер — как у сундука клада (`content/secrets.ts`);
  - содержимое — тем же отбором, что сундуки T-0099, из потока
    `STREAM_SALT.chest`; `world.rng` не трогается;
  - забег без второго сундука не меняется ни на бит — golden прежние;
  - `progression.adChests` — в мире и снимке; в итоге — `adChests` (нет
    поля — 0).
- **Лог выбора** — команда пишется туда же, где `~adreroll`
  (`probe.choice`), поэтому повтор (`replay.ts`) её исполняет, а запись для
  проверки (T-0316, позже) возьмёт её оттуда без правок.
- **Окно** (`ChestOverlay.tsx`):
  - кнопка — второй строкой под «Забрать», не главной: награда уже есть;
  - загрузка ролика — кнопка в загрузке, «Забрать» доступна;
  - ошибка показа — кнопка уходит.

## Как сейчас

- **После T-0258** — клад: постоять 2 с, сундук размера 3 через сундуки
  T-0099; `secrets.ts`, `content/secrets.ts`, `STREAM_SALT.secret`.
- **После T-0260** — облик тайников и окно благословения.
- **После T-0199** — `~adreroll`, `canAdReroll`, `rerollOffersViaAd`,
  `state/ad-reroll.ts`: образец для каждого шага.
- **Сундук** — `game/sim/chests.ts` (`STREAM_SALT.chest`),
  `RunEvents.chestOpened` (`run-api.ts:367`), `closeChest()`.
- **Окно сундука** — `screens/run/ChestOverlay.tsx`, правила —
  `chest-rules.ts`.
- **После T-0327** — место `clad_chest`, `GET` и `POST /runs/:runId/chests/ad`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Движок** — `adChests` в мире и снимке, `canAdChest(world)`, команда,
   `RunEvents.chestOpened.canAdChest`, `RunSession.openAdChest()`, итог.
3. **Клиент** — `state/ad-chest.ts` (проверка, показ, забор), место
   `clad_chest` в `ads-api.ts`, `adChests` в очереди итогов (`state/runs.ts`).
4. **Окно** — кнопка в `ChestOverlay.tsx`; витрина — три состояния.
5. **Аналитика** — `chest_found.source = "clad_ad"`.
6. **`docs/28`** §3.4 — команда `~adchest` в логе выбора.

## Чего не трогаем

- Сервер — T-0327.
- Сундуки элит и боссов: у них кнопки нет.

## Сценарий и интерфейс

- 320 px — кнопка на всю ширину под «Забрать», текст в одну строку.
- Скилл `ui-design`: контраст, зона касания 44 px.
- Настройки (`CLAUDE.md`, «Настройки не отстают от игры»): новой анимации
  нет — второй набор открывается той же анимацией сундука.

## Тесты

Первым коммитом.

- `packages/core-game/test/ad-chest.test.ts`:
  - сундук клада → `canAdChest` истина; сундук элиты — ложь;
  - `~adchest` → второй набор того же размера; повтор — отказ;
  - забег без команды побитно равен прежнему;
  - снимок после второго сундука → продолжение → `adChests` 1;
  - повтор записи с командой → `match`.
- `packages/app-shell/test/ad-chest.test.ts`:
  - `unavailable` → кнопки нет;
  - показ и забор → `openAdChest`;
  - ошибка показа → кнопка уходит, окно закрывается «Забрать»;
  - итог несёт `adChests`.

## Аналитика

`chest_found` с `source: "clad_ad"` для второго сундука — значение в словаре
`docs/22` §3.3; показы — общие события рекламы с местом `clad_chest`.

## Настройки и окружение

Нет.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] В окне сундука клада — «Ещё сундук за ролик», раз за забег; у VIP — без ролика.
- [ ] Второй сундук — из своего потока, в записи забега, забег без него не меняется.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Второй сундук клада за ролик`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: в кладе можно открыть второй сундук за ролик — раз за забег`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВТОРОЙ СУНДУК КЛАДА**

  В окне сундука, открытого кладом, появилась кнопка «Ещё сундук за ролик»: раз за забег, у VIP — без ролика. Второй сундук того же размера открывается сразу и пишется в запись забега. Работает, когда в панели заведены блоки места «Второй сундук клада».
  ```
