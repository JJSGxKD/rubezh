---
id: T-0045
title: Экран смерти в два шага — сначала второй шанс, потом итоги
epic: E12
priority: P1
status: ready
owner:
size: M
depends_on: []
zones:
  - packages/app-shell/src/screens/run/DeathOverlay.tsx
  - packages/app-shell/src/screens/run/death-parts.tsx
  - packages/app-shell/src/screens/run/death-rules.ts
  - packages/app-shell/src/screens/run/SecondChance.tsx
  - packages/app-shell/src/screens/run/RunDouble.tsx
  - packages/app-shell/src/screens/run/RunScreen.tsx
  - packages/app-shell/src/screens/gallery.tsx
  - packages/app-shell/src/state/meta.ts
  - packages/app-shell/src/state/analytics.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/test/death-rules.test.ts
shared:
  - packages/app-shell/src/i18n/ru-run.json
  - packages/app-shell/src/i18n/ru-account.json
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/screens/death.html
---

# T-0045. Экран смерти в два шага — сначала второй шанс, потом итоги

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0045.json)](README.md#значки-статуса)

## Зачем

Сейчас экран смерти — одно длинное окно. В нём:

- итоги и награда;
- причина смерти;
- второй шанс;
- урон по всем оружиям;
- кнопки.

На телефоне второй шанс теряется среди цифр, а «Ещё раз» уходит за прокрутку.

После задачи будет два шага:

1. Пока второй шанс можно взять, игрок видит короткое окно с ним одним.
2. После отказа — итоги: время героем, награда с полосой уровня, подробности
   по кнопке.

## Решения

Решения пользователя от 07.10.2026, макет — `design/screens/death.html`, все семь
состояний:

- **Сначала второй шанс, потом итоги.**
  - Шаг 1 — пока забег ждёт решения (`phase: "downed"`): время, кто убил и
    способы продолжить; тихая кнопка «Закончить забег».
  - Шаг 2 — после отказа или когда продолжить нечем.
- **Главное в итогах — время и рекорд, потом награда.**
  - Время выживания героем, у рекорда — акцентом;
  - плашки сложности, рекорда и места;
  - под ними награда: монеты, опыт, полоса уровня;
  - новый уровень — отдельной плашкой с тем, что открылось.
- **Урон по оружиям — под «Подробнее».**
  - На экране три цифры: уровень забега, убито врагов, лучшее оружие;
  - «Волна» уходит: волн с паузами в игре нет;
  - раскрытие запоминается на устройстве.

Решения тимлидов:

- **Правила второго шанса не меняются:**
  - какие способы видны и как отпадают (`second-chance-offers.ts`);
  - VIP — одной кнопкой;
  - звёзды и ролик разом не берутся;
  - тексты `run.continue.*`.

  Меняется только место и вид блока.
- **Способов нет вовсе** (ни звёзд, ни ролика, ни бесплатного продолжения
  разработчика) — **шага 1 нет**. Окно сразу зовёт `onDecline()`, забег
  закрывается смертью, как сейчас, когда отпали все способы.
- **Отказ — `useRun.getState().declineContinue()`**, уже есть в
  `state/run.ts`. «Ещё раз» и «На главную» из шага 1 не показываются: в шаге 1
  одна тихая кнопка, решение — явное.
- **Новое событие `continue_offered`** — шаг 1 показан. Без него не посчитать,
  какая доля взявших второй шанс от тех, кому его предложили.
  `continue_used` уже есть.
- **«В меню» → «На главную»:** кнопка ведёт на главную, а «меню» у нас —
  лист в шапке.

## Как сейчас

- **`screens/run/DeathOverlay.tsx`** (272 строки):
  - `Modal size="l"`, заголовок `run.death.title` или `run.death.abandoned`,
    значок `Crown` или `Skull`;
  - плашки: сложность, читы, рекорд, место;
  - сетка из четырёх `Stat`: время, уровень, убито, волна;
  - `RewardRow`: монеты, опыт, новый уровень, открытое, потолок, `RunDouble`;
  - причина `run.death.cause`;
  - `SecondChance` при `outcome === "died"` и `secondChance`;
  - список урона по оружиям с полосами;
  - диагностика `run.death.diagnostics`;
  - кнопки `run.death.again`, `run.death.menu`, `run.death.share`.
- **`screens/run/RunScreen.tsx:156-170`:**
  - `DeathOverlayLazy` в фазах `finished` и `downed`;
  - `secondChance` — только в `downed`;
  - `showReward` — в `finished`;
  - `secondChanceFor(result, devRun)` (строка ~190) собирает `onDevContinue`,
    `paidFor`, `adFor`.
- **`state/run.ts`:**
  - `declineContinue()` (строка ~397) — отказ в фазе `downed`;
  - `finishRun` переводит в `finished`, пишет рекорд;
  - `restart()` из `downed` тоже сначала отказывается.
- **`screens/run/SecondChance.tsx`:** блок `surface-sunken` со значком
  `HeartPulse` в тоне `hp`, заголовок `run.continue.title`, текст
  `run.continue.text`, кнопки ролика и звёзд, бесплатная кнопка разработчика.
- **Награда — `RunRewardView`** (`state/progress-api.ts:30-47`):
  - `pending`;
  - `none` с `reason`;
  - `granted` — `coins`, `coinsCapped`, `xp`, `levelBefore`, `levelAfter`,
    `progress` (`xpIntoLevel`, `xpForNext`).
- **Запомненный выбор на устройстве — `state/meta.ts`**: `lastWeaponId`,
  `rememberWeapon` и `persist(get())`.
- **Витрина компонентов — `screens/gallery.tsx:343-373`:** два `DeathOverlay`
  на образцах; блоки `SecondChance` на строках ~184–189.
- **События:**
  - словарь — `backend/api/src/modules/events/event-dictionary.ts`,
    `continue_used` на строке ~133;
  - список имён клиента — `packages/app-shell/src/state/analytics.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Событие** — сначала словарь (`CLAUDE.md`, «Аналитика»):
   - `event-dictionary.ts`, рядом с `continue_used`:

     ```ts
     // Шаг второго шанса показан (tasks/T-0045): сколько раз предложили и чем —
     // ролик, звёзды, VIP. Доля `continue_used` от этого — конверсия второго шанса.
     continue_offered: { version: 1, payload: payload({ ad: z.boolean(), stars: z.boolean(), vip: z.boolean(), elapsedSec: seconds }) },
     ```
   - `analytics.ts` — имя в списке событий клиента;
   - `docs/22-analytics-and-metrics.md` §3.3 — строка события.
3. **Новый `screens/run/death-rules.ts`** — чистые правила, без React:

   ```ts
   /** Какой шаг показать: второй шанс — только пока забег ждёт решения и есть хоть один способ. */
   export function deathStep(input: { phase: "downed" | "finished"; hasWays: boolean }): "chance" | "results";

   /** Полоса уровня после забега: доли 0..1 — что было до забега и что стало; `null` у `toNext` — наивысший уровень. */
   export function levelBar(reward: { xp: number; levelBefore: number; levelAfter: number; progress: { level: number; xpIntoLevel: number; xpForNext: number | null } }): {
     level: number;
     before: number;
     after: number;
     toNext: number | null;
   };

   /** Оружие с наибольшим уроном; пусто — `null`. */
   export function bestWeapon(weapons: readonly { id: string; damage: number }[]): string | null;
   ```

   **`levelBar`:**
   - `xpForNext === null` → `{ before: 1, after: 1, toNext: null }`;
   - уровень вырос (`levelAfter > levelBefore`) → `before: 0`;
   - иначе `before = max(0, xpIntoLevel - xp) / xpForNext`;
   - `after = xpIntoLevel / xpForNext`;
   - `toNext = xpForNext - xpIntoLevel`.

   Доли зажать в `0..1`.
4. **Новый `screens/run/death-parts.tsx`** — части окна по макету, чтобы
   `DeathOverlay.tsx` остался меньше 300 строк:
   - `ChanceStep({ result, secondChance, onDecline })` — шаг 1:
     - значок `Skull` в круге тона `danger`;
     - заголовок `run.death.downed` («Вы пали на {time}»,
       `formatDuration(result.survivalSec)`);
     - под ним `run.death.cause` — если `deathCause` не `null`;
     - `SecondChance` в виде `prominent` (шаг 6);
     - в подвале — `Button variant="secondary" block` `run.death.decline`
       («Закончить забег»).

     При монтировании — один раз
     `track("continue_offered", { ad, stars, vip, elapsedSec })`. Флаги — какие
     способы показаны: та же логика видимости, что в `SecondChance`. Вынести
     её функцией в `SecondChance.tsx` и звать в обоих местах;
   - `ResultsHero({ result, isNewRecord, rank, cheatsCounted })`:
     - время `formatDuration` крупно (`font-display`, 46 px), у рекорда —
       `text-accent` со свечением;
     - подпись `run.death.survived`;
     - плашки сложности, читов, рекорда, места — те же, что сейчас, и в том же
       порядке;
   - `RewardCard({ reward, doubleRunId })` — замена `RewardRow`:
     - `pending` — «Считаем награду…» и заглушка полосы;
     - `none` — причина, как сейчас;
     - `granted`:
       - монеты `font-display` 20 px, опыт в тоне `xp`;
       - полоса `levelBar`: сплошная — `before`, полупрозрачная — до `after`;
         анимируется только `transform: scaleX`;
       - подписи `run.reward.levelLabel` («Уровень {level}») и справа
         `run.reward.toNext` («до {next}-го — {xp} опыта»), на наивысшем —
         `run.reward.maxLevel`;
       - строка потолка, как сейчас;
       - `RunDouble` во всю ширину карточки, как сейчас;
   - `LevelUpCard({ levelAfter, unlocked })` — при росте уровня:
     - плашка в тоне `xp`: `run.reward.levelUp` и
       `run.reward.unlockedNext` («Открыто: {list} — следующий забег уже с
       ними») или без второй строки, если ничего не открылось;
     - значок — первого открытого оружия (`ItemIcon kind="weapon"`), иначе
       `Sparkles`;
   - `RunStats({ result })` — три клетки: `result.level`
     (`run.death.runLevel`), `formatNumber(enemiesKilled)` (`run.death.killed`),
     имя `bestWeapon` в тоне `weapon` (`run.death.bestWeapon`; нет оружия —
     «—»);
   - `RunDetails({ result, open, onToggle })`:
     - кнопка `run.death.more` / `run.death.less` с шевроном;
     - раскрытое — список урона, перенесённый из `DeathOverlay`, и
       `run.death.cause`;
     - диагностика `seed` и `runId` — внутри раскрытого, как сейчас, только при
       `diagnostics`.
5. **`DeathOverlay.tsx`:**
   - новый обязательный проп `onDecline(): void`;
   - шаг — `deathStep({ phase: props.secondChance === undefined ? "finished" : "downed", hasWays })`;
   - `hasWays` — есть `onDevContinue`, `paidFor` или `adFor`;
   - `phase` — `downed`, а способов нет → `useEffect` один раз зовёт
     `props.onDecline()`. Сразу рисуется шаг 2 без награды: она придёт, когда
     забег закроется;
   - **шаг 1** — `Modal` без `size="l"` и без заголовка `Modal`: заголовок
     рисует `ChanceStep`;
   - **шаг 2** — `Modal size="l"`, сверху вниз:
     - значок `Crown` или `Skull`;
     - `run.death.title` или `run.death.abandoned`;
     - `ResultsHero`, `RewardCard`, `LevelUpCard`, `RunStats`, `RunDetails`;
     - подвал:
       - `run.death.again` — `size="l" glow`;
       - ряд из `run.death.home` (`secondary`) и `run.death.share` (`ghost`);
   - ландшафт: слева герой и награда, справа цифры, подробности и кнопки —
     как сейчас две колонки (`landscape:grid-cols-2`);
   - раскрытие «Подробнее» — `useMeta`: `deathDetailsOpen`,
     `rememberDeathDetails(open)`.
6. **`SecondChance.tsx`:**
   - проп `variant?: "inline" | "prominent"`, по умолчанию `inline` — витрина
     и прежние места не меняются;
   - `prominent` по макету:
     - подложка с оттенком `hp` и рамкой `hp/45`;
     - заголовок `font-display` 17 px;
     - кнопки высотой 48 px, ролик — главная (`glow`);
   - функция видимости способов (шаг 4) — экспортировать отсюда:

     ```ts
     export function visibleWays(input: { adStage: AdContinueStage | null; paidStage: ContinueStage | null }): { ad: boolean; stars: boolean; vip: boolean };
     ```

     Сейчас эта логика — `vip`, `showAd`, `showStars` в теле компонента.
     Перенести без изменений.
7. **`RunDouble.tsx`** — только вид кнопки: вторичная во всю ширину карточки,
   отметка `×2` акцентом. Логика и тексты `run.double.*` не меняются.
8. **`RunScreen.tsx`** — `onDecline={() => useRun.getState().declineContinue()}`
   в `DeathOverlayLazy`.
9. **`meta.ts`** — поле `deathDetailsOpen: boolean` (умолчание `false`) и
   `rememberDeathDetails(open)`. Хранится в том же снимке, что
   `lastWeaponId`; старый снимок без поля → `false`.
10. **`gallery.tsx`:**
    - в оба `DeathOverlay` — `onDecline={noop}`;
    - третий образец — шаг 1, `secondChance={{ paidPreview: …, adPreview: … }}`,
      с теми же образцами стадий, что у блоков `SecondChance` выше.
11. **Тексты:**
    - `ru-run.json`:

      ```json
      "run.death.downed": "Вы пали на {time}",
      "run.death.decline": "Закончить забег",
      "run.death.home": "На главную",
      "run.death.runLevel": "Уровень забега",
      "run.death.bestWeapon": "Лучшее оружие",
      "run.death.more": "Подробнее",
      "run.death.less": "Скрыть"
      ```
    - `ru-account.json`:

      ```json
      "run.reward.levelLabel": "Уровень {level}",
      "run.reward.toNext": "до {next}-го — {xp} опыта",
      "run.reward.maxLevel": "Наивысший уровень",
      "run.reward.unlockedNext": "Открыто: {list} — следующий забег уже с ними"
      ```
    - **Удалить**, если поиск по `packages/` не находит других мест:
      - `run.death.menu`;
      - `run.death.wave`;
      - `run.death.level` (заменён `run.death.runLevel`);
      - `run.reward.unlocked`.

      Список удалённых — в описании PR.
12. **Документы** — раздел «Документы».

## Чего не трогаем

- Правила второго шанса, оплату, рекламу и удвоение — только вид.
- Срез углов у окна — T-0013, там одна строка `cut` у `Modal`.
- Шеринг — по-прежнему заглушка `shareRun()`.
- Звук и вибрацию смерти и рекорда: они в `finishRun` и не зависят от шага.

## Сценарий и интерфейс

По макету `design/screens/death.html`, ширина 360 px. Снимки на 320, 390, 768 и
1440 px снимают тимлиды при приёмке.

1. **Смерть, второй шанс есть — шаг 1:**
   - «Вы пали на 7:42», «Убил: …», блок второго шанса;
   - «Закончить забег» → шаг 2 с итогами, наградой, рекордом и местом;
   - взял второй шанс → забег продолжается, как сейчас.
2. **VIP** — одна кнопка «Продолжить с VIP».
3. **Идёт ролик или оплата** — второй способ приглушён, как сейчас. Тексты
   отказов — под блоком.
4. **Способов нет** — шага 1 нет, сразу итоги.
5. **Сдал забег** («Сдаться» в паузе) — сразу шаг 2 с заголовком «Забег сдан».
6. **Шаг 2:**
   - рекорд — время акцентом и корона;
   - место появляется, когда пришло;
   - награда сначала «Считаем награду…», потом числа и полоса — без
     перезапуска окна.
7. **«Подробнее»** — урон по оружиям и кто убил. Раскрытие помнится до
   следующей смерти и после перезапуска.
8. **Ландшафт** — две колонки, «Ещё раз» видна без прокрутки, как сейчас.

## Тесты

Первым коммитом, `packages/app-shell/test/death-rules.test.ts`:

- `deathStep`:
  - `downed` со способами → `chance`;
  - `downed` без способов → `results`;
  - `finished` → `results`;
- `levelBar`:
  - без роста уровня: `xpIntoLevel 300`, `xp 100`, `xpForNext 500` →
    `before 0.4`, `after 0.6`, `toNext 200`;
  - с ростом уровня → `before 0`, `after = xpIntoLevel / xpForNext`;
  - `xpForNext: null` → `before 1`, `after 1`, `toNext null`;
  - `xp` больше `xpIntoLevel` без роста уровня (рассинхрон) → `before 0`, не
    меньше нуля;
- `bestWeapon`:
  - наибольший урон;
  - пусто → `null`;
  - равный урон → первое по порядку;
- `visibleWays` (из `SecondChance.tsx`) — те же случаи, что задают видимость
  сейчас:
  - VIP → только `vip`;
  - ролик недоступен → только звёзды;
  - звёзды недоступны и ролик есть → только ролик.

Существующие тесты второго шанса и удвоения зелёные без правок.

## Аналитика

- **Новое `continue_offered`** — пункт 2 «Шагов по порядку».
- `run_finished`, `continue_used` и события удвоения — как сейчас, из тех же
  мест.

## Настройки и окружение

Нет. Раскрытие «Подробнее» — снимок `meta` на устройстве, не настройка.

## Документы

- `docs/27-design-system-and-app-shell.md`:
  - каталог экранов — строка экрана смерти: два шага, состав итогов,
    «Подробнее»;
  - если в §5.3 описана раскладка экрана смерти в ландшафте — поправить
    состав колонок.
- `docs/22-analytics-and-metrics.md` §3.3 — `continue_offered` (пункт 2 «Шагов»).

## Критерии приёмки

- [ ] Пока второй шанс можно взять — короткое окно с ним одним и «Закончить
  забег». После отказа — итоги.
- [ ] Итоги:
  - время героем;
  - рекорд, место и сложность плашками;
  - награда с полосой уровня;
  - новый уровень с открытым;
  - три цифры;
  - урон по оружиям — под «Подробнее», раскрытие помнится.
- [ ] Правила второго шанса и удвоения не изменились.
- [ ] `continue_offered` в словаре и шлётся один раз на показ шага 1.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Экран смерти в два шага`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: Экран смерти: сначала второй шанс, потом итоги — время, рекорд и награда крупно, подробности по кнопке.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЭКРАН СМЕРТИ В ДВА ШАГА**

  Экран смерти стал короче: сначала второй шанс, если его можно взять, потом итоги. Время, рекорд и награда — крупно, урон по оружиям — по кнопке «Подробнее».

  💀 **Что изменилось**

  • второй шанс — отдельным окном, решение явное: взять или «Закончить забег»
  • в итогах — полоса уровня после забега и плашка нового уровня с открытым оружием
  • новое событие continue_offered: теперь видно, какая доля игроков берёт второй шанс

  ❓ **Нужно от команды**

  • @участник1 — пройти смерть со вторым шансом и без, сказать, понятно ли
  ```
