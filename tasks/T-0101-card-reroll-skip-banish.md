---
id: T-0101
title: Переброс, пропуск и изгнание карточек на выборе улучшения
epic: E10
priority: P1
status: done
owner: claude-13 / sonnet-5.5 / high
author: claude-lead2-14
size: M
depends_on: [T-0099]
zones:
  - packages/core-game/src/game/progression/card-tools.ts
  - packages/core-game/src/game/progression/levels.ts
  - packages/core-game/src/game/progression/boosts.ts
  - packages/core-game/src/game/progression/unlocks.ts
  - packages/core-game/src/content/boosts.ts
  - packages/core-game/src/content/unlocks.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/run-world.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/game/diagnostics/replay.ts
  - packages/core-game/src/run-api.ts
  - packages/core-game/test/**
  - backend/api/src/modules/boosts/boost-catalog.ts
  - backend/api/test/boosts.test.ts
  - packages/app-shell/src/screens/run/CardTools.tsx
  - packages/app-shell/src/screens/run/card-tools-rules.ts
  - packages/app-shell/src/screens/run/overlays.tsx
  - packages/app-shell/src/screens/run/RunScreen.tsx
  - packages/app-shell/src/screens/boost-icons.ts
  - packages/app-shell/src/screens/guide/GuideScreen.tsx
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/i18n/ru-run.json
  - packages/app-shell/src/i18n/ru-boosts.json
  - packages/app-shell/src/i18n/ru-guide.json
  - packages/app-shell/test/card-tools-rules.test.ts
shared:
  - packages/shared-types/src/index.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/src/state/analytics.ts
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - CLAUDE.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 2
---

# T-0101. Переброс, пропуск и изгнание карточек на выборе улучшения

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0101.json)](README.md#значки-статуса) [![T-0099](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0099.json&label=T-0099)](T-0099-run-chest-engine.md)

## Зачем

«Выпало не то» — единственное, что игрок не может поправить: три карточки, берёшь
лучшую из худших. Контроль над случайностью держит интерес в Vampire Survivors и
придаёт смысл мете: бусты и уровень аккаунта начинают ощущаться в забеге. После задачи
на выборе улучшения есть три действия: переброс, пропуск, изгнание.

## Решения

Р102, `docs/39-retention-mechanics.md` Б3. Исполнитель их не пересматривает.

- **Переброс:** все карточки заменяются новыми из кандидатов, **кроме показанных сейчас**.
  Нового нет — не применяется, заряд цел. Число карточек то же (`OFFERS_PER_LEVEL +
  extraOffers`); не хватает новых — добор из прежних.
- **Пропуск:** уровень берётся без улучшения, взамен — доля пути до следующего уровня в
  опыте (в `stats.xpCollected` не считается).
- **Изгнание:** игрок выбирает карточку; предмет (оружие или пассивка) пропадает из пула
  забега насовсем — из карточек и из сундуков (T-0099); на место встаёт новая. Изгнать
  можно и уже взятый предмет (его улучшений больше не будет). Карточку лечения нельзя.
- **Заряды на забег:** базово по уровню аккаунта (строки `content/unlocks.ts`, значение —
  итог с этого уровня, как слоты) плюс от буста. Уровень — из подписанного снимка, как
  слоты; клиент своих чисел не присылает. Между забегами заряды не переносятся.
- **Отдельный поток случайности** (`STREAM_SALT.cards`, заведён в T-0099): новые карточки
  из него, а не из `world.rng`. Первое предложение уровня — из `world.rng`, как раньше,
  поэтому **забег без зарядов не меняется ни на бит, golden остаются прежними**. Бот
  баланса инструментов не использует.
- **Повтор забега:** действия идут в лог ввода как выборы с условными id — `~reroll`,
  `~skip`, `~banish:<id варианта>`; обычный id варианта с `~` не начинается.
- **Новый вид эффекта буста** `cardTools` (код `progression/boosts.ts` и данные): буст
  `control` («Контроль») — +1 переброс, +1 пропуск, +1 изгнание, 5 самоцветов.
- **Страховка:** сумма зарядов каждого вида не выше `MAX_CARD_TOOLS = 9`.

Числа стартовые, **геймдизайнер калибрует** (`CARD_TOOL_UNLOCKS`, `CARD_TOOL_RULES`):

| Уровень аккаунта | Переброс | Пропуск | Изгнание |
|---|---|---|---|
| 1–2 | 0 | 0 | 0 |
| 3 | 1 | 0 | 0 |
| 6 | 1 | 1 | 0 |
| 9 | 2 | 1 | 1 |
| 14 | 2 | 2 | 1 |
| 20 | 3 | 2 | 2 |

Награда пропуска — 0,3 от `xpToNext` (`skipXpRatio`). Новичок уровня 1 видит три карточки,
как сейчас: кнопка вида, которого нет за весь забег, не рисуется.

## Как сейчас

- `game/progression/levels.ts`: `OFFERS_PER_LEVEL = 3` (14); `prepareOffers` (67) берёт карточки
  из `world.rng`; `chooseUpgrade` (217). После T-0099 здесь же `collectCandidates`,
  `drawWeighted`, `applyUpgrade`, `healOption`, `addXp(…, counted)`.
- `game/progression/boosts.ts`: `RunBoosts` (13), `resolveBoosts` (25), `findBoostProblems`
  (60) — эффекты `shieldHits`, `startLevels`, `extraOffers`. `content/boosts.ts` — шесть бустов.
- `game/progression/unlocks.ts`: `unlocksAt`, `findUnlockProblems`; `game/run-world.ts:50` —
  `unlocksAt(ACCOUNT_UNLOCKS, loadout.accountLevel)`.
- `game/MainScene.ts`: `applyChoice` (~375) — выбор, затем следующий `emitLevelUp` из очереди
  или `phase = "running"` и `resumed`. `game/diagnostics/replay.ts:85–94` применяет только
  `chooseUpgrade`; лог — `probe.choice(world, optionId)`.
- `run-api.ts`: `levelUp` (323) без зарядов; `RunSession.chooseUpgrade` (524).
  `state/run.ts`: обработчик `levelUp` (538) шлёт `upgrade_offered` и вибрацию; `choose` (403).
- `screens/run/overlays.tsx`: `LevelUpOverlay` (105). `boost-catalog.ts`: `BOOST_PRICES`;
  тест требует совпадения списка с контентом движка.

## Шаги по порядку

Пункт — коммит; рефакторинг (2) отдельно.

1. **Тесты** (раздел «Тесты») — первым коммитом.
2. **Рефакторинг без изменения поведения**, `MainScene.ts`: хвост `applyChoice` — в приватный
   `finishChoice()`, `emitLevelUp(refreshed = false)`. golden не меняются.
3. **Типы, правила, данные.**
   - `shared-types`: `CardTools { reroll; skip; banish }`, `BoostDef.cardTools?: Partial<CardTools>`,
     `CardToolUnlockDef = { level: number } & Partial<CardTools>`.
   - `progression/boosts.ts`: `RunBoosts.cardTools`; `resolveBoosts` суммирует; `findBoostProblems`
     считает `cardTools` эффектом и требует целое от 1 до 5 у каждого вида.
   - `progression/unlocks.ts`: `cardToolsAt(table, level)` (последняя строка не выше уровня,
     не заданное — как строкой ниже, иначе 0) и `findCardToolProblems(table)`: уровни — целые
     от 1 без повторов, заряды — целые не меньше 0, не убывают от строки к строке, не выше потолка.
   - `content/unlocks.ts`: `CARD_TOOL_UNLOCKS` (таблица выше) **отдельным массивом внизу
     файла** — лестницу открытий (К3) правит другая задача, конфликта быть не должно; рядом
     `CARD_TOOL_RULES = { skipXpRatio: 0.3 }`.
   - `content/boosts.ts`: `{ id: "control", nameKey: "boost.control.name", descriptionKey:
     "boost.control.description", cardTools: { reroll: 1, skip: 1, banish: 1 } }`.
4. **Состояние мира.** `world.ts`: `progression.tools` (осталось), `progression.toolsTotal`
   (выдано), `progression.banished: string[]` (ключи `weapon:<id>` / `passive:<id>`),
   `World.cardRng`, `World.cardRules`. `create-world.ts`: опции `cardTools?` (база) и `cardRules?`;
   итог по виду = `min(MAX_CARD_TOOLS, база + boosts.cardTools)`; `cardRng =
   createRng(deriveSeed(seed, STREAM_SALT.cards))`; заглушки без зарядов. `run-world.ts`:
   `cardToolsAt(CARD_TOOL_UNLOCKS, level)`, без уровня — нули (на этом идут golden). `snapshot.ts`:
   состояние `cardRng`, разбор новых полей `progression` с проверкой типов, `WORLD_SNAPSHOT_VERSION`
   + 1 от значения в `dev` на момент PR.
5. **`progression/card-tools.ts`** (новый; запретные `Math.*` те же):
   - `REROLL_COMMAND = "~reroll"`, `SKIP_COMMAND = "~skip"`, `BANISH_PREFIX = "~banish:"`,
     `MAX_CARD_TOOLS = 9`, `isCardToolCommand(id)`, `itemKeyOf(option): string | null` (`null` у `heal`);
   - `canReroll(world)`: заряд есть, среди карточек есть не-`heal`, есть кандидат вне показанных;
   - `applyCardTool(world, command): { kind; left: number; item: string | null } | null` — `null`,
     если мир не ждёт выбора, заряда нет, команда незнакома, вариант не найден или это лечение.
     Пропуск: `offers = []`, `pendingLevelUps - 1`, `addXp(world, ceil(xpToNext * skipXpRatio),
     false)`. Изгнание: ключ в `banished` без повторов, замена на том же месте одной карточкой
     вне показанных; замены нет — карточка убирается, остался пустой список — `[healOption()]`.
     Все броски — `drawWeighted(world.cardRng, …)`.
   - `levels.ts`: `collectCandidates` пропускает предметы из `banished` (и новые, и уровни) —
     один фильтр на карточки и на сундук.
6. **Сцена, API, повтор.** `run-api.ts`: `RunSession.rerollOffers()`, `skipOffers()`,
   `banishOffer(optionId)`; `levelUp` + `tools`, `toolsTotal`, `canReroll`, `refreshed`; новое
   событие `cardTool { kind; left; level; item?: string }`. `MainScene.ts`: общий метод
   `applyCardToolCommand(command)` — только в фазе `choosing`; `null` → выход; иначе
   `probe.choice(world, command)`, `emit("cardTool")`, `emitHud()`, переброс и изгнание —
   `emitLevelUp(true)`, пропуск — `finishChoice()`. `replay.ts`: команда с `~` идёт в
   `applyCardTool`, остальное — как было. Схему записи диагностики проверить на длину id
   (`grep -rn choices backend/api/src/modules`): `~banish:weapon_level:storm:3` — меньше 64 знаков.
7. **Сервер.** `boost-catalog.ts`: `control: { resource: "gems", amount: 5 }`; `boosts.test.ts`.
8. **Оболочка.**
   - `card-tools-rules.ts` (чистые функции): `toolButtons({ left, total, canReroll, offers })` —
     `{ id, left, disabled }` только для видов с `total > 0`; переброс отключён при `left == 0` или
     `!canReroll`; переброс и изгнание — если все карточки лечения. `cardTapAction(mode, offer)` →
     `"choose"` | `"banish"` | `"ignore"` (режим изгнания и лечение — `ignore`).
   - `state/run.ts`: поля `tools`, `toolsTotal`, `canReroll` из `levelUp`; действия `reroll()`,
     `skip()`, `banish(optionId)` — только в фазе `levelUp`; `upgrade_offered` и вибрация — только
     при `!refreshed`; обработчик `cardTool` шлёт `card_rerolled` / `card_skipped` / `card_banished`.
   - `CardTools.tsx` — ряд кнопок со счётчиком (`RefreshCw`, `SkipForward`, `Ban` из
     `lucide-react`, высота от 44 px, размер не прыгает при отключении); в режиме изгнания над
     рядом подсказка и «Отмена».
   - `overlays.tsx`: `LevelUpOverlay` получает `tools?`, `onReroll`, `onSkip`, `onBanish`; режим
     изгнания — `useState`, сбрасывается при смене карточек; тап по карточке — `cardTapAction`;
     под карточками `CardTools`, подпись `run.tools.caption` — `short:hidden`. `RunScreen.tsx`
     передаёт значения стора. Значок `control` — `Shuffle` в `boost-icons.ts`.
   - Гайдбук: в разделе про выбор улучшения (искать «улучшени» в `ru-guide.json`) абзац про три
     действия и откуда берутся заряды.

Тексты дословно. `ru-run.json`: `run.tools.reroll` «Переброс»; `run.tools.skip` «Пропуск»;
`run.tools.banish` «Изгнание»; `run.tools.banish.hint` «Выбери карточку — она не появится до
конца забега»; `run.tools.banish.cancel` «Отмена»; `run.tools.caption` «Переброс меняет карточки,
пропуск даёт опыт, изгнание убирает предмет из забега»; `run.tools.left` «Осталось: {count}»
(для `aria-label`). `ru-boosts.json`: `boost.control.name` «Контроль»; `boost.control.description`
«+1 переброс, +1 пропуск и +1 изгнание карточек на забег».

## Чего не трогаем

- Правила сундука и эволюции (Б2): здесь только фильтр изгнанного.
- Экран «Уровень» (`screens/meta/level.tsx`) и лестницу открытий (К3): заряды там пока не
  показываются — отдельная правка после К3.
- Продажу бустов, кроме цены `control`; выбор бустов перед забегом; бота баланса.
- `state/run.ts`, `ru-run.json`, `RunScreen.tsx` правит и T-0100 в других местах: конфликт —
  сохранить обе стороны. Звук: действия — `audio.runEvent("choose")`, как выбор карточки.

## Сценарий и интерфейс

Макета нет (`design: null`): ориентир — `LevelUpOverlay`. Снимки на 320, 390, 768, 1440 px и
ландшафт 667×375; окно не уходит в прокрутку на высоте 360 px.

- **Зарядов нет за весь забег:** ряда нет, три карточки, как сейчас.
- **Есть заряды:** под карточками ряд кнопок со счётчиками «×N»; кончились — кнопка серая «0».
- **Переброс:** карточки сменяются (появление проигрывается заново), счётчик −1.
- **Пропуск:** окно закрывается, опыт растёт; накопленный уровень откроется штатно.
- **Изгнание:** нажатие включает режим («Выбери карточку…», «Отмена»); тап по карточке убирает
  предмет из забега и ставит новую; карточка лечения не реагирует.
- **Загрузки, пустого состояния, сети нет:** действия к сети не обращаются.

## Тесты

Первым коммитом. `core-game/test/card-tools.test.ts` (мир на фикстурах, 12 кандидатов,
`cardTools: { reroll: 2, skip: 1, banish: 1 }`):

- переброс: новые карточки не пересекаются с прежними по `id`, число то же (+1 с `extraOffers`),
  `tools.reroll` −1, `world.rng.getState()` не изменилось; без заряда и без альтернатив
  (ровно три кандидата) → `null`, заряд цел;
- пропуск: `offers == []`, `pendingLevelUps` −1, опыт +`ceil(xpToNext * 0,3)`, `stats.xpCollected`
  не изменился; пропуск у порога опыта даёт ещё один накопленный уровень;
- изгнание: карточка заменена на том же индексе, ключ в `banished`; за 30 уровней изгнанный
  предмет не предлагался; сундук размера 5 (T-0099) на 50 seed его не выдаёт; изгнание
  лечения, чужого id и команды `~boom` → `null`; изгнан весь пул — предлагается лечение;
- одинаковый seed и команды → одинаковые карточки.

Остальное: `run-recording.test.ts` — по образцу кейса с выбором запись с `~reroll`,
`~banish:…`, `~skip` повторяется «сошлось», команда без заряда → «не ложится на забег».
`run-snapshot.test.ts` — после переброса и изгнания снимок возвращает заряды, `banished`, поток;
следующие карточки совпадают с прогоном без перерыва; прежняя версия → `SnapshotError`.
`account-unlocks.test.ts`, `boosts.test.ts` — `cardToolsAt` на 1, 3, 9, 20 и выше последней
строки; `createRunWorld` без уровня → нули, уровень 1 + `control` → 1/1/1, уровень 9 + `control`
→ 3/2/2, потолок 9 держится; `findCardToolProblems` на дубле, отрицательном, убывающем, дробном;
`findBoostProblems` на `cardTools: {}` и значении 0 или 6. `backend/api/test/boosts.test.ts` — цена
`control` 5 самоцветов, список совпадает с контентом.
`app-shell/test/card-tools-rules.test.ts`: `total` 0 → кнопки нет; `total 2, left 0` → видна и
`disabled`; `canReroll: false` → отключён только переброс; все карточки лечения → переброс и
изгнание отключены; `cardTapAction("choose", weapon)` → `choose`, `("banish", passive_new)` →
`banish`, `("banish", heal)` → `ignore`; ключи `run.tools.*` и `boost.control.*` есть в словарях.

Все существующие golden-тесты проходят **без правки эталонов**.

## Аналитика

Сначала словарь (`docs/22` §3.3, группа «Забеги» и таблица последнего этапа), потом Zod и
список клиента, потом код. Версия — 1. Шлёт оболочка по `cardTool` движка, то есть только
когда действие применилось.

| Событие | Поля |
|---|---|
| `card_rerolled`, `card_skipped` | `level` (уровень выбора), `left` (зарядов осталось) |
| `card_banished` | `level`, `left`, `item` (`weapon:<id>` / `passive:<id>`) |

Схемы: `payload({ level: count, left: count })`, у изгнания плюс `item: id`.

## Настройки и окружение

Нет. Заряды и награда пропуска — контент, цена буста — `boost-catalog.ts`.

## Документы

- `docs/22` — три события; `docs/30-configuration-map.md` — строка «Заряды карточек:
  `CARD_TOOL_UNLOCKS`»; `docs/32-balance.md` — абзац: заряды вне golden и коридоров, бот их не
  использует; `CLAUDE.md` — пример эффекта `cardTools` в разделе «Как добавить буст»;
  `docs/27` — строка про ряд кнопок, если окно выбора там описано. Гайдбук — шаг 8.

## Вопросы к тимлиду

- Размер на верхней границе M. Не вмещается — отрезать буст `control` (сервер, значок,
  тексты) в отдельную задачу.
- Подтверждено `claude-lead-1` 13.10.2026: уровни 3/6/9/14/20 для зарядов и награда пропуска 0,3.
- Подтверждено `claude-lead-1` 13.10.2026: версия снимка растёт ещё раз, сохранённые забеги тестеров
  при выкате пропадут.

## Критерии приёмки

- [ ] Переброс, пропуск и изгнание работают; заряды — по уровню аккаунта и от буста `control`;
  без зарядов экран выбора прежний.
- [ ] `world.rng` они не двигают; тесты на детерминизм и снимок зелёные; **golden без правки**.
- [ ] Изгнанный предмет не предлагается ни картой, ни сундуком до конца забега.
- [ ] Повтор забега с командами сходится; невозможная команда в записи отвергается.
- [ ] `card_rerolled`, `card_skipped`, `card_banished` в словаре, схеме, клиенте и документе;
  `control` продаётся за 5 самоцветов.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Добавить переброс, пропуск и изгнание карточек`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: на выборе улучшения можно перебросить карточки, пропустить уровень за опыт или изгнать предмет из забега — заряды растут с уровнем аккаунта`
  - `- новое: буст «Контроль» — +1 переброс, +1 пропуск и +1 изгнание на забег`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПЕРЕБРОС, ПРОПУСК И ИЗГНАНИЕ КАРТОЧЕК**

  На выборе улучшения появились три действия. Заряды дают уровень аккаунта (с 3-го) и новый буст «Контроль». Забег без зарядов и golden не изменились.

  🛠 **Бой и мета**

  • отдельный поток случайности для новых карточек, повтор забега и снимок сходятся
  • буст «Контроль» — 5 самоцветов, числа зарядов стартовые, геймдизайнер калибрует

  ❓ **Нужно от команды**

  • @участник1 — подтвердить: версия снимка забега выросла, сохранённые незавершённые забеги тестеров при выкате пропадут
  ```
