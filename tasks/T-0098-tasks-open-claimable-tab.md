---
id: T-0098
title: «Задания» открываются на вкладке, где ждёт награда
epic: E6
priority: P1
status: done
owner: claude-7 / haiku-5.5 / medium
author: claude-lead2-13
size: S
depends_on:
  - T-0084
zones:
  - packages/app-shell/src/screens/meta/tasks.tsx
  - packages/app-shell/src/screens/meta/tasks-rules.ts
  - packages/app-shell/test/tasks-rules.test.ts
shared:
  - docs/27-design-system-and-app-shell.md
runner: any
executor: haiku-5.5
effort: medium
release: patch
design: null
batch: 1
---

# T-0098. «Задания» открываются на вкладке, где ждёт награда

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0098.json)](README.md#значки-статуса) [![T-0084](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0084.json&label=T-0084)](T-0084-segmented-small.md)

## Зачем

Игрок заходит в «Задания», видит ежедневные, а выполненное и не забранное
лежит на соседней вкладке: награду надо искать по знакам на переключателе.
После задачи экран сам открывается там, где награда ждёт.

## Решения

- **Решение участника 1 от 13.10.2026 (тест):** в заданиях в приоритете
  открывается вкладка, где есть выполненные задачи. Выполненные — те, что
  выполнены и не забраны (`isClaimable`, `state/tasks-api.ts:136`): то же, что
  считает знак на вкладке.
- **Правило выбора вкладки при открытии:** первая по порядку переключателя
  вкладка, где есть такое задание. Порядок как на экране: «Партнёры», «День»,
  «Неделя», «Достижения» (`tasks.tsx:178-181`). Нет таких — вкладка по
  умолчанию, как сейчас: «Партнёры», если у игрока есть партнёрские цели или
  предложение сети, иначе «День» (решение участника 1 от 01.10.2026).
- **Выбор игрока важнее правила.** Вкладка решается один раз, по первому
  ответу сервера; если игрок успел нажать вкладку сам, она остаётся. Обновление
  списка после «Забрать», «Проверить» и перечитывание за заданием сети вкладку
  не меняют. Это поведение уже есть (`setView((current) => current ?? …)`),
  сохраняем и покрываем тестом.
- **Логика — чистыми функциями** в `tasks-rules.ts`: в тестовой среде
  (`node`) компоненты не рисуются.
- **Задания рекламных сетей на выбор не влияют:** их награду забирают своим
  путём («Проверить» в `network-tasks.tsx`). Учитываются только обычные
  задания списка `tasks`.

## Как сейчас

- `packages/app-shell/src/screens/meta/tasks.tsx`:
  - `:50` — `type View = "daily" | "weekly" | "achievements" | "partner"`;
  - `:53` — `const TAB_OF: Record<View, TaskTab> = { daily: "daily", weekly: "weekly", achievements: "achievement", partner: "partner" }`;
  - `:59-62` — пояснение и `const [chosen, setView] = useState<View | null>(null)`;
  - `:76-87` — `load()`: после ответа

    ```ts
    const partner = networks.some((item) => item.offer !== null || (isFeedTask(item) && item.nextAt === null)) || response.data.tasks.some((task) => tabOf(task) === "partner");
    setView((current) => current ?? (partner ? "partner" : "daily"));
    ```

  - `:129` — `const view: View = chosen ?? "daily"`; `:130` — вкладка
    фильтрует задания по `TAB_OF[view]`; `:138` — `waiting(tab)` считает
    `tabOf(task) === tab && isClaimable(task)`;
  - `:173-183` — `SegmentedControl` с `onSelect={(id) => setView(id as View)}`
    и вкладками в порядке partner, daily, weekly, achievements.
- `state/tasks-api.ts:122-138` — `TaskTab`, `tabOf(task)` (партнёрская
  категория — своя вкладка, остальные по `period`), `isClaimable(task)`
  (`done && !claimed`). У `TaskItem` `period` — `"daily" | "weekly" |
  "achievement"`, `category` необязателен.
- `test/tasks-api.test.ts` — образец данных (`TASK`, строки 41-52). Тестов
  экрана и его правил нет.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»): `test/tasks-rules.test.ts`.
   Падают, пока нет `tasks-rules.ts`.
2. **Новый файл `screens/meta/tasks-rules.ts`:**

   ```ts
   import { isClaimable, tabOf, type TaskItem, type TaskTab } from "../../state/tasks-api";

   export type TasksView = "daily" | "weekly" | "achievements" | "partner";

   /** Порядок вкладок на экране: первой выбирается та, где ждёт награда. */
   export const TASKS_VIEW_ORDER: readonly TasksView[] = ["partner", "daily", "weekly", "achievements"];

   export const TASK_TAB_OF: Record<TasksView, TaskTab> = {
     daily: "daily",
     weekly: "weekly",
     achievements: "achievement",
     partner: "partner",
   };

   type RewardTask = Pick<TaskItem, "category" | "period" | "done" | "claimed">;

   /**
    * Вкладка при открытии: первая по порядку, где есть выполненное и не
    * забранное задание; иначе по умолчанию — «Партнёры», если они есть, а
    * иначе «День».
    */
   export function initialTasksView(input: { tasks: readonly RewardTask[]; hasPartner: boolean }): TasksView {
     for (const view of TASKS_VIEW_ORDER) {
       if (input.tasks.some((task) => tabOf(task) === TASK_TAB_OF[view] && isClaimable(task))) return view;
     }
     return input.hasPartner ? "partner" : "daily";
   }

   /**
    * Вкладка после ответа сервера. Выбор игрока важнее правила: экран не
    * перескакивает, пока игрок ждёт награду или обновляется список.
    */
   export function viewAfterLoad(input: { chosen: TasksView | null; tasks: readonly RewardTask[]; hasPartner: boolean }): TasksView {
     return input.chosen ?? initialTasksView(input);
   }
   ```

3. **`tasks.tsx`:**
   - импорт: `import { TASK_TAB_OF, viewAfterLoad, type TasksView } from "./tasks-rules";`;
   - удалить `type View` (строка 50) и `TAB_OF` (строка 53); `View` в трёх
     местах (`useState<View | null>`, `const view: View`, `id as View`)
     заменить на `TasksView`, а `TAB_OF[view]` (строка 130) — на
     `TASK_TAB_OF[view]`; тип `TaskTab` в импорте оставить, он нужен `waiting`;
   - строка 86:

     ```ts
     setView((current) => viewAfterLoad({ chosen: current, tasks: response.data.tasks, hasPartner: partner }));
     ```

   - пояснение над `useState` (`:60-61`) и над `partner` (`:82-84`) привести к
     правилу: «Пока игрок не выбрал сам — первая вкладка с наградой к
     получению, иначе партнёрские, если они есть, иначе ежедневные». Комментарии
     на русском, про «почему», без истории правок.
4. **`docs/27-design-system-and-app-shell.md`, строка «Задания»** (около
   `:1238`, ищется по «партнёрские первые и открыты сразу, если они есть»):
   эту фразу заменить на «при входе открывается первая по порядку вкладка, где
   есть награда к получению, иначе партнёрские, если они есть, иначе
   ежедневные; выбор игрока экран не перебивает».

## Чего не трогаем

- Порядок вкладок, подписи, знаки с числом наград (`waiting`), сортировку
  внутри вкладки (`sortTasks`), `network-tasks.tsx`.
- `SegmentedControl` и его размер: правит T-0084 в том же `tasks.tsx`
  (поэтому `depends_on`).
- Вид и тексты пустой вкладки, ошибки, «Повторить».
- Серверный каталог заданий и сами награды: «больше заданий» заводится
  отдельными задачами.
- `state/tasks-api.ts`: функции `tabOf` и `isClaimable` используем как есть.

## Сценарий и интерфейс

- **Загрузка:** список пуст, видна строка «Загружаем задания…»; переключатель
  доступен. Нажатая вкладка закрепляется и после ответа остаётся.
- **Есть готовое в нескольких вкладках:** открывается первая по порядку;
  знаки на остальных остаются.
- **Готового нигде нет:** как раньше — «Партнёры» при наличии партнёрских
  целей, иначе «День».
- **Забрали последнюю награду на вкладке:** вкладка остаётся открытой.
- **Ошибка загрузки и «Повторить»:** без изменений; повторный ответ не
  перебивает уже выбранную вкладку.
- **Без входа:** плашка, вкладка «День».

## Тесты

Первым коммитом. `packages/app-shell/test/tasks-rules.test.ts`. Помощник:
`const task = (period: "daily" | "weekly" | "achievement", done: boolean, claimed: boolean, partner = false) => ({ period, done, claimed, ...(partner ? { category: "partner" } : {}) })`
(`category` необязателен, `undefined` не передавать).

`describe("вкладка заданий при открытии")`, `initialTasksView`:

- готового нет, `hasPartner: false` → `"daily"`;
- готового нет, `hasPartner: true` → `"partner"`;
- готово только в недельных → `"weekly"`; только в достижениях →
  `"achievements"`;
- готово в недельных и достижениях → `"weekly"` (первая по порядку);
- готово в ежедневных и недельных → `"daily"`;
- готово в партнёрских (`category: "partner"`, `period: "daily"`) и
  ежедневных → `"partner"`: партнёрское считается своей вкладкой, а не
  ежедневной;
- готово только в недельных, `hasPartner: true` → `"weekly"`: награда важнее
  вкладки по умолчанию;
- выполнено и уже забрано (`done`, `claimed`) → вкладка по умолчанию;
- не выполнено (`done: false`) → вкладка по умолчанию;
- пустой список, `hasPartner: false` → `"daily"`.

`describe("вкладка после ответа")`, `viewAfterLoad`:

- `chosen: "achievements"`, готовое в ежедневных → `"achievements"`: выбор
  игрока не перебивается;
- `chosen: null`, готовое в недельных → `"weekly"`;
- `chosen: "daily"`, список пуст, `hasPartner: true` → `"daily"`.

`describe("порядок вкладок")`:

- `TASKS_VIEW_ORDER` равен `["partner", "daily", "weekly", "achievements"]`;
- у каждого вида в `TASKS_VIEW_ORDER` есть запись в `TASK_TAB_OF`.

## Аналитика

Нет: события заданий (`task_completed`, `achievement_unlocked`) не меняются,
открытие вкладки отдельного события не имеет.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md` — строка «Задания» (шаг 4).

## Вопросы к тимлиду

- �Подтверждено `claude-lead-1` 13.10.2026: готовая награда в обычной вкладке
  перебивает «партнёрские первые» (решение от 01.10.2026), потому что
  решение от 13.10.2026 новее и ровно про это. Если нужно наоборот, правится
  порядок в `TASKS_VIEW_ORDER` и тест.
- �Подтверждено `claude-lead-1` 13.10.2026: готовые задания рекламных сетей на выбор
  вкладки не влияют; партнёрская вкладка и так открывается первой по умолчанию.

## Критерии приёмки

- [ ] `initialTasksView` и `viewAfterLoad` лежат в `tasks-rules.ts`; тесты из
  раздела «Тесты» зелёные.
- [ ] В `tasks.tsx` выбор вкладки идёт через `viewAfterLoad`, а `current ??`
  внутри функции сохранил выбор игрока; типа `View` и `TAB_OF` в файле нет.
- [ ] Знаки на вкладках, порядок и сортировка строк без изменений.
- [ ] Дифф только в зонах задачи и одной строке `docs/27`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Открывать задания на вкладке с наградой`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- исправлено: «Задания» открываются на вкладке, где ждёт готовая награда`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ЗАДАНИЯ» ОТКРЫВАЮТСЯ ТАМ, ГДЕ ЖДЁТ НАГРАДА**

  При входе в «Задания» открывается первая по порядку вкладка с выполненным и не забранным заданием. Нет таких — вкладка по умолчанию, как раньше. Вкладку, выбранную игроком, экран не перебивает.

  🛠 **Экран заданий**

  • выбор вкладки вынесен в чистые функции с тестами на порядок, партнёрские и выбор игрока
  ```
