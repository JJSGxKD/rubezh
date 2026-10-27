---
id: T-0278
title: Пролог первого забега — движок: таймлайн трёх минут, оберег 25 %, большой первый сундук, «Советуем» и победа над Стражем
epic: E16
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0120]
zones:
  - packages/core-game/src/content/prologue.ts
  - packages/core-game/src/game/run/prologue.ts
  - packages/core-game/test/prologue.test.ts
  - packages/core-game/test/prologue-balance.test.ts
shared:
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/index.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/step.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/sim/timeline.ts
  - packages/core-game/src/game/sim/chests.ts
  - packages/core-game/src/game/sim/events.ts
  - packages/core-game/src/game/progression/levels.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/content/hash.ts
  - packages/core-game/src/content/balance-targets.ts
  - packages/shared-types/src/index.ts
  - docs/30-configuration-map.md
  - docs/32-balance.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: design/art/meta-v2.md
batch: 6
---

# T-0278. Пролог первого забега — движок: таймлайн трёх минут, оберег 25 %, большой первый сундук, «Советуем» и победа над Стражем

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0278.json)](README.md#значки-статуса) [![T-0120](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0120.json&label=T-0120)](T-0120-rubezh-guard-engine.md)

## Зачем

Новичок часто умирает на 2–4-й минуте первого забега, не увидев ни
сундука, ни босса, и уходит с чувством «меня побили». Пролог — первый
забег аккаунта, рассказанный за три минуты:
- сила растёт с первых секунд;
- в 1:30 — большой сундук;
- в 2:40 — настоящий Страж рубежа;
- конец — победа.

После задачи движок умеет режим `prologue`: таймлайн из данных, оберег,
который не даёт умереть, гарантированный большой первый сундук,
«советуемая» карточка и конец забега победой над Стражем. Сервер и
оболочка — T-0279, T-0280.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р151:
- пролог — поверх обучающего забега T-0190, после Стража рубежа T-0120;
- 3 минуты, подсказки по событию;
- оберег не даёт здоровью упасть ниже 25 %;
- первый сундук с элиты — большой;
- кульминация — **настоящий** Страж рубежа;
- таймлайн — данными `content/prologue.ts`, флаг — в `RunOptions`;
- рейтинг и задания пролог не трогает.

Сценарий — `design/art/meta-v2.md` §4.2.

Решения `claude-lead-1` от 25.10.2026:

- **Режим** — `RunOptions.mode: "endless" | "prologue"`. Сложность пролога —
  `easy`, как у обучающего забега (T-0190). Отдельного флага нет:
  - режим попадает в снимок, итог и запись забега;
  - повтор и перепроверка воспроизводят пролог тем же зерном.
- **Данные** `content/prologue.ts` — `PROLOGUE: PrologueDef`:
  - `timeline` — отрезки того же вида, что `waves.ts`. Стартовые числа:

    | С | Что |
    |---|---|
    | 0 | `swarm_rat` 0,6 в секунду, потолок 25 |
    | 45 | `swarm_rat` 1,6, `bone_walker` 0,4, потолок 60 |
    | 75 | событие `ring` — `elite_ghoul` × 1 |
    | 100 | + `dasher_wolf` 0,3, потолок 80 |
    | 150 | событие `ring` — `swarm_rat` × 30 («волна Нави кольцом») |
    | 160 | событие `ring` — `rubezh_guard` × 1 |

  - `guardHpMul` — множитель здоровья Стража в прологе, стартово 0,12 (≈ 170
    из 1 400): «по силе набранного», 30–40 с боя;
  - `hpFloorRatio` — 0,25;
  - `firstChestSize` — 3;
  - `levelCurve` — своя кривая опыта, стартово `{ baseXp: 3, growth: 1.18 }`:
    уровень почти сразу;
  - `pickupRadiusMul` — 1,5: кристаллы летят щедро;
  - `recommendFirstOffer` — `"new_weapon"`.

  Числа калибрует геймдизайнер.
- **Таймлайн** — тот же исполнитель, что у `waves.ts` (`sim/timeline.ts`), с
  другим источником отрезков. `ENDLESS_CURVE` в прологе не работает: после
  последнего отрезка поток держится как есть.
- **Оберег** — в `damagePlayer` (`sim/world.ts`). В прологе урон, который
  опустил бы здоровье ниже `hpFloorRatio × maxHp`, обрезается до порога:
  - здоровье становится ровно порогом;
  - событие `SIM_EVENT.ward` (новое), не чаще раза в 2 с;
  - рисуется той же вспышкой щита, что `SIM_EVENT.shield`: знак под ногами.

  Смерть в прологе невозможна.
- **Первый сундук** — размер первого выпавшего сундука в прологе —
  `firstChestSize`, вместо `CHESTS.opening[0]`. Дальше — как обычно.
  Поток случайности сундуков не трогается (`deriveSeed(seed, STREAM_SALT.chest)`).
- **«Советуем»** — на первом выборе улучшения:
  - если среди кандидатов есть оружие, которого у игрока нет, оно
    обязательно в предложении;
  - у предложения флаг `recommended: true`.

  Кандидат выбирается тем же генератором, что сейчас. Флаг уходит в
  `levelUp` шины, оболочка рисует метку (T-0280).
- **Победа** — смерть Стража в прологе кончает забег:
  - итог `RunResult.prologue = { won: true, sec }`;
  - сообщение шины `prologueWon`.

  Бесконечного продолжения, как у T-0120, в прологе нет. Выход до победы —
  итог с `prologue: { won: false, sec }`.
- **Пролог не трогает** рекорд движка (`run/records.ts`) — как обучающий
  забег T-0190.
- **`CONTENT_HASH`** — `prologue.ts` входит в хэш контента.

## Как сейчас

- **Опции забега** — `packages/core-game/src/run-api.ts:240` (`RunOptions`,
  `mode: "endless"`).
- **Таймлайн:**
  - `content/waves.ts`, `sim/timeline.ts`, `sim/timeline-content.ts`;
  - события `ring`, `flank`, `cordon`.
- **Урон игроку** — `sim/world.ts:459` (`damagePlayer`, щит `shieldHits` —
  буст «Эгида»); событие `SIM_EVENT.shield` рисует `render/WorldRenderer.ts:578`.
- **Сундуки:**
  - `content/chests.ts` — `opening: [1, 3, 1, 5]`;
  - `sim/chests.ts`.
- **Уровни и предложения** — `progression/levels.ts`.
- **Итог и снимок** — `run/run-result.ts`, `run/snapshot.ts`; итог в
  `shared-types` — `RunResult`.
- **После T-0120:**
  - Страж `rubezh_guard`;
  - `RunResult.rubezh`;
  - сообщения `rubezhGuardSpawned`, `rubezhCleared`;
  - поток `rubezh.rng`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`content/prologue.ts`** — `PrologueDef` и данные; схема и проверки
   контента:
   - отрезки по возрастанию;
   - Страж — последним событием;
   - `hpFloorRatio` в 0,1…0,5.
3. **Режим** — `RunOptions.mode`, `World.mode`, снимок и итог;
   `RunResult.prologue` в `shared-types` (необязательное поле).
4. **`game/run/prologue.ts`** — применение `PrologueDef` к миру при создании:
   - таймлайн;
   - кривая опыта;
   - множитель подбора;
   - здоровье Стража.
5. **Оберег, сундук, «Советуем», победа** — по «Решениям».
6. **Шина** — `prologueWon`, флаг `recommended` у `levelUp`, событие `ward`.
7. **Коридоры** — `BALANCE_TARGETS.prologue`:
   - уклоняющийся бот за 20 зёрен побеждает в 100 % забегов;
   - конец — 170…230 с;
   - Страж живёт 25…50 с;
   - первый сундук — на 75…110 с.
8. **Документы:**
   - `docs/30` — строка `content/prologue.ts`;
   - `docs/32` — раздел «Пролог»: числа и коридоры.

## Чего не трогаем

- Сервер и оболочку — T-0279, T-0280.
- Таймлайн бесконечного режима и `CHESTS` — числа не меняются.
- Golden-эталоны бесконечного режима: пролог — отдельный режим, они не
  сдвигаются.

## Тесты

Первым коммитом.

- `prologue.test.ts`:
  - урон 1 000 при здоровье 100 из 100 → здоровье 25, событие `ward`;
  - второе событие `ward` через 1 с — нет, через 2,1 с — есть;
  - вне пролога урон убивает как раньше;
  - первый сундук пролога — 3 награды, второй — по `opening[1]`;
  - первый выбор — новое оружие в предложении с `recommended`; второй выбор —
    без флага;
  - смерть Стража → забег окончен, `prologue.won = true`;
  - повтор пролога тем же зерном → та же контрольная сумма;
  - снимок пролога на 90-й секунде → восстановление → тот же ход;
  - пролог не пишет рекорд движка.
- `prologue-balance.test.ts` — коридоры шага 7.
- Тест контента — проверки шага 2.

## Аналитика

Нет в движке: `tutorial_step` и `tutorial_completed` шлёт оболочка (T-0280).

## Настройки и окружение

Нет: числа — в `content/prologue.ts`.

## Документы

`docs/30`, `docs/32` — по шагу 8.

## Критерии приёмки

- [ ] Режим `prologue`: таймлайн из данных, Страж в 2:40 по силе набранного, победа кончает забег.
- [ ] Оберег держит здоровье на 25 %; первый сундук — большой; первая карточка — новое оружие с «Советуем».
- [ ] Детерминизм: повтор и снимок воспроизводят пролог; эталоны бесконечного режима не сдвинулись.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Пролог первого забега`
- **Метка:** `release: minor`
- **Для игроков:** пусто — пролог включает T-0280.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОЛОГ, ДВИЖОК**

  Движок умеет пролог — первый забег на три минуты: сила с первых секунд, большой сундук с первой элиты, «Советуем» на первом выборе, оберег не даёт умереть, в конце — Страж рубежа и победа. Числа — content/prologue.ts. Включит оболочка следующей задачей.
  ```
