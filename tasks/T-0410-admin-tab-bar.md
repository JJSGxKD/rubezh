---
id: T-0410
title: Вкладки панели — общий компонент TabBar из карточки игрока
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - apps/admin/src/ui/tab-bar.tsx
  - apps/admin/test/tab-bar.test.ts
shared:
  - apps/admin/src/screens/players/PlayerCardView.tsx
  - docs/29-admin-panel.md
runner: any
executor: haiku-5.5
effort: medium
release: patch
merge: self
design: null
batch: 5
---

# T-0410. Вкладки панели — общий компонент TabBar из карточки игрока

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0410.json)](README.md#значки-статуса)

## Зачем

Вкладки с чертой снизу есть только у карточки игрока: локальный компонент
`Tabs` в `PlayerCardView.tsx`. Скоро они нужны карточке партнёра (T-0382) и
разделу «Прокси» (T-0411). Задача выносит компонент в `ui/tab-bar.tsx` без
смены вида и поведения, чтобы следующие задачи его взяли, а не копировали.

## Решения

- **Р201** (`docs/35-stage4-plan.md`): вкладки «Прокси» — строкой с чертой
  снизу, как у карточки игрока, общим компонентом `TabBar`.
- **Р191**: карточка партнёра — тоже вкладками. T-0382 берёт `TabBar` из
  этой задачи и своего компонента вкладок не заводит.

Решения `claude-lead-1` по коду:

1. **Это рефакторинг.** Разметка, классы, порядок и подписи — ровно как у
   нынешнего `Tabs`. Карточка игрока выглядит и работает так же.
2. **Имя — `TabBar`, файл — `ui/tab-bar.tsx`.** Компонент общий, не только
   для карточек.
3. **Подпись строки вкладок (`label`) — обязательна**: это `aria-label` у
   `role="tablist"`, по нему строку находит экранный диктор.

## Как сейчас

- `apps/admin/src/screens/players/PlayerCardView.tsx:71–94` — локальный
  `Tabs({ active, counts, onSelect })`:
  - `div role="tablist" aria-label="Карточка игрока"` с классами
    `flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]`;
  - кнопки по `CARD_TABS` с `role="tab"` и `aria-selected`;
  - активная — `border-accent text-text`, остальные —
    `border-transparent text-text-muted hover:text-text`;
  - число — значком `bg-warning/15 … text-warning`.

  Вызов — `:51`, `<Tabs active={tab} counts={tabCounts(state.data, active)} onSelect={open} />`.
- `apps/admin/src/screens/players/card-rules.ts:12–21` — `CARD_TABS`
  (`{ id, title }[]`, `as const`) и `CardTab`.
- Тесты карточки — `apps/admin/test/card-rules.test.ts`,
  `apps/admin/test/players.test.ts`.

## Шаги по порядку

1. **Тест первым коммитом** — `apps/admin/test/tab-bar.test.ts` (раздел
   «Тесты»).
2. **`apps/admin/src/ui/tab-bar.tsx`** — перенести `Tabs` с обобщённым типом:

   ```tsx
   /** Вкладки строкой: активная — черта акцента снизу, число ожидающего — значком; на телефоне прокручивается строка, не страница. */
   export function TabBar<T extends string>({
     label,
     tabs,
     active,
     counts = {},
     onSelect,
   }: {
     /** подпись строки для экранного диктора: «Карточка игрока», «Прокси» */
     label: string;
     tabs: readonly { id: T; title: string }[];
     active: T;
     /** число у вкладки — значком; нет числа или нуль — значка нет */
     counts?: Partial<Record<T, number>>;
     onSelect: (tab: T) => void;
   }): ReactNode;
   ```

   Разметка и классы — посимвольно из `PlayerCardView.tsx:74–91`.
   Изменение одно: значок не рисуется и при `count === 0`. В карточке
   игрока нулей и так нет: `tabCounts` их не кладёт (`card-rules.ts`,
   «нулей нет»).
3. **`PlayerCardView.tsx`** — удалить локальный `Tabs`. Вызов на `:51`:
   `<TabBar label="Карточка игрока" tabs={CARD_TABS} active={tab} counts={tabCounts(state.data, active)} onSelect={open} />`.
   Импорт `CARD_TABS` остаётся. Больше в файле ничего не править: файл
   правят и другие задачи (T-0072, T-0368, T-0381).
4. **Документы** — раздел «Документы».

## Чего не трогаем

- `card-rules.ts`, `PlayerHeader.tsx`, содержимое вкладок карточки игрока.
- Чипы-фильтры (`role="tablist"` в `NamesScreen.tsx`, `PromoCodesScreen.tsx`,
  `ReviewScreen.tsx`, `AuditScreen.tsx`, `RequestsScreen.tsx`) — другой вид
  с другим смыслом: отбор внутри списка, а не разделы страницы.
- Карточку партнёра — T-0382, раздел «Прокси» — T-0411.

## Сценарий и интерфейс

Видимых изменений нет: карточка игрока выглядит и работает, как раньше.
Тест разметки держит это без снимков. Снимки вкладок карточки игрока на 390
и 1440 px делает тимлид на приёмке.

## Тесты

Первым коммитом.

- `apps/admin/test/tab-bar.test.ts` (`renderToStaticMarkup`, как в
  `apps/admin/test/card-rules.test.ts`), вкладки `[{ id: "a", title: "Первая" },
  { id: "b", title: "Вторая" }]`:
  - есть `role="tablist"` с `aria-label="Проверка"`;
  - у активной `b` — `aria-selected="true"`, у `a` — `aria-selected="false"`;
  - `counts={{ a: 3 }}` → у «Первая» значок с `3`;
  - `counts={{ a: 0 }}` → значка нет;
  - без `counts` → значков нет;
  - порядок кнопок — как в `tabs`.
- Существующие `card-rules.test.ts` и `players.test.ts` зелёные без правки.

## Аналитика

Нет: интерфейс панели, нажатия вкладок не размечены.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` — новый пункт в списке общих компонентов,
  рядом с «ряды полей и причина у кнопки» (~строка 323): «**вкладки
  разделов страницы** (tasks/T-0410, `ui/tab-bar.tsx`): `TabBar` — строка с
  чертой акцента снизу, число ожидающего — значком, на телефоне
  прокручивается строка; у карточек игрока и партнёра и у раздела «Прокси».
  Чипы `role="tablist"` — для отбора внутри списка, не для разделов».

## Критерии приёмки

- [ ] `TabBar` в `ui/tab-bar.tsx`, локального `Tabs` в `PlayerCardView.tsx`
  нет.
- [ ] Карточка игрока выглядит и работает, как раньше: разметка `TabBar`
  совпадает с прежним `Tabs` посимвольно, кроме значка при нуле.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(admin): Вынеси вкладки карточки игрока в TabBar`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет
- **Сводка для команды** — исполнитель переносит блок в описание PR как есть и
  вписывает номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБЩИЕ ВКЛАДКИ ПАНЕЛИ**

  Вкладки карточки игрока стали общим компонентом панели: на нём будут вкладки карточки партнёра и раздела «Прокси». Карточка игрока выглядит и работает, как раньше.
  ```
