---
id: T-0006
title: Кнопка бесплатной крутки не оживает во время крутки за рекламу
epic: E6
priority: P1
status: done
owner: claude-3 / sonnet-5.5
size: S
depends_on: []
zones:
  - packages/app-shell/src/screens/meta/wheel.tsx
  - packages/app-shell/src/state/wheel-api.ts
  - packages/app-shell/test/wheel-api.test.ts
shared: []
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
---

# T-0006. Кнопка бесплатной крутки не оживает во время крутки за рекламу

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0006.json)](README.md#значки-статуса)

## Зачем

Бесплатная крутка на сегодня потрачена, игрок крутит колесо за рекламу. Пока
идёт показ ролика и вращение, кнопка бесплатной крутки снова становится
активной с подписью «Крутить бесплатно», хотя должна по-прежнему показывать
«через N». После вращения она возвращается в прежнее состояние. Игрок видит
ложное обещание, а нажатие ничего не даёт: проверка в `spin()` его отсекает.

## Решения

- Состояние кнопки бесплатной крутки зависит от того, есть ли она сегодня
  (`view.free`), и от того, идёт ли крутка вообще. **От того, какая крутка
  идёт, оно не зависит.**
- Логика выносится в чистую функцию рядом с `adSpinState` в `state/wheel-api.ts`
  и покрывается тестом. Экран только рисует результат.

## Как сейчас

`packages/app-shell/src/screens/meta/wheel.tsx`, кнопка бесплатной крутки
(около строк 155–165):

```tsx
disabled={ready === null || (!ready.free && phase === "idle")}
loading={phase !== "idle" && source === "free"}
…
{ready !== null && !ready.free && phase === "idle" ? t("wheel.spin.next", { time: … }) : t("wheel.spin.free")}
```

При крутке за рекламу `phase` становится `"asking"`, затем `"spinning"`.
Условие `phase === "idle"` ложно, поэтому кнопка разблокируется и подпись
меняется на «бесплатно». Тип `Phase` — в том же файле (строка 68).

## Шаги по порядку

1. **Тест — первым коммитом** (раздел «Тесты»).
2. `state/wheel-api.ts` — экспортировать:

   ```ts
   export type WheelPhase = "idle" | "asking" | "spinning";
   export interface FreeSpinButton { disabled: boolean; loading: boolean; label: "free" | "next" }
   export function freeSpinButton(view: Pick<WheelView, "free"> | null, phase: WheelPhase, source: "free" | "ad"): FreeSpinButton
   ```

   Правила:
   - `view === null` → `{ disabled: true, loading: false, label: "free" }`;
   - `!view.free` → `{ disabled: true, loading: false, label: "next" }` при любой
     фазе и любом источнике;
   - `view.free` и `phase === "idle"` → `{ disabled: false, loading: false, label: "free" }`;
   - `view.free` и `phase !== "idle"` → `disabled: true`,
     `loading: source === "free"`, `label: "free"`.
3. `screens/meta/wheel.tsx`:
   - тип `Phase` заменить на `WheelPhase` из `wheel-api`;
   - кнопка берёт `disabled`, `loading` и подпись из `freeSpinButton(ready, phase, source)`;
   - подпись `"next"` → `t("wheel.spin.next", { time: formatCountdown(msUntilReset(now, "daily")) })`,
     `"free"` → `t("wheel.spin.free")`;
   - вид кнопки (`size`, `variant`, `glow`) не меняется.
4. Гейт. Проверить в браузере (режим разработчика на `localhost`):
   - бесплатная крутка потрачена, крутка за рекламу → бесплатная кнопка всё
     время показывает «через N» и неактивна.

## Чего не трогаем

- Кнопку крутки за рекламу и `adSpinState`.
- Тексты словаря колеса.

## Тесты

`packages/app-shell/test/wheel-api.test.ts`, новый `describe("кнопка бесплатной крутки")`:

- бесплатной нет, фаза `"asking"`, источник `"ad"` → неактивна, подпись `"next"`, без загрузки. **Это и есть ошибка**;
- бесплатной нет, фаза `"spinning"`, источник `"ad"` → то же;
- бесплатной нет, фаза `"idle"` → неактивна, `"next"`;
- бесплатная есть, `"idle"` → активна, `"free"`;
- бесплатная есть, `"asking"`, источник `"free"` → неактивна, загрузка;
- бесплатная есть, `"spinning"`, источник `"ad"` → неактивна, без загрузки;
- `view === null` → неактивна.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Нет.

## Критерии приёмки

- [ ] Во время крутки за рекламу кнопка бесплатной крутки неактивна и показывает «через N».
- [ ] Логика кнопки — в `freeSpinButton`, тест покрывает все сочетания из раздела «Тесты».
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Бесплатная крутка не оживает во время рекламной`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено: Во время крутки за рекламу кнопка бесплатной крутки больше не становится активной.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КНОПКА БЕСПЛАТНОЙ КРУТКИ НЕ ОЖИВАЕТ ВО ВРЕМЯ КРУТКИ ЗА РЕКЛАМУ**

  Пока шла крутка за рекламу, кнопка бесплатной крутки ложно становилась активной. Логика кнопки вынесена в функцию с тестом.
  ```
