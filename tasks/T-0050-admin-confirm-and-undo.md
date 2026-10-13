---
id: T-0050
title: Подтверждения в панели по цене ошибки — окно действия и «Отменить»
epic: E7
priority: P2
status: ready
owner:
size: S
depends_on: [T-0049]
zones:
  - apps/admin/src/ui/confirm-dialog.tsx
  - apps/admin/src/ui/toast.tsx
  - apps/admin/test/confirm-dialog.test.ts
shared:
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/screens/admin-shell.html
batch: 2
---

# T-0050. Подтверждения в панели по цене ошибки — окно действия и «Отменить»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0050.json)](README.md#значки-статуса) [![T-0049](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0049.json&label=T-0049)](T-0049-admin-shell-responsive.md)

## Зачем

Сейчас подтверждения в панели вперемешку:

- ручная операция с кошельком и сообщение игроку — вторым нажатием той же
  кнопки;
- снятие рекорда и ограничения — окном с причиной;
- остальное — сразу.

Человек не знает заранее, спросит ли панель ещё раз. Решение пользователя от
07.10.2026 — подтверждения по цене ошибки (`docs/29-admin-panel.md` §4).
Задача делает два общих компонента. Перевод экранов на них — в задачах этих
экранов, начиная с карточки игрока (T-0054).

## Решения

- **Окно действия — деньги, необратимое, видимое игрокам и роли команды:**
  - заголовок вопросом («Вернуть звёзды?»);
  - строка объекта («Стартовый набор · 50 ⭐ · Алина»);
  - «что изменится» — таблицей пар;
  - поле причины, если действие её требует;
  - кнопка называет действие («Вернуть 50 ⭐»); у опасного — тон опасности;
  - «Отмена» рядом.
- **Сразу с «Отменить» — обратимое внутри команды:** черновики, порядок,
  заметки.
  - Действие выполняется сразу.
  - Уведомление 8 секунд: что сделано и кнопка «Отменить».
  - «Отменить» — обратная операция, её передаёт вызывающий. Запрос не
    задерживается: задержка обманула бы, если вкладку закроют.

## Как сейчас

- `apps/admin/src/ui/dialog.tsx` — `Dialog` (после T-0049 на телефоне — лист
  снизу).
- `apps/admin/src/ui/toast.tsx` — реэкспорт `toast` из `sonner` и `Toaster`.
- Образец окна с причиной — `RankDialog` в
  `screens/players/RatingRunsPanel.tsx`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Новый `ui/confirm-dialog.tsx`:**

   ```tsx
   export interface ConfirmChange { label: string; value: ReactNode }

   export function ConfirmDialog(props: {
     open: boolean;
     onOpenChange: (open: boolean) => void;
     title: string;
     /** чего касается: «Стартовый набор · 50 ⭐ · Алина» */
     subject?: string;
     changes?: readonly ConfirmChange[];
     /** поля самого действия над «что изменится»: ресурс и сумма у кошелька */
     children?: ReactNode;
     /** пока не `null` — поля не годны: кнопка недоступна, текст — под полями */
     problem?: string | null;
     /** нужна причина: пределы, подпись, подсказка под полем */
     reason?: { min: number; max: number; label?: string; hint?: string };
     /** текст главной кнопки — само действие */
     action: string;
     tone?: "primary" | "danger";
     /** выполнить; бросать не должно: ошибку — строкой в `error` */
     onConfirm: (reason: string) => Promise<{ ok: true } | { ok: false; error: string }>;
   }): ReactNode;
   ```

   - на `Dialog`, `description = subject`;
   - порядок сверху вниз: `children`, `problem` (`text-xs text-text-muted`),
     «что изменится», причина, ошибка, кнопки;
   - «что изменится» — сетка пар `label` / `value` на подложке ниже
     поверхности;
   - причина — `TextArea` с подписью (умолчание «Причина»), счётчиком
     `n / max` и подсказкой;
   - главная кнопка недоступна, пока `confirmReady(...)` ложно (раздел
     «Тесты»);
   - ошибка от `onConfirm` — `Notice` над кнопками, окно остаётся;
   - успех — окно закрывается, причина очищается.
3. **`ui/toast.tsx`:**

   ```ts
   /** Обратимое действие сделано: уведомление на 8 с с «Отменить»; отмена — обратная операция вызывающего. */
   export function toastWithUndo(text: string, undo: () => Promise<void>): void;
   ```

   - `toast.success(text, { duration: 8000, action: { label: "Отменить", onClick } })`;
   - при отмене — `undo()`; успех — `toast("Отменено")`, ошибка —
     `toast.error("Не удалось отменить — сделайте обратное вручную")`.
4. **Документы** — раздел «Документы».

## Чего не трогаем

- Экраны: перевод на компоненты — в задачах экранов (T-0054 и следующие).
- `Dialog` — им пользуются и формы.

## Тесты

Первым коммитом, `apps/admin/test/confirm-dialog.test.ts` — чистая функция
доступности кнопки, вынесенная из компонента:

```ts
export function confirmReady(reason: string, rule: { min: number; max: number } | undefined, pending: boolean, problem: string | null = null): boolean;
```

- без правила — `true`, пока не `pending`;
- `problem` не `null` → `false` при любой причине;
- `"  ок "` при `min 3` → `false`;
- `"дубль"` → `true`;
- длиннее `max` → `false`;
- `pending` → `false`.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` §4, «Подтверждения» — компоненты:
  - `ConfirmDialog` — окно действия;
  - `toastWithUndo` — «Отменить».

  И правило, какой из них брать.

## Критерии приёмки

- [ ] `ConfirmDialog`:
  - показывает объект, «что изменится» и причину по правилу;
  - кнопка называет действие;
  - ошибка остаётся в окне.
- [ ] `toastWithUndo` — уведомление 8 секунд с «Отменить», отмена зовёт
  обратную операцию.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Окно подтверждения действия и «Отменить»`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОДТВЕРЖДЕНИЯ ПО ЦЕНЕ ОШИБКИ**

  В панели появились два общих способа подтверждать действия. Деньги, необратимое и то, что увидят игроки, — окном, где видно, что изменится, с причиной. Обратимое — сразу, с «Отменить» на 8 секунд. Экраны переходят на них по одному, первой — карточка игрока.
  ```
