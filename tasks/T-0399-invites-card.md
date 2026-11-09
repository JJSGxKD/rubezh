---
id: T-0399
title: Карточка «Приглашения» в своей личке — кто пришёл по ссылке, кто сколько сыграл, сколько монет получено
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0395, T-0396]
zones:
  - backend/api/widgets/telegram/invites.html
  - backend/api/src/modules/bot-cards/kinds/invites-card.ts
  - backend/api/src/modules/bot-cards/kinds/invites-card.module.ts
  - backend/api/src/modules/referrals/referrals-hooks.ts
  - backend/api/test/invites-card.test.ts
  - backend/api/test/referrals-hooks.test.ts
shared:
  - backend/api/src/modules/referrals/referrals.service.ts
  - backend/api/src/modules/referrals/referrals.module.ts
  - backend/api/src/modules/bot-cards/bot-card-choices.ts
  - backend/api/src/platforms/telegram/bot-card-commands.ts
  - backend/api/src/modules/account-settings/account-settings.catalog.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/app.module.ts
  - packages/app-shell/src/state/bot-notifications.ts
  - packages/app-shell/src/state/account-settings.ts
  - packages/app-shell/src/i18n/ru-bot.json
  - packages/app-shell/test/bot-notifications.test.ts
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0399. Карточка «Приглашения» в своей личке — кто пришёл по ссылке, кто сколько сыграл, сколько монет получено

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0399.json)](README.md#значки-статуса) [![T-0395](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0395.json&label=T-0395)](T-0395-live-cards-core.md) [![T-0396](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0396.json&label=T-0396)](T-0396-live-cards-telegram.md)

## Зачем

Пригласивший сейчас не знает, что друг пришёл по его ссылке и сколько
осталось до награды. Живая карточка «Приглашения» в личке бота показывает:
- сколько друзей пришло и сколько засчитано;
- кто из последних пятерых сколько сыграл до засчитывания;
- сколько монет уже получено.

Карточка приходит, когда по ссылке игрока пришёл первый друг (Р199, сценарий
«Карточка „Приглашения“»).

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52):
  - сценарий «Карточка „Приглашения“» — в своей личке: сколько друзей
    пришло по ссылке, кто сколько сыграл до засчитывания, сколько монет
    получено;
  - на MAX и VK — сообщение о пришедшем друге без обновлений;
  - аналитика — `bot_message_sent` (`kind: invites_card`), `bot_card_query`,
    `referral_activated`;
  - ключ панели — `bot.widget.invites.enabled`, выбор игрока —
    `bot.invitesCard`.
- **Раздел «Приглашения: что можно сейчас и что потом»:** на проде виджет
  живёт только в личке и не пересылается, поэтому карточка — прогресс только
  самому игроку. Пересылаемое приглашение — T-0400 и WP52 № 9, № 16.
- **Правила WP52:**
  - правило 6 — пришедший друг — сообщение, которое бот пишет сам: тихие
    часы ждут конца, со звуком — в пределах `bot.loud-per-day`;
  - правило 8 — только настоящие числа: награды из `REFERRAL_RULES`; вехи
    3/10/25/50 (`docs/23-referral-and-partner-program.md` §2.3) карточка не
    показывает и не обещает.
- **Решения тимлида:**
  - **(подтвердить владельцу) кнопка под карточкой — общая «▶ Играть»**
    ядра (`n-invites_card`), открывает главную. Отдельного входа сразу на
    экран «Друзья» нет: у ссылки запуска нет параметра экрана
    (`attribution/start-param.ts`, `ports/app-links.ts`). На карточке —
    строка «Позвать ещё — в игре, раздел «Друзья»». Вход на экран —
    отдельная задача клиента, если владелец попросит;
  - **автоматически карточка приходит один раз** — когда привязан первый
    друг игрока (за всё время, кроме отклонённых). Дальше привязки и
    засчитывания только правят живую карточку. `/friends` присылает её
    заново;
  - **«получено монет»** = засчитано × `REFERRAL_RULES.referrerCoins`. У
    аккаунта под ограничением `referral_rewards` строки с монетами нет: ему
    награда не приходит (`referrals.service.ts` `withheld`);
  - **имена друзей** — как в игре (`displayName`), до 24 знаков с «…». Их
    видит только сам пригласивший, в своей личке — как на экране «Друзья»;
  - **рефералка не знает карточек**: в модуле `referrals` появляются свои
    слушатели (`ReferralsHooks`, как `RunsHooks`). Сбой слушателя не мешает
    привязке, начислению и засчитыванию.

## Как сейчас

- `modules/referrals/referrals.service.ts`:
  - `bindReferral` (строки 100–125): привязка `bound` — лог `referral_bound`
    и стартовые монеты приглашённому;
  - `activateReferral` (строки 157–186): начисление пригласившему и
    `referrals.activate` → `true` — лог `referral_activated`;
  - оба — внутри слушателей входа и забега, после ответа игроку.
- `referrals/referrals.repository.ts`:
  - `byReferrer(referrerId, limit)` → `ReferralRow[]` (`referredId`,
    `status`: `bound` | `activated`, `boundAt`, `displayName`), без
    отклонённых, новые первыми;
  - модуль экспортирует `REFERRALS_REPOSITORY`.
- `referrals/referral-rules.ts` — `REFERRAL_RULES`: `activationRuns: 3`,
  `welcomeCoins: 100`, `referrerCoins: 300`.
- Сколько сыграл друг — `RunsRepository.stats(accountId).runs` (тот же счёт,
  что у засчитывания), `RUNS_REPOSITORY` экспортирует `RunsModule`.
- Ограничение наград за друзей — `AccountRestrictions.status(accountId, "referral_rewards", at)`.
- После T-0395 и T-0396 — как в T-0397: контракт вида, `sendLater`, `touch`,
  таблицы `CARD_COMMANDS` и `BOT_CARD_CHOICES`, HTML в
  `backend/api/widgets/telegram/`, помощник `test/widget-render.ts`.
- Выбор игрока клиента — как в T-0397, шаг 7 (`bot-notifications.ts`,
  `account-settings.ts`, `ru-bot.json`). T-0397 добавляет туда `seasonCard`:
  при конфликте сохраняются обе строки.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`referrals/referrals-hooks.ts`** — `ReferralsHooks`:
   ```ts
   export interface ReferralChange { referrerId: string; referredId: string; at: Date }
   onBound(name: string, listener: (change: ReferralChange) => Promise<void>): void;
   onActivated(name: string, listener: (change: ReferralChange) => Promise<void>): void;
   emitBound(change): Promise<void>;     // упавший слушатель — лог, не исключение
   emitActivated(change): Promise<void>;
   ```
   По образцу `runs/runs-hooks.ts` `emitRankingChanged`.
   - `referrals.module.ts`: провайдер и `exports`;
   - `referrals.service.ts`: `emitBound` после успешной привязки `bound`
     (после начисления стартовых монет), `emitActivated` — после
     `activate` → `true`. Отклонённая привязка событий не порождает.
3. **`modules/bot-cards/kinds/invites-card.ts`** — `createInvitesCard(deps): BotCardKind`:
   - `kind: "invites"`, `startRef: "n-invites_card"`, `actions: []`,
     `periodKey: () => null` (без финала).
   - `enabled: SETTINGS.botWidgetInvitesEnabled`.
   - `choice: { setting: "bot.invitesCard", byDefault: true }`.
   - `state(accountId, at)`:
     ```ts
     { b: <пришло: bound + activated>, a: <засчитано>,
       m: <монет получено> | null,          // null — ограничение наград за друзей
       f: [{ n: <имя ≤ 24>, r: <забегов, не больше activationRuns>, a: 0 | 1 }],  // до 5 последних
       w: REFERRAL_RULES.welcomeCoins, rc: REFERRAL_RULES.referrerCoins, ar: REFERRAL_RULES.activationRuns }
     ```
     - `byReferrer(accountId, 200)` — один запрос;
     - забеги — `stats` только у пяти последних незасчитанных;
     - укладывается в 1024 байта.
   - `caption(state)`:
     - друзья есть → «Приглашения · пришло друзей: {b}»;
     - нет — «Приглашения».
   - `fallback(state)` — `RichDocument`:
     - есть друзья → абзац «Новый друг по твоей ссылке: {имя последнего}.
       Когда друг сыграет {ar} забега, тебе — {rc} монет»;
     - список до пяти друзей — строки шага 4;
     - строка «Получено: {m} монет», если `m` не `null`.
4. **Тексты — без рода** (как у напоминаний, Р163): не «пришёл» и
   «засчитан», а «Новый друг по твоей ссылке: {имя}» и «засчитано».
   Ровные строки:
   - заголовок карточки — «Приглашения»;
   - «Пришло по твоей ссылке: {b}», «Засчитано: {a}»;
   - «Получено: {m} монет»;
   - строка друга — «{имя} — {r} из {ar} забегов» или «{имя} — засчитано ✓»;
   - пусто — «Пока никто не пришёл по твоей ссылке»;
   - мелко — «Другу — {w} монет сразу, тебе — {rc}, когда друг сыграет {ar}
     забега»;
   - «Позвать ещё — в игре, раздел «Друзья»».
   Слова «монет» и «забега» — по числу (`Intl.PluralRules("ru")` в HTML,
   функция склонения в `invites-card.ts`).
5. **`invites.html`** — по правилам T-0396, шаг 5, бюджет 3 300 байт:
   - тексты шага 4;
   - строки друзей — с полоской прогресса `r / ar` (ширина в процентах,
     цвет — `--tg-theme-button-color`, у засчитанного —
     `--tg-theme-accent-text-color`);
   - имена — только через `esc()`;
   - флаги `moved`, `off`, `stale`, `x`; фоновый запрос `v1:r`;
   - кнопок внутри нет.
6. **`invites-card.module.ts`** — `InvitesCardModule`:
   - импортирует `BotCardsModule`, `ReferralsModule`, `RunsModule`,
     `RestrictionsModule`;
   - `onModuleInit`, только при включённом входе:
     - `BotCardKinds.register(createInvitesCard(…))`;
     - `ReferralsHooks.onBound("invites-card", …)`: у пригласившего ровно одна
       не отклонённая привязка (первый друг) →
       `sendLater({ accountId: referrerId, kind: "invites", origin: "bot" })`,
       иначе `touch(referrerId, "invites")`;
     - `ReferralsHooks.onActivated("invites-card", …)` →
       `touch(referrerId, "invites")`;
   - строка модуля в `app.module.ts`.
7. **Таблицы и выбор игрока:**
   - `bot-card-choices.ts` — `invites: { setting: "bot.invitesCard", byDefault: true }`;
   - `bot-card-commands.ts` — `{ command: "friends", kind: "invites", description: "Мои приглашения", descriptionEn: "My invites" }`;
   - `account-settings.catalog.ts` — `"bot.invitesCard": { schema: z.boolean(), merge: "latest" }`;
   - клиент — переключатель `invitesCard` так же, как `seasonCard` в
     T-0397, шаг 7; текст `"settings.bot.invitesCard": "Приглашения в боте"`.
8. **Настройка панели** — `setting-catalog.ts`, группа «Сообщения бота»:
   `botWidgetInvitesEnabled` — `{ ...feature("bot.widget.invites.enabled", "Карточка «Приглашения»", "Живая карточка в личке пригласившего: кто пришёл по ссылке, кто сколько сыграл, сколько монет получено. Работает, когда включены сообщения нового поколения", () => null, true), group: BOT_MESSAGES_GROUP }`.

## Чего не трогаем

- Правила рефералки — привязка, антифрод на привязке, потолок засчитываний,
  начисления (`referrals.service.ts`): задача только добавляет вызовы
  слушателей.
- Вехи 3/10/25/50 — их нет в игре, карточка о них молчит.
- Приглашение и «Поделиться» (`friends/friend-invite.service.ts`) — T-0253 и
  T-0400.
- Экран «Друзья» и параметр экрана в ссылке запуска.
- Ядро карточек и адаптер (T-0395, T-0396).

## Сценарий и интерфейс

1. **Друг открыл игру по ссылке игрока** и привязался. Пригласивший
   получает карточку (ночью — в 10:00 МСК; со звуком, если не исчерпан
   дневной предел):
   - «Приглашения», «Пришло по твоей ссылке: 1», «Засчитано: 0»;
   - строка «Мирон — 0 из 3 забегов» с пустой полоской;
   - внизу — «Другу — 100 монет сразу, тебе — 300, когда друг сыграет 3
     забега»;
   - кнопка «▶ Играть» под сообщением.
2. **Друг сыграл** — полоска растёт (правка не чаще раза в 10 минут). На
   третьем засчитанном забеге — «Мирон — засчитано ✓», «Получено: 300
   монет».
3. **Пришли ещё друзья** — числа растут, в списке пять последних.
4. **`/friends`** — новая карточка, прежняя «перенесена ниже».

Пусто — «Пока никто не пришёл по твоей ссылке» (только по `/friends`).
Ограничение наград за друзей — без строки «Получено». Флаги `moved`, `off`,
`stale`, `x`. Старый клиент — подпись «Приглашения · пришло друзей: 1» и
«▶ Играть». MAX и VK — простой текст «Новый друг по твоей ссылке: Мирон…».

## Тесты

Первым коммитом.

- `backend/api/test/referrals-hooks.test.ts`:
  - привязка `bound` → `emitBound` один раз с `referrerId` и `referredId`;
  - отклонённая (`same_network`) → нет;
  - засчитывание → `emitActivated`; повторное (`activate` → `false`) → нет;
  - слушатель бросает → привязка и начисление прошли, лог, исключения нет;
  - `ReferralsModule` экспортирует `ReferralsHooks`.
- `backend/api/test/invites-card.test.ts`:
  - `state`:
    - 7 привязок (2 засчитаны) → `b: 7`, `a: 2`, `m: 600`, `f` — 5 последних
      по `boundAt`, у незасчитанных `r` из `stats`, ограниченный сверху `ar`;
    - `stats` вызван не больше 5 раз;
    - ограничение `referral_rewards` → `m: null`;
    - имя из 40 знаков → 24 с «…»;
    - пять имён по 24 кириллических знака укладываются в 1024 байта;
  - слушатели:
    - первая привязка → `sendLater` с `origin: "bot"` для пригласившего;
    - вторая → `touch`;
    - засчитывание → `touch`;
  - `caption` и `plainTextOf(fallback(state))` — ровно ожидаемые строки, без
    слов «вех», «10 друзей» и чисел, кроме `REFERRAL_RULES` и счётчиков;
  - регистрация: вид `invites`, команда `friends`, строка `BOT_CARD_CHOICES.invites`;
  - отрисовка `invites.html` (`renderWidget`):
    - «Пришло по твоей ссылке: 7», «Получено: 600 монет», «Мирон — 2 из 3
      забегов», «засчитано ✓»;
    - имя `<img src=x onerror=1>` выводится текстом (в `app()` нет `<img`);
    - `m: null` → строки «Получено» нет;
    - пустой `f` и `b: 0` → «Пока никто не пришёл»;
    - формы: 1 забег, 2 забега, 5 забегов;
    - первый запрос — `v1:r`.
- `packages/app-shell/test/bot-notifications.test.ts`: `invitesCard` в
  `BOT_NOTIFY_KEYS`, умолчание `true`, ключ `bot.invitesCard`.
- `scripts/test/account-settings-keys.test.ts` (кейс T-0395) проходит со
  строкой `invites`.
- Существующие тесты рефералки (`referrals*.test.ts`) проходят без правок.

## Аналитика

Новых событий нет. Пишет ядро:
- `bot_message_sent` (`kind: "invites_card"`);
- `bot_card_query` (`card: "invites"`, `action: "refresh"`).

`referral_activated` — существующий лог рефералки. Возврат — `start_ref = n-invites_card`.

## Настройки и окружение

- `bot.widget.invites.enabled` — вкл., группа «Сообщения бота»; действует
  при включённом `bot.formats.enabled`.
- Ключ аккаунта `bot.invitesCard` (умолчание — вкл.).
- Строка 90 `docs/30-configuration-map.md` ключ уже называет — правки нет.

## Документы

Нет: ключи и сценарий уже описаны в `docs/35` WP52 и `docs/30`.

## Критерии приёмки

- [ ] Первый друг, привязанный по ссылке игрока, присылает пригласившему
      карточку по правилам звука и тихих часов; привязки и засчитывания
      правят её.
- [ ] Карточка показывает пришедших, засчитанных, монеты (кроме ограничения
      наград) и до пяти последних друзей с прогрессом «N из 3»; вех нет.
- [ ] Имена друзей выводятся только текстом.
- [ ] Рефералка не импортирует карточки; сбой слушателя не влияет на
      привязку и начисления.
- [ ] `/friends` присылает карточку заново; переключатель «Приглашения в
      боте» в настройках игры, умолчания клиента и сервера совпадают.
- [ ] `invites.html` проходит тест бюджета и отрисовки.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Карточка «Приглашения» в личке бота`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое [telegram]: когда по твоей ссылке приходит друг, бот присылает карточку приглашений — кто пришёл, кто сколько сыграл, сколько монет получено; прислать заново — /friends`
  - `- новое: в настройках — переключатель «Приглашения в боте»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТОЧКА «ПРИГЛАШЕНИЯ»**

  Когда по ссылке игрока приходит первый друг, бот присылает ему живую карточку приглашений: сколько пришло, сколько засчитано, кто сколько сыграл до засчитывания и сколько монет получено (Р199). Привязки и засчитывания правят её сами.

  🛠 **Что внутри**

  • только настоящие числа из правил рефералки; вех 3/10/25/50 карточка не обещает
  • рефералка получила свои слушатели — карточки она не знает
  • команда /friends и переключатель «Приглашения в боте» в настройках

  ⚙️ **Настройки**

  • панель → «Сообщения бота»: bot.widget.invites.enabled (вкл.; работает при включённом bot.formats.enabled)

  ❓ **Нужно от команды**

  • @владелец — подтвердить: под карточкой общая кнопка «▶ Играть» на главную, отдельного входа сразу на «Друзья» пока нет
  ```
