---
id: T-0167
title: Порядок заданий перетаскиванием — SortableList в панели и запрос порядка
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - apps/admin/package.json
  - apps/admin/src/ui/sortable-list.tsx
  - apps/admin/src/ui/sortable-order.ts
  - apps/admin/src/ui/kit.tsx
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/src/api/tasks.ts
  - apps/admin/test/sortable-order.test.ts
  - apps/admin/test/tasks.test.ts
  - backend/api/src/modules/admin/admin-tasks.controller.ts
  - backend/api/src/modules/tasks/tasks.service.ts
  - backend/api/src/modules/tasks/tasks.repository.ts
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/src/modules/tasks/tasks-errors.ts
  - backend/api/test/tasks.test.ts
  - backend/api/test/tasks.integration.test.ts
shared:
  - docs/29-admin-panel.md
  - docs/16-tech-stack-decisions.md
  - pnpm-lock.yaml
  - apps/admin/src/ui/help.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0167. Порядок заданий перетаскиванием — SortableList в панели и запрос порядка

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0167.json)](README.md#значки-статуса)

## Зачем

Порядок заданий в панели задаётся числом в поле «Порядок»: чтобы поставить
задание третьим, геймдизайнер открывает форму, угадывает число между
соседями и сохраняет. Вместо этого список переставляют перетаскиванием — мышью,
пальцем и с клавиатуры. Задача заводит общий компонент `SortableList` в UI-ките
панели и серверный запрос «новый порядок списка» на заданиях; остальные списки
с порядком переходят на них следующей задачей (T-0168).

## Решения

Claude-lead-1, 19.10.2026 (запрос пользователя от 15.10.2026, входящие E7):

- общий компонент `SortableList` в UI-ките панели: перетаскивание мышью и
  пальцем **и с клавиатуры** (взять ручку, стрелки, отпустить), подписи для
  экранного диктора;
- библиотека — `@dnd-kit/core` и `@dnd-kit/sortable` точных последних стабильных
  версий (без `^`), в зависимостях `apps/admin`. В панели подходящей библиотеки
  нет: `radix-ui` перетаскивания не умеет, остальные зависимости — формы,
  уведомления, иконки. Проверено 20.10.2026 по `npm view`: `@dnd-kit/core`
  6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2 (его просит
  `CSS.Transform`, а pnpm не отдаёт транзитивную зависимость). Версии
  исполнитель перед установкой сверяет тем же `npm view`; вышла новая
  стабильная — берёт её. Пакет `@dnd-kit/react` (0.x) не берём: не стабилен;
- порядок на сервере — **одним запросом** «новый порядок списка»: массив id в
  нужном порядке, в одной транзакции, идемпотентно; проверка, что пришли ровно
  id этого списка, иначе 400; аудит — одна запись «переупорядочено» с прежним и
  новым порядком; право — то же, что на правку записей этого списка
  (`tasks.edit`);
- поле ручного номера порядка из формы убирается там, где появляется
  перетаскивание.

Следствия, без которых «поле убирается» не складывается (исполнитель их не
пересматривает; если тимлид с ними не согласен — это правка этой спецификации):

- номер порядка (`task_def.sort`) остаётся колонкой и полем `TaskDef` в
  ответе каталога, но **меняется только запросом порядка**. Правка задания
  его не трогает — иначе форма, открытая до перестановки, возвращала бы старое
  место;
- новое задание встаёт **в конец своего списка**: сервер берёт наибольший
  `sort` списка плюс один (пустой список — 0, потолок 10 000, как у схемы);
- «список» — группа каталога панели: «Ежедневные», «Еженедельные»,
  «Достижения» и «Партнёрские» (вид `link`, `bot` или `channel` — всегда в
  партнёрской, какой бы срок ни был). Это та же раскладка, что у
  `groupByPeriod` в `apps/admin/src/api/tasks.ts:350`;
- после перестановки `sort` членов списка — это 0, 1, 2… по новому порядку.

## Как сейчас

Сервер:

- `backend/api/src/modules/tasks/tasks.repository.ts:115` — `catalog()`:
  `ORDER BY period, sort, task_id`; строки с видом, которого сервер не знает,
  пропускаются (ниже в том же методе). `insert` (строка 200) пишет `sort` из тела,
  `update` (строка 210) тоже; интерфейс `TasksRepository` — выше в том же файле.
- `backend/api/src/modules/tasks/task-rules.ts:223` — `sort` в `taskDefSchema`
  обязателен, 0–10 000; `isCheckedKind` — признак партнёрского вида (по нему же
  строится вкладка «Партнёрские» у игрока).
- `backend/api/src/modules/tasks/tasks.service.ts:275` — `save`: право
  `tasks.edit` (`this.roles.require`), аудит `tasks.create` / `tasks.update` через
  `this.roles.audit`, после записи `this.forgetCatalog()`; ошибки — классы
  `DomainError` в `tasks-errors.ts`. Каталог держится в памяти 30 секунд
  (`CATALOG_TTL_MS`).
- `backend/api/src/modules/admin/admin-tasks.controller.ts:26` — маршруты
  `/admin/tasks`: `GET`, `POST` (save), `POST networks/:networkKey`. Каждый
  изменяющий — `@RequirePermission("tasks.edit")`, лимит `ADMIN_LIMITS.mutate`,
  тело через `parse(() => schema.parse(body), "текст ошибки")`.
- Тестов контроллера нет: поведение проверяют на службе
  (`backend/api/test/tasks.test.ts:838`, блок «каталог из панели», фальшивый
  репозиторий и `person(ctx, id, role)`) и на живой базе
  (`backend/api/test/tasks.integration.test.ts`, `describe.skipIf` без
  `TEST_DATABASE_URL`).

Панель:

- `apps/admin/src/screens/tasks/TasksScreen.tsx:267` — поле «Порядок» в форме
  (`number("sort")`, строка 100), `HELP.tasks.order` (`apps/admin/src/ui/help.ts:120`);
  строка 349 — колонка «Порядок» таблицы; таблица каждой группы — `DataTable`
  (строка 301).
- `apps/admin/src/api/tasks.ts:303` — `taskProblem` проверяет `task.sort` как
  целое неотрицательное; строка 354 — `groupByPeriod` сортирует по `sort`, потом по
  `taskId`; `saveTask` шлёт задание целиком, включая `sort`.
- `apps/admin/src/ui/kit.tsx:234` — `DataTable` (таблица на ПК) и `PhoneCards`
  (строка 278, карточки на узком экране); общие `Column`, `phoneLayout`.
- `apps/admin/src/api/audit.ts:107` — словарь названий действий журнала;
  `FIELD_TITLES` (строка 237) — названия полей; массив строк в `auditValue`
  выводится через запятую (строка 453).
- Тест `apps/admin/test/help.test.ts` требует, чтобы каждая строка `HELP`
  стояла на экране (`HELP.<раздел>.<ключ>` встречается в исходниках экранов)
  и была не длиннее 400 знаков.
- В игре порядок `sort` доходит до игрока как порядок ответа сервера, а клиент
  затем сортирует: сперва «можно забрать», «в работе», «получено», потом по виду
  цели и величине цели, и только затем порядок сервера
  (`packages/app-shell/src/state/tasks-api.ts:171`, `sortTasks`). Эту задачу
  клиент не затрагивает (раздел «Чего не трогаем»).
- Панель в `scripts/bundle-budget.mjs` не меряется. Рост бандла панели
  исполнитель записывает в описание PR (`pnpm build`, размер чанка до и после).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. `apps/admin/package.json`: `@dnd-kit/core`, `@dnd-kit/sortable`,
   `@dnd-kit/utilities` точными версиями из раздела «Решения»; `pnpm install`,
   в коммит идёт записанный `pnpm-lock.yaml`. Postinstall-скриптов у пакетов нет.
3. `apps/admin/src/ui/sortable-order.ts` — чистые функции, без React:
   - `moveItem(ids: readonly string[], id: string, overId: string): string[]` —
     новый массив, `id` перенесён на место `overId` (как `arrayMove`); неизвестный
     `id` или `overId` — копия без изменений;
   - `sameOrder(a, b): boolean`;
   - `applyOrder<T>(items: readonly T[], ids: readonly string[], idOf: (item: T) => string): T[]`
     — элементы в порядке `ids`; не названные в `ids` — в конец, в прежнем
     порядке; лишние id в `ids` пропускаются;
   - тексты диктора (по одной функции на текст, чтобы тест видел строки):
     `pickUpText(label, place, total)`, `moveText(label, place, total)`,
     `dropText(label, place, total, moved)`, `cancelText(label, place, total)`,
     константа `INSTRUCTIONS`. Тексты — дословно:
     - `INSTRUCTIONS`: «Чтобы переставить, нажмите пробел или Enter. Стрелки двигают элемент, пробел или Enter кладёт на место, Escape отменяет.»
     - `pickUpText`: «Взяли «{label}», место {place} из {total}.»
     - `moveText`: ««{label}»: место {place} из {total}.»
     - `dropText` при `moved === true`: ««{label}» положили на место {place} из {total}.»; при `false`: ««{label}» осталось на месте {place} из {total}.»
     - `cancelText`: «Перестановка «{label}» отменена, место {place} из {total}.»
4. `apps/admin/src/ui/sortable-list.tsx` — два экспорта поверх dnd-kit:
   - `SortableList` — контекст: `DndContext` + `SortableContext`. Props:
     `ids: readonly string[]`, `labelOf: (id: string) => string`,
     `onReorder: (ids: string[]) => void`, `layout?: "rows" | "grid"`
     (стратегия `verticalListSortingStrategy` или `rectSortingStrategy`; по
     умолчанию `"rows"`), `disabled?: boolean`, `children`.
     - датчики: `PointerSensor` с `activationConstraint: { distance: 6 }` (клик по
       строке не должен начинать перетаскивание), `TouchSensor` с задержкой
       `{ delay: 200, tolerance: 8 }`, `KeyboardSensor` с
       `sortableKeyboardCoordinates`;
     - `accessibility`: `screenReaderInstructions: { draggable: INSTRUCTIONS }` и
       `announcements`, собранные из функций шага 3 (позиция — по `ids`, с
       единицы); язык — русский, не дефолтный английский dnd-kit;
     - `onDragEnd`: считает новый порядок через `moveItem`; зовёт `onReorder`
       **только если порядок изменился**;
     - `disabled` отключает датчики; при `ids.length < 2` ручки не показываются.
   - `SortableItem` — одна строка или карточка. Props: `id: string`,
     `as?: "div" | "li" | "tr"` (по умолчанию `"div"`), `className?`,
     `children: (handle: ReactNode) => ReactNode`. Корневой элемент получает
     `setNodeRef`, `transform` и `transition` в `style`
     (`CSS.Transform.toString`, анимируются только `transform`); поднятый
     элемент — тень и `opacity` ниже единицы, `position: relative`, `z-index`.
     Ручка (`handle`) — отдельная `<button type="button">` с иконкой
     `GripVertical` из `lucide-react`, `aria-label` «Переставить «{label}»»,
     `touch-action: none`, `cursor: grab`, видимый фокус из токенов; атрибуты и
     слушатели `useSortable` вешаются **на ручку**, а не на всю строку — клик по
     строке (открыть форму) остаётся кликом.
   - `prefers-reduced-motion: reduce` — без анимации перемещения
     (`transition: undefined`).
   - Все цвета, отступы и радиусы — утилиты Tailwind из токенов, как в
     остальном `ui/`; своих значений нет.
5. `apps/admin/src/ui/kit.tsx`: `DataTable` получает необязательный проп
   `reorder?: { labelOf: (row: T) => string; onReorder: (ids: string[]) => void; disabled?: boolean }`.
   - Без `reorder` таблица ведёт себя, как сейчас.
   - С `reorder`: ПК — `<tbody>` внутри `SortableList`, каждая `<tr>` —
     `SortableItem as="tr"`, первой идёт ячейка с ручкой (заголовок колонки без
     текста, для диктора — `<span className="sr-only">Порядок</span>`); телефон
     (`PhoneCards`) — `SortableList` вокруг `<ul>`, `SortableItem as="li"`, ручка
     слева в карточке, вне зоны клика по карточке (`stopPropagation` не нужен —
     ручка уже не вызывает `onRowClick`, проверить руками).
   - Идентификатор строки для dnd — `rowKey(row)`, подпись диктора —
     `reorder.labelOf(row)`.
   - Колонка с ручкой не попадает в `phoneLayout`.
6. **Сервер — правило и ошибка.**
   - `task-rules.ts`: `TASK_GROUPS = ["daily", "weekly", "achievement", "partner"] as const`,
     тип `TaskGroup`, `taskGroup(def: Pick<TaskDef, "kind" | "period">): TaskGroup`
     (`isCheckedKind` → `partner`, иначе срок), схема запроса
     `taskOrderSchema = z.object({ group: z.enum(TASK_GROUPS), ids: z.array(<тот же regex id, что у taskId>).min(1).max(10_000) }).strict()`
     с проверкой «id не повторяются».
   - В `taskDefSchema` поле `sort` остаётся (ответ каталога его отдаёт), но во
     входе становится `.default(0)`; комментарий: на входе игнорируется, место
     задаёт сервер.
   - `tasks-errors.ts`: `TaskOrderMismatchError` — `DomainError`, код
     `task_order_mismatch`, статус **400**, текст «Список изменился — обновите страницу и переставьте ещё раз».
7. **Сервер — репозиторий.** `TasksRepository.reorder(group: TaskGroup, ids: readonly string[], actorAccountId: string, at: Date): Promise<TaskReorderResult>`,
   где `TaskReorderResult = { status: "mismatch" } | { status: "ok"; before: string[]; after: string[]; changed: boolean }`.
   Реализация в `PrismaTasksRepository` — одна `$transaction`:
   1. строки каталога читаются **под блокировкой** (`SELECT task_id, period::text, kind, sort FROM task_def ORDER BY period, sort, task_id FOR UPDATE`),
      члены списка выбираются через `taskGroup` (строки с неизвестным серверу
      видом не входят — как в `catalog()`);
   2. прежний порядок списка — по `sort`, затем по `task_id` (как у панели);
   3. набор `ids` не равен набору членов списка (лишний, пропавший, чужой
      списка) — `mismatch`, ничего не пишется;
   4. иначе `sort` = индекс в `ids`; `UPDATE` только строк, у которых значение
      поменялось (`updated_at`, `updated_by` — у них же), одним запросом
      (`unnest`) или по строке в цикле — число строк мало;
   5. порядок уже такой — `changed: false`, записей нет.
   Второй одновременный запрос на тот же список ждёт блокировки и затем читает
   уже новый порядок.
   `insert`: `sort` берётся из тела, а вызывающая служба кладёт туда
   «конец списка» (шаг 8); `update`: из `SET` убрать `sort`.
8. **Сервер — служба.** `TasksService`:
   - `reorder(actor: AccountRef, group: TaskGroup, ids: readonly string[], at = new Date()): Promise<{ order: string[] }>`:
     `await this.roles.require(actor, "tasks.edit")`; `repository.reorder` с
     таймаутом `this.db(...)`; `mismatch` → `TaskOrderMismatchError`; `changed` →
     `this.roles.audit({ actorAccountId, action: "tasks.reorder", target: group, before: { order: before }, after: { order: after } })`,
     `this.forgetCatalog()`, JSON-строка лога
     `{ module: "tasks", event: "tasks_reordered", group, actor }`;
     не изменилось — ни аудита, ни лога, ответ тот же `{ order }`.
   - `save`: у нового задания `sort` = «конец списка» из каталога
     (`max(sort)` членов `taskGroup(task)` плюс один, не больше 10 000, пустой
     список — 0); у существующего — `sort` из `before`, пришедшее значение
     игнорируется. В аудите `after` — с настоящим `sort`.
9. **Сервер — маршрут.** `admin-tasks.controller.ts`:
   `@Post("order") @RequirePermission("tasks.edit")` — лимит `ADMIN_LIMITS.mutate`,
   тело через `parse(() => taskOrderSchema.parse(body), "Некорректный порядок заданий")`,
   ответ `{ data: { order: string[] } }`. Маршрут объявляется **выше** маршрутов
   с параметром, чтобы `order` не принялся за `:networkKey`.
10. **Панель — запрос.** `apps/admin/src/api/tasks.ts`:
    - экспорт `taskGroupOf(task: Pick<TaskDef, "kind" | "period">): TaskGroup`
      (вынести из `groupByPeriod`, поведение то же);
    - `reorderTasks(api: AdminApi, group: TaskGroup, ids: readonly string[]): Promise<ApiResult<{ order: string[] }>>`
      — `POST /tasks/order`, тело `{ group, ids }`, ответ разбирается Zod-схемой;
    - `saveTask` не шлёт `sort`; `taskProblem` проверку `sort` не делает
      (строка 303 — убрать `task.sort` из списка).
11. **Панель — экран.** `TasksScreen.tsx`:
    - убрать поле «Порядок» из формы и колонку «Порядок» из таблицы; `"sort"` из
      типа `number()`;
    - у `DataTable` каждой группы — `reorder={{ labelOf: (task) => task.taskId, onReorder: (ids) => void move(group.group, ids), disabled: reordering }}`;
    - `move(group, ids)`: показывает новый порядок сразу (локальное
      переопределение порядка группы через `applyOrder`), зовёт `reorderTasks`;
      успех — `reload()` и снятие переопределения, плашка `Notice success`
      «Порядок сохранён»; ошибка — переопределение снимается, плашка `Notice`
      с `error.message`, `reload()` (при 400 список мог измениться у другого
      администратора). Пока запрос идёт, `disabled` у всех таблиц;
    - панель группы получает `help={HELP.tasks.order}`.
12. `help.ts`: `HELP.tasks.order` переписать под перетаскивание (иначе тест
    «пояснение стоит на экране» упадёт или текст соврёт). Текст дословно:
    «Строки — в порядке, который задаёте перетаскиванием: ручка слева, мышью, пальцем или с клавиатуры (пробел, стрелки, пробел). Игра ставит выше то, что можно забрать, ниже — полученное, а внутри группирует по виду цели и её величине: ваш порядок решает среди заданий одного вида с одной целью. Новое задание встаёт в конец.»
    (328 знаков, предел 400).
13. `apps/admin/src/api/audit.ts`: `"tasks.reorder": "Порядок заданий"` рядом с
    `tasks.update`; в `FIELD_TITLES` — `order: "порядок"`.
14. Документы: `docs/29-admin-panel.md` — в строке «Задания» вместо «порядок»
    «порядок — перетаскиванием (ручка, мышь, палец или клавиатура)», в разделе об
    устройстве панели (рядом с `ConfirmDialog` и `toastWithUndo`, строка 270) —
    пункт про `SortableList` / `SortableItem` и `reorder` у `DataTable`: когда
    использовать (список с ручным порядком), что порядок уходит одним запросом;
    `docs/16-tech-stack-decisions.md` — строка в таблице рядом с Radix и sonner
    (строки 253–254): «Перетаскивание — **dnd-kit** (`@dnd-kit/core`, `sortable`,
    `utilities`): клавиатура и подписи диктора из коробки, без стилей; Radix
    перетаскивания не умеет».

## Чего не трогаем

- Клиент игры: `packages/app-shell/src/state/tasks-api.ts` (`sortTasks`) и
  порядок показа игроку остаются как есть (см. «Как сейчас», абзац про `sortTasks`).
- Схему Prisma и миграции: колонка `sort` уже есть, миграции не нужны.
- Строки «Задания рекламных сетей» (`NetworkTasksPanel`) и порядок сетей в
  круге рекламы — это T-0168.
- Экраны слайдов главной, журнала обновлений, акций магазина: ручного порядка
  у них нет (раздел «Как сейчас» T-0168).
- Лимиты `ADMIN_LIMITS`, права и роли, `TaskView`, ответ игроку.
- Ротацию пула заданий (`task-pool.ts`) и `RotationPanel`.
- `docs/21-diagrams.md`: схема БД не меняется.

## Сценарий и интерфейс

Экран «Задания», группы «Ежедневные», «Еженедельные», «Достижения»,
«Партнёрские». В каждой таблице слева — столбец с ручкой (значок-«хваталка»).

- Мышью: нажать на ручку и потянуть — строка поднимается (тень), остальные
  расступаются; отпустить — строка на новом месте, порядок уходит на сервер.
  Клик по самой строке по-прежнему открывает форму правки.
- Пальцем (узкий экран, карточки): коснуться ручки и подержать 200 мс, потянуть.
- С клавиатуры: Tab до ручки, пробел или Enter — взять, стрелки вверх и вниз —
  переместить, пробел или Enter — положить, Escape — отменить; фокус остаётся
  на ручке. Экранный диктор говорит тексты из шага 3.
- Состояния: **загрузка** — как сейчас («Загрузка…»), ручек нет; **пусто** —
  «Пусто — заведите задание выше», ручек нет; **один элемент** — ручки нет;
  **идёт сохранение** — ручки неактивны; **ошибка** — плашка с текстом, порядок
  возвращается к серверному; **нет сети** — та же ошибка клиента `api`, порядок
  возвращается; **400 «Список изменился»** — плашка и перечитанный список.
- Права: экран доступен только с `tasks.edit`, отдельного режима «только
  чтение» у него нет.

Макета нет: компонент строится на токенах и `lucide-react`. Снимков экранов
исполнитель не обязан: проверка — руками на 1440 и 390 px по сценарию выше и
запись в PR, что проверено (мышь, клавиатура, диктор не требуется).

## Тесты

Пишутся первым коммитом, до кода.

`apps/admin/test/sortable-order.test.ts`:

- `moveItem(["a","b","c","d"], "a", "c")` → `["b","c","a","d"]`;
  `moveItem([...], "d", "b")` → `["a","d","b","c"]`; `id === overId` → тот же
  порядок; неизвестный `id` и неизвестный `overId` → тот же порядок; исходный
  массив не изменился.
- `sameOrder`: равные массивы — `true`, перестановка — `false`, разной длины —
  `false`.
- `applyOrder`: элементы идут по `ids`; не названные — в конец в прежнем
  порядке; лишний id пропускается.
- Тексты диктора совпадают дословно с шагом 3 (по одному кейсу на функцию, у
  `dropText` — оба значения `moved`); `INSTRUCTIONS` называет пробел, Enter,
  стрелки и Escape.

`apps/admin/test/tasks.test.ts`:

- `taskGroupOf`: `link`, `bot`, `channel` с любым сроком → `partner`; `runs` со
  сроком `weekly` → `weekly`.
- `groupByPeriod` по-прежнему ставит `sort` 5 перед 20, при равных — по `taskId`
  (существующий кейс не меняется).
- `reorderTasks`: запрос `POST /tasks/order`, тело `{ group: "daily", ids: ["a","b"] }`;
  ответ `{ data: { order: ["b","a"] } }` разобран; ответ другой формы — ошибка
  разбора.
- `saveTask`: тело запроса не содержит `sort`.
- `taskProblem`: задание с `sort: -5` не даёт ошибки про порядок (поля в форме
  больше нет).

`apps/admin/test/audit.test.ts`: `actionTitle("tasks.reorder")` →
«Порядок заданий»; `fieldTitle("order")` → «порядок»; для записи
`tasks.reorder` с `before: { order: ["a","b","c"] }` и
`after: { order: ["c","a","b"] }` `auditChanges` отдаёт одну правку `order`, а
`auditValue(…, "order")` — «c, a, b».

`backend/api/test/tasks.test.ts` (блок «каталог из панели», фальшивый
репозиторий получает `reorder` с теми же правилами, что у настоящего):

- ежедневные `a` (sort 0), `b` (10), `c` (20): `reorder(designer, "daily", ["c","a","b"])`
  → каталог отдаёт `c`, `a`, `b` с `sort` 0, 1, 2; `view` игрока сразу после
  этого показывает тот же порядок (кэш каталога сброшен).
- Аудит: одна запись `tasks.reorder`, `target: "daily"`,
  `before: { order: ["a","b","c"] }`, `after: { order: ["c","a","b"] }`,
  `actorAccountId` — геймдизайнер.
- Идемпотентность: тот же запрос второй раз — ответ тот же `{ order }`, второй
  записи аудита нет, ничего не записано.
- 400 `TaskOrderMismatchError` (`status 400`, код `task_order_mismatch`) и
  ничего не записано, аудита нет: не хватает одного id; лишний неизвестный id;
  id задания из другой группы; повтор id.
- Партнёрская группа: `link` (достижение), `channel` (ежедневное), `bot`
  переставляются вместе; id ежедневной цели забега в составе — `mismatch`.
- Выключенное задание входит в порядок своей группы.
- Право: администратор без `tasks.edit` получает тот же отказ, что и у `save`;
  порядок не меняется.
- `save` существующего задания с другим `sort` в теле — `sort` в каталоге
  прежний; новое задание в группе `a`=0, `b`=1, `c`=2 получает `sort` 3, в
  пустой группе — 0; `save` на 10 000 членов не выходит за потолок 10 000.
- `taskOrderSchema`: `group: "other"`, пустой `ids`, повтор id, id не по шаблону
  и лишние поля — отказ.

`backend/api/test/tasks.integration.test.ts` (живой Postgres):

- `reorder` переписывает `sort` только у сдвинувшихся строк: у не сдвинувшихся
  `updated_at` прежний.
- Два одновременных `reorder` одного списка (`Promise.all`) с разными порядками
  — оба завершаются без ошибки, итог — один из двух порядков, `sort` членов —
  перестановка 0…n−1 без дублей и без смешения двух порядков.
- Чужой список и несуществующий id → `mismatch`, `sort` в базе не изменились.
- Строка с неизвестным серверу видом в составе списка не учитывается и не
  переписывается.

## Аналитика

Нет: действие команды в панели, не игрока и не деньги. Журнал — аудит
`tasks.reorder` (раздел «Шаги», 8). Событий словаря
`docs/22-analytics-and-metrics.md` не добавляем.

## Настройки и окружение

Нет: новых ключей каталога настроек и переменных окружения нет.

## Документы

- `docs/29-admin-panel.md` — строка «Задания» и пункт про `SortableList` в
  разделе об устройстве (шаг 14).
- `docs/16-tech-stack-decisions.md` — строка про dnd-kit (шаг 14).
- `pnpm docs:check` проходит.

## Критерии приёмки

- [ ] В `apps/admin/package.json` три пакета `@dnd-kit/*` точными версиями, без
      `^` и `~`; `pnpm-lock.yaml` записан `pnpm install`.
- [ ] Группы заданий переставляются мышью, пальцем (узкий экран) и с клавиатуры
      (пробел, стрелки, пробел, Escape); ручка — кнопка с понятной подписью, тексты
      диктора русские и дословно из шага 3.
- [ ] Клик по строке открывает форму, как раньше; перетаскивание начинается
      только с ручки.
- [ ] Поля и колонки «Порядок» в форме и таблице нет; новое задание встаёт в
      конец своей группы; правка задания порядок не меняет.
- [ ] Запрос `POST /admin/tasks/order` принимает `{ group, ids }`, работает в
      одной транзакции под блокировкой, идемпотентен, на неполный, лишний,
      чужой или повторный id отвечает 400, право — `tasks.edit`.
- [ ] Перестановка пишет одну запись аудита `tasks.reorder` с прежним и новым
      порядком; повтор того же порядка — не пишет.
- [ ] Тесты из раздела «Тесты» написаны до кода и зелёные; интеграционные
      зелёные в CI.
- [ ] Рост бандла панели записан в описании PR; руками проверено на 1440 и 390 px.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Порядок заданий перетаскиванием в панели`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОРЯДОК ЗАДАНИЙ ПЕРЕТАСКИВАНИЕМ В ПАНЕЛИ**

  В панели задания переставляются перетаскиванием вместо числа в поле «Порядок»: мышью, пальцем и с клавиатуры. Новый порядок уходит одним запросом и пишется в аудит одной записью.

  🛠 **Что появилось**

  • общий компонент SortableList в UI-ките панели (dnd-kit) — на нём же переедут остальные списки с порядком (T-0168)
  • новое задание встаёт в конец своей группы, правка задания порядок не трогает
  • запрос порядка проверяет, что пришли ровно задания этой группы, иначе просит обновить страницу
  ```
