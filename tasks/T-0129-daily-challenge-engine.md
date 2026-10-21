---
id: T-0129
title: Испытание дня: движок — фиксированный seed и набор на старте забега
epic: E10
priority: P1
status: ready
owner:
author: claude-lead2-22
size: M
depends_on: [T-0119, T-0190, T-0193, T-0194, T-0195, T-0196, T-0198]
zones:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/game/run/challenge.ts
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/game/run-world.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/diagnostics/run-recorder.ts
  - packages/core-game/src/game/diagnostics/replay.ts
  - packages/core-game/src/engine/run-engine.ts
  - packages/core-game/src/index.ts
  - packages/core-game/test/**
shared:
  - docs/30-configuration-map.md
  - docs/39-retention-mechanics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0129. Испытание дня: движок — фиксированный seed и набор на старте забега

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0129.json)](README.md#значки-статуса) [![T-0119](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0119.json&label=T-0119)](T-0119-run-modifiers-hurry-inverse.md) [![T-0190](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0190.json&label=T-0190)](T-0190-single-difficulty-shell.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md) [![T-0194](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0194.json&label=T-0194)](T-0194-limit-break-offers.md) [![T-0195](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0195.json&label=T-0195)](T-0195-player-power-pressure-engine.md) [![T-0196](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0196.json&label=T-0196)](T-0196-player-power-pressure-wiring.md) [![T-0198](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0198.json&label=T-0198)](T-0198-remove-enemy-projectile-code.md)

## Зачем

Испытание дня (`docs/39-retention-mechanics.md` Б9) честно только тогда, когда у
всех один и тот же забег: тот же seed, то же оружие, тот же модификатор, и ни у
кого нет снаряжения, бустов и открытых уровнем навыков, которых нет у соседа.
Движок уже детерминирован, но «одинаково для всех» держится сейчас на
аккуратности оболочки. После задачи движок принимает одно целое — набор
испытания — и сам запрещает всё, что сделало бы сравнение нечестным. Сервер
(T-0130) и экраны (T-0131) строятся на этом. Решение Р105.

## Решения

**Поправка `claude-lead-1` от 20.10.2026 (Р126, единая сложность).** Сложность плана суток — `hard`; поле `difficultyId` в плане остаётся (id не сводятся, T-0190).

Исполнитель их не пересматривает.

1. **Набор — один объект `DailyChallengeSet`** в `shared-types`:
   `{ dayKey: string; seed: number; mapId: string; difficultyId: DifficultyId;
   weaponId: string; modifierIds: RunModifierId[] }`. `dayKey` — игровые сутки
   `YYYY-MM-DD` (по Москве, как у заданий; чем они считаются — T-0130, движок
   лишь хранит строку). `seed` — целое от 1 до 4 294 967 295.
2. **`RunOptions.challenge?: DailyChallengeSet`.** Есть поле — `seed`, `mapId`,
   `difficultyId`, `startingWeaponId` и `modifierIds` берутся **из набора**, а
   одноимённые поля верхнего уровня игнорируются: рассинхрон двух копий одного
   набора невозможен по построению. Нет поля — забег как раньше, байт в байт.
3. **Испытание — это ограничение, а не новая механика.** Мир испытания обязан
   совпадать с миром, собранным обычным путём из тех же `seed`, карты, сложности,
   оружия и модификатора и **без** снаряжения. Движок ничего не добавляет в
   симуляцию, поэтому эталоны баланса и повторы не двигаются. Это главный тест
   задачи.
4. **Что запрещает режим** (молча, без ошибки: оболочка не обязана знать правила
   движка, а честный клиент их и не нарушает):
   - `loadout` и `boosts` игнорируются, мир собирается без них. Без `loadout`
     движок и так открывает весь контент без ограничений по уровню аккаунта
     (`run-world.ts`, `open = null`) — у всех одинаковый пул карточек и слоты;
   - `continues` игнорируется: смерть окончательна, второго шанса за звёзды и
     рекламу нет;
   - `resume` разрешён: снимок несёт `challenge`, правила восстанавливаются из
     него, а не из `RunOptions`.
5. **Что отвергает режим** (исключение с русским сообщением до создания мира):
   - `challenge` вместе с `dev` — режим разработчика ломает сравнение;
   - `runId` не передан или не начинается с `CHALLENGE_RUN_ID_PREFIX` (`"ch-"`,
     константа в `shared-types`, рядом `isChallengeRunId`). По префиксу сервер
     отличает забег испытания от обычного без обращения к базе (T-0130): забег
     без префикса попал бы в общий рейтинг;
   - набор с проблемами по `findChallengeSetProblems`.
6. **Итог и снимок несут набор.** `RunResult.challenge?: { dayKey: string;
   seed: number }` (оболочка отправляет его в итоге забега, сервер сверяет),
   `RunSnapshot.challenge?: DailyChallengeSet`. Поля необязательные: формат
   снимка (`format`) не меняется, старые снимки и записи читаются как обычные
   забеги. Запись диагностики (`run-recorder.ts`) получает `challengeDayKey?`:
   повтор собирает мир тем же путём и по ключу знает, что забег был испытанием.
7. **Тексты и звуки не нужны**, нового переключателя настроек нет: движок
   ничего не рисует и не озвучивает.

## Как сейчас

- `run-api.ts:230-276` — `RunOptions`: `seed`, `mapId`, `difficultyId`,
  `startingWeaponId`, `continues?`, `loadout?`, `runId?`, `dev?`, `resume?`.
- `game/run-world.ts:23-70` — `RunWorldOptions` и сборка мира; `:49-50` —
  `open = level === undefined ? null : unlocksAt(...)`: без `loadout` открыто всё.
- `engine/run-engine.ts:24-38` — передаёт параметры в сцену; `MainScene.ts`
  (`:100,217,468`) — принимает `loadout`, пишет его в снимок. Где `continues` и
  `dev` попадают в сцену, найти по `options.continues`.
- `game/run/run-result.ts:17,35` — `seed` уже есть в `RunResult`.
- `game/run/snapshot.ts:58-80` — снимок мира; `diagnostics/run-recorder.ts`,
  `replay.ts:73-78,150` — запись и повтор берут `seed` и `loadout` из записи.
- После T-0119: `modifierIds` в `RunWorldOptions`, снимке, записи и повторе.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`shared-types`:** `DailyChallengeSet`, `CHALLENGE_RUN_ID_PREFIX`,
   `isChallengeRunId(runId: string): boolean`, `challenge?` у `RunResult` и
   `RunSnapshot`. Комментарий у префикса: зачем он (сервер отличает забег
   испытания без базы).
3. **`game/run/challenge.ts`** (чистые функции, без Phaser):
   - `findChallengeSetProblems(set: DailyChallengeSet): string[]` — `dayKey` по
     шаблону `\d{4}-\d{2}-\d{2}` и существующая дата; `seed` целый в диапазоне;
     оружие есть в контенте; карта есть в контенте; сложность известна;
     модификаторов не больше `MAX_MODIFIERS_PER_RUN` (T-0119), все из
     `RUN_MODIFIER_IDS`, без повторов. Каждое сообщение называет поле и значение
     («seed 0 вне диапазона 1…4294967295»);
   - `resolveChallengeOptions(options)` — возвращает параметры мира из набора,
     бросает `Error` в случаях решения 5.
4. **`run-world.ts`, `run-engine.ts`, `MainScene.ts`:** при `challenge` брать
   параметры из `resolveChallengeOptions`, не передавать `loadout`, `boosts`,
   `continues` дальше. Без `challenge` путь кода прежний; новые ветки — одним
   условием на входе, а не россыпью по сцене.
5. **`run-result.ts`, `snapshot.ts`:** `challenge` в итоге и снимке; при
   продолжении из снимка правила берутся из снимка.
6. **`run-recorder.ts`, `replay.ts`:** `challengeDayKey?` в записи, повтор не
   теряет его.
7. **`index.ts`:** экспорт `findChallengeSetProblems` и типов; **Phaser в
   `index.ts` не импортируется** (границы слоёв, `CLAUDE.md`).
8. **Документы:** `docs/30-configuration-map.md` — строка «Испытание дня: набор
   `DailyChallengeSet`, расписание — база (T-0130)»; `docs/39` — Б9: движок
   готов. Гейт (`CLAUDE.md`).

## Чего не трогаем

- Сервер, расписание, награды, таблицу (T-0130); экраны и панель (T-0131).
- Контент (`content/*`), числа баланса, golden-эталоны: они **не должны**
  сдвинуться. Упал эталон — ошибка в задаче, а не повод его обновить.
- Серверную перепроверку забега повтором ввода: движок её умеет только в
  диагностике, сервер ввода не получает (вопросы ниже).
- Модификаторы и их числа (T-0119), снаряжение и бусты (`run-loadouts`).

## Тесты

Первым коммитом, до кода. Файлы в `packages/core-game/test/`; для каждого
найти ближайший существующий и положить рядом (`challenge.test.ts`, правки
тестов мира, снимка, повтора).

- `challenge.test.ts`, `findChallengeSetProblems`: верный набор → пусто;
  `dayKey` `2026-13-40`, `26-10-14`, пустая строка → проблема с названием поля;
  `seed` 0, −1, 4294967296, 1,5, `NaN` → проблема; неизвестные оружие, карта,
  сложность → проблема; два модификатора, неизвестный, повтор → проблема.
- Главный: мир из `challenge` равен (`toEqual` на состоянии мира) миру из тех же
  `seed`, карты, сложности, оружия, модификатора без `challenge` и без `loadout`.
  Проверить на трёх наборах (без модификатора, `hurry`, `inverse`).
- Поля верхнего уровня игнорируются: `challenge` с seed 7 и `seed: 99`
  сверху → мир как при seed 7.
- Весь контент открыт всем: набор с `loadout: { accountLevel: 1 }` и с
  `{ accountLevel: 30 }` даёт тот же мир и те же первые три выдачи карточек.
- `boosts` в параметрах (щит, старт с уровнем, лишняя карточка) при `challenge`
  не применяются: старт на уровне 1, без щита.
- `continues: true` при `challenge` → смерть окончательна, второй шанс не
  предлагается (в тесте, который уже проверяет `continues`).
- Детерминизм: один набор, один сценарий ввода, два движка → `RunResult`
  равны, в них `challenge: { dayKey, seed }`.
- Ошибки: `challenge` + `dev`; `challenge` без `runId`; `runId` без префикса
  `ch-`; набор с проблемой → `Error` с понятным русским текстом, мир не создан.
- Снимок: забег испытания → снимок → продолжение: правила на месте (`continues`
  по-прежнему игнорируются), `challenge` в итоге. Старый снимок без поля читается.
- Запись и повтор: запись забега испытания повторяется в тот же итог.
- Регрессия: прежние тесты и golden-эталоны проходят без правок;
  `sim-purity.test.ts` зелёный (степеней и тригонометрии нет); тест границ слоёв
  и бюджет (`pnpm budget`) без изменений.
- `shared-types`: `isChallengeRunId("ch-2026-10-14-…")` истина, обычный uuid и
  `"ch-"` без остального — ложь; длина самого длинного допустимого `runId` не
  больше 64 (потолок формы сервера).

## Аналитика

Нет: движок событий не шлёт. Словарь событий испытания заводит T-0130 (сервер) и
T-0131 (клиентская часть); данные для них — `RunResult.challenge`.

## Настройки и окружение

Нет. Ни ключей каталога настроек, ни переменных окружения.

## Документы

`docs/30-configuration-map.md` (строка про набор), `docs/39-retention-mechanics.md`
(Б9: движок). Схем БД и связей пакетов не меняется.

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: серверной перепроверки
  повтором ввода в этой пачке нет. Сравнение держится на фиксированном наборе,
  вердикте забега и времени от выдачи попытки; запись ввода на сервер — отдельная
  задача, если на таблице дня появятся подозрительные результаты.
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: недопустимые параметры
  (`loadout`, `boosts`, `continues`) движок молча игнорирует, а не бросает
  исключение: ошибка оболочки не должна ронять забег, а сервер всё равно сверит
  итог с выданной попыткой.

## Критерии приёмки

- [ ] Мир из `challenge` совпадает с миром обычного пути на трёх наборах; golden-эталоны не изменены.
- [ ] Снаряжение, бусты и второй шанс в режиме не работают; весь контент открыт при любом уровне аккаунта.
- [ ] `challenge` с `dev`, без `runId` и без префикса даёт русское исключение.
- [ ] Итог, снимок и запись несут набор; старые снимки и записи читаются.
- [ ] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Режим испытания дня в движке`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ИСПЫТАНИЕ ДНЯ: ДВИЖОК**

  Движок умеет играть забег по заданному набору: один seed, оружие, карта, сложность и модификатор, без снаряжения, бустов и второго шанса. До игроков пока не доходит: сервер и экраны — следующие задачи пачки.

  🛠 **Движок**

  • набор испытания — один объект, поля верхнего уровня игнорируются
  • мир испытания совпадает с обычным миром тех же параметров, эталоны баланса не сдвинулись
  • итог и снимок забега несут ключ суток

  ❓ **Нужно от команды**

  • @участник1 — решить, нужна ли серверная перепроверка повтором ввода (сейчас нет)
  ```
