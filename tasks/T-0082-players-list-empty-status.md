---
id: T-0082
title: Список игроков — пустой «Статус» не остаётся подписью без значения в карточке
epic: E7
priority: P3
status: ready
owner:
author: claude-lead2-6
size: S
depends_on: [T-0049]
zones:
  - apps/admin/src/screens/players/PlayerList.tsx
  - apps/admin/src/screens/players/list-status.ts
  - apps/admin/test/player-status.test.ts
shared: []
runner: any
executor: haiku-5.5
effort: low
release: patch
design: null
batch: 1
---

# T-0082. Список игроков — пустой «Статус» не остаётся подписью без значения в карточке

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0082.json)](README.md#значки-статуса) [![T-0049](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0049.json&label=T-0049)](T-0049-admin-shell-responsive.md)

## Зачем

На телефоне список игроков в панели показывается карточками (T-0049). У игрока
без блокировки и без ограничений в карточке висит подпись «Статус» без
значения. Находка приёмки PR #286, 12.10. После задачи у такого игрока строки
«Статус» в карточке нет.

## Решения

- **Карточка скрывает пару «заголовок значение», когда ячейка пуста** — так
  сделана раскладка в T-0049 (PR #286). Эта задача лишь перестаёт отдавать
  пустую обёртку: когда бейджей нет, `render` возвращает `null`.
- **Какие бейджи есть, решает чистая функция** в новом `list-status.ts`
  (DOM-тестов у панели в этом месте нет): «заблокирован» и «закрыто: …».
- Состав и тексты бейджей не меняются: «заблокирован» (`danger`) и «закрыто:
  <виды через запятую>» (`warning`); вид `all` в ограничениях не показывается,
  как и раньше.
- `ui/kit.tsx`, `DataTable` и вся раскладка карточки — зона T-0049, не правим.

## Как сейчас

`apps/admin/src/screens/players/PlayerList.tsx:199-213` (до T-0049 строки те же;
после слияния могут сдвинуться — искать `title: "Статус"`):

```tsx
{
  title: "Статус",
  render: (player) => {
    const limited = player.restrictions.filter((kind) => kind !== "all");
    return (
      <span className="flex flex-wrap gap-1">
        {player.banned === null ? null : <Badge tone="danger">заблокирован</Badge>}
        {limited.length === 0 ? null : <Badge tone="warning">закрыто: {limited.map(kindTitle).join(", ")}</Badge>}
      </span>
    );
  },
},
```

Функция всегда возвращает `<span>`, даже пустой, поэтому карточка не видит
отсутствия значения. `kindTitle` — функция, которую `Статус` уже вызывает
(`limited.map(kindTitle)`); в новую функцию её передают параметром, перенос или
импорт не нужны. Тип строки — `PlayerListItem` из `api/player-list.ts` (поля
`banned: { at, reason } | null` и `restrictions`).

## Шаги по порядку

1. **До начала:** убедиться, что T-0049 влит (`depends_on`), и открыть
   `apps/admin/src/ui/kit.tsx`, `DataTable`: пара в карточке скрывается, когда
   `render(row)` вернул `null`. Если не скрывается — **остановиться и написать
   вопрос тимлиду** (раздел «Если что-то неясно» в `tasks/README.md`); `kit.tsx`
   не править.
2. **Тесты первым коммитом** (раздел «Тесты»): новый файл
   `apps/admin/test/player-status.test.ts`. Падают, пока модуля нет.
3. **Новый `apps/admin/src/screens/players/list-status.ts`:**

   ```ts
   import type { PlayerListItem } from "../../api/player-list";

   export interface StatusBadge {
     tone: "danger" | "warning";
     text: string;
   }

   /**
    * Бейджи столбца «Статус». Пусто — у игрока нет ни блокировки, ни
    * ограничений: экран тогда не рисует ничего, и карточка на телефоне не
    * показывает подпись без значения.
    */
   export function statusBadges(
     player: Pick<PlayerListItem, "banned" | "restrictions">,
     kindTitle: (kind: PlayerListItem["restrictions"][number]) => string,
   ): StatusBadge[] {
     const limited = player.restrictions.filter((kind) => kind !== "all");
     return [
       ...(player.banned === null ? [] : [{ tone: "danger" as const, text: "заблокирован" }]),
       ...(limited.length === 0 ? [] : [{ tone: "warning" as const, text: `закрыто: ${limited.map(kindTitle).join(", ")}` }]),
     ];
   }
   ```

   Если TypeScript не принимает тип параметра `kindTitle` — подогнать его под
   настоящую сигнатуру функции в `PlayerList.tsx`, смысл не менять.
4. **`PlayerList.tsx`:** в импорте добавить `import { statusBadges } from "./list-status";`,
   колонку «Статус» заменить на

   ```tsx
   {
     title: "Статус",
     render: (player) => {
       const badges = statusBadges(player, kindTitle);
       return badges.length === 0 ? null : (
         <span className="flex flex-wrap gap-1">
           {badges.map((badge) => (
             <Badge key={badge.text} tone={badge.tone}>
               {badge.text}
             </Badge>
           ))}
         </span>
       );
     },
   },
   ```

5. **Глазами (по возможности):** панель на ширине до 768 px — у игрока без
   блокировки строки «Статус» в карточке нет; у заблокированного бейдж виден; на
   ПК таблица выглядит как раньше. Нет возможности запустить — написать об этом в PR.

## Чего не трогаем

- `ui/kit.tsx`, `DataTable`, раскладку карточки — T-0049.
- Другие колонки: «Платящий» отдаёт «—», «Писать» — «можно»/«нельзя»; у них
  значение есть всегда.
- Другие экраны разделов с таблицами (не входит в эту задачу).
- Тексты бейджей и их цвета.

## Сценарий и интерфейс

Сотрудник открывает «Игроков» в панели:

- **Телефон, игрок без ограничений** — в карточке нет строки «Статус».
- **Телефон, заблокирован или есть ограничения** — строка «Статус» с бейджами.
- **ПК** — таблица, столбец «Статус»: пустая ячейка у игрока без ограничений,
  как раньше.
- Загрузка, пусто, ошибка, нет сети — без изменений.

## Тесты

Первым коммитом. Новый файл `apps/admin/test/player-status.test.ts`,
`describe("бейджи статуса игрока")`. Виды ограничений в `restrictions` брать из
схемы `PlayerListItem` (`api/player-list.ts`; образец записи — константа `ITEM`
в `test/player-list.test.ts`). `kindTitle` в тесте — `(kind) => \`<${kind}>\``.

- без блокировки, `restrictions: []` → `[]`;
- блокировка (`banned: { at: "2026-10-01T00:00:00.000Z", reason: null }`),
  `restrictions: []` → `[{ tone: "danger", text: "заблокирован" }]`;
- без блокировки, два вида ограничений `A` и `B` → один бейдж
  `{ tone: "warning", text: "закрыто: <A>, <B>" }`;
- блокировка и ограничения → два бейджа, первым `danger`;
- `restrictions: ["all"]` без блокировки → `[]` (вид `all` бейджем не рисуется);
- блокировка и `["all"]` → только бейдж «заблокирован».

## Аналитика

Нет — вид ячейки в панели; события не затрагиваются.

## Настройки и окружение

Нет.

## Документы

Нет — поведение ячейки в документах не описано.

## Вопросы к тимлиду

Подтверждено `claude-lead-1` 13.10.2026: задача идёт после T-0049 (`depends_on`):
скрытие пустой пары есть только в карточке из PR #286, без неё правка ничего
не покажет.

## Критерии приёмки

- [ ] `statusBadges` в `list-status.ts`, тесты из раздела «Тесты» зелёные,
  первым коммитом падали.
- [ ] Колонка «Статус» возвращает `null`, когда бейджей нет; состав и тексты
  бейджей прежние.
- [ ] `ui/kit.tsx` не тронут; дифф только в зонах задачи.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(admin): Убрать пустой «Статус» в карточке игрока`
- **Метка:** `release: patch`
- **Для игроков:** нет — панель команды до игрока не доходит, раздела `## Для игроков` в описании PR нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПАНЕЛЬ: БЕЗ ПУСТОГО «СТАТУСА» В КАРТОЧКЕ**

  В списке игроков на телефоне у игрока без блокировки и ограничений больше нет строки «Статус» без значения.

  🛠 **Панель**

  • бейджи статуса вынесены в чистую функцию с тестами
  ```
