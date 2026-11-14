---
id: T-0426
title: Звук и вибрация Карачуна — холодный выдох предвестия, тяжёлое касание
epic: E10
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: [T-0423]
zones:
  - packages/app-shell/test/stalker-sound.test.ts
shared:
  - packages/core-game/src/game/run/cues.ts
  - packages/core-game/src/run-api.ts
  - packages/core-game/test/**
  - packages/app-shell/src/audio/recipes.ts
  - packages/app-shell/src/audio/sound-director.ts
  - packages/app-shell/src/state/haptics.ts
  - packages/app-shell/src/i18n/ru-team.json
  - packages/app-shell/test/**
  - docs/31-audio-and-haptics.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: design/art/concepts/stalker/README.md
batch: 4
---

# T-0426. Звук и вибрация Карачуна — холодный выдох предвестия, тяжёлое касание

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0426.json)](../README.md#значки-статуса) [![T-0423](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0423.json&label=T-0423)](T-0423-stalker-appearances.md)

## Зачем

Предвестие Карачуна — полторы секунды на то, чтобы понять, откуда он выйдет
(Р205). Глаз в толпе его может пропустить, ухо — нет. Касание снимает треть
здоровья, и игрок должен почувствовать, что это не обычное попадание.

## Решения

- **Р205** (`docs/35-stage4-plan.md`): предвестие — со звуком; звук и
  вибрация — по `docs/31-audio-and-haptics.md`.
- **Предвестие звучит всегда** — на шине `threats`, под громкостью «Бой», без
  отдельного выключателя. Это начало угрозы, как появление элиты, а не атака
  врага: принцип «атаки врагов не звучат» (`docs/31` §1) не нарушен
  (решение тимлида).
- **Касание** — обычный `hurt` и поверх новый глухой удар `stalkerStrike`: «это
  не крыса» слышно сразу (решение тимлида).
- **Вибрация — под общим переключателем** вибрации, новыми событиями
  `stalkerOmen` (`warning`) и `stalkerTouch` (`heavy`). Своего
  переключателя нет.
- Повторное предвестие («возник ближе») звучит так же, как первое.
- Звук делается скиллом `game-sound`: класс «угроза», холодный выдох с
  нарастанием за 1,5 с, **не похожий на телеграф рывка и рог элиты**.

## Как сейчас

- Сигналы забега — `packages/core-game/src/game/run/cues.ts` (`CueTracker`),
  тип `RunCues` — `packages/core-game/src/run-api.ts` (строка ~766). Считаются
  из буфера событий мира и счётчиков, раз в ~33 мс.
- После T-0423 мир пишет события `SIM_EVENT.stalkerOmen`,
  `stalkerAppear`, `stalkerFade` (`game/sim/events.ts`) и счётчики
  `world.stalker.index` и `world.stalker.hits`.
- Звуки на сигналы — `planCueSounds` в
  `packages/app-shell/src/audio/sound-director.ts` (строка ~110), рецепты —
  `SOUND_RECIPES` в `audio/recipes.ts` (образцы угроз — `eliteHorn`,
  `bossArrive`; игрока — `hurt`).
- Вибрация — `packages/app-shell/src/state/haptics.ts`: `HAPTIC_RULES`, выбор
  одной вибрации из пачки (строка ~82: динамит → взрыв рядом → элита →
  попадание → …).
- Подписи звуков лаборатории — `soundLab.sound.<id>` в
  `app-shell/src/i18n/ru-team.json`.
- Порядок добавления звука — `docs/31` §8.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **Сигналы:** в `RunCues` — `stalkerOmens: number` (сколько предвестий
   началось за окно) и `stalkerTouches: number` (сколько касаний Карачуна
   дошло до игрока — по росту `world.stalker.hits`). `CueTracker` считает их
   из событий и счётчиков, как прочие; `any = true` при ненулевых.
3. **Рецепт `stalkerOmen`** (`audio/recipes.ts`): шина `threats`,
   `voices: 1`, `gap` не меньше 1 с, длительность около 1,6 с — шипящий
   выдох с полосой, поднимающейся за 1,5 с, и высокий тонкий «треск инея»
   короткими щелчками к концу; низа меньше, чем у рогов элиты и босса, чтобы
   не спорить с ними. Собирать в звуковой лаборатории, как велит §8.
4. **Рецепт `stalkerStrike`**: шина `player`, короткий тяжёлый удар с
   ледяным призвуком, длительность до 0,4 с.
5. `planCueSounds`: `stalkerOmen` — первым среди угроз (выше рогов);
   `stalkerStrike` — сразу после `hurt`.
6. **Вибрация:** события `stalkerOmen` (`warning`, не чаще раза в 1500 мс) и
   `stalkerTouch` (`heavy`, не чаще раза в 500 мс); в выборе из пачки
   `stalkerTouch` — первым, `stalkerOmen` — после динамита и взрыва рядом,
   перед элитой.
7. Подписи `soundLab.sound.stalkerOmen` — «Карачун: предвестие» и
   `soundLab.sound.stalkerStrike` — «Карачун: касание».
8. `pnpm fx:sound stalkerOmen` и `pnpm fx:sound stalkerStrike` — если поток на
   машине с `pnpm dev`; ошибок нет, предупреждения объяснены в PR. Нет
   dev-сервера — так и написать, замер снимет тимлид.
9. `docs/31`: §4 — сигналы `stalkerOmens`, `stalkerTouches`; §7 — место двух
   вибраций в порядке; в §1 после принципа 1 — одна фраза: предвестие
   неубиваемого звучит, это начало угрозы, а не атака.

## Чего не трогаем

- Мир и директор — T-0423 (ничего в детерминированном шаге не меняется).
- Громкости шин, правила грани, прочие рецепты.
- Музыку.

## Тесты

`packages/app-shell/test/stalker-sound.test.ts`:

- `planCueSounds` с `stalkerOmens: 1` — в плане `stalkerOmen` раньше
  `eliteHorn` и `bossArrive`;
- с `stalkerTouches: 1` и `playerHit: 1` — `hurt`, затем `stalkerStrike`;
- без сигналов Карачуна план прежний (снимок плана на типичной пачке не
  изменился);
- вибрация: пачка с `stalkerTouches` и `dynamite` — `stalkerTouch`; пачка с
  `stalkerOmens` и `eliteSpawns` — `stalkerOmen`; выключенная вибрация —
  ничего;
- рецепты проходят схему лаборатории (`audio.test.ts` проверяет все
  рецепты — убедиться, что новые в нём).

`packages/core-game/test/cues.test.ts` (дописать): мир с правилами
преследователя, предвестие — `stalkerOmens: 1` в ближайшей пачке; касание —
`stalkerTouches: 1`; повторное предвестие тоже даёт сигнал.

## Аналитика

Нет.

## Настройки и окружение

Нет: громкость — регулятор «Бой», вибрация — общий переключатель.

## Документы

`docs/31-audio-and-haptics.md` §1, §4, §7 — шаг 9.

## Критерии приёмки

- [ ] Предвестие Карачуна слышно: холодный выдох 1,5 с на шине угроз, не
      похожий на рога элиты и босса.
- [ ] Касание Карачуна звучит тяжелее обычного попадания и даёт тяжёлую
      вибрацию; предвестие — предупреждающую.
- [ ] Без Карачуна звуки и вибрации не изменились.
- [ ] `docs/31` описывает новые сигналы и порядок вибраций.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и `pnpm task check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Звук и вибрация Карачуна`
- **Метка:** `release: minor`
- **Для игроков:** нет — в забег Карачун приходит в T-0424.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗВУК И ВИБРАЦИЯ КАРАЧУНА**

  Предвестие Карачуна звучит холодным выдохом на полторы секунды — под громкостью «Бой», без отдельного выключателя. Касание — тяжёлый удар со звуком и вибрацией. Послушать: «Звуковая лаборатория» → «Карачун: предвестие» и «Карачун: касание».
  ```
