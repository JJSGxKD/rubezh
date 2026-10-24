---
id: T-0163
title: Забег, прерванный обновлением игры, засчитывается, а не пропадает
epic: E6
priority: P1
status: done
owner: claude-5 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: []
zones:
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/snapshot-counters.ts
  - packages/core-game/src/index.ts
  - packages/core-game/test/snapshot-counters.test.ts
  - packages/core-game/test/run-snapshot.test.ts
  - packages/app-shell/src/state/run-save.ts
  - packages/app-shell/src/state/run-interrupted.ts
  - packages/app-shell/src/state/runs.ts
  - packages/app-shell/src/state/navigation.ts
  - packages/app-shell/src/screens/meta/run-interrupted.tsx
  - packages/app-shell/src/app/App.tsx
  - packages/app-shell/src/app/lazy-screens.tsx
  - packages/app-shell/src/i18n/run-interrupted.ts
  - packages/app-shell/src/i18n/ru-run-interrupted.json
  - packages/app-shell/src/index.tsx
  - packages/app-shell/test/run-interrupted.test.ts
  - packages/app-shell/test/run-save.test.ts
  - backend/api/src/modules/events/event-dictionary.ts
shared:
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
batch: 1
---

# T-0163. Забег, прерванный обновлением игры, засчитывается, а не пропадает

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0163.json)](../README.md#значки-статуса)

## Зачем

Игрок свернул игру посреди забега, мы выкатили версию, он открыл приложение:
сохранение забега другой сборки молча стирается, и забег пропадает из рекорда,
рейтинга и награды. После этой задачи такой забег уходит на сервер как брошенный
(`abandoned`) с тем временем и уровнем, что были в сохранении, а игрок один раз
видит карточку «Игра обновилась — забег засчитан».

## Решения

Решение пользователя от 19.10.2026: забег, прерванный выкатом новой версии,
засчитывается до выпуска пачки 1, а не пропадает. Продолжать старый забег на
новой сборке по-прежнему нельзя и не нужно: на проде v0.8.1 формат мира 7, в
`dev` 8, и контент другой.

Решения `claude-lead-1` от 19.10.2026:

1. **Засчитываем при загрузке.** Оболочка находит сохранение, которое не
   продолжается (не совпал `format` или `contentHash`), и вместо молчаливого
   стирания отправляет завершение забега с исходом `abandoned`: время и уровень —
   из `summary`, оружие и навыки — из `summary`, `contentHash` — из сохранения
   (сборки, на которой шёл забег), `cheats` и `dev` — из сохранения.
2. **Повтор безопасен, отдельных попыток и сроков не заводим.** Отправка идёт
   через уже существующую очередь итогов (`state/runs.ts`, ключ
   `bh.runs.v1.pending`, потолок 40 записей): запись переживает перезапуск,
   уходит при появлении сети, а отказ сервера по самим данным (`rejected`)
   выкидывает её из очереди. Сервер идемпотентен по `runId`
   (`backend/api/src/modules/runs/runs.service.ts:86` и `:140` — повтор итога
   отвечает записанным результатом без новой записи). Поэтому сохранение
   стирается сразу после постановки в очередь, а не после ответа сервера.
3. **Возраст сохранения.** Сохранение старше `SETTLE_MAX_AGE_MS` (14 суток от
   `savedAt`) стирается без отправки и без карточки: сроков хранения у самого
   сохранения сейчас нет (`savedAt` нужен только для подписи в лобби), а итог,
   пролежавший месяцы, уже не отражает нынешнюю игру. `savedAt` из будущего
   (часы переведены) считается свежим. 14 суток — решение claude-lead-1 от
   19.10.2026.
4. **Карточка — один раз.** «Игра обновилась — забег засчитан», время и уровень.
   Показывается в лобби, пока игрок не нажмёт «Понятно»; хранится только в
   памяти: закрыл приложение до лобби — забег всё равно засчитан, карточки уже
   не будет. Забег разработчика (`dev`) и с читами засчитываются ровно так, как
   засчитало бы обычное завершение (`state/run.ts:715` `countsInRating`,
   `state/meta.ts:105`): исключений сверх существующих правил нет.
5. **Убийства.**
   - Впредь движок кладёт в `summary` сохранения `enemiesKilled` и `xpCollected`
     (оба необязательны в схеме оболочки, как `cheats`). Формат
     `RUN_SNAPSHOT_FORMAT` и `WORLD_SNAPSHOT_VERSION` из-за этого **не**
     меняются: поле необязательное, старое сохранение его просто не содержит.
   - Для сохранений без этих полей (прод v0.8.1) счётчики читаются из тела мира
     без восстановления мира: `world.stats.scalars.enemiesKilled` и
     `.xpCollected`. Оба поля называются так же в v0.8.1 и в `dev`
     (проверено: `git show v0.8.1:packages/core-game/src/game/sim/world.ts`,
     строки 141 и 160; в `dev` — `sim/world.ts:141` и `:160`;
     `captureWorld` кладёт `stats: encodeRecord(world.stats, …)`,
     `game/run/snapshot.ts:86`, все числовые поля попадают в `scalars`).
     Читать осторожно: нет поля или не число — 0.
6. **Сервер не меняется.** Вердикт фазы 1 примет такой забег (разбор в «Как
   сейчас»). Правок на сервере нет.
7. **Аналитика.** Новое событие не заводим: исход — `run_abandoned` с признаком
   `interrupted: "update"`. Поле добавляется в словарь сначала, потом в код.

8. **Рейтинг** — решение claude-lead-1 от 19.10.2026: засчитанный забег идёт в
   рейтинг наравне с обычным брошенным (`abandoned`): время — честное, на
   момент сохранения. Урон оружия в листе забега нулевой, бусты и продолжения
   не заявляются — так и принято.
9. **Отпечатки контента на проде** проверяет тимлид при отсечке пачки 1:
   непустой `RUNS_KNOWN_CONTENT_HASHES` без отпечатков прошлой и новой сборки
   пометил бы забеги «подозрительными». Исполнителя это не касается.

## Как сейчас

**Сохранение забега** — `packages/app-shell/src/state/run-save.ts`:

- `savedRunSchema` (строки 23–45): `format`, `contentHash`, `runId`, `seed`,
  `mapId`, `difficultyId`, `startingWeaponId`, `summary { survivalSec, level,
  weapons, passives }`, `world: unknown`, `cheats?`, `dev?`, `savedAt`. Схема
  `zod/mini` отбрасывает незнакомые поля, поэтому новое поле `summary`
  придётся объявить явно. Поля `loadout` в схеме нет (в типе `RunSnapshot`
  оно есть, `core-game/src/run-api.ts:221`), сохранение его теряет.
- `hydrate()` (строки 59–67): несовместимое сохранение — `value().write(null)`,
  `saved: null`, молча.
- `isResumable()` (строки 83–85): `format === RUN_SNAPSHOT_FORMAT &&
  contentHash === CONTENT_HASH`.
- `SAVE_KEY = "bh.run.v1.save"` (строка 19).

**Движок** — `packages/core-game/src/game/MainScene.ts`:
`captureSnapshot()` (строки 471–495) собирает `summary` из
`world.stats.elapsedSec`, `world.progression.level` и слотов;
`restore()` (строки 586–601) повторно сверяет формат и хэш. Тип
`RunSnapshotSummary` — `core-game/src/run-api.ts:224–229`;
`RUN_SNAPSHOT_FORMAT = 7` — там же, строка 187. `index.ts` ядра не
импортирует Phaser, и этого нарушать нельзя: новый файл `snapshot-counters.ts`
не должен ничего импортировать.

**Порядок запуска оболочки** — `packages/app-shell/src/index.tsx:99–106`:
`useMeta.hydrate()`, `useHints.hydrate()`, `useSavedRun.hydrate()`,
`useRuns.hydrate()`, `recoverDownedRun()`, `useDevMode.hydrate()`. Образец «итог
прошлого запуска закрывается при следующем» — `recoverDownedRun()`
(`state/run.ts:696–701`) и `state/downed-run.ts` (`takeDownedRun`).

**Очередь итогов** — `packages/app-shell/src/state/runs.ts`: `enqueue()`
(строка 324), `submitRun(result, countInRating)` (строки 148–153) ставит
`toSubmission(result, countInRating)` (строки 251–280) в очередь и запускает
`flush`. `flush` (строки 155–217) шлёт по одному и по порядку, к итогу при
отправке добавляет подписанное снаряжение по `runId`, если оно лежит на
устройстве (`withLoadout`, строки 304–309). Сеть, сервер, сессия — запись ждёт;
`rejected` — запись выбрасывается; в ответе подмешивается лучшее время в рекорд
устройства (`mergeRemote`).

**Сервер**, `backend/api/src/modules/runs`:

- `dto/runs.dto.ts:49–92` — `runFinishSchema`: `outcome` `died | abandoned`,
  `survivalSec` 0…86400, `level` 1…999, `enemiesKilled` 0…1 000 000
  (обязательное), `contentHash` до 32 знаков, `weapons` до 16, `passives`,
  `stats`, `loadout`, `continues`, `boosts` необязательны.
- `runs.service.ts:82–167` — `finish`: чужой `runId` — `ValidationError`
  (окончательный отказ, на клиенте это `rejected`); уже завершённый — повтор
  ответа (`replay`); параллельный повтор — `duplicate` → тот же ответ.
- `run-verdict.ts:90–126` — вердикт фазы 1. Разбор для нашего случая:
  - **`enemiesKilled: 0` при большом `survivalSec`** — проверка темпа убийств
    сравнивает частоту сверху, ноль её не нарушает; забег не помечается.
    Темп уровней считается от `level` из `summary` и честен.
  - **`contentHash` прошлой сборки** — сверяется только со списком
    `RUNS_KNOWN_CONTENT_HASHES` (`config/app-config.ts:168`), и только если
    список не пуст; незнакомый хэш — «подозрительный», не отказ
    (`run-verdict.ts:113`). Попадёт ли хэш прошлой сборки в список — зависит
    от того, как выкат ведёт список; если нет, забег получит «подозрительный»
    и в рейтинг не пойдёт, награду за забег получит (`progress-rules.ts:50`).
    Список правит выкат, не эта задача.
  - **Время** — сверяется с часами сервера по старту; итог приходит позже
    старта, поэтому заявленное время не длиннее прошедшего. Если старт не дошёл,
    причина `unverified_time` вердикта не меняет.
  - **Продолжения и бусты** — шлём пустые списки, поэтому «неоплаченных»
    нет. Оплаченный, но не заявленный буст в этой задаче не разбирается:
    его возвращает существующий возврат бустов забегам, которые не начались
    (`boosts/boosts-refunder.ts`), если он подходит под его условия.
  - **Рейтинг.** `rankable = verdict === "ok" && (!cheats || …)`
    (`runs.service.ts:111`), исход `abandoned` на это не влияет: забег,
    засчитанный как брошенный, сейчас идёт в рейтинг наравне с обычным.
    Решать о `countInRating` не нужно: поле клиент посылает только при
    читах, правило прежнее.
- Награда за забег (`progress/progress-rules.ts:45–62`): монеты зависят от
  минут и (слабо) от числа убийств (`COINS_PER_100_KILLS = 3`), опыт аккаунта —
  от минут и уровня. С `enemiesKilled` из тела мира недостачи нет; для
  сохранения без счётчика (если мир не прочитается) — потеря малая и
  принимается.

**Что изменилось рядом.** Тест `packages/app-shell/test/run-save.test.ts:169–177`
проверяет, что несовместимое сохранение не предлагается к продолжению
(`saved` — `null`); после задачи это остаётся верным, но запись при этом
остаётся в хранилище до `settleInterruptedRun()`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Ядро: счётчики сохранения.**
   - `packages/core-game/src/snapshot-counters.ts` (без импортов):
     ```ts
     export interface SnapshotCounters { enemiesKilled: number; xpCollected: number }
     /** Счётчики забега из тела мира снимка, без восстановления мира. Не бросает. */
     export function readSnapshotCounters(world: unknown): SnapshotCounters
     ```
     Путь чтения — `world.stats.scalars.enemiesKilled` и `.xpCollected`.
     `enemiesKilled` — целое `Math.floor` и не меньше 0, `xpCollected` — конечное
     не меньше 0; всё остальное (нет объекта, нет поля, не число, `NaN`,
     отрицательное) — 0. Комментарий: почему путь стабилен между форматами 7 и 8
     (все числовые поля пула кладутся в `scalars`, `snapshot.ts:182–191`).
   - `core-game/src/index.ts` — экспорт `readSnapshotCounters` и типа.
   - `run-api.ts`, `RunSnapshotSummary` — два необязательных поля:
     ```ts
     /** убийства к моменту снимка; нет поля — сборка до него, счётчик читается из `world` */
     enemiesKilled?: number;
     xpCollected?: number;
     ```
   - `MainScene.ts`, `captureSnapshot()` — в `summary` добавить
     `enemiesKilled: world.stats.enemiesKilled` и
     `xpCollected: world.stats.xpCollected`. `RUN_SNAPSHOT_FORMAT` и
     `WORLD_SNAPSHOT_VERSION` **не трогать**.
3. **Оболочка: сохранение.** `run-save.ts`:
   - в `savedRunSchema.summary` — `enemiesKilled: z.optional(z.number())`,
     `xpCollected: z.optional(z.number())`;
   - `hydrate()` больше **не стирает** несовместимое сохранение: `saved: null`,
     запись остаётся (комментарий: её заберёт `settleInterruptedRun`, пока
     она не засчитана, стирать нельзя);
   - `takeIncompatibleRun(): SavedRun | null` — читает хранилище; если запись
     есть и `!isResumable(...)` — стирает и возвращает её, иначе `null`.
     Образец — `takeDownedRun()`. Обновить шапочный комментарий файла: «молча
     удаляется» больше неверно.
4. **Оболочка: очередь.** `runs.ts` — в `RunsStore` метод
   `submitSettled(submission: RunFinishSubmission): void`: ставит запись в
   очередь, **если записи итога с этим `runId` в очереди нет**, обновляет
   `pending` и запускает `flush("launch")`. Без авторизации (`api() === null`)
   — ничего, как у `submitRun`.
5. **Оболочка: засчёт.** Новый `state/run-interrupted.ts`:
   - `SETTLE_MAX_AGE_MS = 14 * 24 * 3600 * 1000`;
   - `settleInterruptedRun(): void` — `takeIncompatibleRun()`; нет — выход;
     старше `SETTLE_MAX_AGE_MS` (по `Date.now() - savedAt`; `savedAt` из
     будущего — свежее) — выход без отправки;
   - счётчики: `summary.enemiesKilled` и `summary.xpCollected`, если заданы и
     корректны, иначе `readSnapshotCounters(saved.world)`; затем зажать
     `enemiesKilled` в 0…1 000 000, `xpCollected` в 0…1e9 (потолки схемы
     сервера);
   - собрать `RunFinishSubmission`: `runId`, `difficultyId`,
     `startingWeaponId`, `contentHash` — из сохранения; `outcome: "abandoned"`;
     `survivalSec` зажат в 0…86 400; `level` — целое, не меньше 1, не больше
     999; `weapons` и `passives` — `{ id, level }` из `summary` (урона
     оружия нет — поле `damage` не шлём); `deathCause: null`; `continues: []`;
     `stats: { damageTaken: 0, xpCollected, waveReached: 0, topKills: [] }`
     — **или без `stats`**, если `xpCollected` неизвестен (решение исполнителя,
     ради листа забега в профиле; на вердикт не влияет); `cheats: true` и
     `countInRating` — только если `saved.cheats === true`, ровно как
     `toSubmission` (`countInRating = saved.dev === true &&
     useDevMode.getState().settings.countInRating`);
   - `useRuns.getState().submitSettled(submission)`;
   - рекорд на устройстве: `useMeta.getState().submitRun(result, countInRating)`
     — ему нужен `RunResult`, соберите минимальный (нули и пустые значения там,
     где данных нет), на сервер он **не уходит**. Для забега с читами без
     `countInRating` `submitRun` сам ничего не пишет (`meta.ts:105`);
   - событие: `track("run_abandoned", {...})` с полями, которые уже шлёт
     `outcomeFields` (`state/run.ts:719+`: `seed`, `survivalSec`, `level`,
     `wave: 0`, `enemiesKilled`, `weapon`, `map`, `difficulty`, `contentHash`,
     `isNewRecord`, `cheats`) плюс `interrupted: "update"`. Не копировать
     функцию: вынести `outcomeFields` в общий экспорт `state/run.ts` или
     собрать поля заново — на усмотрение, но без дублей смысла;
   - уведомление: `useInterruptedNotice.setState({ notice: { survivalSec, level } })`
     и ожидание лобби — по образцу `waitForLobby()`
     (`state/compensation.ts:110–128`): подписка на навигацию, когда верхний
     экран — `lobby`, `push("runInterrupted")`. Хранилище карточки — Zustand в
     памяти.
6. **Оболочка: запуск.** `index.tsx` — вызов `settleInterruptedRun()` **после**
   `useDevMode.getState().hydrate()` (строка 106): ему нужны уже поднятые
   `useMeta`, `useRuns`, настройки разработчика и `track`.
7. **Карточка.** `navigation.ts` — `ScreenId` `"runInterrupted"`;
   `lazy-screens.tsx` — загрузчик и `RunInterruptedScreen` по образцу
   `testerThanks`; `App.tsx` — `case "runInterrupted"`;
   `screens/meta/run-interrupted.tsx` — на `Modal` из дизайн-системы, как
   `tester-thanks.tsx`: заголовок, строка итога, кнопка «Понятно» (закрывает
   экран и сбрасывает уведомление); «Назад» тоже закрывает. Нет уведомления
   при открытии (дубль, перезапуск) — `pop()` и ничего не показывать, как
   `tester-thanks.tsx` при пустой компенсации. Тексты — свой ленивый словарь
   `i18n/run-interrupted.ts` по образцу `i18n/tester.ts` (в основной `ru.json`
   не добавлять):

   | Ключ | Текст |
   |---|---|
   | `runInterrupted.title` | `Игра обновилась — забег засчитан` |
   | `runInterrupted.text` | `Забег прервался из-за обновления, но не пропал.` |
   | `runInterrupted.result` | `Вы продержались {time} и дошли до уровня {level}.` |
   | `runInterrupted.ok` | `Понятно` |

   `{time}` — `formatDuration(survivalSec)`, `{level}` — число.
8. **Аналитика.** `event-dictionary.ts`, схема `runOutcome` — необязательное
   поле `interrupted: id.optional()` (а не новое событие); та же строка в
   таблице `run_abandoned` в `docs/22` §3.3 (поле `interrupted`: `update` —
   забег засчитан после обновления игры, `enemiesKilled` и `wave` у него
   приблизительные). Заодно в таблице назвать поле `recovered` у
   `run_finished` (`state/run.ts:700`): оно шлётся, но в словаре не описано.
9. **Документы.**
   - `docs/27` §7 (таблица хранилища, строка `run-save`) и абзац про
     сохранение: несовместимое сохранение засчитывается как брошенный забег
     (с карточкой), а не удаляется;
   - `docs/30` — строка про `bh.run.v1.save`: упомянуть, что несовместимое
     сохранение уходит в очередь итогов (`bh.runs.v1.pending`) и срок
     `SETTLE_MAX_AGE_MS`;
   - гайдбук и `README` менять не нужно.

## Чего не трогаем

- `RUN_SNAPSHOT_FORMAT`, `WORLD_SNAPSHOT_VERSION`, `restoreWorld` и сверку в
  `MainScene.restore()` — продолжать чужой снимок по-прежнему нельзя.
- Сервер: `runs.service.ts`, `run-verdict.ts`, `runFinishSchema`, пороги
  антифрода и награду — без правок.
- Начало забега, второй шанс (`downed-run.ts`), «Продолжить» в лобби.
- Подписанное снаряжение: клиент ничего не пересчитывает, `withLoadout`
  подмешивает его по `runId`, как и для обычного итога.

## Сценарий и интерфейс

Только карточка в лобби:

- **Есть засчитанный забег** — окно с заголовком, строкой итога и «Понятно»;
- **Нет сети или нет входа** — карточка та же: забег в очереди, отправится при
  появлении связи; без авторизации (MAX, VK) в очередь ничего не идёт, а рекорд
  устройства обновляется;
- **Нет данных** (уведомления нет) — окно не показывается;
- **Загрузка и ошибка** — не предусмотрены: окно не ходит в сеть.

Макета нет (`design: null`): тот же `Modal`, что у `tester-thanks.tsx`, токены
и отступы дизайн-системы. Проверить на 320, 390, 768 и 1440 px.

## Тесты

Пишутся первым коммитом, до кода.

- `packages/core-game/test/snapshot-counters.test.ts`:
  - тело из `captureWorld` мира с `enemiesKilled = 37` и `xpCollected = 120`
    → читаются 37 и 120;
  - то же для тела, собранного вручную в виде версии 7 (только `stats.scalars`)
    → читаются;
  - `undefined`, `null`, строка, пустой объект, `stats` без `scalars` → `0` и
    `0`, без исключения;
  - `enemiesKilled: -5`, `NaN`, `"12"` → `0`; `enemiesKilled: 7.9` → `7`.
- `packages/core-game/test/run-snapshot.test.ts` — `captureSnapshot()`
  (через существующий способ получения снимка в этом файле) кладёт в `summary`
  `enemiesKilled` и `xpCollected`, равные счётчикам мира; `format` прежний.
- `packages/app-shell/test/run-interrupted.test.ts` (хранилище в памяти, очередь
  итогов настоящая, сеть подменена):
  - сохранение с другим `contentHash` и `summary` без счётчиков, в теле
    `stats.scalars.enemiesKilled = 41` → в очереди одна запись `finish` с
    `outcome: "abandoned"`, `enemiesKilled: 41`, `contentHash` из сохранения,
    `survivalSec` и `level` из `summary`, `continues: []`; сохранение стёрто;
  - то же с другим `format` → то же самое;
  - сохранение с `summary.enemiesKilled = 12` → берётся 12, а не из тела мира;
  - тело мира без счётчика → `enemiesKilled: 0`;
  - совместимое сохранение (тот же формат и хэш) → ничего не отправлено и не
    стёрто, `saved` задан;
  - сохранение старше `SETTLE_MAX_AGE_MS` → стёрто, в очереди пусто, карточки
    нет; на сутки моложе → засчитано; `savedAt` в будущем → засчитано;
  - `survivalSec: 90 000` → в записи 86 400; `level: 0` → 1;
  - второй вызов `settleInterruptedRun()` подряд → записей в очереди одна;
  - запись с тем же `runId` уже в очереди → вторая не добавляется;
  - забег с читами и `dev`: без `countInRating` в настройках разработчика →
    `cheats: true`, `countInRating: false`, рекорд устройства не меняется; с
    `countInRating` → `countInRating: true`;
  - обычный забег → в записи нет `cheats`; рекорд устройства обновлён;
  - сборка без авторизации → в очередь ничего не идёт, сохранение стёрто, рекорд
    устройства обновлён;
  - сервер ответил `rejected` (поддельный клиент) → запись выброшена, повторов
    нет; ответил сеть/сервер — запись осталась в очереди;
  - `track` вызван с `run_abandoned` и `interrupted: "update"`, `wave: 0`;
  - карточка: верхний экран не `lobby` → не показывается; стал `lobby` → стек
    `["lobby", "runInterrupted"]`; после закрытия повторно не открывается.
- `packages/app-shell/test/run-save.test.ts` — к существующему кейсу
  «не предлагает продолжить…»: после `hydrate()` запись **осталась** в
  хранилище, `saved` — `null`; `takeIncompatibleRun()` вернёт её и стирает; для
  совместимого сохранения вернёт `null` и не стирает; схема принимает
  `summary` с `enemiesKilled`/`xpCollected` и без них.
- Скриншоты экрана — снимки `RunInterruptedScreen` на 320, 390, 768 и 1440 px
  по заведённому в `app-shell` способу (как у `TesterThanksScreen`, если у него
  есть снимки; иначе — проверка в браузере и отметка в PR).

## Аналитика

`run_abandoned` с новым необязательным полем `interrupted: "update"` (словарь
`docs/22` §3.3 и `event-dictionary.ts` — раньше кода). `enemiesKilled`
при этом может быть нулём (мир не прочитался), `wave` равна 0. Событие шлёт
клиент при засчёте. По полю видно, сколько забегов теряет каждый выкат.

## Настройки и окружение

Нет. `SETTLE_MAX_AGE_MS` — константа в коде (14 суток); в панель не выносим.

## Документы

Шаг 9: `docs/27` §7, `docs/30` (строка `bh.run.v1.save`), `docs/22` §3.3.
Схемы `docs/21-diagrams.md` не меняются: связи между модулями те же.

## Критерии приёмки

- [ ] Сохранение забега другой сборки (формат или хэш) больше не стирается
  молча: на сервер уходит завершение с `abandoned`, временем и уровнем из
  сохранения, затем сохранение стирается.
- [ ] Для сохранения прода v0.8.1 (без счётчиков в `summary`) убийства читаются
  из `world.stats.scalars`; нет поля — 0.
- [ ] Новые сохранения несут `summary.enemiesKilled` и `xpCollected`;
  `RUN_SNAPSHOT_FORMAT` и `WORLD_SNAPSHOT_VERSION` не изменены.
- [ ] Повтор не двоит забег: две записи с одним `runId` в очередь не попадают, а
  сервер на повтор отвечает прежним результатом.
- [ ] Игрок один раз видит карточку «Игра обновилась — забег засчитан» с
  временем и уровнем.
- [ ] Забег с читами и режим разработчика ведут себя как при обычном
  завершении.
- [ ] Сервер не изменён; `docs/22` §3.3 и словарь событий согласованы
  (`scripts/test/event-dictionary.test.ts`).
- [ ] Гейт (`CLAUDE.md`), `pnpm budget` и `pnpm docs:check` зелёные; новый
  чанк экрана и словаря не раздул первую загрузку.

## PR

- **Заголовок:** `fix(app-shell): Засчитать забег, прерванный обновлением`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- исправлено: забег, который прервался из-за обновления игры, теперь засчитывается, а не пропадает`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАБЕГ, ПРЕРВАННЫЙ ОБНОВЛЕНИЕМ, ЗАСЧИТЫВАЕТСЯ**

  Если игру обновили посреди забега, сохранение другой сборки больше не стирается молча: забег уходит на сервер как брошенный, с временем и уровнем из сохранения, а игрок один раз видит карточку «Игра обновилась — забег засчитан». Продолжить старый забег на новой сборке по-прежнему нельзя.

  🛠 **Что внутри**

  • сохранение теперь несёт число убийств; у сохранений прошлых сборок оно читается из тела мира, иначе 0
  • отправка идёт через обычную очередь итогов, повтор безопасен
  • сервер не менялся; в аналитике — поле `interrupted` у `run_abandoned`
  ```
