---
id: T-0054
title: Карточка игрока вкладками — шапка с действиями, «Сводка» на один взгляд
epic: E7
priority: P2
status: ready
owner:
size: M
depends_on: [T-0049, T-0050, T-0038]
zones:
  - apps/admin/src/screens/players/PlayerCardView.tsx
  - apps/admin/src/screens/players/PlayerHeader.tsx
  - apps/admin/src/screens/players/PlayerSummary.tsx
  - apps/admin/src/screens/players/PlayerActions.tsx
  - apps/admin/src/screens/players/RestrictDialog.tsx
  - apps/admin/src/screens/players/RestrictionsPanel.tsx
  - apps/admin/src/screens/players/card-rules.ts
  - apps/admin/src/routes.ts
  - apps/admin/test/card-rules.test.ts
  - apps/admin/test/routes.test.ts
shared:
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/screens/admin-player.html
batch: 3
---

# T-0054. Карточка игрока вкладками — шапка с действиями, «Сводка» на один взгляд

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0054.json)](README.md#значки-статуса) [![T-0049](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0049.json&label=T-0049)](archive/T-0049-admin-shell-responsive.md) [![T-0050](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0050.json&label=T-0050)](archive/T-0050-admin-confirm-and-undo.md) [![T-0038](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0038.json&label=T-0038)](archive/T-0038-support-purchase-actions-panel.md)

## Зачем

Сейчас карточка игрока — одна длинная страница из десятка панелей. Поддержке
приходится листать её, чтобы ответить на вопрос «кто это и что с ним».
Решение пользователя от 07.10.2026: игроки — в первых макетах панели. Макет —
`design/screens/admin-player.html`.

## Решения

- **Шапка:**
  - имя крупно и метки:
    - «платящий» — при `card.purchases !== null` и `funnel.firstPurchaseAt`;
    - ограничения и блокировка — как сейчас;
  - строкой — ID на площадке с «копировать», юзернейм, площадка, «с нами с»,
    короткий аккаунт (`3f2a…91c0`, полный — в `title` и в «копировать»);
  - справа — действия по правам.
- **Действия в шапке**:

  | Кнопка | Право | Что открывает |
  |---|---|---|
  | «Написать» | `players.message` | `ConfirmDialog` с текстом |
  | «Ограничить…» | `players.restrict` или `players.ban` | `RestrictDialog`, как сейчас |
  | «Кошелёк ±» | `players.wallet.adjust` | `ConfirmDialog` с ресурсом и суммой |
  | «Заблокировать…» | `players.ban` | `RestrictDialog` с выбранным «всё»; тон опасности |

  Блокирован — «Заблокировать…» не показывается: снимают во вкладке
  «Ограничения».
- **Вкладки** — «Сводка · Забеги · Покупки · Кошелёк · Друзья · Ограничения»:
  - число на вкладке — что ждёт:
    - «Покупки» — покупки в состоянии «не выдан» (`purchaseState`, T-0038);
    - «Ограничения» — действующие;
    - ноль — числа нет;
  - вкладка — в адресе: `#/players/<id>/<вкладка>`; «Сводка» — без части
    вкладки. Ссылка из чата открывает нужную вкладку, «назад» браузера
    возвращает прежнюю;
  - смена вкладки данные не перечитывает.
- **Подтверждения** — по `docs/29-admin-panel.md` §4: сообщение и кошелёк —
  окном `ConfirmDialog` (T-0050) вместо второго нажатия.
- **Знак «Тестер»** в макете есть, в задачу не входит: в ответе карточки
  панели нет поля тестера.

## Как сейчас

- **`screens/players/PlayerCardView.tsx`:**
  - `Header`, `RestrictionsPanel`, сетка из `Funnel`, `Acquisition`, `Runs`,
    `Wallet`, `RatingRunsPanel`, `SocialPanel`, `MessagePanel`,
    `WalletAdjustPanel`;
  - внизу — `PurchasesPanel` (после T-0038);
  - `ratingClosed` из действующих ограничений.
- **`screens/players/PlayerActions.tsx`** — `WalletAdjustPanel` и
  `MessagePanel` с подтверждением вторым нажатием. Ключ идемпотентности живёт,
  пока форма та же (`useMemo` по полям и `round`).
- **`screens/players/RestrictionsPanel.tsx`:**
  - кнопка «Ограничить…» в заголовке;
  - `RestrictDialog` (пропсы `open`, `catalog`, `active`, `canBan`,
    `canRestrict`, `onDone`);
  - черновик — `emptyDraft()` из `api/restrictions.ts`, `kinds: []`.
- **`routes.ts`:**
  - `Route { section; id }`;
  - `parseRoute` берёт две части хэша, третья отбрасывается;
  - `hrefOf`.
- **`ui/router.ts`** — `useHashRoute()`, `navigate(route)`.
- **`PlayersScreen.tsx`** — `<PlayerCardView key={id} …>`: при смене
  вкладки карточка не пересоздаётся, `id` тот же.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`routes.ts`:**
   - `Route` += `tab?: string` — вкладка объекта: третья часть хэша;
   - `parseRoute`:
     - третья часть есть → `tab`;
     - нет → поле не задано;
   - `hrefOf` добавляет `/<tab>` только при `id !== null` и заданном `tab`.

   Остальные вызовы не меняются.
3. **Новый `screens/players/card-rules.ts`** — чистые функции:

   ```ts
   export const CARD_TABS = [
     { id: "summary", title: "Сводка" },
     { id: "runs", title: "Забеги" },
     { id: "purchases", title: "Покупки" },
     { id: "wallet", title: "Кошелёк" },
     { id: "friends", title: "Друзья" },
     { id: "restrictions", title: "Ограничения" },
   ] as const;
   export type CardTab = (typeof CARD_TABS)[number]["id"];
   /** Вкладка из адреса; нет или чужая — «Сводка». */
   export function cardTabOf(tab: string | undefined): CardTab;
   /** Числа на вкладках: что ждёт поддержку. */
   export function tabCounts(card: PlayerCard, active: readonly Restriction[]): Partial<Record<CardTab, number>>;
   /** Цепочка вех в «Сводке» — шесть из девяти, коротко. */
   export const MILESTONE_CHAIN = [
     ["enteredAt", "Вход"],
     ["firstRunStartedAt", "1-й забег"],
     ["runs5At", "5 забегов"],
     ["returnedD1At", "D1"],
     ["returnedD7At", "D7"],
     ["firstPurchaseAt", "Покупка"],
   ] as const;
   /** Лучший забег — на самой трудной сложности, где он есть: hard, normal, easy, затем прочие. */
   export function bestRun(best: PlayerCard["runs"]["best"]): { difficulty: string; survivalSec: number; rank: number } | null;
   export interface SummaryNumber { value: string; label: string }
   /** Цифры «Сводки» — по макету. */
   export function summaryNumbers(card: PlayerCard): SummaryNumber[];
   /** Аккаунт коротко: первые 4 и последние 4 знака. */
   export function shortId(accountId: string): string;
   ```

   `summaryNumbers` по порядку:

   | Цифра | `value` | `label` |
   |---|---|---|
   | забеги | `formatNumber(runs.runs)` | `plural(n, ["забег", "забега", "забегов"])` |
   | лучшее | `formatDuration(survivalSec)` | `лучшее, <difficultyTitle> · место <rank>` |
   | звёзды | сумма `chargedStars` | `⭐ всего, <N> <покупка/покупки/покупок>` |
   | возвраты | число | `plural(n, ["возврат", "возврата", "возвратов"])` |
   | монеты | `balances.coins ?? 0` | `plural(n, ["монета", "монеты", "монет"])` |
   | самоцветы | `balances.gems ?? 0` | `plural(n, ["самоцвет", "самоцвета", "самоцветов"])` |

   - **лучшее** — по `bestRun`; `null` — цифры нет;
   - **звёзды** — по покупкам с `mode === "live"`, `paidAt !== null` и
     `refundedAt === null`; `N` — их число;
   - **возвраты** — покупки с `refundedAt !== null`;
   - `card.purchases === null` — звёзд и возвратов нет.
4. **Новый `screens/players/PlayerHeader.tsx`** — шапка по макету:
   - аватар-кружок 56 px (на телефоне 44 px);
   - имя `font-display` 20 px и метки;
   - строка данных `text-xs text-text-muted`;
   - «копировать» — `navigator.clipboard.writeText`:
     - успех → `toast("Скопировано")`;
     - ошибка → `toast.error("Не удалось скопировать")`;
   - без права на персональные данные — «ID скрыт», без «копировать»;
   - действия справа (таблица в «Решениях»):
     - окна — `MessageDialog`, `WalletAdjustDialog` из `PlayerActions.tsx` и
       `RestrictDialog`;
     - каталог ограничений грузится, как в `RestrictionsPanel`;
   - **телефон (`useNarrow`):**
     - шапка столбиком;
     - действия — одной кнопкой «Действия» с меню (Radix `DropdownMenu`, как
       меню аккаунта в T-0049) из тех же пунктов.
5. **`PlayerActions.tsx`** — формы становятся окнами на `ConfirmDialog`:
   - **`WalletAdjustDialog({ card, open, onOpenChange, onChanged })`:**
     - `title` «Ручная операция с кошельком», `subject` — имя игрока;
     - `children` — «Ресурс» (`Select`) и «Изменение» (`Input`), как сейчас;
     - `problem` — `walletAdjustProblem` без проверки причины, пока изменение
       пустое — «Укажите изменение»;
     - `changes` — «Ресурс», «Изменение» (`formatDelta`), «Баланс» — «было →
       станет» по `card.wallet.balances`;
     - `reason` — `{ min: 3, max: 200, hint: "Попадёт в журнал кошелька и в аудит." }`;
     - `action` — `Провести <formatDelta> — <ресурс>`, при пустой форме —
       «Провести»;
     - `tone="danger"` при списании;
     - успех:
       - `toast.success` с прежним текстом (и про повтор операции);
       - `onChanged()`;
       - форма очищается.
     - Ключ идемпотентности — как сейчас, по полям и `round`;
   - **`MessageDialog({ card, open, onOpenChange })`:**
     - `title` «Сообщение игроку», `subject` — имя;
     - `reason` — `{ min: 3, max: TEAM_MESSAGE_MAX, label: "Текст", hint: <прежняя подсказка поля> }`;
     - `action` — «Отправить»;
     - успех — `toast.success` с прежним текстом;
   - `WalletAdjustPanel`, `MessagePanel` и `OutcomeLine` удаляются.
6. **`RestrictDialog.tsx`** — проп `initialKinds?: readonly string[]`:
   - при открытии черновик — `emptyDraft()` с этими `kinds`;
   - «Заблокировать…» передаёт `[BAN_KIND]`.
7. **`RestrictionsPanel.tsx`** — кнопка «Ограничить…» в заголовке
   остаётся: во вкладке она на своём месте.
8. **Новый `screens/players/PlayerSummary.tsx`** — вкладка «Сводка»:
   - **сетка `lg:grid-cols-3`:**
     - **«Профиль»** — уровень с опытом и полосой (как в нынешней шапке),
       «Писать в бота», «Предупреждение» (`testNoticeLabel`), «Роли»;
     - **«Вехи воронки»** — `MILESTONE_CHAIN` цепочкой:
       - пройденная веха — точка и линия `bg-success`, под названием дата
         «21 сент.» — `Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" })`
         в местном времени, как `formatDateTime`; полная дата — в `title`;
       - не пройденная — пустая точка;
       - `funnel === null` — прежний текст;
     - **«Откуда пришёл»** — нынешний `Acquisition`;
   - **цифры** — `summaryNumbers`: `grid-cols-3 lg:grid-cols-6`, число
     `font-display` 18 px;
   - **«Последние покупки»** — три строки: время, `purchaseLabel`, «N ⭐»,
     значок `purchaseState`. Ссылка «все →» открывает вкладку «Покупки»;
   - **«Последние забеги»** — три строки из `runs.recent`: время,
     сложность, время забега, уровень, оружие. Ссылка «все →» открывает
     «Забеги»;
   - без права на выручку покупок нет — забеги на всю ширину;
   - **телефон** — всё в одну колонку, цифры — первые три.
9. **`PlayerCardView.tsx`:**
   - сверху «← Игроки», затем `PlayerHeader`;
   - вкладки — строкой под шапкой:
     - активная — текст `text-text` и черта акцента 2 px снизу;
     - число — значком тона предупреждения;
     - на телефоне строка прокручивается вбок, страница — нет;
   - вкладка — из `useHashRoute()` через `cardTabOf`, смена —
     `navigate({ section: "players", id, tab })` (у «Сводки» — без `tab`);
   - содержимое вкладок:

     | Вкладка | Что внутри |
     |---|---|
     | «Сводка» | `PlayerSummary` |
     | «Забеги» | нынешние `Runs`, `RatingRunsPanel`, полный список вех (`Funnel`) |
     | «Покупки» | `PurchasesPanel` (T-0038) |
     | «Кошелёк» | нынешний `Wallet` |
     | «Друзья» | `SocialPanel` |
     | «Ограничения» | `RestrictionsPanel` |

   - `MessagePanel` и `WalletAdjustPanel` из сетки уходят: они в шапке;
   - нынешний `Header` удаляется: его данные — в `PlayerHeader` и в
     «Профиле».
10. **Документы** — раздел «Документы».

## Чего не трогаем

- Сервер и ответ карточки.
- `PurchasesPanel`, `RatingRunsPanel`, `SocialPanel` внутри — только где
  стоят.
- Список и поиск игроков.
- Знак «Тестер» — отдельная задача: нужно поле в ответе карточки панели.

## Сценарий и интерфейс

По макету `design/screens/admin-player.html`:

- **ПК** — шапка с четырьмя действиями, вкладки с числами, «Сводка» из трёх
  колонок, шести цифр и двух списков.
- **Телефон** — шапка столбиком с «Действия», вкладки строкой, цифры, вехи,
  откуда пришёл.

Состояния:

- **модератор без права на выручку** — нет «платящий», звёзд, возвратов и
  последних покупок; вкладка «Покупки» — с текстом «Скрыто…»;
- **без права на кошелёк и сообщения** — в шапке только «Ограничить…»;
- **игрок заблокирован** — метка блокировки, «Заблокировать…» нет;
- **адрес `#/players/<id>/purchases`** — открыта вкладка «Покупки»;
- **адрес с чужой вкладкой** — «Сводка».

Снимки на 390, 768 и 1440 px снимают тимлиды.

## Тесты

Первым коммитом.

- **`apps/admin/test/routes.test.ts`:**
  - `parseRoute("#/players/abc/purchases")` → `{ section: "players", id: "abc", tab: "purchases" }`;
  - `parseRoute("#/players/abc")` — без `tab`;
  - `hrefOf` с `tab` и без него;
  - `hrefOf({ section: "players", id: null, tab: "runs" })` → `#/players`.
- **`apps/admin/test/card-rules.test.ts`** — на собранной в тесте карточке:
  - `cardTabOf`: `undefined` → `summary`, `"wallet"` → `wallet`, `"x"` →
    `summary`;
  - `tabCounts`:
    - одна покупка «не выдан» и одна выданная → `purchases: 1`;
    - два действующих ограничения → `restrictions: 2`;
    - нулей в ответе нет;
  - `bestRun`:
    - есть `normal` и `hard` → `hard`;
    - только `easy` → `easy`;
    - все `null` → `null`;
  - `summaryNumbers`:
    - тестовая и возвращённая покупки в звёзды не идут;
    - склонения: 1 забег, 2 забега, 5 забегов;
    - `purchases: null` → цифр звёзд и возвратов нет;
  - `shortId("3f2a1b7c9d0e91c0")` → `3f2a…91c0`.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` §2, строка «Игроки» — карточка вкладками, вкладка
  в адресе, действия в шапке.

## Критерии приёмки

- [ ] Шапка:
  - метки и строка данных с «копировать»;
  - действия по правам;
  - на телефоне — «Действия».
- [ ] Вкладки:
  - числа ожидающего;
  - вкладка в адресе, «назад» работает, смена вкладки не перечитывает
    данные.
- [ ] «Сводка» — по макету. Без права на выручку — без покупок.
- [ ] Сообщение и ручная операция — окном `ConfirmDialog`: ключ
  идемпотентности прежний, повтор не задваивает.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Карточка игрока вкладками`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТОЧКА ИГРОКА ВКЛАДКАМИ**

  Карточка игрока больше не длинная страница: шапка с действиями и вкладки «Сводка · Забеги · Покупки · Кошелёк · Друзья · Ограничения». «Сводка» отвечает на вопрос «кто это и что с ним» без прокрутки, на вкладках — число того, что ждёт: не выданные покупки, действующие ограничения.

  🧭 **Что ещё**

  • вкладка — в адресе: ссылка из чата открывает нужную
  • сообщение и ручная операция с кошельком — окном, где видно, что изменится
  ```
