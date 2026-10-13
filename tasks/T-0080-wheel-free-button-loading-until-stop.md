---
id: T-0080
title: Колесо — на кнопке бесплатной крутки загрузка идёт до остановки колеса
epic: E6
priority: P3
status: done
owner: claude-9 / haiku-5.5 / low
author: claude-lead2-6
size: S
depends_on: []
zones:
  - packages/app-shell/src/state/wheel-api.ts
  - packages/app-shell/test/wheel-api.test.ts
shared: []
runner: any
executor: haiku-5.5
effort: low
release: patch
design: null
version: v0.8
---

# T-0080. Колесо — на кнопке бесплатной крутки загрузка идёт до остановки колеса

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0080.json)](README.md#значки-статуса)

## Зачем

Игрок жмёт «Крутить бесплатно». Пока сервер думает, на кнопке спиннер, но как
только ответ пришёл и колесо начало вращаться, спиннер исчезает и кнопка
пишет «через N»: игрок видит обратный отсчёт до следующей бесплатной, пока
ещё не знает, что выпало. Раньше спиннер крутился до остановки колеса. Находка
приёмки PR #243 (после T-0006), 11.10. После задачи спиннер на кнопке идёт,
пока крутится колесо этой самой крутки, а «через N» появляется, когда оно
встало.

## Решения

- **Загрузка нужна до конца вращения** — принято по умолчанию (см. «Вопросы»).
  Условие: идёт крутка (`phase !== "idle"`) и это крутка бесплатной
  (`source === "free"`). Подпись под спиннером не видна (`Button` с `loading`
  показывает только спиннер).
- **Сервер по-прежнему сразу отдаёт `free: false`** — это честно, и T-0006 не
  отменяем: после остановки колеса (`phase` стал `idle`) кнопка неактивна с
  «через N», как сейчас.
- **Крутка за рекламу не меняется:** бесплатная неактивна, спиннера на ней нет
  (кейсы T-0006 остаются как есть).
- Правка только в чистой функции `freeSpinButton`: `wheel.tsx` уже берёт
  `loading` и `label` из неё (`screens/meta/wheel.tsx:141`, `:163-165`).

## Как сейчас

`packages/app-shell/src/state/wheel-api.ts:80-86`:

```ts
export function freeSpinButton(view: Pick<WheelView, "free"> | null, phase: WheelPhase, source: "free" | "ad"): FreeSpinButton {
  if (view === null) return { disabled: true, loading: false, label: "free" };
  if (!view.free) return { disabled: true, loading: false, label: "next" };
  if (phase === "idle") return { disabled: false, loading: false, label: "free" };
  return { disabled: true, loading: source === "free", label: "free" };
}
```

Ход бесплатной крутки в `screens/meta/wheel.tsx:101-132`: `setPhase("asking")` →
запрос → `setState({ view: response.data.view })` (теперь `free: false`) →
`setPhase("spinning")` → по окончании перехода колеса `onSpinEnd` ставит
`"idle"`. На шаге «spinning» `view.free` уже ложно, и вторая строка функции
возвращает `loading: false`: спиннер пропадает посреди вращения.

Тесты — `packages/app-shell/test/wheel-api.test.ts:138-163`, описание «кнопка
бесплатной крутки».

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»): добавить кейсы в существующее
   описание. Первый из них падает, пока кода нет.
2. **`wheel-api.ts`, `freeSpinButton`:** заменить тело (сигнатуру и
   `FreeSpinButton` не менять):

   ```ts
   export function freeSpinButton(view: Pick<WheelView, "free"> | null, phase: WheelPhase, source: "free" | "ad"): FreeSpinButton {
     if (view === null) return { disabled: true, loading: false, label: "free" };
     // Своя крутка идёт до остановки колеса: сервер уже списал бесплатную
     // (`free: false`), но «через N» игрок увидит, когда колесо встанет, а не
     // посреди вращения.
     if (phase !== "idle" && source === "free") return { disabled: true, loading: true, label: view.free ? "free" : "next" };
     if (!view.free) return { disabled: true, loading: false, label: "next" };
     if (phase === "idle") return { disabled: false, loading: false, label: "free" };
     return { disabled: true, loading: false, label: "free" };
   }
   ```

3. **Описание над функцией** (комментарий над `freeSpinButton`): добавить
   фразу: «Пока колесо крутится по бесплатной, на кнопке загрузка — до
   остановки, а не до ответа сервера.» Комментарий на русском, про «почему».

## Чего не трогаем

- `screens/meta/wheel.tsx`: кнопка берёт всё из функции. В том числе размер и
  вид кнопки (`ready?.free === false ? "m" : "l"`, `variant`, строки 157-159):
  при ответе сервера большая оранжевая кнопка со спиннером уменьшается и
  становится вторичной — это отдельное поведение, не чиним здесь (см. «Вопросы»).
- Крутку за рекламу, `adSpinState`, `spinForAd`.
- Остальные кейсы T-0006: они остаются зелёными без правок.

## Сценарий и интерфейс

Бесплатная крутка есть сегодня:

- **Покой** — «Крутить бесплатно», активна.
- **Нажали, ждём сервер** — спиннер, неактивна (как сейчас).
- **Колесо вращается** — спиннер, неактивна (новое: раньше тут уже было «через N»).
- **Колесо встало** — «через N» (обратный отсчёт), неактивна.
- **Отказ сервера** — `phase` снова `idle`, кнопка по виду колеса; уведомление
  как сейчас.

## Тесты

Первым коммитом. `packages/app-shell/test/wheel-api.test.ts`, в существующее
`describe("кнопка бесплатной крутки")` добавить:

- `freeSpinButton({ free: false }, "spinning", "free")` →
  `{ disabled: true, loading: true, label: "next" }` (колесо крутится по бесплатной,
  сервер уже списал её);
- `freeSpinButton({ free: false }, "asking", "free")` →
  `{ disabled: true, loading: true, label: "next" }`;
- `freeSpinButton({ free: true }, "spinning", "free")` →
  `{ disabled: true, loading: true, label: "free" }`;
- `freeSpinButton({ free: false }, "idle", "free")` — после остановки →
  `{ disabled: true, loading: false, label: "next" }` (уже есть; не дублировать).

Существующие кейсы не менять.

## Аналитика

Нет — вид кнопки; `wheel_spun` и остальные события не затрагиваются.

## Настройки и окружение

Нет.

## Документы

Нет — поведение кнопки в документах не описано.

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: загрузка до конца вращения (рекомендуемый
  вариант из входящих). Если нужно, чтобы «через N» появлялось сразу, как
  сейчас, задачу закрыть без изменений.
- Подтверждено `claude-lead-1` 13.10.2026: скачок размера и вида кнопки в момент
  ответа сервера (большая `primary` → `m` `secondary`) не чиним. Если мешает —
  отдельная правка `wheel.tsx:157-159` (держать вид по `freeButton`, а не по
  `ready?.free`).

## Критерии приёмки

- [ ] `freeSpinButton` возвращает `loading: true` при `phase !== "idle"` и
  `source === "free"` независимо от `view.free`; тесты из раздела «Тесты»
  зелёные, новый первым коммитом падал.
- [ ] Кейсы T-0006 (крутка за рекламу, покой, нет вида) проходят без правок.
- [ ] Дифф только в двух файлах зон; `wheel.tsx` не тронут.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Держать загрузку на бесплатной крутке до остановки колеса`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- исправлено: на колесе спиннер на кнопке «Крутить бесплатно» идёт, пока колесо крутится, и «через N» появляется после остановки`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КОЛЕСО: ЗАГРУЗКА ДО ОСТАНОВКИ**

  Пока колесо крутится по бесплатной крутке, на кнопке остаётся спиннер; «через N» показывается, когда колесо встало.

  🛠 **Колесо**

  • правило вида кнопки бесплатной крутки дополнено тестами на вращение после ответа сервера
  ```
