---
id: T-0109
title: Экран смерти — блок «Что дальше» с двумя-тремя ближайшими целями
epic: E16
priority: P1
status: ready
owner:
author: claude-lead2-17
size: M
depends_on:
  - T-0108
zones:
  - packages/app-shell/src/screens/run/death-next.ts
  - packages/app-shell/src/screens/run/DeathNext.tsx
  - packages/app-shell/src/screens/run/DeathOverlay.tsx
  - packages/app-shell/test/death-next.test.ts
shared:
  - packages/app-shell/src/i18n/ru-run.json
  - docs/27-design-system-and-app-shell.md
  - docs/39-retention-mechanics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
version: v0.8
---

# T-0109. Экран смерти — блок «Что дальше» с двумя-тремя ближайшими целями

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0109.json)](README.md#значки-статуса) [![T-0108](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0108.json&label=T-0108)](T-0108-unlock-ladder.md)

## Зачем

Решение «уйти или сыграть ещё» принимается на экране смерти, а он показывает
только итог и награду. Игрок не видит, что до рекорда не хватило сорока секунд,
что задание выполнено на 4 из 5 или что до нового оружия остался один уровень.
После задачи под наградой стоят две-три ближайшие цели, а «Ещё раз» остаётся
главной кнопкой. Решение Р102, `docs/39-retention-mechanics.md` Р4: победы в
забеге пока нет, вместо неё «до рекорда».

## Решения

- **Блок показывает до трёх целей, самые близкие первыми.** Виды: `record` (до
  рекорда на этой сложности), `level` (до следующего уровня аккаунта), `task`
  (ежедневное или недельное задание почти выполнено), `unlock` (ближайшее
  открытие по лестнице, T-0108). Блока нет, если целей нет вовсе.
- **Серверной части нет.** Прогресс заданий берём существующей ручкой
  `GET /api/v1/tasks` (`createTasksApi().view()`, `state/tasks-api.ts:221`) после
  того, как награда за забег пришла; ответ итога забега (`RunRewardView`) не
  меняется. Причина: хук заданий на сервере срабатывает сразу после записи забега
  (`tasks.service.ts:123,286`), а награда считается позже, поэтому к моменту
  запроса прогресс, как правило, уже учтён. В редкой гонке игрок увидит на один
  забег меньше, что безвредно: блок подсказка, а не расчёт.
- **Пороги стартовые, геймдизайнер калибрует** (константы в `death-next.ts`,
  с комментарием «почему»):

  | Константа | Значение | Смысл |
  |---|---|---|
  | `MAX_GOALS` | 3 | сколько целей показывать |
  | `RECORD_CLOSE` | 0.5 | цель «рекорд» — если забег не короче половины рекорда |
  | `LEVEL_CLOSE` | 0.4 | цель «уровень» — если пройдено не меньше 40% полосы уровня |
  | `TASK_CLOSE` | 0.5 | цель «задание» — если выполнено не меньше половины |
  | `UNLOCK_CLOSENESS` | 0.3 | «близость» цели «открытие»: ставит её после трёх других, но берёт, когда они не набрались |

- **Близость цели (0…1) решает порядок:** `record` — `забег / рекорд`; `level` —
  доля полосы уровня после забега; `task` — `value / target`; `unlock` —
  `UNLOCK_CLOSENESS`. Одинаковая близость — порядок `record`, `task`, `level`,
  `unlock`.
- **Правила целей.**
  - `record`: только если забег **не** новый рекорд (у нового рекорда есть своя
    плашка в шапке) и рекорд известен (`best > 0`), `survivalSec < best`.
  - `level`: только при награде `granted`; доля и остаток опыта — из
    `levelBar(reward)` (`death-rules.ts:21-33`: `after` и `toNext`); на высшем
    уровне (`toNext === null`) цели нет.
  - `task`: из заданий периода `daily` и `weekly` с видом цели из забега
    (`runs`, `kills`, `survive_sec`, `best_survival_sec`, `run_level`), у которых
    `done === false` и `value / target ≥ TASK_CLOSE`. Подписки на канал, ссылки,
    достижения и уже выполненные не берутся. Из подходящих — одно, с большей
    долей; при равенстве ежедневное раньше недельного, дальше меньший `id`.
  - `unlock`: `nextUnlockAfter(уровень после забега)` из T-0108.
  - **Слияние:** если цель `level` прошла порог и ближайшее открытие лежит
    ровно на следующем уровне, цель `unlock` не добавляется, а её предметы
    дописываются в цель `level` («…— откроется: оружие «…»»).
- **Нет сети, гость, пустая награда.** Блок появляется одним показом, когда
  награда пришла (`granted` или `none`) и запрос заданий закончился (успехом
  или нет); ждать больше нечего, мелькания нет. Ошибка заданий, гость и
  `none` дают блок без тех целей, которые не посчитать. Награда так и не
  пришла (нет сети) — блока нет.
- **Макета нет.** `design/screens/death.html` блока не содержит; экран
  строится из токенов и существующих компонентов (`Card`, `Badge`), дизайнер
  потом приведёт к макету (E12). Место: левая колонка итогов, сразу под
  `LevelUpCard`.
- **Новые файлы вместо правки `death-parts.tsx`:** эту часть правят T-0078 и
  T-0079 (`SecondChance.tsx`, `death-parts.tsx`, `AdContinue.tsx`); отдельный
  модуль не пересекается с ними, в `DeathOverlay.tsx` вставляется одна строка.

## Как сейчас

- `packages/app-shell/src/screens/run/DeathOverlay.tsx:57-143` — шаг итогов:
  левая колонка (`ResultsHero`, `RewardCard`, `LevelUpCard`), правая
  (`RunStats`, `RunDetails`, кнопки в альбомной раскладке). Награда:
  `props.reward ?? stored` (`useProgress((s) => s.rewards[result.runId])`),
  строки 60-63. «Ещё раз» — `Button size="l" block glow` с `t("run.death.again")`,
  строки 94-97; в портрете он в закреплённом подвале, прокручивается только
  содержимое (строка 124).
- `death-rules.ts:21-33` — `levelBar(reward)` возвращает `{ level, before, after, toNext }`;
  `reward.progress` несёт `level`, `xpIntoLevel`, `xpForNext`
  (`state/progress-api.ts:22-48`).
- Рекорд: `useMeta((s) => s.best[difficultyId])`; `submitRun` обновляет его до
  показа экрана (`state/meta.ts:101-116`), поэтому у нового рекорда
  `best === survivalSec`, у обычного забега `best > survivalSec`. Новый ли
  рекорд — проп `isNewRecord` (`DeathOverlay.tsx:31`).
- Задания: `createTasksApi().view()` → `{ tasks: TaskItem[] }`; в `TaskItem`
  `period` (`daily`/`weekly`/`achievement`), `kind` (строка), `target`, `value`,
  `done`, `claimed` (`state/tasks-api.ts:21-43`). Модуль грузится вместе с
  экраном заданий — тянуть его в чанк смерти статическим импортом нельзя
  (бюджет, `pnpm budget`), только `await import("../../state/tasks-api")`.
- Время рекорда форматирует `formatDuration`, тот же, что в `ResultsHero`
  (`death-parts.tsx:78-90`); импортировать его оттуда же, откуда импортирует
  `death-parts.tsx`.
- Словарь строк забега — `i18n/ru-run.json`, подключается `import "../../i18n/run"`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`death-next.ts`**, чистые функции без React и без запросов:

   ```ts
   import type { LevelUnlock } from "../../state/level-unlocks";

   export type NextGoal =
     | { kind: "record"; closeness: number; gapSec: number; bestSec: number }
     | { kind: "level"; closeness: number; level: number; xpLeft: number; unlocks: LevelUnlock[] }
     | { kind: "task"; closeness: number; period: "daily" | "weekly"; value: number; target: number }
     | { kind: "unlock"; closeness: number; level: number; unlocks: LevelUnlock[] };

   export interface NextGoalsInput {
     isNewRecord: boolean;
     survivalSec: number;
     /** рекорд на сложности забега с учётом этого забега; `null` — неизвестен */
     bestSec: number | null;
     /** после забега: из `levelBar`; `null` — награды нет или высший уровень */
     level: { level: number; fraction: number; xpLeft: number } | null;
     tasks: readonly { id: string; period: string; kind: string; value: number; target: number; done: boolean }[];
     nextUnlock: { level: number; unlocks: LevelUnlock[] } | null;
   }

   export function pickNextGoals(input: NextGoalsInput): NextGoal[];
   ```

   Константы и правила — по «Решениям». Окружать нулевой `target`
   (деление на ноль) защитой: такое задание пропускается. Результат
   отсортирован по убыванию `closeness`, длина ≤ `MAX_GOALS`. Рядом
   `goalText(goal: NextGoal): string` — подписи из словаря (шаг 3);
   `levelGoalInput(reward)` — превращает `RunRewardView` в `level` из
   `NextGoalsInput` через `levelBar` (`null` для `pending`/`none`/высшего).
3. **`ru-run.json`** — дословно:

   ```json
   "run.next.title": "Что дальше",
   "run.next.record": "До рекорда ещё {gap} (рекорд {best})",
   "run.next.level": "До {level}-го уровня — {xp} опыта",
   "run.next.level.unlock": "До {level}-го уровня — {xp} опыта, откроется: {list}",
   "run.next.task.daily": "Задание дня почти выполнено — {value} из {target}",
   "run.next.task.weekly": "Задание недели почти выполнено — {value} из {target}",
   "run.next.unlock": "Откроется на {level}-м уровне: {list}"
   ```

   `{gap}` и `{best}` — `formatDuration(…)`; `{list}` —
   `unlocks.map(unlockLabel).join(", ")` (`state/level-unlocks.ts`); словарь
   аккаунта (`import "../../i18n/account"`) уже подключён в `DeathOverlay.tsx`.
4. **`DeathNext.tsx`** — карточка. Входные свойства: `result`, `isNewRecord`,
   `reward: RunRewardView | undefined`, `withTasks: boolean` (у витрины
   компонентов `false`: сети нет). Внутри:
   - рекорд — `useMeta((s) => s.best[result.difficultyId])`;
   - уровень после забега — `reward.progress.level` при `granted`;
   - задания: эффект, когда `reward` пришла (`status !== "pending"`) и
     `withTasks`: `await import("../../state/tasks-api")` → `createTasksApi().view()`;
     состояние `"loading" | TaskItem[] | "failed"`; размонтирование отменяет
     запись результата (флаг в эффекте, как в других экранах);
   - пока `reward` не пришла или задания грузятся — `null` (никакого скелета);
   - иначе `pickNextGoals(…)`; пусто — `null`; иначе `Card` с заголовком
     `t("run.next.title")` (стиль заголовка — как у соседних карточек, токены
     без новых цветов) и строками `goalText`; значки строк из `lucide-react`:
     `Crown` (record), `Sparkles` (level), `ListChecks` (task), `Lock` (unlock);
     появление — `animate-pop-in`, как у `LevelUpCard`. Только `transform` и
     `opacity` анимируем; отступы — токены.
5. **`DeathOverlay.tsx`**, левая колонка, сразу после `LevelUpCard`:

   ```tsx
   <DeathNext result={result} isNewRecord={props.isNewRecord} reward={reward} withTasks={props.showReward === true} />
   ```

   Блок рисуется для `died` и для `abandoned`. Кнопки и подвал не трогать.
6. **Документ:** `docs/27-design-system-and-app-shell.md`, строка экрана
   смерти — одна фраза про «Что дальше» (виды целей, пороги в `death-next.ts`).
   `docs/39` Р4: пометить «сделано (T-0109)» в таблице §4.4 одним словом.
7. Гейт и `pnpm budget`: чанк смерти не должен вырасти заметно; `tasks-api`
   только динамическим импортом.

## Чего не трогаем

- `death-parts.tsx`, `SecondChance.tsx`, `AdContinue.tsx`: зоны T-0078 и T-0079.
- Ответ итога забега и сервер: награда и задания остаются как есть.
- Кнопки «Ещё раз», «Домой», «Поделиться» и их порядок: «Ещё раз» уже главная.
- Рубеж, финальный босс, «победа в забеге»: второй волной (`docs/39` Б6).
- Забор награды за задание с этого экрана: цель «выполнено, но не забрано» не
  показывается, для неё есть значок на вкладке заданий.
- Эволюции, сундуки, достижения как цели: появятся своими задачами.

## Сценарий и интерфейс

Игрок умер на 4:12 при рекорде 6:40, уровень аккаунта почти вырос, задание
дня 4/5. Под наградой карточка «Что дальше»:

- До рекорда ещё 2:28 (рекорд 6:40)
- Задание дня почти выполнено — 4 из 5
- До 4-го уровня — 120 опыта, откроется: оружие «Буря»

Состояния:

- **загрузка** — блока нет, пока не пришла награда и ответ заданий; экран
  итога уже полный, блок появляется одним показом без сдвига кнопок (кнопки
  в закреплённом подвале);
- **пусто** — целей нет (новый рекорд, высший уровень, нет заданий, нет
  открытий) — блока нет;
- **ошибка заданий и нет сети** — блок без цели «задание»; награда не пришла —
  блока нет;
- **ограничение аккаунта** — никак не влияет;
- **гость** — награды и заданий нет, блока нет.

В узком портрете блок прокручивается вместе с итогами, подвал с «Ещё раз» на
месте; в альбомной — в левой колонке.

## Тесты

Первым коммитом. Компоненты в тестовой среде приложения не рисуются, поэтому
вся логика — в `death-next.ts`; файл `packages/app-shell/test/death-next.test.ts`.

- новый рекорд (`isNewRecord: true`) → цели `record` нет, даже если
  `bestSec > survivalSec` в данных;
- рекорд 600, забег 330 → `record` с `gapSec: 270`, `bestSec: 600`; забег 200
  (доля 0.33) → цели нет; `bestSec: null` → цели нет; `survivalSec >= bestSec`
  без `isNewRecord` → цели нет;
- `level` с долей 0.8 → цель с `xpLeft`; доля 0.3 → цели нет; `level: null` → нет;
- задания: 4 из 5 `daily` → `task`; 2 из 5 (0.4) → нет; `done: true` → нет;
  вид `channel` и период `achievement` → нет; `target: 0` → нет и не падает;
  два подходящих задания → одно, с большей долей; равная доля — ежедневное
  раньше недельного, затем меньший `id`;
- слияние: цель `level` прошла порог, `nextUnlock.level === level + 1` → одна
  цель `level` с `unlocks`, цели `unlock` нет; `nextUnlock.level === level + 2` →
  две цели; `level` не прошла порог, а открытие есть → отдельная цель `unlock`;
- порядок и предел: пять подходящих → три, по убыванию близости; равная
  близость — `record`, `task`, `level`, `unlock`;
- пустой вход → `[]`;
- `goalText` (после `import "../src/i18n/run"` и `"../src/i18n/account"`):
  `record` → `До рекорда ещё ${formatDuration(270)} (рекорд ${formatDuration(600)})`;
  `task` недельная → «Задание недели почти выполнено — 4 из 5»; `level` без
  открытий → «До 4-го уровня — 120 опыта»; `unlock` →
  `Откроется на 4-м уровне: оружие «${t("weapon.storm.name")}»`;
- `levelGoalInput`: `granted` с `xpForNext: null` → `null`; `pending` → `null`;
  `granted` → доля и остаток из `levelBar`.

## Аналитика

Новых событий нет. Что мерить: растёт ли доля «Ещё раз» сразу после смерти и
число забегов на первую сессию (`docs/39` §4.6) — это разность существующих
событий забега (`run_start` после `run_end`) из словаря
`docs/22-analytics-and-metrics.md` §3.3; отдельное событие показа блока
заведёт тимлид после первых замеров. Если исполнитель не находит этих событий
в словаре, это вопрос, а не повод заводить своё.

## Настройки и окружение

Нет. Пороги целей — константы геймдизайнера в `death-next.ts`, в каталог
настроек не переезжают. Переключателя блока нет: он статичный (только
появление через `animate-pop-in`, которое подчиняется настройке анимаций
вместе с остальными карточками экрана); решение «нужен ли отдельный
переключатель» записано здесь: нет.

## Документы

- `docs/27-design-system-and-app-shell.md` — экран смерти (шаг 6).
- `docs/39-retention-mechanics.md` §4.4 — пометка у Р4.
- Гайдбук и `README` не затронуты.

## Критерии приёмки

- [ ] Под наградой при подходящих данных стоят от одной до трёх целей, самые
      близкие первыми; «Ещё раз» по-прежнему главная кнопка в закреплённом
      подвале.
- [ ] Блок не появляется, пока награда не пришла и задания не ответили; сдвига
      раскладки нет.
- [ ] `tasks-api` грузится динамическим импортом, `pnpm budget` зелёный.
- [ ] Логика целей покрыта тестами из списка, компоненты без логики.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Показать на экране смерти «Что дальше»`
- **Метка:** `release: minor`
- **Для игроков:**
  - новое: на экране после забега — до трёх ближайших целей: сколько до рекорда, до уровня, до выполнения задания и что откроется дальше
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ЧТО ДАЛЬШЕ» НА ЭКРАНЕ СМЕРТИ**

  Под наградой за забег появился блок с двумя-тремя ближайшими целями: до
  рекорда, до уровня, задание на подходе, ближайшее открытие. «Ещё раз» —
  главная кнопка, как и было.

  🛠 **Экран смерти**

  • блок «Что дальше»: пороги целей в death-next.ts, задания берутся из GET /tasks
  • сервер не менялся

  ❓ **Нужно от команды**

  • @участник2 — подстроить пороги целей и посмотреть блок в бою
  ```

## Вопросы к тимлиду

- �Подтверждено `claude-lead-1` 13.10.2026: цель «задание выполнено, награда не
  забрана» в блок не входит (для неё есть значок на вкладке); цель можно
  добавить следующей задачей вместе с переходом на экран заданий.
- �Подтверждено `claude-lead-1` 13.10.2026: серверная часть не нужна (прогресс
  заданий читается `GET /api/v1/tasks`). Если нужно точнее, чем гонка
  «награда позже хука», в ответ награды добавляют `tasks`, но это уже
  правка `backend/api/src/modules/progress/` отдельной задачей.
