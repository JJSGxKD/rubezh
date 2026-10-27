---
id: T-0133
title: Панель — подпись «отдельной доски» в журнале и сверка списка оружия с контентом
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - apps/admin/src/api/tasks.ts
  - apps/admin/test/weapon-titles.test.ts
shared:
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
runner: any
executor: haiku-5.5
effort: low
release: patch
design: null
batch: 3
---

# T-0133. Панель — подпись «отдельной доски» в журнале и сверка списка оружия с контентом

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0133.json)](README.md#значки-статуса)

## Зачем

Две находки ревью (`tasks/inbox.md`, 14.10):

1. **#331.** В деталях записей журнала `players.board.set` и `players.board.unset`
   держатель права видит сырой ключ `separate_board`: его нет в словаре видов
   ограничений панели.
2. **#325.** Список оружия для фильтра заданий в панели набран руками. Новое
   оружие (T-0118 — седьмое) в фильтр не попадёт, пока про него не вспомнят.

## Решения

- Подпись — нейтральная: «отдельная доска».
- Сверка оружия — тестом по исходникам: панель не зависит от `core-game`, а
  тест читает файлы как текст. Набор id в `WEAPON_TITLES` равен набору id
  **базового** оружия в `packages/core-game/src/content/weapons.ts`. Эволюции —
  записи с `evolvedFrom` (T-0102) — в фильтр не входят: задания считают их
  базовым оружием. Название в панели совпадает с названием для игрока
  `weapon.<id>.name` в `packages/app-shell/src/i18n/ru.json`.

## Как сейчас

- `apps/admin/src/api/audit.ts:382` — `RESTRICTION_KINDS`: виды ограничений
  с подписями (`purchases: "покупки"` и другие), `separate_board` нет.
- `apps/admin/src/api/tasks.ts:57` — `WEAPON_TITLES`: шесть пар id → название руками.
- `packages/core-game/src/content/weapons.ts` — записи оружия вида
  `id: "spark"`, `id: "knife"` и т. д.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`audit.ts`** — в `RESTRICTION_KINDS` строка `separate_board: "отдельная доска"`.
3. Больше ничего не менять: `WEAPON_TITLES` сейчас совпадает с контентом.
   Новый тест будет падать, когда появится новое оружие без строки в панели.

## Чего не трогаем

- Сервер и права, текст других видов ограничений, фильтры заданий.

## Тесты

- `apps/admin/test/audit.test.ts` — строка с видом `separate_board` в деталях
  ограничения показывается как «отдельная доска» (по образцу соседних кейсов
  `restrictionLine`).
- `apps/admin/test/weapon-titles.test.ts` (новый):
  - прочитать `packages/core-game/src/content/weapons.ts` через `readFileSync`
    (путь — от `import.meta.url`, как в соседних тестах);
  - разрезать текст на записи по началу `{` перед `id: "…"`; id базового
    оружия — записи без `evolvedFrom`;
  - набор ключей `WEAPON_TITLES` равен набору id базового оружия;
  - для каждого id `WEAPON_TITLES[id]` равен `weapon.<id>.name` из
    `packages/app-shell/src/i18n/ru.json`;
  - сообщение ошибки называет лишний или недостающий id.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Нет.

## Критерии приёмки

- [ ] В журнале панели вид `separate_board` подписан «отдельная доска».
- [ ] Тест сверки падает, если в контенте появилось базовое оружие без строки
  в `WEAPON_TITLES` или если название расходится с названием для игрока.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `fix(admin): Подпись «отдельной доски» и сверка оружия`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДВЕ МЕЛОЧИ ПАНЕЛИ**

  Журнал аудита подписывает «отдельную доску» словами. Список оружия в фильтре заданий сверяется с игрой тестом: новое оружие без строки в панели уронит CI.
  ```
