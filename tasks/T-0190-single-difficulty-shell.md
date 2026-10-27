---
id: T-0190
title: Одна сложность у игрока — без выбора, первый забег обучающий
epic: E10
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0101, T-0102, T-0103, T-0107, T-0111, T-0116, T-0125, T-0166, T-0182, T-0185]
zones:
  - packages/app-shell/src/state/difficulty.ts
  - packages/app-shell/src/state/meta.ts
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/screens/pre-run.tsx
  - packages/app-shell/src/screens/run/RunScreen.tsx
  - packages/app-shell/src/screens/run/death-parts.tsx
  - packages/app-shell/src/screens/run/DeathNext.tsx
  - packages/app-shell/src/screens/meta/rating.tsx
  - packages/app-shell/src/screens/meta/profile.tsx
  - packages/app-shell/src/screens/meta/run-detail.tsx
  - packages/app-shell/src/screens/home-widgets.tsx
  - packages/app-shell/src/screens/home-widget-rules.ts
  - packages/app-shell/src/screens/home-showcase.tsx
  - packages/app-shell/src/screens/guide/GuideScreen.tsx
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/engine/run-engine.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/game/run/restart-data.ts
  - packages/core-game/src/game/run/records.ts
  - packages/core-game/test/run-records.test.ts
  - packages/app-shell/test/difficulty.test.ts
  - packages/app-shell/test/single-difficulty.test.ts
  - packages/app-shell/test/run-restart-difficulty.test.ts
  - packages/app-shell/test/meta-last-run.test.ts
  - packages/core-game/test/restart-data.test.ts
shared:
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/i18n/ru-guide.json
  - packages/app-shell/src/i18n/ru-home.json
  - packages/app-shell/src/i18n/ru-tasks.json
  - docs/05-game-design.md
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
  - docs/30-configuration-map.md
  - packages/app-shell/src/app/App.tsx
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0190. Одна сложность у игрока — без выбора, первый забег обучающий

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0190.json)](README.md#значки-статуса) [![T-0101](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0101.json&label=T-0101)](archive/T-0101-card-reroll-skip-banish.md) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](archive/T-0102-weapon-evolutions-data-and-engine.md) [![T-0103](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0103.json&label=T-0103)](archive/T-0103-weapon-evolution-recipes-in-game.md) [![T-0107](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0107.json&label=T-0107)](T-0107-achievements-showcase-shell.md) [![T-0111](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0111.json&label=T-0111)](T-0111-weekly-season-screen.md) [![T-0116](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0116.json&label=T-0116)](archive/T-0116-freeze-pickup.md) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](T-0125-run-result-rank-chest-crystal-counters.md) [![T-0166](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0166.json&label=T-0166)](archive/T-0166-narrow-screen-leftovers.md) [![T-0182](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0182.json&label=T-0182)](archive/T-0182-cordon-ring-analytics.md) [![T-0185](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0185.json&label=T-0185)](archive/T-0185-modal-layer-above-chrome.md)

## Зачем

Сейчас перед каждым забегом игрок выбирает из трёх сложностей, и у каждой свой
рекорд и своя таблица рейтинга. Решение Р126: **выбора нет, сложность одна**,
она заметно тяжелее нынешней «Сложной» (сами числа — T-0192). Легче только
первый, обучающий забег аккаунта. После задачи игрок не видит слова «сложность»
ни в листе «Перед забегом», ни на экране смерти, ни в рейтинге; рекорд и
таблица одни. Серверная половина перехода — T-0191.

## Решения

Р126 (`docs/35-stage4-plan.md`, 20.10.2026; уточняет Р65 и WP34). Порядок
перехода решил `claude-lead-1` 20.10.2026 (**первый шаг expand**, сведение id
в одно значение — отдельной задачей потом, не здесь):

- **Внутренние id остаются.** Единая сложность занимает место `"hard"`.
  Обучающий первый забег — `"easy"` (так и сейчас: `App.tsx`, `acceptAndPlay`
  ставит `"easy"` до первого забега). `"normal"` новый клиент **не выдаёт**,
  но схемы читают его (`z.enum(DIFFICULTY_IDS)`): сохранённый забег, запись в
  очереди отправки и старые значения в `localStorage` прежних сборок
  принимаются. Типы `DifficultyId`, `DIFFICULTY_IDS`, контент
  `core-game/src/content/difficulty.ts` **не меняются** (числа множителей
  меняет T-0192, id сводит отдельная задача).
- **Правило сложности забега одно:** аккаунт без законченных забегов
  (`useMeta.runs === 0`) → `"easy"`, иначе `"hard"`. Сохранённый
  `lastDifficultyId` из `localStorage` не влияет ни на что: выбор исчез.
  «Ещё раз» с экрана итогов — всегда `"hard"` (до него уже был забег).
- **Обучающий забег не рекорд.** Он увеличивает счётчик забегов, но не пишет
  локальный рекорд, не зажигает «Новый рекорд», не попадает в `lastRun`.
  Сервер его в рейтинг не берёт (T-0191), место в ответе пустое.
- **Рекорд один** — по `"hard"`. Старые локальные рекорды `normal`/`easy`
  остаются в хранилище, но нигде не показываются. Локальный рекорд `hard`
  прежней сборки **сбрасывается** (решение `claude-lead-1`, 20.10.2026): он
  поставлен на прежнем, лёгком контенте, и «До рекорда ещё…» звало бы к числу,
  которого на единой сложности не достать. Сервер отдаёт лучшее с отсечки
  рейтинга (T-0191, `profile.best`), так что после сброса локальный рекорд и
  серверный сходятся. Сбрасывается и рекорд движка
  (`core-game/src/game/run/records.ts`, ключ `bestSurvivalSec.hard` — новый
  ключ единой сложности, старый не читается), и `best.hard` в сохранённом
  профиле `state/meta.ts` (`bh.meta.v1.profile`): иначе `mergeRemote` вернёт
  старое число как большее.
- **История остаётся с прежней пометкой:** в списке последних забегов и в
  листе забега плашка сложности показывается только у забегов не на единой
  сложности — «Обучение» (`easy`) и «Нормальная» (`normal`); у `hard` плашки
  нет.
- **Режим разработчика** выбор сложности не получает (прежде он выбирал её
  там же, в листе): проверка баланса — `pnpm balance:sim`.

## Как сейчас

Оболочка (`packages/app-shell/src`):

- `screens/pre-run.tsx:212-218` — `SegmentedControl` сложности и строка
  описания (`difficulty.<id>.description`); импорты `DIFFICULTIES` (стр. 4) и
  `DifficultyId` (стр. 3).
- `app/App.tsx:285-302` — `acceptAndPlay`: после согласия
  `playedBefore()`; не играл → `rememberDifficulty("easy")`, `intend({kind:"new"})`,
  `push("run")`. Комментарий называет «Лёгкую» балансом без поправок.
- `screens/run/RunScreen.tsx:84` — `difficultyId: resume?.difficultyId ??
  useMeta.getState().lastDifficultyId`.
- `state/meta.ts` — `lastDifficultyId` (стр. 23, 43, 66, 77), `rememberDifficulty`
  (стр. 53, 91), `best: Record<DifficultyId, number>` по сложностям,
  `submitRun` (стр. 99-113) пишет рекорд и `lastRun` для любой сложности.
- `state/run.ts:433-451` `restart()` и `485-505` `restartSession`: «Ещё раз»
  зовёт `session.restart(seed)`; движок пересоздаёт сцену с **теми же**
  `sceneData`, в том числе `difficultyId`
  (`core-game/src/game/MainScene.ts:422-432` `restartRun`). Без правки после
  обучающего забега «Ещё раз» повторил бы лёгкий.
- `screens/run/death-parts.tsx:96-97` — `Badge` сложности в `ResultsHero`;
  `screens/run/DeathNext.tsx:31` — `state.best[result.difficultyId]`.
- `screens/meta/rating.tsx:39-77` — выбор сложности, `leaderboards[difficultyId]`,
  `load(id)` с защитой от гонки между вкладками; тексты `rating.subtitle`,
  `rating.empty`, `rating.me.none` говорят «на этой сложности».
- `screens/meta/profile.tsx:133-152` — три карточки рекордов по
  `DIFFICULTY_IDS`; `profile.tsx:194` и `screens/meta/run-detail.tsx:88` —
  `Badge` сложности забега.
- `screens/home-widgets.tsx:200-203` и `536-544`, `screens/home-widget-rules.ts:131`
  (`recordFace`), `screens/home-showcase.tsx:27-29` — виджет рекорда по
  `lastDifficultyId` и подпись «Лучший забег · {difficulty}».
- `screens/guide/GuideScreen.tsx:153-168` — раздел «Сложность» перечисляет
  `DIFFICULTIES` с множителями (`guide.difficulty.*`).
- Словари: `i18n/ru.json` строки 55, 88-94, 198-204; `ru-guide.json` 38-41 и
  45; `ru-home.json` 53; `ru-tasks.json` 53-54 (тексты заданий «на сложности
  «…»»).

Движок (`packages/core-game/src`): `run-api.ts:561` `restart(seed)`,
`engine/run-engine.ts:83-85`, `game/MainScene.ts:76-81` `MainSceneData`
(`difficultyId`), `422-432` `restartRun`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`state/difficulty.ts` (новый файл)** — единственное место правил:
   ```ts
   export const RATED_DIFFICULTY_ID = "hard" satisfies DifficultyId;
   export const TUTORIAL_DIFFICULTY_ID = "easy" satisfies DifficultyId;
   /** Сложность следующего забега по числу законченных забегов аккаунта. */
   export function difficultyForNextRun(runsPlayed: number): DifficultyId;
   /** Ключ плашки сложности в истории; `null` — плашки нет (единая сложность). */
   export function historyDifficultyKey(id: DifficultyId): string | null;
   ```
   `difficultyForNextRun(0)` → `"easy"`, любое большее (и нецелое, и
   отрицательное — как `0`) считается по правилу «`runsPlayed > 0` → `"hard"`».
   `historyDifficultyKey("hard")` → `null`, `"easy"` → `"difficulty.easy.name"`,
   `"normal"` → `"difficulty.normal.name"`.
3. **`state/meta.ts`:**
   - из стора и `persist` уходят `lastDifficultyId` и `rememberDifficulty`;
     в `schema` поле остаётся необязательным с комментарием «читается и
     игнорируется: до единой сложности игрок выбирал её сам» — старый снимок
     профиля не должен ломать `createPersistedValue`;
   - `submitRun`: после проверки читов, если `result.difficultyId !==
     RATED_DIFFICULTY_ID`, — только `runs + 1` и `persist`, без
     `submitRunResult`, без `best`, без `lastRun`; вернуть `false`. Для
     `RATED_DIFFICULTY_ID` и для `"normal"` из продолженного старого
     сохранения поведение прежнее;
   - `best`, `mergeRemote`, `bestOverall` не трогать: сервер присылает `null`
     для нерейтинговых, остальное уже умеет.
4. **Движок: «Ещё раз» с новой сложностью.**
   - `core-game/src/game/run/restart-data.ts` — чистая функция
     `restartSceneData(data: MainSceneData, seed: number, difficultyId?:
     DifficultyId): MainSceneData`: то, что сейчас делает `restartRun`
     (`seed`, без `resume` и `runId`, бусты `[]` у `loadout`), плюс
     `difficultyId`, если передан. Тип `MainSceneData` импортировать из
     `MainScene.ts` как тип; циклического импорта значений быть не должно.
   - `MainScene.restartRun(seed, difficultyId?)` берёт данные из этой
     функции; `engine/run-engine.ts` и `run-api.ts` (`restart(seed: number,
     options?: { difficultyId?: DifficultyId }): void`, комментарий — зачем:
     после обучающего забега следующий идёт на единой сложности) пробрасывают
     параметр. Без параметра поведение прежнее.
5. **`state/run.ts`** — `restartSession`: `session.restart(seed, { difficultyId:
   RATED_DIFFICULTY_ID })` и `startOptions = { ...startOptions, difficultyId:
   RATED_DIFFICULTY_ID }` до события `run_started`, чтобы в аналитику ушла
   настоящая сложность. Комментарий: «Ещё раз» бывает только после забега —
   значит, первого забега уже нет.
6. **`screens/run/RunScreen.tsx:84`** — `difficultyId: resume?.difficultyId ??
   difficultyForNextRun(useMeta.getState().runs)`.
7. **`app/App.tsx` `acceptAndPlay`** — убрать `rememberDifficulty("easy")`;
   комментарий переписать: сложность выберет `RunScreen` по числу забегов,
   у нового аккаунта это обучающий забег. Остальное (`playedBefore`,
   подсказки) не меняется.
8. **`screens/pre-run.tsx`** — убрать `SegmentedControl` и строку описания,
   импорты `DIFFICULTIES` и `DifficultyId`. На их месте, только при
   `meta.runs === 0`, одна строка `<p className="text-xs text-text-muted">`
   с `t("prerun.tutorial")`. Раскладку листа не ломать (T-0094: без
   горизонтальной прокрутки).
9. **`screens/run/death-parts.tsx`** — `Badge` сложности заменить:
   `result.difficultyId === TUTORIAL_DIFFICULTY_ID` → `Badge` с
   `t("run.death.tutorial")`; иначе плашки нет (стоит оставить обёртку
   `flex flex-wrap`, в ней уже плашки читов и рекорда). Комментарий «рекорд
   засчитан именно на ней» удалить.
   **`screens/run/DeathNext.tsx:31`** — `state.best[RATED_DIFFICULTY_ID]`: для
   обучающего забега цель «рекорд» строится от рекорда единой сложности, а не
   от лёгкой.
10. **`screens/meta/rating.tsx`** — без выбора: `const difficultyId =
    RATED_DIFFICULTY_ID`, `useState`, `latest` и `SegmentedControl` уходят
    (гонка вкладок больше невозможна), `load()` без параметра зовёт
    `loadLeaderboard(RATED_DIFFICULTY_ID)`. Тексты — раздел «Сценарий».
11. **`screens/meta/profile.tsx`** — три карточки рекордов → одна: слева
    строка места (`profile.best.rank` / `profile.best.noRank`), справа время;
    сложность в карточке не называется. Сервер — `profile?.best[RATED_DIFFICULTY_ID]`,
    локальный — `local.best[RATED_DIFFICULTY_ID]`, как сейчас берётся
    большее. Плашка забега в `RecentRunRow` и в `run-detail.tsx` —
    `historyDifficultyKey(run.difficultyId)`, `null` — без `Badge`.
12. **Рекорд на главной.** `home-widgets.tsx` (стр. 200-203) —
    `recordFace(meta.best[RATED_DIFFICULTY_ID], RATED_DIFFICULTY_ID, meta.lastRun,
    meta.runs)`; `RecordView` теряет свойство `difficulty`, заголовок —
    `t("widget.record.title")` («Лучший забег») у обоих размеров (плитка по-
    прежнему `label("record", size)`); `home-showcase.tsx:27-29` без
    `difficulty`. Сигнатура `recordFace` не меняется — тесты виджетов целы.
13. **`screens/guide/GuideScreen.tsx:153-168`** — раздел «Сложность» без
    списка: `Topic` только с текстом, `DIFFICULTIES` и `formatDecimal`
    (если больше не нужен) из импортов убрать.
14. **Словари** (тексты — дословно из раздела «Сценарий»): `ru.json`
    (`difficulty.title` и три `difficulty.*.description` удалить; имя
    `difficulty.easy.name` → «Обучение»; `lobby.record.on` — удалить, он
    нигде не используется; `rating.*`; новые `prerun.tutorial` и
    `run.death.tutorial`); `ru-guide.json` (`guide.basics.difficulty.text`,
    удалить `guide.difficulty.base` и `guide.difficulty.stats`, поправить
    `guide.basics.reward.text`); `ru-home.json` (удалить `widget.record.on`);
    `ru-tasks.json:53-54` (убрать «на сложности «{difficulty}»»). Ключи
    `difficulty.normal.name` и `difficulty.hard.name` **остаются**: на них
    ссылается `nameKey` контента. `goalFilterParams` в `state/tasks-api.ts`
    не трогаем (лишний аргумент текста безвреден — зона T-0105/T-0169).
15. **Документы:** `docs/05-game-design.md` (стр. 22, 31, 188-191),
    `docs/22-analytics-and-metrics.md` (стр. 331-337, 395, 437: поле
    `difficulty` — `easy` у обучающего забега, `hard` у единой сложности,
    `normal` бывает только у старых клиентов), `docs/27-design-system-and-app-shell.md`
    (стр. 1272, лист «Перед забегом» без выбора сложности),
    `docs/30-configuration-map.md` (стр. 75, 96, 271-272, 346: где в таблицах
    сказано «сложность выбирается»). Правятся только фразы про выбор;
    документы про баланс (`docs/32-balance.md`) и решения (`docs/35`) — не
    здесь.
16. Описание PR — раздел «Что не вошло»: сведение id в одно значение и
    очистка контента от `easy`/`normal`.

## Чего не трогаем

- `packages/core-game/src/content/difficulty.ts` и сами множители — T-0192;
  `DifficultyId`, `DIFFICULTY_IDS`, `DEFAULT_DIFFICULTY_ID` — остаются.
- `packages/core-game/src/game/run/records.ts`: ключи рекордов `easy` и
  `normal` и `migrateLegacyRecord` не меняются; меняется только ключ `hard`
  (сброс, «Решения»).
- Схемы сохранений (`state/run-save.ts`, `downed-run.ts`,
  `run-interrupted.ts`, `runs.ts`, `runs-api.ts`, `run-detail-api.ts`):
  `z.enum(DIFFICULTY_IDS)` остаётся — иначе старый клиент в очереди или
  сохранённый забег перестанут читаться. Запрос `?difficulty=` рейтинга тоже
  остаётся: сервер принимает его от любого клиента.
- `state/tasks-api.ts`, `goalFilterParams`, виды заданий и их тексты кроме
  двух строк `ru-tasks.json` — T-0191 (данные заданий) и готовые задачи
  T-0105/T-0169/T-0183.
- `screens/gallery.tsx`: витрина компонентов использует ключи
  `difficulty.<id>.name` как пример `SegmentedControl` — они остаются.
- Лист модификаторов забега (T-0123) и экран сезона (T-0111) — их правят свои
  задачи; здесь им место не отводится.
- Серверная часть и бот — T-0191. Обратная совместимость API сервера не
  меняется.
- Выбор сложности в режиме разработчика не добавляем.

## Сценарий и интерфейс

Игрок:

- **Новый аккаунт**, согласие принято → забег стартует сам на `"easy"`
  (как и сейчас), без листа «Перед забегом». Подсказки первого забега те же.
- **Смерть в обучающем забеге** → экран итогов: время, плашка «Обучающий
  забег», **без** «Нового рекорда» и без строки места. «Ещё раз» стартует
  забег на `"hard"`.
- **Лист «Перед забегом»**: переключателя и описания сложности нет. Если
  `runs === 0` (лист открыт до первого забега, например на новом устройстве
  аккаунта, который ещё не загрузил профиль), под выбором оружия строка
  «Первый забег — обучающий: враги слабее, в рейтинг он не идёт.»
- **Рейтинг**: одна таблица. Тексты: подзаголовок «Лучшее время каждого игрока.
  Обучающий забег в таблицу не идёт, попадают забеги, прошедшие проверку.»;
  пусто — «Пока никто не записал забег. Стань первым!»; у игрока без места —
  «Сыграй забег, чтобы попасть в таблицу.» Состояния загрузки, ошибки, нет
  сессии, ограничение рейтинга — как сейчас.
- **Профиль**: блок «Лучший забег» — одна карточка; у забегов в истории плашка
  «Обучение» (`easy`) или «Нормальная» (`normal`), у единой сложности плашки
  нет.
- **Главная**: виджет рекорда — «Лучший забег», время рекорда единой
  сложности; пока его нет — «—» и «Первый забег ещё впереди» (ключи те же).
- **Гайдбук**, раздел «Сложность»: «Сложность одна для всех. Первый забег
  аккаунта — обучающий: враги слабее, он не идёт в рейтинг и в рекорд. Дальше
  сложность полная, рекорд и рейтинг ведутся по ней.» В «Монеты и уровень
  аккаунта» из фразы убрать «, на сложной — щедрее» и дописать после неё
  «; за обучающий забег — поменьше».
- Новые строки: `prerun.tutorial` — «Первый забег — обучающий: враги слабее, в
  рейтинг он не идёт.»; `run.death.tutorial` — «Обучающий забег».
- Тексты заданий: «Сыграй {count} {забег…}» и «Продержись {time} в одном
  забеге» (без фразы о сложности).

Снимки в PR: лист «Перед забегом» (с подсказкой и без), итоги обучающего и
обычного забега, рейтинг, профиль, главная с виджетом рекорда, гайдбук — на
320, 390, 768 и 1440 px.

## Тесты

Пишутся первым коммитом, до кода.

- `packages/app-shell/test/difficulty.test.ts` — `difficultyForNextRun(0)` →
  `"easy"`; `(1)`, `(7)` → `"hard"`; `(-1)` и `(NaN)` → `"easy"`;
  `historyDifficultyKey`: `hard` → `null`, `easy` → `"difficulty.easy.name"`,
  `normal` → `"difficulty.normal.name"`; в словаре эти ключи есть.
- `packages/app-shell/test/meta-last-run.test.ts` (дописать):
  - забег `easy` увеличивает `runs`, возвращает `false`, не меняет `best.easy`
    и не пишет `lastRun`; повторное чтение хранилища даёт нули;
  - забег `hard` пишет рекорд и `lastRun`, возвращает `true` для нового;
  - в `bh.meta.v1.profile` лежит `lastDifficultyId: "normal"` (старая сборка):
    `hydrate()` не падает, в сторе поля нет, следующая запись профиля его не
    содержит;
  - в `bh.meta.v1.profile` лежит `best.hard: 900` прежней сборки → после
    `hydrate()` рекорд единой сложности пуст; `mergeRemote` с сервера
    `best.hard: 120` даёт 120, а не 900.
- `packages/core-game/test/run-records.test.ts` (новый) — старое значение под прежним ключом `hard` не читается
  как рекорд единой сложности; `easy` и миграция прежнего рекорда — как были.
- `packages/app-shell/test/run-restart-difficulty.test.ts` — по образцу
  `run-outcome.test.ts` (поддельный движок): после `start({ difficultyId:
  "easy" })` и события `finished` вызов `restart()` зовёт
  `session.restart(seed, { difficultyId: "hard" })`, а событие `run_started`
  несёт `difficulty: "hard"`; то же из фазы `downed`.
- `packages/core-game/test/restart-data.test.ts` — `restartSceneData`: сид
  заменён, `resume` и `runId` удалены, бусты `loadout` пусты, остальные поля
  не тронуты; без `difficultyId` сложность прежняя, с ним — новая; исходный
  объект не изменён.
- `packages/app-shell/test/single-difficulty.test.ts` (по исходникам, как
  `scripts/test/layer-boundaries.test.ts`): в `src/screens/**` и `src/state/**`
  нет `rememberDifficulty`, `lastDifficultyId` (кроме схемы в `meta.ts`),
  `difficulty.title`, `DIFFICULTIES.map`; в `pre-run.tsx` и `rating.tsx` нет
  `SegmentedControl` сложности.
- Существующие тесты, которые могут упасть и править которые нужно только по
  смыслу: `home-widgets.test.ts` (`recordFace` не менялся), `runs.test.ts`,
  `run-outcome.test.ts`, `run-save.test.ts` (id `normal` и `hard` по-прежнему
  валидны — менять нечего).

## Аналитика

События не добавляются. `run_started` и `run_finished` (`state/run.ts`) по-
прежнему несут `difficulty`: `easy` — обучающий забег, `hard` — единая
сложность, `normal` — только забеги старых клиентов и продолженные старые
сохранения. Разрез «обучающий забег» в дашбордах делается по этому значению;
словарь `docs/22` §3.3 — правка описания поля, не нового имени.

## Настройки и окружение

Нет. Переключателя в «Настройках» тоже нет: обучающий забег определяется
числом забегов аккаунта.

## Документы

Шаг 15. `docs/21-diagrams.md` не затрагивается (схема БД не меняется).

## Критерии приёмки

- [ ] В листе «Перед забегом», на итогах, в рейтинге, профиле и на главной нет
  выбора и названия сложности (кроме плашек истории «Обучение»/«Нормальная»).
- [ ] Новый аккаунт: первый забег идёт на `easy`, «Ещё раз» и все следующие —
  на `hard`; в аналитике `difficulty` соответствует.
- [ ] Обучающий забег не зажигает «Новый рекорд», не пишет рекорд и `lastRun`,
  но увеличивает число забегов.
- [ ] Старый профиль в `localStorage` с `lastDifficultyId` читается без ошибки.
- [ ] Сохранённый забег или очередь отправки со сложностью `normal` читаются.
- [ ] `restart(seed)` без параметра в движке ведёт себя как раньше.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; `pnpm budget` не превышен.

## PR

- **Заголовок:** `feat(app-shell): Одна сложность для игрока, первый забег обучающий`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: сложность теперь одна для всех; первый забег — обучающий, враги в нём слабее, и в рейтинг он не идёт`
  - `- новое: рекорд и рейтинг ведутся по единой сложности`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОДНА СЛОЖНОСТЬ У ИГРОКА**

  Игрок больше не выбирает сложность: первый забег аккаунта обучающий, дальше — единая сложность. Рекорд и рейтинг одни. Сервер переходит в T-0191, числа сложности — T-0192.

  🛠 **Что изменилось**

  • из листа «Перед забегом», рейтинга, профиля и главной ушли названия и выбор сложности
  • «Ещё раз» после обучающего забега запускает единую сложность
  • обучающий забег не даёт рекорда и в рейтинг не идёт
  • старые сохранения и значения в профиле читаются как раньше

  ❓ **Нужно от команды**

  • @владелец — выкатывать вместе с T-0191 (серверной частью) и до T-0192; проверить на телефоне первый и второй забег нового аккаунта
  ```
