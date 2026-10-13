---
id: T-0079
title: Второй шанс — ролик главной кнопкой, звёзды второй, как в макете
epic: E12
priority: P2
status: ready
owner:
author: claude-lead2-6
size: S
depends_on: []
zones:
  - packages/app-shell/src/screens/run/AdContinue.tsx
  - packages/app-shell/src/screens/run/ad-continue-look.ts
  - packages/app-shell/test/ad-continue-look.test.ts
shared:
  - docs/27-design-system-and-app-shell.md
runner: any
executor: haiku-5.5
effort: medium
release: patch
design: design/screens/death.html
version: v0.8
---

# T-0079. Второй шанс — ролик главной кнопкой, звёзды второй, как в макете

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0079.json)](README.md#значки-статуса)

## Зачем

В макете шага 1 экрана смерти блок «Второй шанс» держит одну главную кнопку:
оранжевую «Реклама»; звёзды стоят рядом второй кнопкой. В игре обе кнопки
вторичные, и блок, который должен быть главным на экране, не показывает, чем
продолжить в первую очередь. Находка приёмки PR #254 (T-0045), 11.10. После
задачи кнопка ролика (и «Продолжить с VIP») оранжевая и главная.

## Решения

- **Кнопка ролика — `variant="primary"` в любой стадии**, в том числе у VIP
  («Продолжить с VIP», корона). Макет: `design/screens/death.html`, класс
  `.cbtn.ad` (строка 74) и подпись к кадру «ролик — главной кнопкой, звёзды —
  второй» (строка 244). Золотой градиент VIP из макета (`.cbtn.vip`) — это новый
  вид кнопки, которого в дизайн-системе нет; его здесь не делаем.
- **Звёзды остаются как есть** (`PaidContinue.tsx`: вид `stars`, цвет Stars,
  у недоступной — `secondary`). В макете это `.cbtn.stars`: вторая кнопка.
- **Проп `primary` не вводим.** `AdContinue` и `AdContinueView` рисуются только
  внутри `SecondChance` (витрина компонентов тоже идёт через `SecondChance`),
  и везде кнопке ролика положено быть главной. Без пропа `SecondChance.tsx` не
  меняется: его правит T-0078 (PR #296), пересечения зон нет, `depends_on` не
  нужен.
- **Логику вида кнопки выносим в чистую функцию** (DOM-тестов у оболочки нет):
  её проверяет тест, экран только рисует результат.

## Как сейчас

- `packages/app-shell/src/screens/run/AdContinue.tsx:34-64` — `AdContinueView`:
  кнопка рисуется `<Button block variant="secondary" loading={…} disabled={…}
  ariaLabel={…}>`; `loading` — стадии `checking` и `watching`; `disabled` — не
  `ready` или `locked` (идёт покупка звёзд); подпись и `ariaLabel` выбираются по
  `pass` (VIP) и `wide` (кнопка одна — полная подпись, рядом со звёздами —
  короткая «Реклама»). Строка состояния под кнопками (`lineOf`) не относится к
  задаче.
- `packages/app-shell/src/state/ad-continue.ts:57-62` — `AdContinueStage`:
  `idle` · `checking` · `ready { pass, notice }` · `watching { pass }` ·
  `unavailable { reason }`. Образцы стадий — `AD_STAGES` в
  `screens/gallery.tsx:414`.
- Ключи текстов (уже есть, новых нет): `run.continue.ad`,
  `run.continue.ad.short`, `run.continue.vip`, `run.continue.vip.wide`,
  `run.continue.vip.short`.
- `packages/app-shell/src/screens/run/PaidContinue.tsx:42-53` — кнопка звёзд
  (не трогаем). Её комментарий «основное действие экрана смерти — «Ещё раз»»
  устарел после двух шагов экрана (T-0045); правка комментария — вне этой
  задачи, см. «Вопросы».

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»): новый файл
   `packages/app-shell/test/ad-continue-look.test.ts`. Они падают, пока нет
   модуля.
2. **Новый `packages/app-shell/src/screens/run/ad-continue-look.ts`:**

   ```ts
   import type { AdContinueStage } from "../../state/ad-continue";

   /** Вид кнопки второго шанса за рекламу в данной стадии. */
   export interface AdButtonLook {
     /** Ролик — главное действие блока «Второй шанс» (макет, `.cbtn.ad`). */
     variant: "primary";
     loading: boolean;
     disabled: boolean;
     /** VIP-пропуск: ролика нет, на кнопке корона. */
     pass: boolean;
     /** Подпись на кнопке: короткая рядом со звёздами, полная — когда кнопка одна. */
     labelKey: string;
     /** Подпись для скринридера: всегда полная. */
     ariaKey: string;
   }

   /** `null` — кнопки нет: за рекламу продолжить нельзя (отказ показывает строка под кнопками). */
   export function adButtonLook(stage: AdContinueStage, options: { locked: boolean; wide: boolean }): AdButtonLook | null {
     if (stage.kind === "unavailable") return null;
     const pass = (stage.kind === "ready" || stage.kind === "watching") && stage.pass;
     return {
       variant: "primary",
       loading: stage.kind === "checking" || stage.kind === "watching",
       disabled: stage.kind !== "ready" || options.locked,
       pass,
       labelKey: pass ? (options.wide ? "run.continue.vip.wide" : "run.continue.vip.short") : options.wide ? "run.continue.ad" : "run.continue.ad.short",
       ariaKey: pass ? "run.continue.vip" : "run.continue.ad",
     };
   }
   ```

3. **`AdContinue.tsx`, `AdContinueView`:** убрать вычисление `pass` и вложенные
   условия в кнопке, взять вид из функции. Импорт
   `import { adButtonLook } from "./ad-continue-look";`. Тело вместо строк
   35-55:

   ```tsx
   const { stage } = props;
   const look = adButtonLook(stage, { locked: props.locked, wide: props.wide });
   const line = lineOf(stage);

   return (
     <>
       {look === null ? null : (
         <Button block variant={look.variant} loading={look.loading} disabled={look.disabled} ariaLabel={t(look.ariaKey)} onClick={props.onWatch}>
           {look.pass ? <Crown size={18} aria-hidden="true" /> : <Tv size={18} aria-hidden="true" />}
           {/* Рядом с кнопкой звёзд — коротко: колонка экрана смерти узкая, и
               «За рекламу» переносилась на две строки. Одна — целиком. */}
           {t(look.labelKey)}
         </Button>
       )}
       {/* строка состояния — как была, без изменений */}
     </>
   );
   ```

   Блок со строкой состояния (`line === null ? null : <p …>`) оставить как есть,
   вместе с его комментарием. Импорты `Crown`, `Tv`, `Button` остаются.
4. **`docs/27-design-system-and-app-shell.md`:** в строке, начинающейся
   `| Забег | Смерть | рабочий |`, в конец описания шага 1 (перед закрывающей
   `|` ячейки) дописать: «В блоке «Второй шанс» ролик — главная оранжевая
   кнопка, звёзды — вторая (макет `design/screens/death.html`).»
5. **Глазами:** в витрине компонентов (`screens/gallery.tsx`, блок «Второй
   шанс») кнопка «Реклама» оранжевая, «звёзды» рядом вторичная; у VIP одна
   оранжевая кнопка с короной; во время ролика и проверки на кнопке спиннер.
   Если запустить оболочку нельзя — написать об этом в PR.

## Чего не трогаем

- `SecondChance.tsx`, `death-parts.tsx`, событие `continue_offered` — T-0078.
- `PaidContinue.tsx` (вид, цвет и комментарий кнопки звёзд).
- `ad-continue.ts` (стор и стадии), тексты `i18n/*`.
- Золотую кнопку VIP из макета и «Закончить забег» — другие задачи.

## Сценарий и интерфейс

Игрок на шаге 1 экрана смерти (макет `design/screens/death.html`, кадры 1-3):

- **Проверка рекламы** — оранжевая кнопка со спиннером, неактивна; звёзды рядом.
- **Ролик доступен** — оранжевая «Реклама» слева, звёзды справа вторичной.
- **Идёт покупка звёзд** — «Реклама» оранжевая, но приглушена (неактивна).
- **Идёт ролик** — спиннер на оранжевой, звёзды приглушены.
- **VIP** — одна оранжевая «Продолжить с VIP» с короной.
- **Рекламы нет** (лимит, ограничение, нет показа) — кнопки нет, строка причины
  под блоком, как сейчас.
- **Нет сети, ошибка ролика** — строки `run.continue.ad.notice.*`, без изменений.

## Тесты

Первым коммитом. Новый файл `packages/app-shell/test/ad-continue-look.test.ts`,
один `describe("вид кнопки второго шанса за рекламу")`. Образцы стадий — из
`AD_STAGES` и `AD_READY` в `gallery.tsx`; `adButtonLook(stage, { locked, wide })`.

- `unavailable` с причиной `daily_cap` → `null` (кнопки нет);
- `idle` → `variant: "primary"`, `loading: false`, `disabled: true`;
- `checking` → `loading: true`, `disabled: true`;
- `ready`, не VIP, `locked: false`, `wide: false` → `variant: "primary"`,
  `loading: false`, `disabled: false`, `pass: false`, `labelKey:
  "run.continue.ad.short"`, `ariaKey: "run.continue.ad"`;
- то же, `wide: true` → `labelKey: "run.continue.ad"`;
- `ready`, `locked: true` (идёт покупка звёзд) → `disabled: true`, `loading: false`;
- `ready` с `notice: "closed"` → `disabled: false` (можно попробовать снова);
- `ready` с VIP, `wide: false` → `pass: true`, `labelKey:
  "run.continue.vip.short"`, `ariaKey: "run.continue.vip"`; `wide: true` →
  `labelKey: "run.continue.vip.wide"`;
- `watching` без VIP и с VIP → `loading: true`, `disabled: true`, `pass`
  по стадии;
- сводный: для каждой стадии, кроме `unavailable`, `variant` равен `"primary"`.

## Аналитика

Нет — меняется только вид кнопки; события второго шанса (`continue_offered` и
остальные) не затрагиваются.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md` — строка «Забег | Смерть» (шаг 4).

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: проп `primary` у `AdContinue` не вводим
  (во входящих он предлагался): кнопка ролика всегда главная, `SecondChance.tsx`
  не меняется, пересечения с T-0078 нет. Нужен «неглавный» вид — тогда проп и
  правка `SecondChance.tsx` после T-0078.
- Подтверждено `claude-lead-1` 13.10.2026: у VIP кнопка тоже оранжевая `primary`;
  золотая по макету — отдельная задача на новый вид кнопки.
- Для тимлидов: комментарий в `PaidContinue.tsx:42-45` («основное действие —
  «Ещё раз»») после T-0045 неверен для шага 1; поправить при случае.

## Критерии приёмки

- [ ] `adButtonLook` в `ad-continue-look.ts`, тест из раздела «Тесты» зелёный;
  первым коммитом падал.
- [ ] `AdContinueView` берёт вид кнопки из функции; `variant` — `primary` во всех
  стадиях, где кнопка есть; логика `loading`/`disabled`/подписей прежняя.
- [ ] Дифф только в зонах задачи и в одной строке `docs/27`; `SecondChance.tsx` не тронут.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Сделать ролик главной кнопкой второго шанса`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- исправлено: на экране смерти в блоке «Второй шанс» главная оранжевая кнопка — «Реклама», звёзды рядом второй`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ВТОРОЙ ШАНС»: РОЛИК ГЛАВНОЙ КНОПКОЙ**

  На шаге 1 экрана смерти кнопка ролика стала главной оранжевой, как в макете; кнопка звёзд осталась второй.

  🛠 **Экран смерти**

  • вид кнопки ролика вынесен в чистую функцию с тестами на все стадии проверки, ролика и VIP
  ```
