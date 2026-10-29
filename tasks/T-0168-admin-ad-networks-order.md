---
id: T-0168
title: Порядок рекламных сетей в круге — перетаскиванием вместо числа
epic: E7
priority: P2
status: in-progress
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: [T-0167]
zones:
  - apps/admin/src/screens/ads/NetworkCards.tsx
  - apps/admin/src/api/ads.ts
  - apps/admin/test/ads.test.ts
  - backend/api/src/modules/admin/admin-ads.controller.ts
  - backend/api/src/modules/ads/ads-catalog.service.ts
  - backend/api/src/modules/ads/ads-catalog.repository.ts
  - backend/api/src/modules/ads/ads-errors.ts
  - backend/api/test/ads-catalog.test.ts
  - backend/api/test/ads.integration.test.ts
shared:
  - docs/29-admin-panel.md
  - apps/admin/src/api/audit.ts
  - apps/admin/src/ui/help.ts
  - apps/admin/test/audit.test.ts
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0168. Порядок рекламных сетей в круге — перетаскиванием вместо числа

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0168.json)](README.md#значки-статуса) [![T-0167](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0167.json&label=T-0167)](archive/T-0167-admin-sortable-list-tasks-order.md)

## Зачем

Место рекламной сети в круге показа задаётся числом в карточке сети
(«Место в круге», меньше — раньше). Чтобы поставить сеть второй, нужно знать
числа соседей и сохранить каждую карточку отдельно. После T-0167 в панели есть
`SortableList`: сети в карточках переставляются перетаскиванием, а порядок уходит
на сервер одним запросом.

## Решения

Те же, что в T-0167 (решения claude-lead-1 от 19.10.2026): общий `SortableList`
на dnd-kit с клавиатурой и подписями для диктора; порядок на сервере — одним
запросом «новый порядок списка» (массив id) в одной транзакции, идемпотентно,
400 на неполный, лишний или повторный id, одна запись аудита с прежним и новым
порядком, право — то же, что на правку записей списка (`ads.edit`); поле ручного
номера из формы убирается.

Следствия для сетей (как в T-0167 для заданий):

- список — все сети каталога `ad_network`, включая выключенные и те, чьего
  профиля нет в коде: в панели они все показаны карточками;
- после перестановки `priority` — 0, 1, 2… по новому порядку. Прежние равные
  числа (в круге равные места допустимы, `ads-rules.ts:184`) станут разными;
  это следствие одной перестановки и нужной сетям строгой очередности;
- `priority` **меняется только запросом порядка**. Правка карточки (ключи,
  включённость) его не трогает — иначе форма, открытая до перестановки, вернула
  бы старое место.

## Как сейчас

Сервер:

- `backend/api/src/modules/ads/ads-catalog.repository.ts:101` — `networks()`:
  `ORDER BY priority, network_key`; `updateNetwork` (строка 128) пишет
  `active`, `priority` и ключи; интерфейс `AdsCatalogRepository` — строка 58.
- `backend/api/src/modules/ads/ads-catalog.service.ts:53` — `networkEditSchema`
  (`priority` обязателен, 0–10 000); `saveNetwork` (строка 151): право
  `ads.edit` через `this.roles.require`, аудит `ads.network.update`
  (`before`/`after`), `this.changed(...)` сбрасывает кэш блоков выдачи и пишет
  строку лога.
- `backend/api/src/modules/admin/admin-ads.controller.ts:21` — маршруты
  `/admin/ads`: `GET`, `POST networks` (`saveNetwork`), `POST blocks`; изменяющие
  — `@RequirePermission("ads.edit")`, лимит через `this.mutating(request)`,
  тело через `parse(() => schema.parse(body), "текст")`.
- `backend/api/src/modules/ads/ads-errors.ts:29` — `AdCatalogNotFoundError`;
  ошибки — наследники `DomainError`.
- Тесты: `backend/api/test/ads-catalog.test.ts` — служба с `MemoryCatalog`
  (строка 53; `updateNetwork` в нём ставит `priority`, строка 74), права и
  аудит; `backend/api/test/ads.integration.test.ts` — живая база.

Панель:

- `apps/admin/src/screens/ads/NetworkCards.tsx:34` — сети карточками в сетке
  (`grid-cols-1 xl:grid-cols-2`), `key={network.networkKey}`; в `NetworkCard`
  поле «Место в круге» (строка 167, `HELP.ads.priority`), успех сохранения пишет
  в уведомление «место в круге N» (строка 67).
- `apps/admin/src/api/ads.ts:180` — `saveNetwork` шлёт `priority`; `NetworkForm`
  (строка 297) и `networkFormOf`, `networkFormSchema` (строка 313) содержат
  `priority`; `PRIORITY_MAX` (строка 64); `coverage()` (строка 264) сортирует
  активные сети по `priority`.
- `apps/admin/src/ui/help.ts:17` — `HELP.ads.priority`, строка 15 —
  `HELP.ads.circle` (пояснение круга). Тест `apps/admin/test/help.test.ts`
  требует, чтобы каждая строка словаря стояла на экране.
- `SortableList`, `SortableItem`, `moveItem`, `applyOrder` и тексты диктора —
  из T-0167 (`apps/admin/src/ui/sortable-list.tsx`, `sortable-order.ts`).
- Разделов с ручным порядком в панели других нет: у слайдов главной порядок
  задают закрепление и время начала (`pinned`, `startsAt`), журнал «Что нового»
  упорядочен версией и видом строки, акции магазина — датами. Поля порядка в их
  схемах нет, и эта задача их не заводит.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. `ads-errors.ts`: `AdNetworkOrderMismatchError` — `DomainError`, код
   `ad_network_order_mismatch`, статус **400**, текст «Список сетей изменился —
   обновите страницу и переставьте ещё раз».
3. `ads-catalog.repository.ts`: в `AdsCatalogRepository` —
   `reorderNetworks(ids: readonly string[], at: Date): Promise<AdNetworksReorderResult>`,
   `AdNetworksReorderResult = { status: "mismatch" } | { status: "ok"; before: string[]; after: string[]; changed: boolean }`.
   Реализация — одна `$transaction`: `SELECT network_key, priority FROM ad_network ORDER BY priority, network_key FOR UPDATE`;
   набор `ids` не равен набору всех сетей — `mismatch`, ничего не пишется; иначе
   `priority` = индекс в `ids`, `UPDATE` только строк, у которых значение
   поменялось (`updated_at` — у них же); порядок уже такой — `changed: false`.
   `updateNetwork`: из `SET` убрать `priority`; `AdNetworkEdit.priority` убрать.
4. `ads-catalog.service.ts`:
   - `networkEditSchema`: `priority` — `z.number().int().min(0).max(10_000).optional()`,
     на входе игнорируется (комментарий: порядок задаёт запрос порядка; поле
     оставлено, чтобы вкладка панели со старой сборкой не получила 400);
     `saveNetwork` берёт `priority` из `before`, в аудите `after` — с ним же;
   - `reorderNetworks(actor: AccountRef, ids: readonly string[], at = new Date()): Promise<{ order: string[] }>`:
     `await this.roles.require(actor, "ads.edit")`; `this.db(this.repository.reorderNetworks(ids, at))`;
     `mismatch` → `AdNetworkOrderMismatchError`; `changed` — аудит
     `{ action: "ads.networks.reorder", target: "networks", before: { order: before }, after: { order: after } }`
     и `this.changed({ event: "ad_networks_reordered", actor: actor.accountId })`;
     не изменилось — ни аудита, ни лога, ответ тот же `{ order }`;
   - схема запроса `networkOrderSchema = z.object({ ids: z.array(z.string().min(1).max(32)).min(1).max(100) }).strict()`
     с проверкой «id не повторяются» — рядом с `networkEditSchema`, экспорт.
5. `admin-ads.controller.ts`: `@Post("networks/order") @RequirePermission("ads.edit")`,
   лимит `this.mutating(request)`, тело через
   `parse(() => networkOrderSchema.parse(body), "Некорректный порядок сетей")`,
   ответ `{ data: { order: string[] } }`. Объявить рядом с `@Post("networks")`.
6. `apps/admin/src/api/ads.ts`: `reorderNetworks(api: AdminApi, ids: readonly string[]): Promise<ApiResult<{ order: string[] }>>`
   — `POST /ads/networks/order`, тело `{ ids }`, ответ разбирается Zod-схемой;
   из `NetworkForm`, `networkFormOf`, `networkFormSchema` и тела `saveNetwork`
   убрать `priority`. `PRIORITY_MAX` и `AdNetwork.priority` остаются (ответ
   сервера и `coverage()` их используют).
7. `NetworkCards.tsx`:
   - убрать поле «Место в круге» и текст «место в круге N» из уведомления об
     успехе;
   - сетка карточек — внутри `SortableList` (`layout="grid"`,
     `ids` — ключи сетей в порядке `view.networks`, `labelOf` — название сети),
     каждая карточка — `SortableItem as="div"`; ручка — в шапке карточки слева от
     названия. Ручки показываются, только когда `canEdit` и сетей больше одной;
     без права `ads.edit` карточки как сейчас;
   - перетаскивание начинается только с ручки: поля ввода, чекбокс и кнопка
     «Сохранить» внутри карточки продолжают работать;
   - `move(ids)`: порядок на экране меняется сразу (`applyOrder`), вызывается
     `reorderNetworks`; успех — `toast.success("Порядок сетей сохранён", { description: "Выдача увидит правку в течение полуминуты" })`
     и `onSaved()`; ошибка — `toast.error(error.message)`, порядок возвращается,
     `onSaved()`; пока запрос идёт, ручки неактивны;
   - карточки сохраняют несохранённые правки ключей при перестановке (ключ
     `key={network.networkKey}` не меняется — форма не пересоздаётся).
   - у `Panel` «Сети» — `help={HELP.ads.networks}` остаётся.
8. `help.ts`: `HELP.ads.priority` переписать под перетаскивание и показать его на
   экране у заголовка списка сетей (подсказка рядом с кнопкой-подсказкой панели
   или подписью над сеткой; место выбирает исполнитель, главное — строка стоит в
   `NetworkCards.tsx`, иначе тест словаря упадёт). Текст дословно:
   «Сети идут по кругу сверху вниз, слева направо — в порядке карточек. Переставляйте за ручку в шапке: мышью, пальцем или с клавиатуры (пробел, стрелки, пробел). Правка видна выдаче в течение полуминуты.»
   Заодно `HELP.ads.circle` (`help.ts:14`) называет «Место в круге» — это поле исчезает: переписать фразу про порядок на «порядок карточек сетей»; остальной текст круга не менять.
9. `audit.ts`: `"ads.networks.reorder": "Порядок рекламных сетей"` рядом с
   `ads.network.update`. Поле `order` в `FIELD_TITLES` добавлено в T-0167 — здесь
   не повторять.
10. `docs/29-admin-panel.md`: в строке «Реклама» «место в круге» — «порядок сетей
    в круге (перетаскиванием)».

## Чего не трогаем

- `SortableList`, `SortableItem`, `sortable-order.ts` и `DataTable` — T-0167;
  если компоненту чего-то не хватает, это вопрос тимлидам, а не правка заодно.
- Круг показа на стороне игрока и правила `networkOrder` (`ads-rules.ts`):
  читает `priority`, как раньше.
- Блоки мест, воронку, покрытие мест, ключи сетей и их проверки.
- Строки заданий сетей (`NetworkTasksPanel`).
- Схему Prisma и миграции: колонка `ad_network.priority` уже есть.

## Сценарий и интерфейс

Экран «Реклама», панель «Сети». В шапке каждой карточки слева — ручка
(видна при праве `ads.edit` и двух сетях и больше).

- Мышью, пальцем (задержка 200 мс) и с клавиатуры (пробел или Enter — взять,
  стрелки — переместить, пробел или Enter — положить, Escape — отменить) —
  как в T-0167; диктор говорит те же тексты.
- Состояния: **загрузка** и **ошибка загрузки** — как сейчас; **одна сеть** —
  ручки нет; **нет права** — ручек нет, порядок виден, карточки только для
  чтения; **идёт сохранение** — ручки неактивны; **ошибка записи / нет сети** —
  всплывающее сообщение, порядок возвращается к серверному; **400 «Список сетей
  изменился»** — то же и перечитанный список.

Макета нет. Проверка — руками на 1440 и 390 px, запись в описании PR.

## Тесты

Пишутся первым коммитом, до кода.

`backend/api/test/ads-catalog.test.ts` (`MemoryCatalog` получает
`reorderNetworks` с теми же правилами, что у настоящего):

- сети `adsgram` (10), `richads` (30), `taddy` (40):
  `reorderNetworks(admin, ["taddy","adsgram","richads"])` → `networks()` отдаёт
  `taddy`, `adsgram`, `richads` с `priority` 0, 1, 2; выдача (`ads` с кэшем
  блоков) сброшена.
- Аудит: одна запись `ads.networks.reorder`, `target: "networks"`,
  `before: { order: ["adsgram","richads","taddy"] }`,
  `after: { order: ["taddy","adsgram","richads"] }`.
- Повтор того же порядка: ответ тот же, второй записи аудита нет, ничего не
  записано.
- `AdNetworkOrderMismatchError` (400, `ad_network_order_mismatch`) и ничего не
  записано: нет одной сети; неизвестный id; повтор id.
- Право: администратор без `ads.edit` получает тот же отказ, что у
  `saveNetwork`; порядок не меняется.
- `saveNetwork` с `priority: 5` в теле не меняет `priority` сети; прежний кейс
  «сеть сохранена» (строка 134) проверяет остальные поля; сеть, чьего профиля
  нет в коде, тоже переставляется.
- `networkOrderSchema`: пустой `ids`, повтор, лишние поля, больше 100 id — отказ.
- Контроллер: у `AdminAdsController.reorderNetworks` в метаданных право
  `ads.edit` (как у соседних маршрутов — повторить способ проверки из этого
  файла).

`backend/api/test/ads.integration.test.ts` (живой Postgres):

- `reorderNetworks` переписывает `priority` только у сдвинувшихся строк
  (`updated_at` у остальных прежний).
- Два одновременных запроса с разными порядками — оба без ошибки, итог — один
  из двух порядков, `priority` — перестановка 0…n−1 без дублей.
- Неполный или с неизвестной сетью набор → `mismatch`, `priority` в базе не
  изменились.

`apps/admin/test/ads.test.ts`:

- `reorderNetworks`: `POST /ads/networks/order`, тело `{ ids: ["taddy","adsgram"] }`,
  ответ `{ data: { order: [...] } }` разобран; ответ другой формы — ошибка.
- `saveNetwork`: тело `{ networkKey, active, keys }` — без `priority` (обновить
  кейс на строках 125–127).
- `networkFormOf` отдаёт `{ active, keys }` (кейс строки 201);
  `networkFormSchema` принимает форму без `priority` (кейсы строк 189–197
  правятся: проверка «целое» уходит вместе с полем).
- `coverage()` по-прежнему сортирует активные сети по `priority` (существующий
  кейс не меняется).

`apps/admin/test/audit.test.ts`: `actionTitle("ads.networks.reorder")` →
«Порядок рекламных сетей».

## Аналитика

Нет: действие команды в панели, не игрока и не деньги. Журнал — аудит
`ads.networks.reorder`; строка лога `ad_networks_reordered`.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` — строка «Реклама» (шаг 10).
- `pnpm docs:check` проходит.

## Критерии приёмки

- [ ] Карточки сетей переставляются за ручку мышью, пальцем и с клавиатуры;
      поля ввода и кнопка «Сохранить» в карточке работают, как раньше;
      несохранённые правки ключей не теряются при перестановке.
- [ ] Поля «Место в круге» нет; правка карточки `priority` не меняет.
- [ ] `POST /admin/ads/networks/order` принимает `{ ids }`, работает в одной
      транзакции под блокировкой, идемпотентен, на неполный, лишний или
      повторный id отвечает 400, право — `ads.edit`.
- [ ] Перестановка пишет одну запись аудита `ads.networks.reorder`; повтор того
      же порядка — не пишет. Кэш блоков выдачи сброшен.
- [ ] Тесты из раздела «Тесты» написаны до кода и зелёные; интеграционные
      зелёные в CI.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; в диффе нет правок
      `SortableList` и `DataTable`.

## PR

- **Заголовок:** `feat(admin): Порядок рекламных сетей перетаскиванием`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОРЯДОК РЕКЛАМНЫХ СЕТЕЙ ПЕРЕТАСКИВАНИЕМ**

  В панели «Реклама» сети переставляются перетаскиванием (мышью, пальцем, с клавиатуры) вместо числа «Место в круге». Порядок уходит одним запросом, пишется в аудит одной записью и вступает в силу в течение полуминуты.

  🛠 **Что изменилось**

  • сети с равными прежними местами получают разные: 0, 1, 2… по порядку на экране
  • правка карточки сети (ключи, включённость) порядок не трогает
  ```
