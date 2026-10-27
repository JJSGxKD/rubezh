---
id: T-0189
title: Порядок слайдов главной перетаскиванием в панели
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0167]
zones:
  - backend/api/src/modules/home/team-slide-rules.ts
  - backend/api/src/modules/home/team-slide.repository.ts
  - backend/api/src/modules/home/team-slides.service.ts
  - backend/api/src/modules/home/home-errors.ts
  - backend/api/src/modules/admin/admin-home.controller.ts
  - backend/api/test/helpers/memory-team-slides.ts
  - backend/api/test/team-slides.test.ts
  - backend/api/test/team-slides.integration.test.ts
  - backend/api/test/home.test.ts
  - apps/admin/src/screens/home/HomeSlidesScreen.tsx
  - apps/admin/src/api/home-slides.ts
  - apps/admin/test/home-slides.test.ts
shared:
  - docs/29-admin-panel.md
  - docs/21-diagrams.md
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - apps/admin/src/api/audit.ts
  - apps/admin/src/ui/help.ts
  - apps/admin/test/audit.test.ts
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0189. Порядок слайдов главной перетаскиванием в панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0189.json)](README.md#значки-статуса) [![T-0167](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0167.json&label=T-0167)](T-0167-admin-sortable-list-tasks-order.md)

## Зачем

Порядок слайдов команды в карусели главной сейчас не задаётся вовсе: игрок видит
закреплённые, потом начавшиеся позже. Чтобы поставить анонс турнира выше анонса
конкурса, команде приходится двигать «Начало» слайда. Разом в карусели не больше
двух слайдов команды (`shownMax`), поэтому от порядка зависит, какой из идущих
игрок вообще увидит. После T-0167 в панели есть `SortableList`: слайды
переставляются перетаскиванием, порядок уходит на сервер одним запросом и
действует на игрока.

## Решения

Р120 (`docs/35-stage4-plan.md`, 20.10.2026; расширяет Р118 по запросу
пользователя «порядок для слайдов нужен»):

- слайды команды (`HomeSlide`, таблица `home_slide`) переставляются
  перетаскиванием `SortableList` из T-0167 в разделе панели «Главная»;
- порядок хранится новым полем `position` (Int); миграция только добавляет
  колонку, существующим слайдам `position` проставляется в нынешнем порядке
  показа;
- серверный запрос «новый порядок списка» — как в T-0167 и T-0168: массив id,
  одна транзакция под блокировкой, идемпотентно, ровно id этого списка, иначе
  400, одна запись аудита, право — то же, что на правку слайдов (`home.edit`);
- закрепление (`pinned`) остаётся: закреплённые идут первыми (до акции),
  незакреплённые — после акции и нового в версии, как в `pickSlides`
  (`home-slides.ts`); **внутри каждой группы — по `position`**;
- ручного поля порядка у слайдов нет (проверено: форма — заголовок, подпись,
  картинка, значок, цель, аудитория, площадки, срок, «Первым в карусели»),
  убирать из формы нечего;
- автоматические слайды (акция, VIP, стартовый набор, приглашение, канал, задание
  дня) не переставляются: их порядок решает сервер по ценности.

Следствия, без которых решение не складывается (исполнитель их не
пересматривает; не согласен тимлид — правит спецификацию):

- «список» — группа: **закреплённые** (`pinned = true`) и **остальные**. Это те же
  две группы, на которые карусель делит слайды команды. Запрос порядка несёт
  `group`, как в T-0167; перетащить слайд из группы в группу нельзя — за группу
  отвечает отметка «Первым в карусели» в форме;
- в порядок входят все слайды **без `archived_at`**, в том числе кончившиеся и
  будущие: набор не зависит от времени, поэтому два администратора не получают
  400 из-за того, что слайд «кончился» между загрузкой и перестановкой. Снятые
  (архивные) в порядок не входят, остаются в списке панели ниже без ручек —
  у T-0168 в порядке были и выключенные сети, потому что они остаются рабочими
  записями; снятый слайд вернуть нельзя;
- новый слайд встаёт **последним в своей группе**: сервер берёт наибольший
  `position` группы плюс один (пустая группа — 0);
- правка слайда `position` **не трогает**, кроме случая, когда сменилась отметка
  `pinned`: слайд переходит в другую группу и встаёт в её конец. Иначе форма,
  открытая до перестановки, вернула бы старое место;
- равные `position` допустимы (миграция и параллельные создания слайдов могут их
  дать), тогда порядок — по `starts_at` (позже — раньше), затем по `slide_id`.
  Запрос порядка делает значения разными: 0, 1, 2… по новому порядку группы;
- дальше `shownMax` (2) слайдов команды игрок не видит: после перестановки
  вторым в карусели идёт второй по `position` идущий слайд группы, а не самый
  поздний по началу.

## Как сейчас

Сервер:

- `backend/api/prisma/schema.prisma:2086` — `model HomeSlide` (таблица
  `home_slide`), индекс `@@index([endsAt])`; поля порядка нет. Миграция таблицы —
  `backend/api/prisma/migrations/20261004120000_home_slides/migration.sql`;
  последняя миграция в репозитории — `20261014082616_seasons`.
- `backend/api/src/modules/home/team-slide-rules.ts:175` — `teamSlidesFor`:
  идущие слайды игрока, `sort` по `Number(b.pinned) - Number(a.pinned)`, затем
  `b.startsAt - a.startsAt`, `slice(0, shownMax)`. `TeamSlideRow` (строка 94) —
  тип строки; `TEAM_SLIDE_LIMITS.shownMax = 2` (строка 23);
  `teamSlideInputSchema` (строка 71) — вход create/update, `strict()`.
- `backend/api/src/modules/home/team-slide.repository.ts:26` — интерфейс
  `TeamSlideRepository`; `current` (строка 83) читает не снятые, идущие или
  начинающиеся в окне, `orderBy: { startsAt: "desc" }`; `list` (строка 88) — все
  слайды для панели, `startsAt desc`; `create`, `update`, `archive`; строка из
  базы разбирается `rowSchema` (строка 32) — `position` в схему добавить; `fields()`
  (строка 62) — поля записи.
- `backend/api/src/modules/home/team-slides.service.ts` — `catalog` (панель),
  `create`, `update`, `archive`: право `home.edit` через `this.roles.require`,
  аудит `home.slide.create|update|archive`, после записи `this.forget()` сбрасывает
  кэш идущих (30 с, `CACHE_TTL_MS`), строка лога через `this.log`; `auditOf`
  (строка 148) — что идёт в аудит.
- `backend/api/src/modules/home/home-errors.ts` — `TeamSlidePeriodError`,
  `TeamSlideNotFoundError`; ошибки — наследники `DomainError`.
- `backend/api/src/modules/home/home-slides.ts:66` — `pickSlides` берёт
  `sources.team` **в готовом порядке** (`filter(pinned)` и `filter(!pinned)`
  сохраняют его), порядок решает `teamSlidesFor`. Поэтому `home-slides.ts` и
  `home.service.ts` этой задачей не правятся.
- `backend/api/src/modules/admin/admin-home.controller.ts:23` — маршруты
  `/admin/home/slides`: `GET`, `POST` (create), `POST :slideId`, `POST :slideId/archive`;
  изменяющие — `@RequirePermission("home.edit")`, лимит через `this.consume(request)`,
  тело через `parse(() => schema.parse(body), "текст")`.
- Тесты: `backend/api/test/team-slides.test.ts` — правила, аудитория, служба
  (`MemoryTeamSlideRepository` из `backend/api/test/helpers/memory-team-slides.ts`,
  `list` — `startsAt desc`, `current` — не снятые и идущие) и блок «по HTTP панели»
  (строка 263); `backend/api/test/team-slides.integration.test.ts` — живой Postgres
  (`describe.skipIf` без `TEST_DATABASE_URL`); `backend/api/test/home.test.ts:101` —
  строит `TeamSlideRow` литералом (после добавления `position` в тип нужен
  `position: 0`).
- Снимок плана стирания `backend/api/src/modules/wipe/wipe-plan.ts:73`
  (`HomeSlide: keep`) — колонка таблицы его не меняет.

Панель:

- `apps/admin/src/screens/home/HomeSlidesScreen.tsx:151` — панель «Слайды»: одна
  `DataTable` из `catalog.slides` (все слайды, поздние первыми), строка кликом
  открывает форму правки (`edit`), кнопки «Изменить» и «Снять» (снятие —
  двухшаговое), колонка «Состояние» с бейджем «первым»; над таблицей
  предупреждение `crowded` («игрок видит закреплённые, потом начавшиеся позже»).
  `EDITABLE` (`api/home-slides.ts:19`) — состояния, которые правятся.
- `apps/admin/src/api/home-slides.ts:58` — `slideSchema` (ответ списка и правки),
  `catalogSchema`, `fetchSlides`, `createSlide`, `updateSlide`, `archiveSlide`,
  `slideRequest` (тело create/update, строка 187), `crowded` (строка 241).
- `apps/admin/src/api/audit.ts:114` — названия действий `home.slide.*`;
  `FIELD_TITLES` (строка 309 — `pinned`); поле `order` и `auditValue` для массива
  строк (через запятую) заведены T-0167.
- `apps/admin/src/ui/help.ts:135` — `HELP.home.*`; `section`, `pinned` (строка 147)
  и `state` (строка 149) говорят о порядке «закреплённые, потом начавшиеся
  позже» — после задачи это неправда. Тест `apps/admin/test/help.test.ts`
  требует, чтобы каждая строка словаря стояла на экране и была не длиннее 400
  знаков.
- Из T-0167: `SortableList`, `SortableItem`, `moveItem`, `applyOrder`, тексты
  диктора, проп `reorder` у `DataTable` (`{ labelOf, onReorder, disabled }`).
  Образец использования — экран заданий (T-0167, шаг 11) и карточки сетей (T-0168).
- Что игрок видит и сейчас: карусель получает слайды команды готовыми из
  `/home`; клиент их не сортирует (`packages/app-shell/src/state/home-api.ts`,
  `home-carousel.tsx`) и задачей не затрагивается.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема и миграция.** `schema.prisma`, `model HomeSlide`: поле
   `position Int` с комментарием «место в своей группе (закреплённые / остальные);
   меньше — раньше; меняется только запросом порядка», индекс
   `@@index([pinned, position])`. Миграция — `prisma migrate dev --create-only` на
   отдельной базе, **один раз**, после перебазирования на свежий `dev`; проверить
   `ls backend/api/prisma/migrations | tail`: папка одна. В SQL — вручную, в
   таком порядке:
   1. `ALTER TABLE "home_slide" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;`
   2. заполнение в нынешнем порядке показа — внутри каждой группы:
      `UPDATE "home_slide" SET "position" = r.n FROM (SELECT "slide_id", (ROW_NUMBER() OVER (PARTITION BY "pinned" ORDER BY "starts_at" DESC, "slide_id") - 1) AS n FROM "home_slide" WHERE "archived_at" IS NULL) r WHERE "home_slide"."slide_id" = r.slide_id;`
      (снятые остаются с 0: в порядок они не входят);
   3. `ALTER TABLE "home_slide" ALTER COLUMN "position" DROP DEFAULT;`
   4. `ALTER TABLE "home_slide" ADD CONSTRAINT "home_slide_position_check" CHECK ("position" >= 0);`
   5. `CREATE INDEX "home_slide_pinned_position_idx" ON "home_slide"("pinned", "position");`
   Комментарий в начале миграции — по-русски, зачем поле. Миграция **только
   добавляет**: ни столбцы, ни данные не удаляются.
3. `team-slide-rules.ts`:
   - `TeamSlideRow` получает `position: number`;
   - `teamSlidesFor`: сортировка `Number(b.pinned) - Number(a.pinned) || a.position - b.position || b.startsAt.getTime() - a.startsAt.getTime() || a.slideId.localeCompare(b.slideId)`;
     комментарий над функцией («закреплённые первыми, дальше по месту в списке
     панели») переписать;
   - `TEAM_SLIDE_GROUPS = ["pinned", "regular"] as const`, тип `TeamSlideGroup`,
     `teamSlideGroup(slide: Pick<TeamSlideRow, "pinned">): TeamSlideGroup`;
   - `teamSlideOrderSchema = z.object({ group: z.enum(TEAM_SLIDE_GROUPS), ids: z.array(z.uuid()).min(1).max(200) }).strict()`
     с проверкой «id не повторяются»; `200` — тот же `LIST_LIMIT`, что у панели;
   - `teamSlideInputSchema` **не меняется**: `position` на входе create/update
     не принимается (`strict()` вернёт 400 на лишнее поле — так и надо).
4. `home-errors.ts`: `TeamSlideOrderMismatchError` — `DomainError`, код
   `team_slide_order_mismatch`, статус **400**, текст «Список слайдов изменился —
   обновите страницу и переставьте ещё раз».
5. `team-slide.repository.ts`:
   - `rowSchema` и `toRow` получают `position`;
   - `current`: `orderBy: [{ pinned: "desc" }, { position: "asc" }, { startsAt: "desc" }, { slideId: "asc" }]`;
   - `list` (панель): те же поля порядка, но **снятые в конце**:
     `orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { pinned: "desc" }, { position: "asc" }, { startsAt: "desc" }, { slideId: "asc" }]`.
     Если `nulls: "first"` в нашей версии Prisma недоступно, порядок выбирается
     запросом `$queryRaw` по образцу соседних репозиториев — на усмотрение
     исполнителя, результат тот же;
   - `create(slideId, input, position, by, at)` и
     `update(slideId, input, position: number | null, by, at)`: `position` при
     создании пишется, при правке `null` — не менять;
   - `nextPosition(pinned: boolean): Promise<number>` — `max(position) + 1`
     среди слайдов группы без `archived_at`, пустая группа — 0;
   - `reorder(group: TeamSlideGroup, ids: readonly string[], actorAccountId: string, at: Date): Promise<TeamSlideReorderResult>`,
     `TeamSlideReorderResult = { status: "mismatch" } | { status: "ok"; before: { slideId: string; title: string }[]; after: { slideId: string; title: string }[]; changed: boolean }`.
     Реализация — одна `$transaction`: `SELECT slide_id, title, position FROM home_slide WHERE archived_at IS NULL AND pinned = $1 ORDER BY position, starts_at DESC, slide_id FOR UPDATE`;
     набор `ids` не равен набору строк группы (лишний, пропавший, чужой группы,
     снятый) — `mismatch`, ничего не пишется; иначе `position` = индекс в `ids`,
     `UPDATE` только строк, у которых значение поменялось (`updated_at`,
     `updated_by` — у них же); порядок уже такой — `changed: false`. Второй
     одновременный запрос на тот же список ждёт блокировки и читает уже новый
     порядок.
6. `team-slides.service.ts`:
   - `create`: `position = await this.db(this.repository.nextPosition(input.pinned))`;
   - `update`: `before` уже читается; если `input.pinned !== before.pinned` —
     `nextPosition(input.pinned)`, иначе `null`;
   - `reorder(actor: AccountRef, group: TeamSlideGroup, ids: readonly string[], at = new Date()): Promise<{ order: string[] }>`:
     `await this.roles.require(actor, "home.edit")`; `this.db(this.repository.reorder(...))`;
     `mismatch` → `TeamSlideOrderMismatchError`; `changed` — аудит
     `{ actorAccountId, action: "home.slides.reorder", target: group, before: { order: <заголовки до> }, after: { order: <заголовки после> } }`
     (в журнале нужны названия, а не UUID; повтор названий допустим),
     `this.forget()` и строка лога `team_slides_reordered`
     (`{ group, actor }`); не изменилось — ни аудита, ни лога, ответ тот же
     `{ order: ids }`;
   - `catalog`: ответ получает `position` у каждой строки (он уже в `TeamSlideRow`),
     порядок строк — как отдал `list`;
   - `auditOf` (create/update) `position` не включает.
7. `admin-home.controller.ts`: `@Post("order") @RequirePermission("home.edit")`,
   лимит `this.consume(request)`, тело через
   `parse(() => teamSlideOrderSchema.parse(body), "Некорректный порядок слайдов")`,
   ответ `{ data: { order: string[] } }`. Маршрут объявить **выше** `@Post(":slideId")`,
   чтобы `order` не принялся за `:slideId`.
8. `apps/admin/src/api/home-slides.ts`:
   - `slideSchema` получает `position: z.number()`;
   - `reorderSlides(api, group: "pinned" | "regular", ids: readonly string[]): Promise<ApiResult<{ order: string[] }>>`
     — `POST /home/slides/order`, тело `{ group, ids }`, ответ разбирается Zod-схемой;
   - `slideGroups(slides: readonly TeamSlide[]): { pinned: TeamSlide[]; regular: TeamSlide[]; archived: TeamSlide[] }` —
     делит ответ списка: снятые (`state === "archived"`) отдельно, остальные по
     `pinned`, порядок внутри групп сохраняется как в ответе;
   - `crowded` остаётся.
9. `HomeSlidesScreen.tsx`: панель «Слайды» делится на три таблицы одной панелью:
   - «Закреплённые» и «Остальные» — каждая `DataTable` с
     `reorder={{ labelOf: (slide) => slide.title, onReorder: (ids) => void move(group, ids), disabled: reordering }}`;
     колонки, клик по строке и кнопки — как сейчас; если группа пуста — строка
     «Нет закреплённых слайдов» / «Нет слайдов без закрепления»;
   - «Снятые» — `DataTable` без `reorder`, только если снятые есть;
   - `move(group, ids)`: показывает новый порядок сразу (локальное переопределение
     порядка группы через `applyOrder`), зовёт `reorderSlides`; успех — `reload()`,
     снятие переопределения, плашка `Notice success` «Порядок слайдов сохранён —
     игроки увидят его в течение полуминуты»; ошибка — переопределение снимается,
     плашка с `error.message`, `reload()` (при 400 список мог измениться у другого
     администратора). Пока запрос идёт, `disabled` у обеих таблиц;
   - предупреждение `crowded` переписать: «Идут {N} — в карусели разом не больше
     {shownMax}: игрок видит сначала закреплённые, потом остальные, внутри — в
     порядке списка. Остальные ждут, пока первые кончатся.»; `Panel` «Слайды» —
     `help={HELP.home.state}` остаётся;
   - строка с `HELP.home.order` стоит у заголовка списков (подпись над таблицами
     или кнопка-подсказка — на усмотрение исполнителя, главное — в этом файле,
     иначе тест словаря упадёт).
10. `help.ts`: `HELP.home.pinned`, `HELP.home.state` и `HELP.home.section` —
    переписать, где они говорят «начавшиеся позже»; новая строка `HELP.home.order`.
    Тексты дословно:
    - `order`: «Слайды идут в порядке списка: закреплённые — первыми, остальные —
      после акции и нового в версии. Переставляйте за ручку слева: мышью, пальцем
      или с клавиатуры (пробел, стрелки, пробел). Между группами слайд не
      переносится — для этого есть отметка «Первым в карусели». Разом игрок видит
      не больше двух слайдов команды — тех, что выше в списке и идут сейчас.»
    - `pinned`: «Первым в карусели — раньше акции. Без отметки слайд встаёт после
      акции и нового в версии. Новый слайд встаёт последним в своей группе, место
      потом меняется перетаскиванием. Разом в карусели не больше двух слайдов
      команды.»
    - `state`: «Будет, идёт, кончился или снят. Снятый остаётся внизу списка без
      ручки, вернуть его нельзя — заведите новый.»
    - в `section` слова про порядок слайдов (если есть) привести к тому же
      правилу; остальной текст не менять. Каждая строка не длиннее 400 знаков.
11. `audit.ts`: `"home.slides.reorder": "Порядок слайдов главной"` рядом с
    `home.slide.archive`. Поле `order` в `FIELD_TITLES` заведено T-0167 — здесь
    не повторять; если T-0167 ещё не влит, задача не берётся (`depends_on`).
12. Документы: `docs/29-admin-panel.md`, строка «Главная» (строка 66): «Первым в
    карусели» дополнить «, порядок слайдов в группе — перетаскиванием»; фразу «не
    больше двух слайдов команды» оставить, добавить «— те, что выше в списке»;
    `docs/21-diagrams.md`: в `HOME_SLIDE` (строка 671) — строка
    `int position "место в своей группе (pinned / нет); меняется запросом порядка"`
    и в описании сущности (строка 1069) одна фраза про порядок.
    `pnpm docs:check` проходит.

## Чего не трогаем

- `SortableList`, `SortableItem`, `sortable-order.ts` и `DataTable` — T-0167; если
  компоненту чего-то не хватает, это вопрос тимлидам, а не правка заодно.
- Автоматические слайды и их порядок: `pickSlides`, `partnerTaskOfDay`,
  `HOME_SLIDES_MAX` — `home-slides.ts` и `home.service.ts` **не правятся**
  (порядок слайдов команды приходит в них готовым). Слайд «Что нового» скрывается
  отдельной задачей T-0188, слайд доната — T-0157; обе трогают те же файлы.
- Клиент игры: `packages/app-shell` (`home-api.ts`, `home-carousel.tsx`,
  `home-slide.tsx`) — показ и аналитика (`home_slide_viewed`, `home_slide_clicked`)
  остаются.
- Входной контракт слайда: `teamSlideInputSchema` без `position`, форма слайда без
  нового поля; «Первым в карусели», аудитории, площадки, сроки и их проверки.
- Правила снятия (`archive`): снятый слайд не возвращается и в порядок не
  входит; `position` снятого не очищается.
- `TEAM_SLIDE_LIMITS.shownMax` и срок слайда.
- `wipe-plan.ts`: `HomeSlide: keep` не меняется.

## Сценарий и интерфейс

Раздел «Главная», панель «Слайды». Над таблицами — подпись с подсказкой
`HELP.home.order`. Ниже — таблицы «Закреплённые», «Остальные» и (если есть)
«Снятые». В двух первых слева в каждой строке ручка (видна при двух слайдах и
больше в группе).

- Мышью: нажать на ручку и потянуть — строка поднимается, остальные расступаются;
  отпустить — порядок на экране меняется сразу, уходит на сервер. Клик по самой
  строке открывает форму правки, как раньше; кнопки «Изменить» и «Снять»
  работают, как раньше.
- Пальцем (узкий экран, карточки): коснуться ручки и подержать 200 мс, потянуть.
- С клавиатуры и диктор — как в T-0167.
- Закрепить или снять отметку: форма правки → «Сохранить»; слайд уходит в конец
  другой группы.
- Состояния: **загрузка** и **ошибка загрузки** — как сейчас; **пусто** — «Слайдов
  ещё не было — заведите первый выше»; **один слайд в группе** — ручки нет;
  **идёт сохранение** — ручки неактивны; **ошибка записи / нет сети** — плашка с
  текстом, порядок возвращается к серверному; **400 «Список слайдов изменился»** —
  плашка и перечитанный список; **нет права** — раздел недоступен без `home.edit`
  (отдельного режима чтения нет).

Макета нет. Проверка — руками на 1440 и 390 px, запись в описании PR.

## Тесты

Пишутся первым коммитом, до кода. Миграцию на живой базе проверяет интеграционный
тест.

`backend/api/test/team-slides.test.ts` (`MemoryTeamSlideRepository` получает
`position`, `nextPosition`, `reorder` с теми же правилами, что у настоящего;
`list` — снятые в конце, потом `pinned desc, position, startsAt desc, slideId`;
`current` — тот же порядок):

- правила: `teamSlidesFor` с двумя идущими слайдами одной группы, у первого
  `position: 1`, у второго `0` → второй идёт первым (раньше шёл по `startsAt`);
  при равных `position` — по `startsAt` (позже — раньше), затем по `slideId`;
  закреплённые по-прежнему идут перед остальными независимо от `position`; из
  трёх идущих игрок получает два — первые по порядку.
- `create`: новый слайд получает `position` = наибольший в группе + 1 (в пустой
  группе — 0); поля `position` во входе нет, лишнее поле во входе — отказ схемы.
- `update`: правка текста `position` не меняет; смена `pinned` переводит слайд в
  конец другой группы; `position` из тела не принимается.
- `reorder(admin, "regular", [c, a, b])` → `catalog` отдаёт `c`, `a`, `b` с
  `position` 0, 1, 2; `forPlayer` сразу после этого показывает тот же порядок
  (кэш идущих сброшен — `repository.currentCalls` растёт).
- Аудит: одна запись `home.slides.reorder`, `target: "regular"`,
  `before: { order: [заголовки до] }`, `after: { order: [заголовки после] }`.
- Повтор того же порядка: ответ тот же, второй записи аудита нет, ничего не
  записано.
- `TeamSlideOrderMismatchError` (400, `team_slide_order_mismatch`) и ничего не
  записано, аудита нет: не хватает одного id; неизвестный id; id слайда другой
  группы; id снятого слайда; повтор id.
- Кончившийся и будущий слайды входят в порядок своей группы.
- Право: администратор без `home.edit` получает тот же отказ, что у `create`;
  порядок не меняется.
- `teamSlideOrderSchema`: `group: "other"`, пустой `ids`, повтор id, не UUID,
  лишние поля, больше 200 id — отказ.
- По HTTP панели: `POST /admin/home/slides/order` с `{ group, ids }` → `200` и
  `{ data: { order } }`; неполный набор → `400`, код `team_slide_order_mismatch`;
  маршрут не принят за `:slideId`; роль без `home.edit` → `403`.

`backend/api/test/team-slides.integration.test.ts` (живой Postgres):

- колонка `position` не принимает отрицательное значение (`CHECK`);
- миграция: слайды, созданные до неё (вставка строк без `position` невозможна —
  проверить обратным путём: после применения миграции `position` у каждой группы
  идёт 0, 1, 2… по `starts_at desc`, у снятых — 0); если миграционный тест
  невозможно выразить на готовой схеме — исполнитель проверяет это один раз
  руками на базе с тестовыми строками и записывает результат в описание PR;
- `current` и `list` отдают слайды в порядке `pinned desc, position, starts_at desc`;
- `reorder` переписывает `position` только у сдвинувшихся строк (`updated_at` у
  остальных прежний);
- два одновременных `reorder` одной группы (`Promise.all`) с разными порядками —
  оба завершаются без ошибки, итог — один из двух порядков, `position` группы —
  перестановка 0…n−1 без дублей;
- чужая группа, снятый слайд и несуществующий id → `mismatch`, `position` в базе
  не изменились;
- `nextPosition`: пустая группа — 0, иначе максимум + 1; снятые не считаются.

`backend/api/test/home.test.ts`: литерал `TeamSlideRow` (строка 101) получает
`position: 0`; порядок слайдов в `pickSlides` проверяется как раньше (он зависит
только от входа).

`apps/admin/test/home-slides.test.ts`:

- `reorderSlides`: `POST /home/slides/order`, тело `{ group: "regular", ids: ["a","b"] }`,
  ответ `{ data: { order: [...] } }` разобран; ответ другой формы — ошибка разбора.
- `slideGroups`: закреплённые, остальные и снятые в своих списках, порядок внутри
  группы сохраняется; кончившийся слайд остаётся в своей группе, снятый — только
  в `archived`.
- `slideSchema` принимает ответ с `position` и отвергает без него.
- `createSlide`/`updateSlide`: тело запроса `position` не содержит (кейс «список,
  заведение, правка и снятие» обновить).
- `crowded` не меняется.

`apps/admin/test/audit.test.ts`: `actionTitle("home.slides.reorder")` → «Порядок
слайдов главной»; запись `home.slides.reorder` с `before: { order: ["Турнир","Конкурс"] }`
и `after: { order: ["Конкурс","Турнир"] }` — `auditChanges` отдаёт одну правку
`order`, `auditValue(…, "order")` — «Конкурс, Турнир».

`apps/admin/test/help.test.ts` менять не нужно: он сам проверит, что `HELP.home.order`
стоит на экране и строки не длиннее 400 знаков.

## Аналитика

Нет: действие команды в панели, не игрока и не деньги. Журнал — аудит
`home.slides.reorder`; строка лога `team_slides_reordered`. События игрока
`home_slide_viewed` / `home_slide_clicked` (`docs/22-analytics-and-metrics.md`)
не меняются: слайд по-прежнему идентифицируется своим `slideId`.

## Настройки и окружение

Нет: новых ключей каталога настроек и переменных окружения нет. Миграция —
только добавление колонки и индекса.

## Документы

- `docs/29-admin-panel.md` — строка «Главная» (шаг 12).
- `docs/21-diagrams.md` — `HOME_SLIDE.position` и фраза в описании сущности
  (шаг 12): схема БД меняется, обновляется в этом же PR.
- `pnpm docs:check` проходит.

## Критерии приёмки

- [ ] Слайды переставляются за ручку мышью, пальцем (узкий экран) и с клавиатуры
      внутри групп «Закреплённые» и «Остальные»; клик по строке, «Изменить» и
      «Снять» работают, как раньше; снятые — внизу без ручек.
- [ ] После перестановки игрок видит слайды команды в новом порядке в течение
      полуминуты: закреплённые первыми, внутри группы — по `position`; не больше
      двух разом.
- [ ] Новый слайд встаёт последним в своей группе; правка слайда место не
      меняет, кроме смены «Первым в карусели» (тогда — конец другой группы).
- [ ] `POST /admin/home/slides/order` принимает `{ group, ids }`, работает в одной
      транзакции под блокировкой, идемпотентен, на неполный, лишний, чужой,
      снятый или повторный id отвечает 400, право — `home.edit`; объявлен выше
      `:slideId`.
- [ ] Перестановка пишет одну запись аудита `home.slides.reorder` с названиями до
      и после; повтор того же порядка — не пишет. Кэш идущих слайдов сброшен.
- [ ] Миграция только добавляет `position` (с `CHECK` и индексом), существующим
      слайдам порядок проставлен как сейчас видит игрок; папка миграции одна.
- [ ] Тесты из раздела «Тесты» написаны до кода и зелёные; интеграционные зелёные
      в CI.
- [ ] В диффе нет правок `home-slides.ts`, `home.service.ts`, `SortableList` и
      `DataTable`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; руками проверено на 1440 и
      390 px.

## PR

- **Заголовок:** `feat(admin): Порядок слайдов главной перетаскиванием`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОРЯДОК СЛАЙДОВ ГЛАВНОЙ ПЕРЕТАСКИВАНИЕМ**

  В панели «Главная» слайды команды переставляются перетаскиванием (мышью, пальцем, с клавиатуры). Порядок уходит одним запросом, пишется в аудит одной записью и действует на игроков в течение полуминуты.

  🛠 **Что изменилось**

  • у слайдов появилось место в списке: закреплённые идут первыми, внутри группы — по месту; раньше внутри шло «позже начался — выше»
  • новый слайд встаёт последним в своей группе, правка слайда место не трогает, смена «Первым в карусели» переносит слайд в конец другой группы
  • существующим слайдам место проставлено так, как игроки видят их сейчас
  • в карусели по-прежнему не больше двух слайдов команды — теперь это два верхних идущих из списка
  ```
