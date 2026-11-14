---
id: T-0424
title: Карачун в забеге — подключение, шина сцены, калибровка и эталоны
epic: E10
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0392, T-0422, T-0423, T-0425, T-0426]
zones:
  - packages/core-game/src/game/run-world.ts
  - packages/core-game/src/content/balance-targets.ts
  - packages/core-game/test/balance-stalker.test.ts
shared:
  - packages/core-game/src/content/stalker.ts
  - packages/core-game/src/content/enemies.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/engine/run-bus.ts
  - packages/core-game/src/game/balance/simulate.ts
  - packages/core-game/src/game/diagnostics/replay.ts
  - packages/core-game/test/**
  - scripts/balance/balance-sim.ts
  - docs/32-balance.md
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
  - CLAUDE.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: design/art/concepts/stalker/README.md
batch: 5
---

# T-0424. Карачун в забеге — подключение, шина сцены, калибровка и эталоны

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0424.json)](../README.md#значки-статуса) [![T-0392](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0392.json&label=T-0392)](T-0392-siege-of-standing-player.md) [![T-0422](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0422.json&label=T-0422)](T-0422-bots-flee-stalker.md) [![T-0423](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0423.json&label=T-0423)](T-0423-stalker-appearances.md) [![T-0425](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0425.json&label=T-0425)](T-0425-stalker-look.md) [![T-0426](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0426.json&label=T-0426)](T-0426-stalker-sound.md)

## Зачем

Тело (T-0421), директор появлений (T-0423), облик с предвестием (T-0425),
звук (T-0426) и бегство ботов (T-0422) готовы, но в настоящем забеге
Карачуна нет. Эта задача включает его в боевой забег, отдаёт оболочке
событие конца появления, калибрует числа ботами и обновляет эталоны. Цель
владельца — игра сейчас слишком лёгкая, Карачун её усложняет (Р205).

## Решения

- **Р205** (`docs/35-stage4-plan.md`) и решения тимлида в той же строке.
- **Р197**: давление на стоящего — механикой. Осада стоящего (T-0392) уже
  влита; Карачун давит на стоящего вторым способом и не должен наказывать
  бегущего сильнее, чем нужно.
- **Коридоры Карачуна — решение тимлида, подтвердить владельцу:**
  - сильный «стоит» + «ветеран»: медиана с Карачуном **хотя бы на 10%
    короче**, чем без него на тех же seed;
  - сильный «бегает», все профили: медиана с Карачуном **не больше чем на
    15% короче**;
  - уклоняющийся бот: медиана остаётся в `BALANCE_TARGETS.dodgingMedianSec`.
- **Рычаги калибровки — только числа `STALKER` и скорость `karachun`** в
  `content/enemies.ts`. Ступени, поток, оружие, подстройку, осаду не
  трогаем. Не сходится — вопрос в PR с таблицей «что пробовал и насколько
  мимо».
- **Пролог** получает правила тоже: директор сам выключает Карачуна в
  прологе (T-0423), особых веток в `createRunWorld` не нужно.

## Как сейчас

- `packages/core-game/src/game/run-world.ts` — `createRunWorld` собирает
  `createWorld` из `ContentSnapshot`; `stalker` туда не передаётся.
- Шина сцены: тип `RunEvents` — `packages/core-game/src/run-api.ts` (строка
  ~411, образец — `ringEnded`); наборы обработчиков —
  `engine/run-bus.ts`; раздача журнала — `MainScene.ts` (строка ~813:
  `for (const ended of events.ended) bus.emit("ringEnded", ended)`).
- Журнал появлений — `world.stalker.ended` (T-0423).
- Коридоры — `content/balance-targets.ts` (`BALANCE_TARGETS`,
  `STRONG_BOT_TARGETS`); свойства — `test/balance-properties.test.ts`,
  `test/balance-strong-properties.test.ts`; эталоны — golden-тесты
  (`docs/32-balance.md` §3.3), контрольная сумма в `test/determinism.test.ts`.
- Свод `pnpm balance:sim` — `scripts/balance/balance-sim.ts`,
  `game/balance/simulate.ts` (принимает `content`).

## Шаги по порядку

1. Тесты первым коммитом: `test/balance-stalker.test.ts` (раздел «Тесты»)
   — красные до подключения.
2. **Подключение:** в `createRunWorld` — `stalker: content.stalker` в
   `createWorld`.
3. **Шина:** в `RunEvents` — `stalkerEnded: { index: number; outcome:
   "faded" | "cut" | "died"; hits: number; pushes: number; relocations:
   number; lifeSec: number; elapsedSec: number }`; набор в `run-bus.ts`;
   в `MainScene.ts` — раздача `world.stalker.ended` и очистка журнала так же,
   как у `ringEnded`.
4. **Калибровка** `pnpm balance:sim` и `balance-strong-properties`:
   - «без Карачуна» — тот же контент, у которого `stalker.appear.fromSec`
     больше длины забега (функция-помощник в тесте, не в контенте);
   - сравнить медианы по профилям на тех же seed; привести к коридорам из
     «Решений» рычагами Карачуна;
   - коридоры записать в `STRONG_BOT_TARGETS.stalker`:
     `{ standDropMin: 0.1, kiteDropMax: 0.15 }` с комментарием-ссылкой на
     Р205;
   - если сдвинулись прежние коридоры (`kite`, `stand.veteran` после
     T-0392), — не двигать их молча: вопрос в PR с таблицей.
5. **Эталоны:** обновить golden и контрольную сумму забега, в описании PR —
   таблица «секунда смерти до → после» по эталонным прогонам и сколько
   появлений и касаний было в каждом.
6. **Документы** (раздел «Документы»).

## Чего не трогаем

- Тело, директор, облик, звук — сделаны в T-0421, T-0423, T-0425, T-0426;
  правка их кода здесь — только если калибровка упёрлась в ошибку, с
  объяснением в PR.
- Ступени, таймлайн, кривая, оружие, пассивки, подстройка, осада, числа
  ботов.
- Оболочка: аналитика и гайдбук — T-0427.

## Тесты

`packages/core-game/test/balance-stalker.test.ts`:

- `createRunWorld` боевого забега на «Сложной» с `accountLevel` 9 — за 10
  минут уклоняющимся ботом было хотя бы одно предвестие и выход Карачуна;
- `createRunWorld` пролога и забега с `accountLevel` 2 — ни одного;
- `stalkerEnded` приходит в шину сцены по одному на появление с полями
  журнала (тест сцены по образцу `ringEnded`, если такой есть; иначе — на
  уровне `RunSession`/шины, как проверяется `ringEnded`).

`balance-strong-properties.test.ts`:

- «стоит» + «ветеран»: медиана с Карачуном короче хотя бы на
  `standDropMin`;
- «бегает», каждый профиль: короче не больше чем на `kiteDropMax`.

`balance-properties.test.ts`: уклоняющийся бот в
`dodgingMedianSec` — как было.

Эталоны (golden, контрольная сумма) — обновлены, дельта в PR.

## Аналитика

Событие шины `stalkerEnded`; отправка `stalker_ended` и словарь — T-0427.

## Настройки и окружение

Нет. Числа — данные `content/stalker.ts`, входят в снимок контента и
`CONTENT_HASH` (T-0421, T-0423).

## Документы

- `CLAUDE.md`, раздел «Как добавить нового врага»:
  - в таблицу паттернов — строка `stalker` | «Неубиваемый преследователь:
    идёт на игрока, урон оружия не снимает здоровье, а отталкивает — каждый
    толчок подряд слабее, за секунду не дальше предела; касание — доля
    максимума здоровья и отброс. Приходит только своим директором
    (`content/stalker.ts`), в таймлайне его быть не может» | нет (числа — у
    `STALKER`);
  - после абзаца про `cordon` — короткий абзац «**Неубиваемый
    преследователь** (Р205)»: где числа (`content/stalker.ts` — `body` и
    `appear`), что проверяет `findStalkerProblems`, что `maxPerSec` не больше
    0,6 скорости, кого и когда он не трогает (новичок, босс, строй, разлом),
    что поток случайности свой.
- `docs/32-balance.md`:
  - новый §2.10 «Карачун — неубиваемый преследователь (Р205)»: правила
    числами, почему `maxPerSec ≤ 0,6 скорости`, почему `appearDistance`
    ограничен видимой областью;
  - §3.1 — коридоры `STRONG_BOT_TARGETS.stalker`;
  - §3.2 — строка свода: медианы с Карачуном и без, боты уходят от него
    (T-0422).
- `docs/30-configuration-map.md` — строка в конце таблицы боя: «Карачун:
  тело (касание, отброс, толчки) и появления (с какой секунды, паузы,
  погоня, предвестие, дистанции, порог новичка)» | `content/stalker.ts` →
  `STALKER`, `content/enemies.ts` → `karachun` | тест контента
  (`findStalkerProblems`), отпечаток контента; геймдизайнер калибрует.
- `docs/35-stage4-plan.md`: у Р205 — «Как сделано: T-0424, коридоры
  `STRONG_BOT_TARGETS.stalker`» одной фразой в конце текста решения. Если
  калибровка упёрлась в решение владельца — вопрос в PR, а не правка Р205.

## Критерии приёмки

- [ ] В боевом забеге с 4-й минуты приходит Карачун; в прологе и у новичка —
      нет.
- [ ] Оболочка получает `stalkerEnded` по одному на появление.
- [ ] Коридоры Карачуна выполнены или в PR вопрос с таблицей; прежние
      коридоры не сдвинуты молча.
- [ ] Эталоны обновлены, дельта описана.
- [ ] `CLAUDE.md`, `docs/32`, `docs/30` описывают Карачуна.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и `pnpm task check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Карачун приходит в забег`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: с 4-й минуты за тобой может прийти Карачун. Убить его нельзя — удары лишь отталкивают, касание снимает треть здоровья. Иней на земле показывает, откуда он выйдет: уходи, через 10–20 секунд он растворится`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРАЧУН ПРИХОДИТ В ЗАБЕГ**

  С 4-й минуты боевого забега в случайный момент приходит Карачун — неубиваемый преследователь (Р205). Иней на земле за полторы секунды показывает место, потом погоня 10–20 секунд и растворение. Касание снимает треть здоровья, удары только отталкивают. Новичкам до 4-го уровня аккаунта и в прологе его нет.

  🛠 **Баланс**

  • стоящий сильный бот живёт короче, бегущий — почти как раньше; таблица — в PR
  • эталоны забега обновлены
  ```
