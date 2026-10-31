---
id: T-0352
title: Тайники рубежа — проводка к забегу: события в шину, выбор благословения с паузой, снимок контента и забега, эталоны
epic: E10
priority: P1
status: in-progress
owner: claude-13 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0258]
zones:
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/engine/run-bus.ts
  - packages/core-game/src/engine/run-engine.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/game/run-world.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/content/snapshot.ts
  - packages/core-game/src/content/snapshot-schema.ts
  - packages/core-game/src/game/content-problems.ts
  - packages/core-game/src/game/sim/checksum.ts
  - packages/core-game/test/secrets-run.test.ts
  - packages/core-game/test/run-snapshot.test.ts
  - packages/core-game/test/content-snapshot.test.ts
  - packages/core-game/test/determinism.test.ts
  - packages/core-game/test/run-summary.test.ts
shared:
  - packages/app-shell/test/**
  - docs/32-balance.md
  - CLAUDE.md
  - packages/core-game/src/game/balance/simulate.ts
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0352. Тайники рубежа — проводка к забегу: события в шину, выбор благословения с паузой, снимок контента и забега, эталоны

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0352.json)](README.md#значки-статуса) [![T-0258](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0258.json&label=T-0258)](archive/T-0258-secrets-engine-core.md)

## Зачем

T-0258 (#545) влита как «движок и данные»: размещение по кольцам, капище,
клад, камень-указатель, огонёк, благословения работают в мире, но забег их не
видит — `createRunWorld` не передаёт тайники в мир, события не уходят в шину,
выбора благословения у оболочки нет, тайники не входят в `CONTENT_HASH` и в
снимок прерванного забега. Это решение тимлида по вопросу 1 в #545 (вариант
B): проводка — отдельной задачей перед T-0260, вместе с обновлением эталонов.

## Решения

Решение `claude-lead-1` от 28.10.2026 (комментарий в #545), Р153:

- События `secretFound`, `secretUsed`, `secretBlessing` (предложение трёх
  благословений) уходят в шину забега так же, как события сундука.
- Капище при опции паузы (`pauseOnChest`, та же, что у сундука) останавливает
  забег, пока оболочка не ответит `chooseBlessing(id)`; без опции (боты,
  golden) берётся первое из трёх — как в движке T-0258.
- Тайники входят в контент-снимок (`content/snapshot.ts`, схема, хэш) и в
  `findContentProblems` (`findSecretsProblems`).
- Снимок прерванного забега хранит состояние тайников (поток, места, выбор,
  взятые благословения); версия снимка — на единицу выше значения в `dev` на
  момент взятия (константу в тестах не хардкодить).
- Golden-эталоны сдвигаются: автопилот проходит мимо тайников; эталон
  обновляется в этом PR, дельта длины забега — в описании и в `docs/32` §3.2.

## Как сейчас

- `packages/core-game/src/game/sim/secrets.ts` — `updateSecrets`,
  `isAwaitingBlessing`, `chooseBlessing`, `restoreBlessings`,
  `takeSecretEvents(world, cursor)` (стр. 300–308, `SecretCursor`,
  `SecretEvents`); размещение — `secrets-layout.ts`, проверки —
  `secrets-rules.ts` (`findSecretsProblems`).
- `packages/core-game/src/game/run-world.ts:60` — `createRunWorld` берёт
  контент из снимка и не передаёт `secrets` в `createWorld`.
- `packages/core-game/src/game/MainScene.ts:686–712` — образец:
  `emitChestEvents` (курсор, `bus.emit("chestFound"/"chestOpened")`, пауза
  `enterChest` при `pauseOnChest`), `isInChest`, `closeChest`.
- `packages/core-game/src/engine/run-bus.ts:5–15` — набор слушателей на каждое
  событие `RunEvents`; `engine/run-engine.ts:63–76` — объект `RunSession`;
  `run-api.ts` — `RunEvents`, `RunSession` (`closeChest`, стр. 592).
- `packages/core-game/src/content/snapshot.ts:65, 79, 133, 150` и
  `snapshot-schema.ts:225, 282` — форма снимка, хэш, схема;
  `game/content-problems.ts:71` — сборщик проблем контента.
- `packages/core-game/src/game/run/snapshot.ts:72, 98` — снимок прерванного
  забега хранит `chest`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»), красные.
2. `run-api.ts`: в `RunEvents` — `secretFound`, `secretUsed`,
   `secretBlessing` с типами из `takeSecretEvents`; в `RunSession` —
   `chooseBlessing(id: string): void`; в описании опции `pauseOnChest` —
   «и капище».
3. `run-bus.ts`, `run-engine.ts` — новые события и метод, как у сундука;
   поддельные сессии оболочки (`packages/app-shell/test/**`) — то же, только
   заглушки (это `shared`).
4. `MainScene.ts`: курсор тайников, `emitSecretEvents` рядом с
   `emitChestEvents`, фаза `blessing` по образцу `chest` (пауза при
   `pauseOnChest` и `isAwaitingBlessing`), `chooseBlessing` из сессии; запись
   забега получает тик выбора (`probe.choice`) — как у карточек.
5. `run-world.ts` — `secrets` из снимка в `createWorld`.
6. Контент-снимок: `secrets` в `content/snapshot.ts`, схему и хэш;
   `findSecretsProblems` — в `content-problems.ts`.
7. Снимок забега (`run/snapshot.ts`): состояние тайников, версия +1;
   восстановление благословений — `restoreBlessings`.
8. `checksum.ts` — свёртка состояния тайников (позиции и выбор), если в ней
   есть сундуки; иначе не трогать.
9. Golden: перегенерировать, дельту длины забега — в описание PR и
   `docs/32` §3.2.

## Чего не трогаем

- Правила тайников и числа (`content/secrets.ts`, `sim/secrets*.ts`) — T-0258.
- Облик и экран выбора благословения в оболочке — T-0260.
- Древо-оберег и разлом Нави — T-0259.

## Тесты

- `secrets-run.test.ts`:
  - забег без опции паузы: капище выбирает первое благословение, события
    `secretFound`/`secretUsed` приходят в шину по одному разу;
  - с `pauseOnChest`: на капище забег стоит (мир не шагает), пока
    `chooseBlessing(id)` не придёт; неизвестный id — забег стоит дальше;
  - `world.rng` не трогается (состояние генератора то же, что без тайников).
- `content-snapshot.test.ts`: тайники в снимке и в хэше; битые данные тайников
  ловит `findContentProblems`.
- `run-snapshot.test.ts`: снимок с тайниками восстанавливает места и взятые
  благословения; снимок прошлой версии → `SnapshotError`.
- Эталоны (`determinism.test.ts`, `run-summary.test.ts`; другие — по Р176 п. 4 с путём в `shared`) — обновлены.

## Аналитика

Новых событий аналитики нет: события шины — для оболочки (T-0260 решит, что
из них уходит в аналитику).

## Настройки и окружение

Нет.

## Документы

`docs/32-balance.md` §3.2 — дельта длины забега от тайников.

## Критерии приёмки

- [ ] Тайники есть в забеге: события в шине, капище с паузой и без.
- [ ] Тайники входят в `CONTENT_HASH` и в проверки контента.
- [ ] Прерванный забег сохраняет и восстанавливает тайники.
- [ ] Golden обновлены, дельта описана.

## PR

- **Заголовок:** `feat(core-game): Тайники рубежа — проводка к забегу`
- **Метка:** `release: minor`
- **Для игроков:** нет (облик и выбор — T-0260)
- **Сводка для команды:**

  ```
  🗺 **СВОДКА: В DEV ВЛИТ PR #<номер> — ТАЙНИКИ В ЗАБЕГЕ**

  Тайники рубежа подключены к забегу: события находки и использования уходят оболочке, капище останавливает забег на выбор благословения, тайники входят в контент и снимок прерванного забега. Эталоны баланса обновлены — дельта в описании PR. Что видит игрок — следующей задачей (T-0260).
  ```
