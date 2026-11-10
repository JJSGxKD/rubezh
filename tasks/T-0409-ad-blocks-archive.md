---
id: T-0409
title: Архив рекламных блоков — «В архив» выключает блок и убирает его из списка
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/ads/ad-block-archive.service.ts
  - backend/api/src/modules/ads/ads-catalog.repository.ts
  - backend/api/src/modules/ads/ads-catalog.service.ts
  - backend/api/src/modules/ads/ads-tools.service.ts
  - backend/api/src/modules/admin/admin-ad-block-archive.controller.ts
  - backend/api/test/ad-block-archive.test.ts
  - backend/api/test/ad-block-archive.integration.test.ts
  - apps/admin/src/screens/ads/AdsScreen.tsx
  - apps/admin/src/screens/ads/BlocksPanel.tsx
  - apps/admin/src/screens/ads/blocks-view.ts
  - apps/admin/test/ads-archive.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/ads/ads-errors.ts
  - backend/api/src/modules/ads/ads.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/test/ads-catalog.test.ts
  - backend/api/test/ads-tools.test.ts
  - apps/admin/src/api/ads.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
  - apps/admin/src/ui/help.ts
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0409. Архив рекламных блоков — «В архив» выключает блок и убирает его из списка

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0409.json)](README.md#значки-статуса)

## Зачем

Удаления у рекламного блока нет: на него ссылаются показы. Отслужившие блоки
копятся в списке «Блоки мест» раздела «Реклама» и мешают его читать. После
задачи у блока есть кнопка «В архив». Она выключает блок и уносит его во
вкладку «Архив» списка. «Вернуть» возвращает блок в список выключенным.
Показы и воронка считаются как прежде.

## Решения

Записаны в `docs/35-stage4-plan.md` **Р200** (решение владельца 09.11.2026).
Исполнитель их не пересматривает.

1. **«В архив» выключает блок** (`active = false`) и ставит отметку архива
   (`archived_at`) одной записью.
2. **Архив — вкладка списка «Блоки мест»**, рядом с «Действующие». Блок в
   архиве виден только там.
3. **Статистика остаётся.** Воронка и пропуски считаются по сети и месту
   (`ad_session`), а сеть и место у блока не меняются. Отчёты архив не
   трогает.
4. **«Вернуть» возвращает блок выключенным.** Отметка архива снимается, а
   `active` остаётся `false`. Включают блок отдельно, в его карточке.
5. **Право — `ads.edit`.** В журнал идут действия `ads.block.archive` и
   `ads.block.unarchive`, как у остальных правок блока: запись аудита с
   «было» и «стало» плюс строка лога `{ module: "ads", event: … }`.
6. **Миграция только расширяющая:** новая колонка `ad_block.archived_at`,
   допускает `NULL`, без умолчания. Старый код колонку не читает, выкат по
   репликам безопасен.

Решения `claude-lead-1` по коду (раскладка, не продукт):

7. **Блок в архиве не правится.** Правка (`POST /admin/ads/blocks` с его
   `blockId`) отвечает 409 `ad_block_archived`. Сначала «Вернуть». Проверка
   стоит и в сервисе, и условием в `UPDATE` (`archived_at IS NULL`). Иначе
   правка, начатая до архива, могла бы включить блок, который уже в архиве.
8. **Повтор безопасен.** «В архив» для блока в архиве и «Вернуть» для
   блока вне архива отвечают 200 с тем же блоком. Записи, аудита и сброса
   кэша выдачи при этом нет.
9. **Каталог проверки рекламы командой** (`GET /api/v1/tools/ads/catalog`,
   Р165) блоков из архива не показывает: в архиве их не выдают и не
   проверяют.
10. **Архив и возврат — отдельный сервис** `AdBlockArchiveService` в
    `ads/ad-block-archive.service.ts`. В `AdsCatalogService` уже 275 строк,
    а порог декомпозиции — 300 (`CLAUDE.md`, «Стиль кода»). Там остаётся
    только проверка решения 7.
11. **Подтверждение у «В архив» есть, у «Вернуть» нет.** «В архив» может
    снять блок с выдачи, «Вернуть» ничего не включает.

## Как сейчас

- **Схема:** `backend/api/prisma/schema.prisma:1864–1886`, `model AdBlock`:
  поля `active`, `updatedAt`, `updatedBy`, архива нет. Образец поля архива —
  `archivedAt DateTime? @map("archived_at") @db.Timestamptz(3)` (~строка 2376).
- **Репозиторий каталога:** `backend/api/src/modules/ads/ads-catalog.repository.ts`.
  - `AdBlockDef` (`:31–41`) — поля блока, которые правит панель.
  - `AdsCatalogRepository` (`:73–92`).
  - `blockSchema` (`:100–109`).
  - `blocks()` (`:137–155`) — `SELECT … FROM ad_block ORDER BY place,
    network_key, created_at`.
  - `insertBlock` (`:186`).
  - `updateBlock` (`:212–230`) — `updateMany` по `blockId`.
- **Сервис:** `ads-catalog.service.ts`.
  - `view` (`:138–158`) отдаёт `blocks` с `problem`.
  - `saveBlock` (`:204–226`) — создание и правка, аудит `ads.block.create` /
    `ads.block.update`, затем `changed()`.
  - `changed()` (`:250–253`) — `ads.forgetBlocks()` и строка лога.
- **Ошибки:** `ads-errors.ts`. Образцы — `AdCatalogNotFoundError` (404) и
  `AdBlockShapeLockedError` (409).
- **Контроллер:** `backend/api/src/modules/admin/admin-ads.controller.ts`.
  `POST blocks` — `ads.edit`, лимит `mutating()`.
- **Выдача** (`ads.repository.ts:266–271`, `activeBlocks`) берёт только
  `b.active AND n.active`. Выключенный блок не выдаётся, правка выдачи не
  нужна.
- **Каталог проверки:** `ads-tools.service.ts:103–108` — `read()` и
  `buildCatalog(networkRows, blockRows)`.
- **Тестовые репозитории** реализуют `AdsCatalogRepository`:
  - `backend/api/test/ads-catalog.test.ts:54–110` (`MemoryCatalog`,
    `blockRows: AdBlockDef[]`, прямой `push` литерала на `:258`);
  - `backend/api/test/ads-tools.test.ts:38–75`.
- **Панель:** `apps/admin/src/screens/ads/AdsScreen.tsx:143–192`,
  `BlocksPanel`: таблица блоков, клик по строке открывает `BlockDialog`.
  Колонка «Состояние» показывает «не по правилам сети», «выключен», «в
  выдаче» или «ждёт сеть».
- **Клиент панели:** `apps/admin/src/api/ads.ts`. `blockSchema` (`:129–141`),
  `saveBlock` (`:203–206`).
- **Журнал:** `apps/admin/src/api/audit.ts:150–151` — подписи
  `ads.block.create` и `ads.block.update`. Объект блока (`:242–244`)
  подписывается сам — по `externalId` из записи.
- **Образец чипов вкладок** — `apps/admin/src/screens/promo-codes/PromoCodesScreen.tsx:65–78`
  (`role="tablist"`, классы `rounded-pill border px-3 py-1 text-xs …`).
  Образец подтверждения — `ui/confirm-dialog.tsx` (`ConfirmDialog`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема и миграция.** В `model AdBlock` после `updatedBy`:

   ```prisma
   /// в архиве с этого момента (Р200): блок выключен и в панели виден только во вкладке «Архив»; `null` — не в архиве
   archivedAt DateTime?  @map("archived_at") @db.Timestamptz(3)
   ```

   Индекс не нужен: блоков единицы, выдача читает `active`. Миграцию
   собрать по `tasks/README.md`, «Общие файлы», строка миграций, с именем
   `<метка>_ad_block_archive`. В ней ровно
   `ALTER TABLE "ad_block" ADD COLUMN "archived_at" TIMESTAMPTZ(3);`.
   Новой модели нет, `wipe-plan.ts` не меняется.
3. **Репозиторий** (`ads-catalog.repository.ts`):
   - тип рядом с `AdBlockDef`:

     ```ts
     /** Блок каталога как его видит панель: правимые поля и отметка архива (Р200). */
     export interface AdCatalogBlock extends AdBlockDef {
       /** ISO-время отметки; `null` — не в архиве */
       archivedAt: string | null;
     }
     ```

     Имя `AdBlockRow` занято типом выдачи в `ads.repository.ts`, не путать;
   - `blocks(): Promise<AdCatalogBlock[]>`. В `SELECT` добавить
     `archived_at`, в `blockSchema` — `archived_at: z.date().nullable()`.
     В объект — `archivedAt: row.archived_at?.toISOString() ?? null`;
   - в интерфейс и в Prisma-реализацию:

     ```ts
     /**
      * Отметка архива (Р200): `archived: true` — `archived_at = at` и `active = false`
      * одной записью; `false` — `archived_at = NULL`, `active` не трогается.
      * Пишет только при смене состояния. Результат: `null` — блока нет, иначе
      * блок после записи и `changed` — была ли запись.
      */
     setBlockArchived(blockId: string, archived: boolean, actorAccountId: string, at: Date): Promise<{ block: AdCatalogBlock; changed: boolean } | null>;
     ```

     Реализация — `updateMany` с условием `archivedAt: null` (в архив) или
     `archivedAt: { not: null }` (возврат). Поля: `archivedAt`, `active`
     (только в архив), `updatedAt`, `updatedBy`. Затем блок перечитывается
     по `blockId` тем же `SELECT`, что у `blocks()`. Нет строки — `null`;
     `count === 0` — `changed: false`;
   - `updateBlock`: в `where` добавить `archivedAt: null`. Блок в архиве
     не правится даже при гонке, ответ — `false`.
4. **Ошибка** (`ads-errors.ts`), рядом с `AdBlockShapeLockedError`:

   ```ts
   /** Блок в архиве не правится (Р200): сначала «Вернуть». */
   export class AdBlockArchivedError extends DomainError {
     constructor() {
       super("ad_block_archived", "Блок в архиве — верните его, чтобы изменить", 409);
     }
   }
   ```

5. **`AdsCatalogService.saveBlock`.** После проверки `before === null`:
   `if (before.archivedAt !== null) throw new AdBlockArchivedError();`. Если
   `updateBlock` вернул `false`, перечитать блок: он в архиве — бросить
   `AdBlockArchivedError`, иначе — `AdCatalogNotFoundError("block")`.
   `before` в аудите `ads.block.update` теперь несёт и `archivedAt` — так и
   надо. Больше в файле ничего не менять; тип `before` выводится из
   `blocks()`.
6. **`AdBlockArchiveService`** (`ads/ad-block-archive.service.ts`, новый).
   Зависимости — те же токены, что у `AdsCatalogService`:
   `ADS_CATALOG_REPOSITORY`, `RolesService`, `AdsService`. Таймаут базы —
   `withTimeout(…, 3_000, "реклама")`.

   ```ts
   archive(actor: AccountRef, blockId: string, at?: Date): Promise<AdCatalogBlock>;
   unarchive(actor: AccountRef, blockId: string, at?: Date): Promise<AdCatalogBlock>;
   ```

   Каждый метод:
   - `roles.require(actor, "ads.edit")`;
   - перед записью берёт блок из `blocks()`. Нет блока —
     `AdCatalogNotFoundError("block")`;
   - вызывает `setBlockArchived`. При `changed: true`:
     - аудит `{ action: "ads.block.archive" | "ads.block.unarchive",
       target: blockId, before, after }`;
     - `ads.forgetBlocks()`;
     - строка лога `{ module: "ads", event: "ad_block_archived" |
       "ad_block_unarchived", blockId, actor }`.
   - При `changed: false` — только вернуть блок (решение 8).

   В `ads.module.ts`: провайдер и `exports` — сервис нужен контроллеру из
   `AdminModule`. Без `exports` Nest не соберёт `AdminModule`.
7. **Контроллер** — новый `admin/admin-ad-block-archive.controller.ts`,
   `AdminAdBlockArchiveController`. `admin-ads.controller.ts` не трогаем:
   новая зависимость в его конструкторе сломала бы HTTP-тест
   `ads-catalog.test.ts`.
   - `@Controller("admin/ads/blocks")`, `@UseGuards(AdminSessionGuard, PermissionGuard)`;
   - `POST :blockId/archive` и `POST :blockId/unarchive`;
   - право `@RequirePermission("ads.edit")`;
   - лимит — тот же приём, что `mutating()` в `admin-ads.controller.ts:58–62`:
     `ADMIN_LIMITS.mutate` по `actor.accountId`, текст «Слишком много
     действий — подождите минуту»;
   - `blockId` — `z.string().uuid()` через `parse(…, "Некорректный блок")`;
   - ответ — `{ data: AdCatalogBlock }`.

   Регистрация — строкой в `controllers` у `admin.module.ts` (рядом с
   `AdminAdsController`, `:115`).
8. **Каталог проверки** (`ads-tools.service.ts`). В `read()` или в начале
   `buildCatalog` отбросить блоки с `archivedAt !== null`. Тип строки —
   `AdCatalogBlock`.
9. **Тестовые репозитории** (`ads-catalog.test.ts`, `ads-tools.test.ts`,
   общие файлы — правка добавлением):
   - `MemoryCatalog` из `ads-catalog.test.ts`:
     - поле `archived = new Map<string, string>()`;
     - `blocks()` возвращает `{ ...row, archivedAt: this.archived.get(row.blockId) ?? null }`;
     - `setBlockArchived` — по контракту из шага 3, через `archived` и `blockRows`;
     - `updateBlock` для блока из `archived` возвращает `false`.

     Литералы `blockRows` не трогать: поле архива живёт в `Map`.
   - В `ads-tools.test.ts`:
     - `blocks()` с тем же `archivedAt` из `Map`;
     - `setBlockArchived` бросает «проверка рекламы блоки не правит», как
       соседние методы;
     - один кейс из раздела «Тесты».
10. **Клиент панели** (`apps/admin/src/api/ads.ts`, общий файл — дописать):
    - в `blockSchema` — `archivedAt: z.string().nullable().default(null)`;
    - функции:

      ```ts
      export function archiveBlock(api: AdminApi, blockId: string): Promise<ApiResult<AdBlock>>;   // POST /ads/blocks/<id>/archive
      export function unarchiveBlock(api: AdminApi, blockId: string): Promise<ApiResult<AdBlock>>; // POST /ads/blocks/<id>/unarchive
      ```

      `blockId` в пути — через `encodeURIComponent`.
11. **Чистые функции** (`apps/admin/src/screens/ads/blocks-view.ts`, новый):

    ```ts
    export type BlocksTab = "current" | "archive";
    export const BLOCKS_TABS: readonly { id: BlocksTab; title: string }[] = [
      { id: "current", title: "Действующие" },
      { id: "archive", title: "Архив" },
    ];
    /** Блоки вкладки в прежнем порядке сервера и числа для чипов. */
    export function blocksOfTab(blocks: readonly AdBlock[], tab: BlocksTab): AdBlock[];
    export function blocksTabCounts(blocks: readonly AdBlock[]): Record<BlocksTab, number>;
    /** Состояние блока словами — то же, что колонка «Состояние»: для подтверждения «было → станет». */
    export function blockStateText(view: AdsView, block: AdBlock): string; // «не по правилам сети» | «выключен» | «в выдаче» | «ждёт сеть»
    ```

12. **Рефакторинг отдельным коммитом, поведение то же.** `BlocksPanel`
    переезжает из `AdsScreen.tsx` в `screens/ads/BlocksPanel.tsx` как есть.
    В `AdsScreen.tsx` остаётся импорт. Колонка «Состояние» при этом берёт
    текст из `blockStateText`, бейджи и тона — прежние.
13. **`BlocksPanel.tsx`** — архив по разделу «Сценарий и интерфейс»:
    - чипы вкладок над таблицей по образцу `PromoCodesScreen.tsx:65–78`,
      `aria-label="Блоки"`;
    - вкладка — локальное состояние, `useState<BlocksTab>("current")`;
    - колонки вкладок;
    - кнопки «В архив» и «Вернуть». Клик по кнопке не открывает карточку
      блока: `event.stopPropagation()`;
    - `ConfirmDialog` у «В архив» и тосты.
14. **Подписи** — общие файлы, строками:
    - `apps/admin/src/api/audit.ts`:
      `"ads.block.archive": "Рекламный блок в архив"`,
      `"ads.block.unarchive": "Рекламный блок из архива"`. Тест подписей —
      строкой в `apps/admin/test/audit.test.ts`;
    - `apps/admin/src/ui/help.ts`: `HELP.ads.archive` — текст из раздела
      «Сценарий и интерфейс».
15. **Документы** — раздел «Документы».

## Чего не трогаем

- `BlockDialog.tsx`, `NetworkCards.tsx`: архив живёт в строке таблицы, не
  в карточке блока. Оба файла — в `shared` у T-0374.
- Выдачу (`ads.service.ts`, `ads.repository.ts`): выключенный блок она уже
  пропускает.
- Воронку, «Пропуск VIP», покрытие мест, сводку панели (`admin-overview`):
  они считают по сети и месту либо уже отсекают выключенные блоки.
- Удаление блоков — его по-прежнему нет.
- `backend/api/test/ads.test.ts`, `apps/admin/test/ads.test.ts`: они в зонах
  T-0199, свои кейсы — в новых файлах.
- `wipe-plan.ts`: новой модели нет.

## Сценарий и интерфейс

Раздел «Реклама», панель «Блоки мест».

- **Над таблицей — чипы** «Действующие · 7» и «Архив · 2». По умолчанию
  открыта «Действующие». Число — блоков во вкладке, нуль показывается.
  Рядом с чипами — `Help` с `HELP.ads.archive`: «В архив уходят блоки,
  которые больше не нужны: блок выключается и пропадает из списка, его
  показы остаются в воронке и отчётах. «Вернуть» возвращает блок
  выключенным — включите его в карточке блока».
- **«Действующие»** — блоки с `archivedAt === null`. Колонки прежние, клик
  по строке открывает карточку, как сейчас. С `ads.edit` в конце —
  колонка без заголовка с кнопкой «В архив». На телефоне она уходит в угол
  карточки строки (`phoneLayout`).
- **«В архив»** открывает `ConfirmDialog`:
  - заголовок «Убрать блок в архив»;
  - `subject` — «<место> · <сеть> · <externalId или «по ключам сети»>»;
  - изменение `{ label: "Состояние", value: "<blockStateText> → в архиве, выключен" }`;
  - кнопка «В архив». Тон `danger`, если блок сейчас «в выдаче», иначе
    `primary`.

  После успеха: тост «Блок убран в архив и выключен», список перечитан,
  вкладка не меняется. Ошибка сервера показывается текстом в окне
  подтверждения (`{ ok: false, error }`).
- **«Архив»**:
  - колонки «Место», «Сеть», «Блок», «Успех», «В архиве с»
    (`formatDateTime(archivedAt)`);
  - клик по строке ничего не открывает: блок в архиве не правится;
  - с `ads.edit` — колонка без заголовка с кнопкой «Вернуть». Нажатие без
    подтверждения:
    - кнопка недоступна, пока идёт запрос;
    - тост «Блок возвращён выключенным» с описанием «Включите его в
      карточке блока»;
    - список перечитан.
- **Пусто.** «Действующие» без блоков — прежний текст «Блоков нет —
  заведите блок кнопкой «Новый блок»». Пустой «Архив» — «В архиве пусто —
  сюда попадают блоки, убранные кнопкой «В архив»».
- **Загрузка, ошибка загрузки, нет сети** — как сейчас у всего экрана.
- **Ошибка «Вернуть»** — `toast.error` с текстом сервера.
- **Без `ads.edit`** — обе вкладки видны, кнопок «В архив» и «Вернуть» нет.
- **Покрытие мест** архив не учитывает: блок в архиве выключен.

Снимки: обе вкладки и окно подтверждения на 390 и 1440 px; пустой
«Архив»; вкладки без `ads.edit`. Поток с dev-сервером снимает их сам и
кладёт в PR. Без dev-сервера поток пишет в PR «снимков нет», их делает
тимлид на приёмке. Поэтому `runner: any`.

## Тесты

Первым коммитом.

- `backend/api/test/ad-block-archive.test.ts` — сервис на своём
  `MemoryCatalog` в этом файле, по образцу `ads-catalog.test.ts:54–110`.
  Методы, которые архиву не нужны (`updateNetwork`, `reorderNetworks`,
  `funnel`, `passes`), бросают, как в `ads-tools.test.ts:61–75`:
  - `archive` включённого блока → `active: false`, `archivedAt` равен `at`;
    одна запись аудита `ads.block.archive`: `before.active === true`,
    `after.archivedAt !== null`; `forgetBlocks` вызван один раз;
  - повторный `archive` → тот же блок, аудита и `forgetBlocks` нет;
  - `unarchive` → `archivedAt: null`, `active: false`, аудит
    `ads.block.unarchive`;
  - `unarchive` блока не из архива → без записи и аудита;
  - неизвестный `blockId` → `AdCatalogNotFoundError` (404);
  - без `ads.edit` → отказ `roles.require`, записи нет;
  - `AdsCatalogService.saveBlock` с `blockId` блока в архиве →
    `AdBlockArchivedError` (409 `ad_block_archived`), строка не изменилась;
  - `AdsCatalogService.view` → у блока в архиве `archivedAt` строкой, у
    остальных `null`;
  - HTTP через `app.inject`, модуль по образцу `ads-catalog.test.ts:388–420`
    с `AdminAdBlockArchiveController` и `{ provide: AdBlockArchiveService, useValue: … }`:
    - `POST /api/v1/admin/ads/blocks/<uuid>/archive` → 201, `data.active === false`;
    - `blockId` не UUID → 400;
    - неизвестный UUID → 404 `ad_block_not_found`;
    - без заголовка CSRF → 403.
- `backend/api/test/ad-block-archive.integration.test.ts` — живой Postgres
  (`describe.skipIf(TEST_DATABASE_URL === "")`, своя сеть `it_<hex>`, как в
  `ads.integration.test.ts`), `PrismaAdsCatalogRepository`:
  - `setBlockArchived(id, true)` → `archived_at` задан, `active = false`,
    `changed: true`; второй вызов → `changed: false`, `updated_at` не
    сдвинулся;
  - `updateBlock` блока в архиве с `active: true` → `false`, в базе
    `active = false`;
  - `setBlockArchived(id, false)` → `archived_at IS NULL`, `active = false`;
  - `PrismaAdsRepository.activeBlocks()` блока в архиве не возвращает;
  - несуществующий `blockId` → `null`.
- `backend/api/test/ads-tools.test.ts` — один кейс: блок с отметкой архива
  в `MemoryCatalog` → в `GET /api/v1/tools/ads/catalog` его нет.
- `apps/admin/test/ads-archive.test.ts`:
  - `blocksOfTab` делит блоки по `archivedAt`, порядок сохраняется;
  - `blocksTabCounts` → `{ current: 2, archive: 1 }` на наборе из трёх;
  - `blockStateText`: `problem` задан → «не по правилам сети»;
    `active: false` → «выключен»; сеть включена и готова → «в выдаче»;
    сеть выключена → «ждёт сеть»;
  - `archiveBlock(api, id)` → `POST /api/v1/admin/ads/blocks/<id>/archive`;
    `unarchiveBlock` → `…/unarchive`;
  - ответ сервера без `archivedAt` разбирается в `archivedAt: null`;
  - `renderToStaticMarkup(<BlocksPanel …>)` с `canEdit: false` → кнопок
    «В архив» и «Вернуть» нет; с `canEdit: true` на «Действующих» → «В
    архив» в каждой строке.
- `apps/admin/test/audit.test.ts` — строкой: `actionTitle("ads.block.archive")`
  → «Рекламный блок в архив», `ads.block.unarchive` → «Рекламный блок из
  архива».
- Существующие `ads-catalog.test.ts`, `ads-tools.test.ts`, `ads.test.ts`,
  `ads.integration.test.ts`, `apps/admin/test/ads.test.ts` зелёные.

## Аналитика

Событий словаря нет, как у остальных правок блока. След — аудит
`ads.block.archive` / `ads.block.unarchive` и строка лога `ad_block_archived`
/ `ad_block_unarchived`. Показы и воронка считаются по-прежнему.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md`, строка «Реклама» в таблице модулей. Фразу «удаления
  нет — блок выключают» заменить: «удаления нет — ненужный блок убирают
  «В архив»: он выключается и виден только во вкладке «Архив» списка
  блоков, показы остаются в воронке; «Вернуть» возвращает блок
  выключенным; блок в архиве не правится (`35-stage4-plan.md` Р200)». В
  перечень действий журнала — `ads.block.archive`, `ads.block.unarchive`.
- `docs/21-diagrams.md` не меняется: полей `ad_block` в ER-схеме нет.

## Критерии приёмки

- [ ] «В архив» выключает блок и уносит его во вкладку «Архив». «Вернуть»
  возвращает блок выключенным.
- [ ] Блок в архиве не выдаётся, не правится (409) и не попадает в каталог
  проверки рекламы.
- [ ] Повторные «В архив» и «Вернуть» ничего не пишут и не аудируют.
- [ ] Миграция — одна колонка `archived_at` без умолчания, только
  расширяющая.
- [ ] `AdBlockArchiveService` есть в `exports` модуля рекламы, контроллер
  зарегистрирован в `AdminModule`, маршруты отвечают (HTTP-тест).
- [ ] Перенос `BlocksPanel` в свой файл — отдельным коммитом без смены
  поведения.
- [ ] Снимки из раздела «Сценарий и интерфейс» — в PR или у тимлида на
  приёмке.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Архив рекламных блоков`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет
- **Сводка для команды** — исполнитель переносит блок в описание PR как есть и
  вписывает номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — АРХИВ РЕКЛАМНЫХ БЛОКОВ**

  В разделе «Реклама» у блока появилась кнопка «В архив»: она выключает блок и убирает его во вкладку «Архив». Список «Блоки мест» больше не копит отслужившие блоки.

  🛠 **Как работает**

  • «В архив» — блок выключен и виден только во вкладке «Архив»
  • показы и воронка по нему остаются в отчётах
  • «Вернуть» — блок возвращается выключенным, включают его в карточке блока
  • в журнале — «Рекламный блок в архив» и «Рекламный блок из архива»
  ```
