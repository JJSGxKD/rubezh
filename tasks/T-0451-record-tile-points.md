---
id: T-0451
title: Плитка «Лучший забег» на главной — очки, время рядом
epic: E11
priority: P1
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - packages/app-shell/src/state/runs-api.ts
  - packages/app-shell/src/screens/home-widget-rules.ts
  - packages/app-shell/src/screens/home-widgets.tsx
  - packages/app-shell/test/home-widgets.test.ts
  - packages/app-shell/test/runs-api.test.ts
shared:
  - packages/app-shell/src/i18n/ru-home.json
runner: any
executor: sonnet-5.5
effort: medium
release: patch
merge: lead
design: null
batch: 4
---

# T-0451. Плитка «Лучший забег» на главной — очки, время рядом

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0451.json)](README.md#значки-статуса)

## Зачем

Рейтинг, лента главной и карточка бота считают по очкам эффективности
(Р212, T-0446, T-0447), а плитка «Лучший забег» на главной крупно пишет
лучшее время. Игрок видит рекорд «12:40» и место на доске, где решают очки.
После задачи плитка говорит очками, а время лучшего забега видно рядом
мелко.

## Решения

- `docs/35-stage4-plan.md`, **Р212**, ответ владельца 12.11.2026:
  - главное число плитки — **очки лучшего забега**;
  - время того же забега — мелко рядом;
  - очков нет (нет связи, профиль не загружен, старый сервер) — плитка
    по времени, как сейчас.
- Источник очков — профиль с сервера (`GET /api/v1/runs/me`, поле
  `best.hard.points`, оно уже есть в ответе: `BestView` в
  `backend/api/src/modules/runs/runs-view.service.ts`). Сервер не меняется.
- Очки последнего забега берутся из ответа на итог (`lastSubmitted.result.score.points`
  в `useRuns`). В память устройства они не пишутся: после перезапуска
  плитка показывает лучший забег без сравнения с последним, и этого
  достаточно.

## Как сейчас

- `packages/app-shell/src/state/runs-api.ts`, строка ~127:
  `bestSchema = z.nullable(z.object({ survivalSec: z.number(), rank: z.number() }))` —
  очки лучшего забега клиент не разбирает, хотя сервер их шлёт.
- `useRuns` (`state/runs.ts`): `profile` — ответ профиля, `loadProfile()`
  вызывается при старте (`index.tsx`); `lastSubmitted` — последний
  отправленный итог, `result.score?.points` — его очки.
- `packages/app-shell/src/screens/home-widget-rules.ts`, `recordFace`
  (строка ~131): состояния `none`, `best`, `gap`, `record`. Сравнивает
  время последнего забега на устройстве (`meta.lastRun`) с лучшим
  (`meta.best`).
- `packages/app-shell/src/screens/home-widgets.tsx`:
  - вызов — строка ~204, `recordFace(meta.best[RATED_DIFFICULTY_ID], …)`;
  - `RecordView` — строки ~580–597: крупно `<Time sec={face.bestSec} />`,
    подпись — `widget.record.fresh`, `widget.record.gap` (время) или
    `lobby.runs`.
- Тексты — `packages/app-shell/src/i18n/ru-home.json`, `widget.record.*`.
- Числа с разрядами — `formatNumber` из `packages/app-shell/src/i18n/index.ts`.

## Шаги по порядку

1. `runs-api.ts`: в `bestSchema` — `points: z.optional(z.nullable(z.number()))`.
   Старый сервер без поля разбирается.
2. `home-widget-rules.ts`: новая функция рядом с `recordFace`:

   ```ts
   export type RecordPointsFace =
     | { state: "best"; points: number; bestSec: number; runs: number }
     | { state: "record"; points: number; bestSec: number }
     | { state: "gap"; points: number; bestSec: number; gapPoints: number };

   /** Плитка по очкам (Р212); `null` — очков нет, плитка остаётся по времени (`recordFace`). */
   export function recordPointsFace(
     best: { points?: number | null; survivalSec: number } | null,
     lastPoints: number | null,
     runs: number,
   ): RecordPointsFace | null;
   ```

   Правила:
   - `best` равен `null` или `best.points` не число — `null`;
   - `lastPoints === null` — `best`;
   - `lastPoints >= best.points` — `record`. Профиль мог не успеть
     обновиться после нового рекорда, поэтому «больше» тоже рекорд, и
     показываются очки последнего забега:
     `points: max(best.points, lastPoints)`;
   - иначе — `gap`, `gapPoints = best.points - lastPoints` (целое, очки
     целые).

   `recordFace` не меняется.
3. `home-widgets.tsx`, случай `"record"`:
   - `const best = useRuns((s) => s.profile?.best[RATED_DIFFICULTY_ID] ?? null)`;
   - `const lastPoints = useRuns((s) => s.lastSubmitted?.result.score?.points ?? null)`;
   - сначала `recordPointsFace(best, lastPoints, meta.runs)`; вернул `null` —
     прежний `recordFace` и прежний `RecordView`.

   Селекторы возвращают примитивы или ссылку из стора, без новых объектов:
   иначе Zustand перерисует главную на каждом обновлении стора.
4. `home-widgets.tsx`, новый вид `RecordPointsView` (или ветка в
   `RecordView`) по тем же правилам `Layout`:
   - крупно — `formatNumber(face.points)`, тем же размером, что сейчас
     время;
   - время лучшего забега — **мелко в той же строке справа** от очков:
     `text-xs`, цвет второстепенного текста, `formatDuration(face.bestSec)`;
   - на плитке (`size === "tile"`) время в строке не помещается (проверять
     снимками с «12 340» и «12:40») — оно уходит в подпись:
     «за 12:40»;
   - подписи:
     - `record` — «в последнем забеге» (`widget.record.fresh`, как сейчас);
     - `gap` — «не хватило 140 очков» (новый ключ `widget.record.gapPoints`);
     - `best` — «7 забегов» (`lobby.runs`, как сейчас).
5. `ru-home.json`:
   - `"widget.record.gapPoints": "не хватило {points} {count, plural, one {очка} few {очков} many {очков} other {очка}}"`,
     где `points` — строка `formatNumber`, `count` — число (по образцу
     соседних ключей с `plural`; если словарь берёт одно имя для числа и
     формы — использовать его способ);
   - `"widget.record.at": "за {time}"`.
   Других ключей `widget.record.*` не менять.

## Чего не трогаем

- Сервер: профиль уже отдаёт очки.
- `meta.ts`, `meta.best`, `meta.lastRun` и их схему в памяти устройства.
- Ленту главной и карточку бота — T-0447. Недельный сезон — T-0446.
- Порядок и размеры виджетов (`arrangeWidgets`).
- Куда ведёт нажатие на плитку: как сейчас, в «Рейтинг».

## Сценарий и интерфейс

- Профиль загружен, лучший забег 2 340 очков за 12:40, после запуска забегов
  не было: крупно «2 340», справа мелко «12:40», подпись «7 забегов».
- Только что сыгран забег на 2 200 очков: подпись «не хватило 140 очков».
- Только что поставлен рекорд 2 500: крупно «2 500», подпись «в последнем
  забеге».
- Нет связи или профиль не пришёл: всё как сейчас, по времени.
- Новичок без забегов: «—», «Первый забег ещё впереди», как сейчас.

## Тесты

Первым коммитом:

- `packages/app-shell/test/home-widgets.test.ts`, `recordPointsFace`:
  - `best === null` и `best.points` равен `null` или не задан → `null`;
  - нет последнего забега → `best` с очками, временем и числом забегов;
  - последний забег меньше лучшего → `gap` с разницей;
  - последний равен лучшему → `record`;
  - последний больше лучшего (профиль устарел) → `record` с очками
    последнего;
  - `recordFace` — прежние кейсы не меняются.
- `packages/app-shell/test/home-widgets.test.ts`, вид (как `TasksView` и
  `WheelView` в том же файле): плитка и широкий виджет по очкам — в разметке
  есть «2 340» и «12:40»; `gap` — «не хватило 140 очков»; при `null` —
  прежняя разметка со временем.
- `packages/app-shell/test/runs-api.test.ts` (новый файл; разбор профиля
  сейчас тестами не покрыт): `createRunsApi` с подменённым `request` (аргумент функции) — ответ
  профиля с `best.hard.points` и без поля разбирается, `points` у второго —
  `undefined`.
- Снимки экрана главной на 320, 390 и 768 px: плитка и широкий виджет с
  «12 340» и «12:40» — ничего не обрезается и не переносится.

## Аналитика

Нет: виджет ничего не отправляет сверх того, что уже отправляет главная.

## Настройки и окружение

Нет.

## Документы

- Гайдбук и подсказки плитку не описывают — проверить `guide.*` поиском по
  «Лучший забег»; нашлось — поправить на очки.

## Критерии приёмки

- [ ] С загруженным профилем плитка показывает очки лучшего забега крупно и
      его время рядом (на плитке — подписью).
- [ ] После забега подпись говорит «в последнем забеге» или «не хватило N
      очков» по очкам этого забега.
- [ ] Без очков в профиле плитка такая же, как до задачи.
- [ ] Главная не перерисовывается чаще, чем до задачи (селекторы без новых
      объектов).
- [ ] Тесты из раздела «Тесты» есть и зелёные; снимки 320, 390, 768 px
      приложены к PR.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Лучший забег на главной — по очкам`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено: плитка «Лучший забег» на главной показывает очки, как рейтинг, а время — рядом`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЛУЧШИЙ ЗАБЕГ НА ГЛАВНОЙ ПО ОЧКАМ**

  Плитка «Лучший забег» говорит той же мерой, что рейтинг: крупно очки
  лучшего забега, время рядом (Р212, ответ владельца 12.11.2026).

  🛠 **Что сделано**

  • очки лучшего забега — из профиля, который сервер уже отдаёт
  • «не хватило N очков» и «в последнем забеге» — по очкам последнего забега
  • без очков (нет связи, старый сервер) плитка по времени, как раньше
  ```
