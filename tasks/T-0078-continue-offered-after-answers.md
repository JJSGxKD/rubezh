---
id: T-0078
title: Событие continue_offered уходит после ответа проверок, а не при открытии шага
epic: E6
priority: P1
status: in-progress
owner: claude-3 / sonnet-5.5 / medium
author: claude-lead2-5
size: S
depends_on: []
zones:
  - packages/app-shell/src/screens/run/SecondChance.tsx
  - packages/app-shell/src/screens/run/death-parts.tsx
  - packages/app-shell/test/death-rules.test.ts
shared:
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
version: v0.8
---

# T-0078. Событие continue_offered уходит после ответа проверок, а не при открытии шага

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0078.json)](README.md#значки-статуса)

## Зачем

Событие `continue_offered` («игроку предложили второй шанс») задумано
знаменателем для `continue_used`: какая доля тех, кому предложили, взяла
второй шанс. Сейчас оно уходит в первый кадр шага, когда сервер ещё не ответил
ни про ролик, ни про звёзды. Флаги в нём — догадка: `vip` всегда ложен, `ad` и
`stars` почти всегда истинны. Приёмка PR #254 (T-0045), 13.10. Данные, не
записанные сегодня, задним числом не восстановить, поэтому задача P1. После неё
событие уходит один раз, когда обе проверки ответили, с настоящими флагами.

## Решения

- **Слать один раз, когда ответили обе проверки способов:** ролик
  (`state/ad-continue.ts`) и звёзды (`state/continue-purchase.ts`). Нет одной из
  проверок вовсе (способа на площадке нет) — ждать нечего.
- **Своего таймаута у события нет, и он не нужен.** Проверки заканчиваются
  сами: каждый их запрос ограничен по времени (`state/session.ts:201`, срок
  `AUTH_TIMEOUT_MS` = 8 с, `state/auth-api.ts:92`), а отказ или обрыв переводит
  состояние в `unavailable` (`ad-continue.ts:125`) или в `retry` / `unavailable`
  (`continue-purchase.ts:93`). Вечно «спрашивает» ни одна не остаётся.
- **Закончил забег раньше ответа — события нет.** Пока проверки спрашивают
  сервер, кнопки крутят «загрузку»: взять второй шанс игрок ещё не может, значит
  и «предложено» ещё нет.
- **Ничего предложить нельзя — события нет.** Если по ответам отпали все способы
  (ролик `unavailable` и звёзды `unavailable`) или их нет вовсе (площадка без
  оплаты и рекламы; шаг тогда держит только бесплатное продолжение забега
  разработчика), платного и рекламного предложения у игрока нет, а забег
  закрывается смертью (`state/second-chance-offers.ts`). Так же сказано в
  `docs/22` §3.3 («забег без способов шага не имеет»).
- **Флаги считает прежнее правило `visibleWays`** (`SecondChance.tsx:40`), его не
  меняем. Правится только момент, в который его читают.
- **Состав события не меняется:** `{ ad, stars, vip, elapsedSec }`, версия в
  словаре та же (`event-dictionary.ts:136`), бэкенд не трогаем.
- **Старые записи не чинятся:** в `docs/22` рядом с событием остаётся пометка,
  что по флагам записей до этой правки способы считать нельзя.

## Как сейчас

- `packages/app-shell/src/screens/run/death-parts.tsx`:
  - строка 16 — `import { SecondChance, useSecondChanceStages, visibleWays, type SecondChanceProps } from "./SecondChance"`;
  - строки 44-57 — `ChanceStep`: `stages = useSecondChanceStages(secondChance)`,
    `shown = useRef(false)` и эффект, который при монтировании читает
    `visibleWays(stages)` и шлёт

    ```ts
    track("continue_offered", { ad: ways.ad, stars: ways.stars, vip: ways.vip, elapsedSec: Math.round(result.survivalSec) });
    ```

  - первый кадр шага: ролик и звёзды в `idle`, `visibleWays` даёт `ad: true`,
    `stars: true`, `vip: false`. Запросы стартуют позже — эффектами `prepare`
    в `AdContinue.tsx:18-20` и `PaidContinue.tsx:20-22`.
- `packages/app-shell/src/screens/run/SecondChance.tsx`: строки 40-46 —
  `visibleWays({ adStage, paidStage })` (`vip` — ролик `ready` / `watching` с
  `pass`; `ad` — ролик не `unavailable` и не VIP; `stars` — есть состояние
  звёзд, не VIP, и не «звёзды недоступны, а ролик есть»); строки 52-59 —
  `useSecondChanceStages(props)`, у отсутствующего способа `null`.
- Состояния проверок:
  - ролик (`AdContinueStage`, `ad-continue.ts:57`): `idle` · `checking` · `ready` ·
    `watching` · `unavailable`. «Ещё спрашивает» — `idle` и `checking`;
  - звёзды (`ContinueStage`, `continue-purchase.ts:34`): `idle` · `loading` ·
    `ready` · `buying` · `confirming` · `retry` · `unavailable`. «Ещё спрашивает» —
    `idle` и `loading`.
- `packages/app-shell/test/death-rules.test.ts:81-102` — кейсы `visibleWays`; там
  же константа `OFFER` (строка 8).
- `docs/22-analytics-and-metrics.md:204` — строка `continue_offered`;
  `docs/27-design-system-and-app-shell.md:1238` — строка «Забег · Смерть».

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»). Они падают, пока кода нет.
2. **`SecondChance.tsx`, сразу после `visibleWays` (после строки 46):**

   ```ts
   /**
    * Ответили ли проверки способов. Пока ролик (`idle`, `checking`) или звёзды
    * (`idle`, `loading`) спрашивают сервер, флаги `visibleWays` — догадка: ролик
    * «есть», VIP «нет». Способа нет вовсе (`null`) — спрашивать нечего, это тоже ответ.
    */
   export function waysAnswered(input: { adStage: AdContinueStage | null; paidStage: ContinueStage | null }): boolean {
     const { adStage, paidStage } = input;
     const adAsking = adStage !== null && (adStage.kind === "idle" || adStage.kind === "checking");
     const paidAsking = paidStage !== null && (paidStage.kind === "idle" || paidStage.kind === "loading");
     return !adAsking && !paidAsking;
   }

   /** Тело события `continue_offered`. `null` — слать нечего: ответов ещё нет или предложить нечего. */
   export function continueOfferedPayload(
     input: { adStage: AdContinueStage | null; paidStage: ContinueStage | null },
     survivalSec: number,
   ): { ad: boolean; stars: boolean; vip: boolean; elapsedSec: number } | null {
     if (!waysAnswered(input)) return null;
     // Все существующие способы отпали (или их нет): шага у игрока нет, предлагать было нечего.
     const adGone = input.adStage === null || input.adStage.kind === "unavailable";
     const paidGone = input.paidStage === null || input.paidStage.kind === "unavailable";
     if (adGone && paidGone) return null;
     return { ...visibleWays(input), elapsedSec: Math.round(survivalSec) };
   }
   ```

3. **`death-parts.tsx`, `ChanceStep` (строки 46-57):** заменить `shown` и эффект на

   ```tsx
   const stages = useSecondChanceStages(secondChance);
   const sent = useRef(false);
   // Пока проверки спрашивают сервер, флаги были бы догадкой, поэтому до ответа `null`.
   const offered = continueOfferedPayload(stages, result.survivalSec);

   // Шаг предложил способы — один раз: по этому событию считается доля взявших
   // второй шанс. Объект `offered` новый на каждом рендере, повтор отсекает
   // `sent`: ни перемены способов потом (ролик ушёл, звёзды отпали), ни повторный
   // монтаж в режиме разработки второй раз не пишут.
   useEffect(() => {
     if (sent.current || offered === null) return;
     sent.current = true;
     track("continue_offered", offered);
   }, [offered]);
   ```

   В импорте (строка 16) убрать `visibleWays` (в файле он больше не нужен) и
   добавить `continueOfferedPayload`. Остальной файл не менять.
4. **`docs/22-analytics-and-metrics.md`, строка `continue_offered` (204):** заменить
   целиком на

   ```
   | `continue_offered` | Шаг второго шанса на экране смерти показан (tasks/T-0045, tasks/T-0078): сколько раз предложили и чем. Знаменатель для `continue_used`: без него не посчитать, какая доля тех, кому предложили, взяла второй шанс. Событие — один раз на показ шага и только после ответа проверок: пока ролик и звёзды спрашивают сервер, предлагать нечего, и игрок, закончивший забег раньше ответа, в знаменатель не попадает. Сданный забег, забег без способов и случай, когда по ответам все способы отпали, шага не имеют и события не шлют. **Записи сборок до этой правки слались при открытии шага, до ответа:** `vip` в них всегда ложен, `ad` и `stars` почти всегда истинны — по флагам таких записей способы не считать | `ad` — показан ролик, `stars` — показаны звёзды, `vip` — одна кнопка VIP (с ним `ad` и `stars` ложны); флаги — по ответам проверок; `elapsedSec` — секунда забега |
   ```

5. **`docs/27-design-system-and-app-shell.md`, строка «Забег · Смерть» (1238):**
   фразу «показ пишет событие `continue_offered`» заменить на «когда проверки
   способов ответили, пишется событие `continue_offered`». Остальное в строке не трогать.
6. Гейт: `pnpm typecheck` из корня (только он проверяет тесты), `pnpm lint`,
   `pnpm test`, `pnpm build`, `pnpm budget`, `pnpm docs:check`.

## Чего не трогаем

- `AdContinue.tsx`, `PaidContinue.tsx`, `ad-continue.ts`, `continue-purchase.ts`:
  запросы, эффекты `prepare` и состояния остаются как есть, правится только
  момент отправки события.
- `visibleWays` и его кейсы в `death-rules.test.ts`: правила флагов прежние
  (в том числе кейс «ролика нет и звёзд нет» из строки 98).
- `event-dictionary.ts`, `state/analytics.ts`: состав и версия события прежние.
- Остальные события экрана смерти и вид шага; `tasks/T-0045-…` (выполнена).

## Сценарий и интерфейс

Нет — игрок ничего нового не видит. Меняется только момент записи события.

## Тесты

Первым коммитом, `packages/app-shell/test/death-rules.test.ts`. Эффект
`ChanceStep` в среде тестов (`node`) не отрисовать, поэтому правило вынесено в
две чистые функции, и проверяются они. Рядом с `OFFER` завести образцы
состояний: ролик `ready` без VIP, ролик `ready` с VIP, ролик `unavailable`
(причина `no_fill`), звёзды `ready` (`{ kind: "ready", offer: OFFER }`), звёзды
`unavailable` (причина `used_up`).

`describe("ответили ли проверки способов")`, функция `waysAnswered`:

- `false`, пока спрашивает хоть одна: `idle` + `idle` (первый кадр шага),
  `checking` + `loading`, ролик `ready` + звёзды `loading`, ролик `checking` +
  звёзды `ready`;
- `true`, когда ответили обе: `ready` + `ready`, `unavailable` + `unavailable`;
- звёзды `retry` (`{ kind: "retry", reason: "offline", offer: null, purchaseId: null }`),
  ролик `ready` → `true` (повтор — тоже ответ);
- только ролик (`paidStage: null`): `checking` → `false`, `ready` → `true`;
- только звёзды (`adStage: null`): `idle` → `false`, `ready` → `true`;
- способов нет (`null` и `null`) → `true`.

`describe("событие continue_offered")`, функция `continueOfferedPayload`:

- первый кадр (`idle`, `idle`) → `null`;
- ролик `checking`, звёзды `loading` → `null` (раньше уходило как `ad: true,
  stars: true`);
- обычный игрок, ролик `ready` и звёзды `ready`, `survivalSec: 311.6` →
  `{ ad: true, stars: true, vip: false, elapsedSec: 312 }`;
- VIP: ролик `ready` с `pass: true`, звёзды `ready` →
  `{ ad: false, stars: false, vip: true, elapsedSec }`;
- ролика нет (`unavailable`), звёзды `ready` →
  `{ ad: false, stars: true, vip: false, elapsedSec }`;
- ролик `ready`, звёзды `unavailable` →
  `{ ad: true, stars: false, vip: false, elapsedSec }`;
- ролик `unavailable`, звёзды `unavailable` → `null` (предлагать нечего);
- `null` и `null` (способов нет, остался только `onDevContinue` разработчика) → `null`;
- только звёзды (`adStage: null`), `ready` → `{ ad: false, stars: true, vip: false, elapsedSec }`;
- округление секунды: `survivalSec: 0.4` → `elapsedSec: 0`, `59.5` → `60`.

## Аналитика

Событие `continue_offered` уже в словаре (`docs/22-analytics-and-metrics.md`
§3.3, `event-dictionary.ts:136`); имя, поля и версия не меняются. Меняется
момент отправки и описание (шаг 4): один раз, после ответа обеих проверок, не
при пустом наборе способов, флаги по ответам. Уходит по-прежнему через `track`
из `state/shell`, игру не задерживает.

## Настройки и окружение

Нет.

## Документы

- `docs/22-analytics-and-metrics.md` §3.3 — строка `continue_offered` (шаг 4).
- `docs/27-design-system-and-app-shell.md` — строка «Забег · Смерть» (шаг 5).

## Вопросы к тимлиду

Подтверждено `claude-lead-1` 13.10.2026: - игрок, закончивший забег раньше ответа проверок, в `continue_offered` не
  попадает (предлагать было нечего);
- у забега, где остаётся только бесплатное продолжение разработчика (способов
  `ad` / `stars` / `vip` нет), события больше нет: раньше уходило
  `false, false, false`.

Исполнитель ответа не ждёт.

## Критерии приёмки

- [ ] `continue_offered` не уходит, пока ролик (`idle`, `checking`) или звёзды
  (`idle`, `loading`) спрашивают сервер.
- [ ] После ответа обеих проверок событие уходит один раз с флагами из
  `visibleWays`; VIP даёт `vip: true`, `ad: false`, `stars: false`.
- [ ] Когда все способы отпали или их нет, события нет.
- [ ] Тесты из раздела «Тесты» зелёные; кейсы `visibleWays` не изменены.
- [ ] В `docs/22` строка события описывает новый момент и предупреждает о
  записях до правки; строка `docs/27` поправлена.
- [ ] Дифф только в зонах задачи и двух строках документов.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Слать continue_offered после ответа проверок`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СОБЫТИЕ continue_offered ТЕПЕРЬ ЧЕСТНОЕ**

  Событие «игроку предложили второй шанс» уходило в первый кадр экрана смерти, до ответа сервера: VIP в нём не было никогда, ролик и звёзды были почти всегда. Теперь оно уходит один раз, когда обе проверки ответили, и с настоящими флагами.

  🛠 **Аналитика**

  • записи до этой правки по флагам ad, stars и vip не читать — пометка есть в словаре событий
  • если предложить нечего (все способы отпали или их нет), события нет
  ```
