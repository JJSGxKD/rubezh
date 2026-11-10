---
id: T-0382
title: Карточка партнёра — страница с вкладками вместо окна
epic: E14
priority: P2
status: ready
owner:
author: claude-lead2-3
size: M
depends_on: [T-0218, T-0221, T-0410]
zones:
  - apps/admin/src/screens/partners/PartnerCard.tsx
  - apps/admin/src/screens/partners/PartnerHeader.tsx
  - apps/admin/src/screens/partners/partner-card-rules.ts
  - apps/admin/src/screens/partners/PartnersScreen.tsx
  - apps/admin/test/partner-card.test.ts
shared:
  - docs/29-admin-panel.md
runner: local
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: null
batch: 5
---

# T-0382. Карточка партнёра — страница с вкладками вместо окна

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0382.json)](README.md#значки-статуса) [![T-0218](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0218.json&label=T-0218)](T-0218-partner-cabinet-links-promo.md) [![T-0221](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0221.json&label=T-0221)](T-0221-partner-materials.md) [![T-0410](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0410.json&label=T-0410)](T-0410-admin-tab-bar.md)

## Зачем

Карточка партнёра — окно поверх списка, и в нём всё подряд: статус, плитки,
коды, ссылки, постбэк, воронка, выплаты. Окно длинное, ссылку на нужное место
не отправишь, а «назад» закрывает всё. После задачи карточка — страница
`#/partners/<id>/<вкладка>`, как карточка игрока: шапка с именем, статусом и
действиями и вкладки по разделам.

## Решения

Записаны в `docs/35-stage4-plan.md` Р191 (03.11.2026). Исполнитель их не
пересматривает.

1. **Страница `#/partners/<id>/<вкладка>`, как карточка игрока**, а не окно
   поверх списка.
2. **Шапка** — имя, статус и действия.
3. **Вкладки** — «Сводка», «Ссылки и коды», «Воронка», «Постбэк», «Реклама»
   (Р190). **«Реклама» в этой задаче не появляется**: вкладку с данными
   добавит T-0383. Заглушки «появится позже» нет — вкладки просто нет.

Решения `claude-lead2-3` по коду (раскладка, не продукт):

4. **Что на какой вкладке** — всё, что есть в окне сейчас, без новых данных:
   - «Сводка» — статус и «Сменить статус…», плитки «Привёл / Играли / Платили /
     Звёзды», «Привязки по дням», «Выплаты», нижний блок (TG id,
     договорённости, заведён, окно привязки);
   - «Ссылки и коды» — «Коды партнёра» и «Ссылки партнёра» со строкой
     «Привязано по ссылкам»;
   - «Воронка» — `PartnerFunnelBlock`;
   - «Постбэк» — `PostbackBlock` партнёра. Вкладка есть только при
     `partners.edit`: блок и сейчас виден только с этим правом.
5. **Шапка** — имя, связь (`contact` или «Связь не указана»), значок статуса и
   кнопки, что сейчас в подвале окна: «Изменить» (`partners.edit`), «Завести
   ссылку» (`links.manage`), «Завести код партнёра», и кнопки кабинета от
   T-0218. «← Партнёры» над шапкой, как «← Игроки».
6. **Вкладка — в адресе**, без вкладки — «Сводка»; неизвестная — «Сводка»
   (как `cardTabOf`). Смена вкладки карточку не перечитывает.
7. **Вкладки — общим компонентом** `TabBar` (`ui/tab-bar.tsx`): его выносит
   из карточки игрока T-0410 (Р201), своего компонента вкладок задача не
   заводит.

## Как сейчас

- `apps/admin/src/screens/partners/PartnersScreen.tsx:22–40, 116` —
  `#/partners/<id>` открывает `PartnerCard` окном поверх списка (`openId`,
  `close`); клик по строке — `setOpenId`, без смены адреса.
- `PartnerCard.tsx:82–117` — `Dialog` с подвалом-кнопками; `CardBody`
  (`:121–268`) — всё содержимое подряд; `PartnerDialog` и `PartnerStatusDialog` —
  окна правки и статуса, открываются вместо карточки (`:56–80`).
- После T-0218 в карточке есть «Открыть кабинет» / «Закрыть кабинет»; после
  T-0221 в разделе «Партнёры» — вкладка «Материалы» (`PartnersScreen.tsx`).
  Задача берётся после обеих и переносит их кнопки и вкладки как есть.
- Эталон — карточка игрока: `screens/players/PlayerCardView.tsx` (вкладка из
  `useHashRoute()?.tab`, `navigate({ section, id, tab })`, после T-0410 — `TabBar`
  вместо локального `Tabs`), `card-rules.ts` (`CARD_TABS`, `cardTabOf`, `tabCounts`).
- `ui/router.ts` — `navigate`, `useHashRoute`; `routes.ts` — `hrefOf` с третьей
  частью адреса.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Вкладки** — `TabBar` из `ui/tab-bar.tsx` (T-0410) с `label="Карточка
   партнёра"` и `tabs={partnerTabs(canEdit)}`. Карточку игрока задача не
   трогает: её перевела на `TabBar` T-0410.
3. **`partner-card-rules.ts`**:

   ```ts
   export const PARTNER_TABS = [
     { id: "summary", title: "Сводка" },
     { id: "links", title: "Ссылки и коды" },
     { id: "funnel", title: "Воронка" },
     { id: "postback", title: "Постбэк" },
   ] as const;
   export type PartnerTab = (typeof PARTNER_TABS)[number]["id"];
   /** Вкладки, которые видит человек: «Постбэк» — только с `partners.edit`. */
   export function partnerTabs(canEdit: boolean): (typeof PARTNER_TABS)[number][];
   /** Вкладка из адреса; нет, чужая или недоступная — «Сводка». */
   export function partnerTabOf(tab: string | undefined, canEdit: boolean): PartnerTab;
   ```

4. **`PartnerHeader.tsx`** — шапка по решению 5 (кнопки — из нынешнего подвала
   `PartnerCard.tsx:91–111` и от T-0218, их условия и заглушки `NO_LINK_FOR_INACTIVE`
   — как есть).
5. **`PartnerCard.tsx`** — страница вместо `Dialog`: «← Партнёры», загрузка
   (`Loading`), ошибка (`ErrorNotice` с «Повторить»), шапка, `TabBar`,
   содержимое вкладки по решению 4. `PartnerDialog` и `PartnerStatusDialog`
   остаются окнами — поверх страницы, а не вместо неё. Пропсы: `{ partnerId,
   canEdit, onChanged }`, `onClose` больше нет.
6. **`PartnersScreen.tsx`** — с `id` рисует только `PartnerCard` (список не
   рисуется); клик по строке — `navigate({ section: "partners", id })`; после
   «Новый партнёр» — переход на его страницу; `openId` и `close` убрать.
   Вкладка «Материалы» (T-0221) остаётся во вкладках раздела.
7. **Документы** — раздел «Документы».

## Чего не трогаем

- Сервер, `api/partners.ts`, данные карточки — новых запросов нет.
- `PostbackBlock`, `PartnerFunnelBlock`, `PartnerDialog`, `PartnerStatusDialog` —
  переносятся как есть.
- Вкладку «Реклама» — T-0383.
- Кабинет партнёра (`screens/cabinet/**`) — T-0218/T-0219.
- Карточку игрока (`PlayerCardView.tsx`) и `ui/tab-bar.tsx` — T-0410.

## Сценарий и интерфейс

- **Список → строка партнёра** → адрес `#/partners/<id>`, страница на «Сводке».
- **Вкладка** → адрес `#/partners/<id>/links`; ссылку можно отправить, «назад»
  в браузере возвращает прежнюю вкладку, второй — список.
- **«Изменить» / «Сменить статус…»** → окно поверх страницы; сохранили —
  страница и список перечитаны.
- **Ссылка из карточки игрока** (`#/partners/<id>`) открывает страницу.
- **Загрузка** — `Loading` под «← Партнёры»; **ошибка** — `ErrorNotice` с
  «Повторить»; **партнёра нет** (404) — текст ошибки сервера и «← Партнёры».
- **Без `partners.edit`** — нет «Изменить», «Сменить статус…» и вкладки
  «Постбэк»; адрес `#/partners/<id>/postback` открывает «Сводку».

Снимки в PR: каждая вкладка на 390 и 1440 px; на 390 строка вкладок
прокручивается сама, страница — без боковой прокрутки.

## Тесты

Первым коммитом.

- `apps/admin/test/partner-card.test.ts`:
  - `partnerTabOf(undefined, true)` → `summary`; `"links"` → `links`;
    `"ads"` → `summary` (вкладки ещё нет); `"postback", false` → `summary`;
  - `partnerTabs(false)` без «Постбэка»; `partnerTabs(true)` — четыре вкладки в
    порядке решения 3;
  - `hrefOf({ section: "partners", id: "<uuid>", tab: "funnel" })` →
    `#/partners/<uuid>/funnel`.
- Существующие `partners.test.ts`, `postbacks.test.ts`, `card-rules.test.ts`,
  `players.test.ts` зелёные.

## Аналитика

Нет: интерфейс панели.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md`: строка «Партнёры» в таблице модулей — карточка
  открывается страницей `#/partners/<id>/<вкладка>`, вкладки «Сводка»,
  «Ссылки и коды», «Воронка», «Постбэк» (Р191).

## Критерии приёмки

- [ ] `#/partners/<id>` открывает страницу, а не окно; вкладка в адресе, «назад»
  работает.
- [ ] На вкладках — всё, что было в окне, без потерь; «Постбэк» — только с
  `partners.edit`.
- [ ] Снимки вкладок на 390 и 1440 в PR.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Карточка партнёра — страница с вкладками`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет
- **Сводка для команды** — исполнитель переносит блок в описание PR как есть и
  вписывает номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТОЧКА ПАРТНЁРА СТРАНИЦЕЙ**

  Карточка партнёра открывается страницей с вкладками, как карточка игрока, а не окном поверх списка. Ссылку на нужную вкладку можно отправить, «назад» в браузере работает.

  🛠 **Что внутри**

  • шапка — имя, статус и действия
  • вкладки «Сводка», «Ссылки и коды», «Воронка», «Постбэк»
  • вкладка «Реклама» появится следующей задачей (T-0383)
  ```
