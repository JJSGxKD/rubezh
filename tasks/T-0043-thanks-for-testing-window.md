---
id: T-0043
title: Окно «Спасибо за тест» и знак «Тестер» в профиле, у друзей и в рейтинге
epic: E2
priority: P1
status: ready
owner:
size: M
depends_on: [T-0042, T-0048]
zones:
  - packages/app-shell/src/screens/meta/tester-thanks.tsx
  - packages/app-shell/src/screens/meta/tester-badge.tsx
  - packages/app-shell/src/state/compensation.ts
  - packages/app-shell/src/i18n/tester.ts
  - packages/app-shell/src/i18n/ru-tester.json
  - packages/app-shell/src/state/navigation.ts
  - packages/app-shell/src/app/App.tsx
  - packages/app-shell/src/app/lazy-screens.tsx
  - packages/app-shell/src/index.tsx
  - packages/app-shell/src/state/auth-api.ts
  - packages/app-shell/src/state/runs-api.ts
  - packages/app-shell/src/state/friends-api.ts
  - packages/app-shell/src/screens/meta/profile.tsx
  - packages/app-shell/src/screens/meta/rating.tsx
  - packages/app-shell/src/screens/meta/friends.tsx
  - packages/app-shell/src/state/analytics.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/test/compensation.test.ts
  - packages/app-shell/test/friends-api.test.ts
  - packages/app-shell/test/session.test.ts
shared:
  - packages/app-shell/src/i18n/ru.json
  - packages/shared-types/src/index.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/screens/tester-thanks.html
---

# T-0043. Окно «Спасибо за тест» и знак «Тестер» в профиле, у друзей и в рейтинге

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0043.json)](README.md#значки-статуса) [![T-0042](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0042.json&label=T-0042)](T-0042-compensation-claim-and-tester-flag.md) [![T-0048](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0048.json&label=T-0048)](T-0048-friends-screen-layout.md)

## Зачем

После вайпа тестер должен увидеть, что обещание выполнено:

- купленное за звёзды вернулось;
- за игру на тесте дали бонус и знак.

Без окна компенсация лежит на сервере, и о ней никто не знает (T-0042). Без
знака на экранах признак `tester` в ответах сервера никто не видит.

## Решения

Р87, решения пользователя от 07.10.2026:

- **Окно «Спасибо за тест» при первом входе после вайпа:**
  - что вернули и что дали сверху: купленное, самоцветы за второй шанс
    (`continueGems`), бонус за уровень;
  - кнопка «Забрать» начисляет один раз.
- **Знак «Тестер» виден в профиле, у друзей и в рейтинге.**
- **Тексты утверждены пользователем 07.10.2026** — таблица в макете
  `design/screens/tester-thanks.html`, дословно в шаге 2.

Решения тимлидов (макет):

- **Окно — `Modal` по центру**, отдельным экраном в лобби после входа, как
  предупреждение о тесте (`state/test-notice.ts`, `waitForLobby`): не поверх
  забега.
- **Закрыть окно до забора нельзя:**
  - нет `onDismiss` и крестика;
  - «Назад» не закрывает;
  - не забрал и закрыл приложение — окно придёт при следующем входе.

  Окно обещает то, что уже лежит на сервере.
- **Строки — только те, где есть что выдать:**
  - «Купленное за звёзды» — суммой самоцветов из `restored`;
  - «Второй шанс» — `continueGems`;
  - «Бонус за уровень N» — `bonusGems`;
  - «Знак «Тестер»» — при `tester`.

  Внизу «Всего» — сумма самоцветов.
- **Заголовок и текст** — у тестера свои, у того, кто только покупал, свои.
- **Знак — тон элиты и значок колбы** (`FlaskConical` из lucide): метка «Вы» в
  рейтинге — акцентом, знак не должен с ней спорить. Стоит после имени;
  длинное имя обрезается, знак — нет.
- **Признак `tester` в ответах необязательный**: нет поля — не тестер (T-0042).

## Как сейчас

- **Сервер (T-0042):**
  - `GET /api/v1/me/compensation` → `{ data: CompensationView | null }`;
  - `POST /api/v1/me/compensation/claim` → `{ data: { view, alreadyClaimed, balances } }`;
  - `CompensationView` — `tester`, `level`, `bonusGems`, `restored`
    (`[{ resource, amount }]`), `continueGems`;
  - `tester: true` — в `account` сессии, в строках рейтинга и у друзей.
- **Образец синхронизации после входа — `state/test-notice.ts`:**
  - `syncTestNotice()` спрашивает сервер;
  - `waitForLobby` ждёт, пока игрок в лобби, и кладёт экран
    `push("testNotice")`;
  - вызывается из `index.tsx:147-151` ленивым импортом после входа.
- **Экраны:**
  - `ScreenId` — `state/navigation.ts`;
  - `case` — `app/App.tsx:209`;
  - ленивые экраны — `app/lazy-screens.tsx`.
- **Словарь-чанк — `i18n/test-notice.ts`:** `addTranslations(json)`, импорт
  файла из экрана.
- **Разбор ответов:**
  - сессия — `state/auth-api.ts:96-108` (`sessionSchema.account`);
  - рейтинг — `state/runs-api.ts:38-54` (`leaderboardSchema.entries`);
  - друзья — `state/friends-api.ts:13` (`peer`).
- **Где встаёт знак:**
  - профиль — `screens/meta/profile.tsx:80-86`, имя в шапке карточки;
    аккаунт — `useSession((state) => state.account)`;
  - рейтинг — `screens/meta/rating.tsx`, `LeaderboardRow` (~строки 170–180):
    после имени, перед `Badge` «Вы»;
  - друзья — проп `badge` у `PeerRow` в `screens/meta/friends-parts.tsx`
    (T-0048).
- **Балансы в шапке** — кошелёк клиента. После забора — те же функции, что
  после «Забрать» подарки (`loadWallet` в `friends.tsx`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Тексты.**
   - Новый `i18n/ru-tester.json` (утверждены пользователем, дословно):

     ```json
     "tester.thanks.title": "Спасибо за тест!",
     "tester.thanks.text": "Вы играли до релиза и помогли сделать «Рубеж» лучше. Прогресс обнулился, как мы и предупреждали, — а купленное и подарок за тест уже ждут.",
     "tester.returned.title": "Купленное вернулось",
     "tester.returned.text": "Перед релизом мы обнулили прогресс. Всё, что вы купили за звёзды, возвращается на счёт.",
     "tester.line.restored": "Купленное за звёзды",
     "tester.line.continue": "Второй шанс",
     "tester.line.continue.hint": "за купленные продолжения",
     "tester.line.bonus": "Бонус за уровень {level}",
     "tester.line.badge": "Знак «Тестер»",
     "tester.line.badge.hint": "в профиле, у друзей и в рейтинге",
     "tester.total": "Всего",
     "tester.claim": "Забрать",
     "tester.claiming": "Забираем…",
     "tester.failed": "Не получилось — попробуйте ещё раз. Ничего не потеряется."
     ```
   - Новый `i18n/tester.ts` — по образцу `i18n/test-notice.ts`.
   - В основной `ru.json` — `"tester.badge": "Тестер"`. Знак виден на трёх
     экранах, поэтому слово — в основном словаре.
3. **Событие** — сначала словарь:
   - `event-dictionary.ts`:

     ```ts
     // Тестер забрал компенсацию после вайпа (Р87, tasks/T-0043): дошли ли и сколько выдано.
     compensation_claimed: { version: 1, payload: payload({ tester: z.boolean(), bonusGems: count, restoredGems: count, continueGems: count }) },
     ```
   - `analytics.ts` — имя в списке клиента;
   - `docs/22-analytics-and-metrics.md` §3.3 — строка.
4. **Новый `state/compensation.ts`** — по образцу `state/test-notice.ts`:

   ```ts
   export interface CompensationView { tester: boolean; level: number; bonusGems: number; restored: { resource: string; amount: number }[]; continueGems: number }
   export interface CompensationApi {
     pending(): Promise<ApiResult<CompensationView | null>>;
     claim(): Promise<ApiResult<{ view: CompensationView; alreadyClaimed: boolean; balances: Record<string, number> }>>;
   }
   export function createCompensationApi(request?: ApiRequest): CompensationApi;

   /** Компенсация ждёт — запомнить её и показать окно, как только игрок в лобби. */
   export async function syncCompensation(api?: CompensationApi): Promise<void>;

   /** «Забрать»: `true` — забрано, окно можно закрыть; `false` — показать ошибку. */
   export async function claimCompensation(api?: CompensationApi): Promise<boolean>;

   /** Строки окна и сумма: только ненулевые; самоцветы купленного — суммой ресурса `gems`. */
   export function compensationLines(view: CompensationView): { restoredGems: number; continueGems: number; bonusGems: number; badge: boolean; total: number };
   ```

   - Ждущая компенсация хранится в небольшом сторе `useCompensation`
     (zustand, как другие `state/*`) — экран читает её оттуда.
   - **`syncCompensation`:**
     - `pending()`, `null` или ошибка → ничего;
     - иначе — запомнить вид и ждать лобби, как `waitForLobby`, затем
       `useNavigation.getState().push("testerThanks")`.
   - **`claimCompensation`:**
     - `claim()`;
     - успех → балансы в кошелёк клиента, как после забора подарков;
     - `track("compensation_claimed", { tester, bonusGems, restoredGems, continueGems })`
       — только при `alreadyClaimed: false`;
     - стор очищается.
5. **Новый `screens/meta/tester-thanks.tsx`** — `TesterThanksScreen`:
   - `Modal` без `onDismiss`, значок 64 px:
     - колба в тоне элиты — у тестера;
     - `Gift` — у того, кто только покупал;
   - заголовок и текст по `tester`;
   - строки из `compensationLines`, по макету:
     - значок в подложке своего тона: купленное — самоцвет, второй шанс —
       `hp`, бонус — `xp`, знак — `elite`;
     - справа «+N» и самоцвет, у строки знака — `TesterBadge`;
   - «Всего» и сумма;
   - кнопка `Button size="l" glow` `tester.claim`:
     - пока идёт запрос — `tester.claiming` и `loading`;
     - успех — `navigation.pop()`;
     - неудача — `tester.failed` над кнопкой, `role="alert"`, окно остаётся;
   - если стор пуст (открыли экран без компенсации) — сразу `pop()`;
   - экран регистрируется:
     - `ScreenId` += `"testerThanks"`;
     - `case` в `App.tsx`;
     - ленивый экран в `lazy-screens.tsx` — как `TestNoticeScreen`;
   - «Назад» на этом экране ничего не делает: обработчик стека возврата —
     пустой, как у модалок забега.
6. **`index.tsx`** — рядом с `syncTestNotice` ленивым импортом
   `syncCompensation()`. Порядок: сначала предупреждение о тесте. Если оба
   ждут лобби, окно компенсации — после закрытия предупреждения: проверка
   `waitForLobby` — «верхний экран — лобби».
7. **Знак — новый `screens/meta/tester-badge.tsx`:**

   ```tsx
   /** Знак «Тестер» (Р87): тон элиты, колба; `size="l"` — в профиле. */
   export function TesterBadge(props: { size?: "s" | "l" }): ReactNode;
   ```

   - `inline-flex shrink-0`, `font-display`: 10.5 px у `s`, 12 px у `l`;
   - `bg-elite/15 text-elite ring-1 ring-elite/40`, `rounded-sm`;
   - значок `FlaskConical` 11 или 13 px;
   - подпись — `tester.badge`.
8. **Разбор признака:**
   - `auth-api.ts`, `sessionSchema.account` — `tester: z.optional(z.literal(true))`;
   - `runs-api.ts`, строка доски — то же;
   - `friends-api.ts`, `peer` — то же;
   - `packages/shared-types`, `LeaderboardEntry` — `tester?: true`. Если тип
     строки доски клиента выводится из схемы, а не из `shared-types`, — только
     схема.
9. **Экраны:**
   - `profile.tsx` — после имени `{account?.tester ? <TesterBadge size="l" /> : null}`,
     имя и знак в одном ряду (`flex items-center gap-2`, имя — `truncate`);
   - `rating.tsx`, `LeaderboardRow` — после имени, до «Вы»:
     `{entry.tester ? <TesterBadge /> : null}`;
   - `friends.tsx` — в `PeerRow` друзей и заявок:
     `badge={peer.tester ? <TesterBadge /> : undefined}`.
10. **Документы** — раздел «Документы».

## Чего не трогаем

- Сервер — T-0042, снимок и вайп — T-0040, T-0041.
- Предупреждение о тесте и его экран — только порядок с окном компенсации.
- Строки и раскладку рейтинга, друзей и профиля сверх знака.

## Сценарий и интерфейс

По макету `design/screens/tester-thanks.html`:

1. **Тестер с покупками** — четыре строки, «Всего +222», «Забрать».
2. **Тестер без покупок** — бонус и знак.
3. **Только покупал** — «Купленное вернулось», одна строка, без знака.
4. **Не забралось** — текст ошибки, повтор той же кнопкой.
5. **Знак:**
   - профиль — после имени, крупнее;
   - рейтинг — после имени, рядом с «Вы» у своей строки;
   - друзья — после имени;
   - длинное имя обрезается, знак — нет.

Снимки на 320, 390, 768 и 1440 px снимают тимлиды при приёмке.

## Тесты

Первым коммитом.

- **`packages/app-shell/test/compensation.test.ts`:**
  - `compensationLines`:
    - `restored: [{ gems, 150 }, { coins, 40 }]`, `continueGems 12`,
      `bonusGems 60`, `tester` → `restoredGems 150`, `total 222`,
      `badge true`;
    - только покупки → `bonusGems 0`, `badge false`;
  - `syncCompensation`:
    - `pending` отдал `null` → экран не кладётся;
    - отдал вид, игрок в лобби → `push("testerThanks")`;
    - игрок в забеге → экран — только когда верхний экран снова `lobby`;
  - `claimCompensation`:
    - успех → `true`, событие с полями, стор пуст;
    - `alreadyClaimed: true` → `true`, события нет;
    - ошибка → `false`, стор на месте.
- **`packages/app-shell/test/session.test.ts`** — сессия с `account.tester: true`
  разбирается и доступна в `useSession`; без поля — как сейчас.
- **`packages/app-shell/test/friends-api.test.ts`** — друг с `tester: true`
  разбирается; без поля — как сейчас.

## Аналитика

`compensation_claimed` — шаг 3.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md`:
  - каталог экранов — строка «Спасибо за тест»: окно после вайпа, один раз,
    до забора не закрывается;
  - в строках «Рейтинг», «Друзья» и «Профиль» — знак «Тестер».
- `docs/22-analytics-and-metrics.md` §3.3 — `compensation_claimed`.

## Критерии приёмки

- [ ] После вайпа тестер видит окно в лобби один раз. «Забрать» начисляет
  компенсацию и обновляет балансы; ошибка оставляет окно с повтором.
- [ ] Тексты — дословно утверждённые.
- [ ] Знак «Тестер» — в профиле, в строках рейтинга и у друзей, только у
  тестеров.
- [ ] `compensation_claimed` в словаре и шлётся при заборе.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Окно «Спасибо за тест» и знак тестера`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: После вайпа — окно «Спасибо за тест»: купленное возвращается, тестерам — бонус и знак «Тестер» в профиле, у друзей и в рейтинге.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «СПАСИБО ЗА ТЕСТ» И ЗНАК ТЕСТЕРА**

  После вайпа тестер увидит окно «Спасибо за тест»: что вернулось из купленного и что дали сверху. Знак «Тестер» появился в профиле, у друзей и в рейтинге.

  🎁 **Как устроено**

  • окно — один раз в лобби после входа, до забора не закрывается; повтор после ошибки безопасен
  • знак — золотом элиты с колбой, после имени; у своей строки рейтинга рядом с «Вы»
  • событие compensation_claimed — видно, сколько тестеров забрали компенсацию
  ```
