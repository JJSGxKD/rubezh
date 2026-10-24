---
id: T-0072
title: Метка партнёрки Telegram у игрока — слот источника занят, процент и срок программы в настройках
epic: E14
priority: P2
status: ready
owner:
author: claude-lead2-3
size: M
depends_on: [T-0053, T-0054, T-0191, T-0199]
zones:
  - backend/api/src/modules/attribution/source-slot.ts
  - backend/api/src/modules/attribution/telegram-affiliate.repository.ts
  - backend/api/src/modules/attribution/telegram-affiliate.marker.ts
  - backend/api/src/modules/attribution/attribution.module.ts
  - backend/api/src/modules/admin/admin-players.service.ts
  - backend/api/test/telegram-affiliate.test.ts
  - backend/api/test/telegram-affiliate.integration.test.ts
  - backend/api/test/helpers/memory-telegram-affiliate.ts
  - backend/api/test/admin-players.test.ts
  - backend/api/test/settings.test.ts
  - apps/admin/src/api/players.ts
  - apps/admin/src/api/funnel.ts
  - apps/admin/src/screens/players/PlayerCardView.tsx
  - apps/admin/src/screens/players/PlayerSummary.tsx
  - apps/admin/src/screens/players/acquisition-text.ts
  - apps/admin/test/acquisition-text.test.ts
  - apps/admin/test/players.test.ts
  - apps/admin/test/funnel-review.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/23-referral-and-partner-program.md
  - docs/24-attribution-and-sharing.md
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
  - backend/api/src/modules/wipe/wipe-plan.ts
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 4
---

# T-0072. Метка партнёрки Telegram у игрока — слот источника занят, процент и срок программы в настройках

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0072.json)](README.md#значки-статуса) [![T-0053](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0053.json&label=T-0053)](T-0053-funnel-chart-screen.md) [![T-0054](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0054.json&label=T-0054)](T-0054-player-card-tabs.md) [![T-0191](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0191.json&label=T-0191)](T-0191-single-difficulty-server.md) [![T-0199](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0199.json&label=T-0199)](T-0199-reroll-for-ad.md)

## Зачем

Игрок, пришедший по ссылке партнёрской программы Telegram (`_tgr_<id>`),
сегодня виден только как первое касание в `acquisition`, причём записывается
оно позже ответа входа и может опоздать. Слот источника при этом свободен:
такого игрока ещё можно привязать к реферу друга или к партнёру по коду, а
правила Telegram этого не допускают.

После задачи:

- у такого игрока на аккаунте стоит **метка, навсегда**;
- слот источника занят ею, реферер и партнёр к нему не привязываются;
- в карточке игрока и в воронке источник называется «Партнёрка Telegram»;
- процент и срок отчислений программы лежат в «Настройках» панели — для
  будущей бухгалтерии (WP50). Деньги в этой задаче не считаются.

## Решения

**Поправка `claude-lead-1` от 21.10.2026 (приёмка #429, T-0067).** Сейчас первое касание `_tgr_` (`telegram_affiliate`) слот источника не занимает: `source-slot.ts` про него не знает, и игрок из партнёрки Telegram в первые 7 суток может быть привязан и по ссылке партнёра (T-0067), и по промокоду. Эта задача закрывает дыру в `source-slot.ts`; привязчик ссылок партнёра берёт слот через `lockSourceSlot` и подхватит правку сам. В тесты — кейс: аккаунт с первым касанием `_tgr_` не привязывается по ссылке партнёра и по коду.

- **Р97** (`docs/35-stage4-plan.md`, WP49 часть 5, 12.10.2026): игрок по ссылке
  партнёрки Telegram помечается навсегда, слот источника занят ею, реферер и
  партнёр не привязываются; процент и срок отчислений берутся из настроек
  программы бота, задаются в панели; сколько выручки уходит программе,
  считает бухгалтерия (Р98, позже, `docs/37-accounting.md`).
- **Решения claude-lead-1, 13.10.2026:**
  - метка хранится у аккаунта: вид источника «партнёрка Telegram» и код из
    параметра, как пришёл; пишется один раз;
  - приход с меткой при уже занятом слоте ничего не меняет — первый
    выигрывает, как у слота (`docs/23-referral-and-partner-program.md` §5);
  - настройки «процент программы» и «срок отчислений, месяцев» — ключи
    каталога настроек, без расчёта денег;
  - в воронке и карточке игрока источник виден как «Партнёрка Telegram»;
  - аналитика — существующее событие атрибуции с видом источника; новое
    имя только если такого события нет (оно есть, раздел «Аналитика»).
- **Как Telegram устроил программу** (официальные документы):
  - <https://core.telegram.org/api/bots/referrals> — программа создаётся для
    Mini App бота; рефералом считается тот, кто впервые запустил Mini App
    после перехода по ссылке программы; комиссия — доля звёзд, которые
    рефералы платят в Mini App;
  - <https://core.telegram.org/method/bots.updateStarRefProgram> — комиссия
    задаётся в **промилле** (`commission_permille`), срок — в **месяцах**
    (`duration_months`, не задан — программа без срока); поднять можно,
    снизить — только закрыв программу и заведя новую;
  - <https://core.telegram.org/bots/webapps#direct-link-mini-apps> — значение
    `startapp` приходит в Mini App как `start_param`.

  Формат самого параметра `_tgr_<id>` в этих документах **не описан**: он
  известен нам из боевого опыта `vpnsibcom` (`docs/13-reuse-from-vpnsibcom.md`
  §6) и уже разобран в `attribution/start-param.ts`. Разбор не меняем.
- **Метка ничего не выдаёт игроку:** ни награды, ни доступа. Она только
  закрывает слот источника и служит основанием для будущей проводки
  «Расход: программа Telegram» (`docs/37-accounting.md` §4).

## Вопросы к тимлиду

Подтверждено `claude-lead-1` 13.10.2026 — пункты 1–5 как написано. Пункт 2
следует Р97 буквально: лишняя метка закрывает слот, а пропущенная нарушила
бы правила программы; расхождение ловит сверка по выписке Telegram.

1. Процент хранится в **промилле**
   (`telegram-affiliate.commission-permille`, целое 0–1000), а не в
   процентах: Telegram считает в промилле, и 15,5% в целых процентах не
   записать без потери точности.
2. Метка ставится при **любом** приходе с `_tgr_<id>` на
   Telegram, если слот свободен, в том числе уже играющему игроку (Р97
   буквально). Telegram же засчитывает только первый запуск Mini App.
   Расхождение уйдёт в сверку по выписке Telegram (`docs/37-accounting.md`
   §8). Вариант строже — ставить метку только новому аккаунту
   (`login.created`): он рискует оставить слот открытым у игрока, которого
   Telegram считает своим, а это нарушение правил программы.
3. Срок `0` значит «без срока» — как в Telegram, где срок
   не задан. Процент `0` — «программы нет», срок тогда не важен.
4. Метка — отдельная таблица `telegram_affiliate_mark`, а не
   колонка в `account` (горячая таблица не растёт; так же устроены
   `referral_binding` и `partner_binding`). Индекса по `ref` нет — он
   появится вместе с отчётом по аффилиатам.
5. Метку видно в карточке игрока строкой (поле
   `telegramAffiliate` в ответе карточки) — шире, чем «источник называется
   так-то»: воронка считает по **первому** касанию, и игрок с меткой, чьё
   первое касание было другим, там не виден. Не нужно — убрать шаг 9 и
   строку метки из шага 10, названия видов касания оставить.
6. **Принято и не вопрос:** формат `_tgr_<id>` сверить по реальным значениям
   после выката (`account_session.start_param` при
   `start_kind = 'telegram_affiliate'`) — это делает тимлид, не задача.

## Как сейчас

- **Разбор параметра** — `backend/api/src/modules/attribution/start-param.ts`:
  - вид `telegram_affiliate` уже есть (`START_KINDS`, строка 35);
  - `TELEGRAM_AFFILIATE = /^_tgr_([A-Za-z0-9_-]{1,59})$/` (строка 49);
  - `parseStartParam` отдаёт `{ kind, raw: "_tgr_<id>", ref: "<id>" }`
    (строки 65–66); тест — `backend/api/test/start-param.test.ts:16`;
  - длина `_tgr_` плюс идентификатор не больше 64 знаков — это предел
    Telegram.
- **Вход и хуки:**
  - `auth/auth.service.ts:105-106` — Mini App: параметр берётся из
    проверенного `initData`; `:143-150` — `/start` бота (`enterChannel`);
    `:195-205` — `announce` кладёт `LoginEvent` в `AuthHooks.emit`;
  - `auth/auth-hooks.ts:37-51` — `LoginEvent`: `accountId`, `platform`,
    `place`, `startParam`, `created`, `at`, `reason`; `:67` — слушатели идут
    после ответа игроку, упавший не отменяет вход и пишется в лог.
- **Касания** — `attribution/session-recorder.ts:52` слушает вход, `:74-93`
  пишет сессию через очередь `sessions`; `sessions.repository.ts:94-117` —
  `acquisition` (первое касание — самая ранняя сессия). Запись идёт
  асинхронно через очередь, поэтому на неё слот опереть **нельзя**: решения
  о слоте принимаются в транзакции под блокировкой аккаунта.
- **Слот источника** — `attribution/source-slot.ts:16-26`:
  `SourceSlot = "free" | "referral" | "partner"`; `lockSourceSlot(tx, accountId)`
  берёт `pg_advisory_xact_lock` и смотрит `referral_binding` и
  `partner_binding`. Пользователи:
  - `referrals/referrals.repository.ts:54-65` — `bind`, `!== "free"` →
    `false`;
  - `promo-codes/promo-codes.repository.ts:304` — привязка партнёра по коду
    только при `=== "free"`.

  Метки партнёрки Telegram он не знает.
- **Ссылка дружбы** (`friends.service.ts:267`, `referrals.service.ts:76`)
  работает только с `f-<код>`; в одном запуске параметр один, поэтому `f-` и
  `_tgr_` не встречаются вместе. Дружба по `f-` с помеченным игроком
  по-прежнему возникает, а реферал — нет (`bind` вернёт `false`).
- **Каталог настроек** — `settings/setting-catalog.ts`:
  - `integer(key, group, title, hint, range, fallback)` (строки 98–105) —
    числовой ключ с пределами и единицей для панели;
  - группы — константы `…_GROUP` (строки 54, 78, 87–91);
  - последний ключ — `paymentsStars` (298–304);
  - общий тест каталога — `backend/api/test/settings.test.ts:96-121`.
- **Карточка игрока, сервер** — `admin/admin-players.service.ts`:
  `PlayerCard` (52–65), конструктор (86–101), `card()` (114–148). Модуль
  админки уже импортирует `AttributionModule`
  (`admin/admin.module.ts:79`), а тот экспортирует `SESSIONS_REPOSITORY`
  (`attribution.module.ts`, строка `exports`).
- **План вайпа** — `wipe/wipe-plan.ts:32` `WIPE_PLAN: Record<Prisma.ModelName, …>`:
  новая модель Prisma без строки в нём не компилируется; рядом
  `PartnerBinding: keep("слот источника игрока навсегда")` (строка 60).
- **Панель:**
  - `apps/admin/src/api/players.ts:96-112` — `playerCardSchema`; образец
    поля, которого старый сервер не пришлёт, — `testNotice …nullable().optional()`;
  - `screens/players/PlayerCardView.tsx:122` — `Acquisition`; локальный
    `touch` печатает сырой вид: `telegram_affiliate: <id>`. После T-0054
    «Откуда пришёл» живёт во вкладке «Сводка» (`PlayerSummary.tsx`) —
    найти функцию: `grep -rn "function Acquisition" apps/admin/src/screens/players`;
  - `apps/admin/src/api/funnel.ts:117` — `touchOf`, вид `telegram_affiliate`
    называется «Партнёрская программа Telegram». Остальные списки панели
    говорят «партнёрка Telegram» (`api/player-list.ts:20`, `api/overview.ts:61`,
    `api/broadcasts.ts:28`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»). Они падают — так и должно быть.
2. **Схема и миграция** — по процедуре «Общие файлы» в `tasks/README.md`:
   - в конец `backend/api/prisma/schema.prisma` блоком с заголовком-комментарием:

     ```prisma
     // Метка партнёрки Telegram (docs/35-stage4-plan.md Р97, T-0072)

     /// Игрок пришёл по ссылке партнёрской программы Telegram (`_tgr_<id>`).
     /// Пишется один раз и навсегда; занимает слот источника наравне с
     /// `referral_binding` и `partner_binding`
     /// (docs/23-referral-and-partner-program.md §5).
     model TelegramAffiliateMark {
       accountId  String   @id @map("account_id") @db.Uuid
       /// параметр запуска целиком, как пришёл: `_tgr_<id>`
       startParam String   @map("start_param") @db.VarChar(64)
       /// идентификатор внутри параметра
       ref        String   @db.VarChar(64)
       markedAt   DateTime @map("marked_at") @db.Timestamptz(3)

       account Account @relation(fields: [accountId], references: [accountId], onDelete: Cascade)

       @@map("telegram_affiliate_mark")
     }
     ```

   - в `model Account` — одна строка связи: `telegramAffiliateMark TelegramAffiliateMark?`
     (рядом с `partnerBinding`);
   - миграция — `prisma migrate dev --create-only` **один раз** на отдельной
     базе, после слияния со свежим `dev`; проверить, что папка одна
     (`ls backend/api/prisma/migrations | tail`). Миграция только создаёт
     таблицу и внешний ключ, существующее не трогает.
3. **`wipe/wipe-plan.ts`** — строка в «остаются: друзья, приглашения, привязки»:
   `TelegramAffiliateMark: keep("метка партнёрки Telegram — слот источника игрока навсегда")`.
   `WIPE_ORDER` и `WIPE_LOCK_TABLES` не трогать: таблица не стирается.
4. **`attribution/source-slot.ts`:**
   - `SourceSlot = "free" | "referral" | "partner" | "telegram"`;
   - в запрос — третий `EXISTS (SELECT 1 FROM telegram_affiliate_mark WHERE account_id = …) AS telegram`;
   - порядок ответа: `referral` → `partner` → `telegram` → `free`;
   - комментарий файла: слот занимают три источника, не два.
5. **Новый `attribution/telegram-affiliate.repository.ts`:**

   ```ts
   export interface TelegramAffiliateMark {
     /** параметр целиком, как пришёл: `_tgr_<id>` */
     startParam: string;
     /** идентификатор внутри параметра */
     ref: string;
     markedAt: Date;
   }
   export type MarkOutcome =
     | { status: "marked" }
     | { status: "already" }
     | { status: "slot_taken"; slot: "referral" | "partner" };
   export const TELEGRAM_AFFILIATE_REPOSITORY = Symbol("TELEGRAM_AFFILIATE_REPOSITORY");
   export interface TelegramAffiliateRepository {
     /** Поставить метку, если слот свободен. Одна на аккаунт, навсегда: повтор с другим id её не меняет. */
     mark(input: { accountId: string; startParam: string; ref: string; at: Date }): Promise<MarkOutcome>;
     byAccount(accountId: string): Promise<TelegramAffiliateMark | null>;
   }
   ```

   `PrismaTelegramAffiliateRepository`:
   - `byAccount` — `findUnique` по первичному ключу;
   - `mark`:
     1. быстрый путь: `byAccount` не `null` → `{ status: "already" }` без
        транзакции;
     2. `prisma.$transaction`: `lockSourceSlot(tx, accountId)`;
        `telegram` → `already`; `referral`/`partner` → `slot_taken` с этим
        слотом; `free` → `INSERT INTO telegram_affiliate_mark (account_id, start_param, ref, marked_at) VALUES (…) ON CONFLICT (account_id) DO NOTHING` →
        `marked`.
   - запрос — сырым SQL с типами `::uuid`, как в соседних репозиториях.
6. **Новый `attribution/telegram-affiliate.marker.ts`** — слушатель входа
   `TelegramAffiliateMarker` (`@Injectable`, `OnModuleInit`):
   - как `SessionRecorder`: `onModuleInit` подписывается
     `hooks.onLogin("telegram-affiliate", …)` только при
     `config.auth.enabled`;
   - `onLogin(login: LoginEvent): Promise<MarkOutcome | { status: "skipped" }>`
     пропускает вход (`skipped`), если не выполнено **всё**:
     - `login.reason === "launch"`;
     - `login.platform === "telegram"` (на других площадках `_tgr_` — просто
       чужой текст);
     - `startParam.kind === "telegram_affiliate"`, `raw` и `ref` не `null`;
   - иначе зовёт `marks.mark({ accountId, startParam: raw, ref, at: login.at })`;
   - исход `marked` и `slot_taken` — строка лога модуля `attribution`
     (`JSON.stringify({ module: "attribution", event, … })`, как в соседних
     модулях): события `telegram_affiliate_marked` и
     `telegram_affiliate_slot_taken` с полями `accountId`, `ref`, `place`,
     `created`; у `slot_taken` ещё `slot`. `already` не пишется — шум;
   - ошибку базы **не глотать**: `AuthHooks.emit` сам запишет
     `login_listener_failed`, метка поставится при следующем приходе по ссылке;
   - вход не ждёт слушателя (хуки идут после ответа).
7. **`attribution/attribution.module.ts`:** провайдеры
   `TelegramAffiliateMarker` и `{ provide: TELEGRAM_AFFILIATE_REPOSITORY, useClass: PrismaTelegramAffiliateRepository }`;
   `exports` += `TELEGRAM_AFFILIATE_REPOSITORY`; комментарий модуля — одна
   фраза про метку.
8. **`settings/setting-catalog.ts`** (общий файл — строки в конец
   `SETTINGS`, перед `} as const`, и константа группы рядом с другими):

   ```ts
   const TELEGRAM_AFFILIATE_GROUP = "Партнёрка Telegram";
   // …
   telegramAffiliateCommission: integer(
     "telegram-affiliate.commission-permille",
     TELEGRAM_AFFILIATE_GROUP,
     "Партнёрка Telegram: процент программы",
     "Какую долю звёзд платит Telegram партнёрам программы вашего бота, в промилле: 150 — это 15%. Впишите то, что задано в программе Telegram: здесь это справочное число для бухгалтерии, программу оно не меняет. 0 — программы нет",
     { min: 0, max: 1000, unit: ["промилле", "промилле", "промилле"] },
     0,
   ),
   telegramAffiliateDuration: integer(
     "telegram-affiliate.duration-months",
     TELEGRAM_AFFILIATE_GROUP,
     "Партнёрка Telegram: срок отчислений",
     "Сколько месяцев после первого запуска игрока Telegram платит партнёрам с его покупок. 0 — без срока, как в Telegram, где срок не задан. Справочное число для бухгалтерии",
     { min: 0, max: 120, unit: ["месяц", "месяца", "месяцев"] },
     0,
   ),
   ```

   Переменных окружения нет (`integer` их не берёт): продуктовое число правят
   в панели. Читателя у ключей пока нет — его заведёт бухгалтерия (WP50);
   код, читающий ключи, в этой задаче не пишется.
9. **`admin/admin-players.service.ts`:**
   - конструктор — **последним** параметром
     `@Inject(TELEGRAM_AFFILIATE_REPOSITORY) private readonly telegramAffiliate: TelegramAffiliateRepository`;
   - `PlayerCard` += `telegramAffiliate: TelegramAffiliateMark | null` (рядом
     с `acquisition`, комментарий: метка партнёрки Telegram, Р97);
   - в `card()` — `this.telegramAffiliate.byAccount(accountId)` в том же
     `Promise.all`;
   - права не меняются: метка — не персональные данные.
10. **Панель:**
    - **`api/players.ts`:** в `playerCardSchema`
      `telegramAffiliate: z.object({ startParam: z.string(), ref: z.string(), markedAt: iso }).nullable().optional()`
      с комментарием «сервер старее панели поля не пришлёт» (образец —
      `testNotice`);
    - **новый `screens/players/acquisition-text.ts`** — чистые функции без React:

      ```ts
      /** Названия видов касания — те же слова, что в списках и воронке. */
      export const TOUCH_TITLES: Readonly<Record<string, string>> = {
        organic: "Органика",
        click: "Ссылка кампании",
        invite: "Приглашение друга",
        friend: "Ссылка дружбы",
        telegram_affiliate: "Партнёрка Telegram",
        notification: "Кнопка уведомления в боте",
        unknown: "Неизвестно",
      };
      /** `null` → «—»; известный вид → название, с кодом через «: »; незнакомый — как есть. */
      export function touchText(kind: string | null, ref: string | null): string;
      /** Строка метки: «код x9Y-z, с 13 окт. 2026, 14:05» — дату форматирует вызывающий. */
      export function affiliateMarkText(ref: string, markedAtText: string): string;
      ```

      `affiliateMarkText("x9Y-z", "13.10.2026, 14:05")` → `код x9Y-z, с 13.10.2026, 14:05`;
    - **`Acquisition`** (в `PlayerCardView.tsx` или `PlayerSummary.tsx` — где
      она после T-0054): локальный `touch` заменить на `touchText`; в
      `KeyValue` добавить строку `["Партнёрка Telegram", affiliateMarkText(…)]`
      **только** при `card.telegramAffiliate` не `null`/`undefined`; дата —
      существующим `formatDateTime`. Пустое состояние «Касаний нет.» — только
      когда нет ни касаний, ни метки. Больше в компоненте ничего не менять;
    - **`api/funnel.ts`**, `touchOf`: заголовок вида `telegram_affiliate` —
      «Партнёрка Telegram» (уточнение — `startRef`, как сейчас).
11. **Документы** — раздел «Документы».

## Чего не трогаем

- **Деньги:** проводка «Расход: программа Telegram», начисления, расчёт доли
  выручки, чтение ключей настроек — WP50 (Р98), `docs/37-accounting.md`
  остаётся черновиком и не правится.
- **Разбор параметра**: `start-param.ts`, `broadcasts/segment.ts` и
  `START_KINDS` — вид уже есть; файлы в зоне T-0057.
- **Запись сессий и касаний** (`session-recorder.ts`, `sessions.repository.ts`)
  и `acquisition`: метка не заменяет первое касание, они живут рядом.
- **Привязка партнёра по ссылке** — T-0067: она ходит через `lockSourceSlot`
  и метку учтёт сама; в этой задаче ссылок партнёра нет.
- **Привязки друга и партнёра по коду**: `referrals.repository.ts` и
  `promo-codes.repository.ts` менять не нужно — они уже сравнивают слот с
  `"free"`. Дружба по `f-` остаётся как есть.
- **Проверка метки у Telegram:** запросов к API Telegram нет, бот ничего не
  пересылает и не сверяет.
- **Остальные списки панели** (`player-list.ts`, `overview.ts`,
  `broadcasts.ts`) и дубли названий видов в них: общий справочник видов —
  отдельный рефакторинг, не здесь.
- **Memory-подмены слота** в чужих тестовых помощниках
  (`memory-promo-codes.ts`, `memory-friends.ts`): про метку они ничего не
  знают, а слот проверяется на живой базе.
- Ежедневный отчёт в чат (`admin-notify/daily-stats*.ts`): вид
  `telegram_affiliate` в нём уже есть.

## Сценарий и интерфейс

Панель, раздел «Игроки» → карточка игрока, блок «Откуда пришёл»
(`design: null`, вид — как у соседних строк `KeyValue`):

- **метки нет, касания есть** — как сейчас, но вместо сырых кодов названия:
  «Первое касание: 21.09.2026, 10:00 — Ссылка кампании: Ab12Cd34»;
- **метка есть** — дополнительная строка «Партнёрка Telegram» со значением
  «код x9Y-z, с 13.10.2026, 14:05»; первое касание показывается как есть
  («Первое касание … — Партнёрка Telegram: x9Y-z», если пришёл первым так);
- **ни касаний, ни метки** — «Касаний нет.»;
- **метка есть, касаний ещё нет** (сессия не успела записаться) — только
  строка метки, без «Касаний нет.»;
- **загрузка, ошибка, нет сети, ограничение аккаунта** — состояния всей
  карточки, они не меняются;
- **сервер старее панели** — поля `telegramAffiliate` нет, карточка
  открывается без строки метки;
- длинный код (до 59 знаков) переносится, страница не прокручивается вбок на
  320 px — снимок строки на 320, 390, 768 и 1440 px приложить к PR.

Воронка: в таблице источников строка вида `telegram_affiliate` называется
«Партнёрка Telegram», справа от названия — `startRef`.

«Настройки» → группа «Партнёрка Telegram»: два числовых поля с единицами
(«промилле», «месяцев») — панель рисует их сама по каталогу, экран не меняется.

## Тесты

Пишутся первым коммитом, до кода. Интеграционные — на живых Postgres и Redis
(`docs/17-testing-strategy.md` §4.2), без `TEST_DATABASE_URL` пропускаются.

- **`backend/api/test/telegram-affiliate.test.ts`** (на `MemoryTelegramAffiliate`
  из `helpers/memory-telegram-affiliate.ts` — подмена репозитория с таблицей
  `marks` и `slots: Map<string, "referral" | "partner">`; вход собирается как
  в `attribution.test.ts`, функция `login(patch)`):
  - Mini App, `_tgr_x9Y-z`, платформа `telegram`, слот свободен → исход
    `marked`; в хранилище `{ startParam: "_tgr_x9Y-z", ref: "x9Y-z", markedAt: login.at }`;
  - то же с `place: "channel"` (`/start` бота) → `marked`;
  - второй приход того же аккаунта с `_tgr_other` → `already`, в хранилище
    по-прежнему `ref: "x9Y-z"`, дата не изменилась;
  - слот занят приглашением (`slots.set(id, "referral")`) → `slot_taken` со
    слотом `referral`, метки нет; то же с `partner`;
  - граница длины: `_tgr_` + 59 знаков → `marked`, `startParam.length === 64`;
  - пропуск (`skipped`, репозиторий не вызван) для: `c-Ab12Cd34`,
    `f-Ab12Cd34Ef`, `invite`, `n-friend_request`, пустого параметра,
    `_tgr_` без идентификатора, `_tgr_аб` (кириллица);
  - `reason: "reauth"` → `skipped`;
  - `platform: "max"` с `_tgr_x9Y-z` → `skipped`;
  - через `AuthHooks`: после `onModuleInit` вход, объявленный `hooks.emit`,
    доходит до репозитория; репозиторий, бросивший ошибку, не роняет
    `hooks.emit` (он резолвится); при `auth.enabled = false` слушатель не
    подписывается.
- **`backend/api/test/telegram-affiliate.integration.test.ts`** (`runner: local`,
  Postgres, как `referrals.integration.test.ts`):
  - `PrismaTelegramAffiliateRepository.mark` на новом аккаунте → `marked`;
    `byAccount` → `{ startParam, ref, markedAt }`;
  - `lockSourceSlot` внутри `prisma.$transaction`: без метки — `free`, с
    меткой — `telegram`;
  - повтор с другим идентификатором → `already`, запись прежняя;
  - аккаунт с привязкой реферала (`PrismaReferralsRepository.bind`) → `mark`
    возвращает `slot_taken` со слотом `referral`, строки метки нет;
  - аккаунт с партнёром (завести партнёра и кампанию так, как это делают
    `partners.integration.test.ts` и `promo-codes.integration.test.ts`, и
    погасить код с `partnerId`) → `slot_taken` со слотом `partner`;
  - аккаунт с меткой: `PrismaReferralsRepository.bind(...)` → `false`, строки
    в `referral_binding` нет; `PrismaPromoCodesRepository.redeem({ …, partnerId })`
    → `{ status: "redeemed", bound: false }`, строки в `partner_binding` нет;
  - **гонка:** 20 раз на новых аккаунтах `Promise.all([mark(...), referrals.bind(...)])`
    → ровно один победитель в каждом раунде (либо метка `marked`, либо `bind`
    вернул `true`), оба вместе — никогда;
  - удаление аккаунта удаляет метку (`onDelete: Cascade`).
- **`backend/api/test/wipe-plan.test.ts`** (существующий, не менять) —
  зелёный: модель `TelegramAffiliateMark` есть в плане со значением `keep`.
- **`backend/api/test/settings.test.ts`:**
  - `telegram-affiliate.commission-permille`: схема принимает `0`, `150`,
    `1000`; отказывает на `1001` («не больше 1000»), `-1` («не меньше 0»),
    `15.5` («целое число»), `"150"`; `fallback === 0`; `kind: "number"`;
    `range: { min: 0, max: 1000, unit: ["промилле", "промилле", "промилле"] }`;
    группа «Партнёрка Telegram»; `fromEnv` → `null`;
  - `telegram-affiliate.duration-months`: принимает `0` и `120`, отказывает на
    `121`; `fallback === 0`;
  - через `AdminSettingsService.save(owner, "telegram-affiliate.commission-permille", 150)`
    → `{ value: 150, source: "base", fallback: 0 }` (по образцу теста на
    `ads.interstitial.every-runs`, строки 339–343);
  - общий тест каталога (`:96-121`) остаётся зелёным.
- **`backend/api/test/admin-players.test.ts`:** `setup()` передаёт
  `MemoryTelegramAffiliate` последним аргументом конструктора;
  - карточка без метки → `telegramAffiliate: null`;
  - с меткой → `{ startParam: "_tgr_x9Y-z", ref: "x9Y-z", markedAt: <дата> }`;
  - персональные данные и права карточки не меняются: прежние кейсы зелёные.
- **`apps/admin/test/acquisition-text.test.ts`:**
  - `touchText(null, null)` → `"—"`;
  - `touchText("organic", null)` → `"Органика"`;
  - `touchText("click", "Ab12Cd34")` → `"Ссылка кампании: Ab12Cd34"`;
  - `touchText("telegram_affiliate", "x9Y-z")` → `"Партнёрка Telegram: x9Y-z"`;
  - `touchText("telegram_affiliate", null)` → `"Партнёрка Telegram"`;
  - `touchText("new_kind", "q")` → `"new_kind: q"`, `touchText("new_kind", null)` → `"new_kind"`;
  - `affiliateMarkText("x9Y-z", "13.10.2026, 14:05")` → `"код x9Y-z, с 13.10.2026, 14:05"`.
- **`apps/admin/test/players.test.ts`:** `playerCardSchema` разбирает карточку с
  `telegramAffiliate: { startParam, ref, markedAt }`, с `null` и без поля
  (старый сервер); существующие фикстуры не ломаются.
- **`apps/admin/test/funnel-review.test.ts`:**
  `touchOf({ …ROW, startKind: "telegram_affiliate", startRef: "x9Y-z" })` →
  `{ title: "Партнёрка Telegram", detail: "x9Y-z" }`; с `startRef: null` —
  `detail: null`.

## Аналитика

Новых имён событий **нет**:

- запуск по ссылке партнёрки — уже существующее `session_started` со
  `startKind: "telegram_affiliate"` (`docs/22-analytics-and-metrics.md`
  §3.3; поле `startKind` — свободный идентификатор, словарь и
  `event-dictionary.ts` не меняются);
- сама метка — **таблица**, а не событие: серверных событий в конвейере пока
  нет (`docs/22` §3.3, абзацы про `funnel_step_reached` и `currency_earned`),
  факт лежит в `telegram_affiliate_mark` с временем `marked_at`;
- строки лога модуля `attribution`: `telegram_affiliate_marked` и
  `telegram_affiliate_slot_taken` — как `referral_bound` у рефералов.

В `docs/22` §5.1 — абзац: число помеченных считается по таблице меток;
воронка по первому касанию игрока с меткой, у которого первое касание было
другим, не видит.

Нагрузка: транзакция с блокировкой аккаунта — только когда параметр
`_tgr_<id>` и метки ещё нет; у уже помеченного — чтение по первичному ключу.
Запись идёт после ответа входа.

## Настройки и окружение

- Два ключа каталога `setting-catalog.ts` (группа «Партнёрка Telegram»):
  - `telegram-affiliate.commission-permille` — целое 0–1000, умолчание `0`;
  - `telegram-affiliate.duration-months` — целое 0–120, умолчание `0`.
- Переменных окружения и секретов нет; порты не нужны.
- Значения вписывает человек в панели «Настройки» по тому, что задано в
  программе Telegram бота; сверки с Telegram нет.

## Документы

- **`docs/21-diagrams.md`:** в ER — сущность `TELEGRAM_AFFILIATE_MARK`
  (`account_id PK,FK`, `start_param`, `ref`, `marked_at`; в конец блока
  `erDiagram`), связь `ACCOUNT ||--o| TELEGRAM_AFFILIATE_MARK : "пришёл по партнёрке Telegram"`;
  в пояснение к `PARTNER_BINDING` (строки около 1131) — слот занимают три
  источника, не два.
- **`docs/23-referral-and-partner-program.md`** §5, «Как сделано» — абзац:
  слот занимает ещё и метка партнёрки Telegram (`telegram_affiliate_mark`),
  `lockSourceSlot` смотрит три таблицы; приход с меткой при занятом слоте
  ничего не меняет.
- **`docs/24-attribution-and-sharing.md`** §5 — абзац про `_tgr_<id>`:
  параметр ставит Telegram в ссылку программы бота, формат в документации
  Telegram не описан (ссылка на `core.telegram.org/api/bots/referrals`),
  разбор — `start-param.ts`, метка ставится после входа, один раз.
- **`docs/22-analytics-and-metrics.md`** §5.1 — абзац из раздела «Аналитика».
- **`docs/30-configuration-map.md`:** две строки в конец таблицы настроек —
  процент и срок программы Telegram (панель → «Настройки» → «Партнёрка
  Telegram», ключи `telegram-affiliate.*` в `settings/setting-catalog.ts`;
  читает бухгалтерия, WP50 — пока справочные); строка про метку — где
  разбор (`attribution/start-param.ts`) и где слот (`attribution/source-slot.ts`).
- **`docs/35-stage4-plan.md`**, WP49 — «Как сделано, часть 5» в формате
  соседних частей: метка, слот, настройки, ссылка на `T-0072`.

## Критерии приёмки

- [ ] Вход по `_tgr_<id>` на Telegram (Mini App и `/start` бота) ставит метку
  аккаунта с параметром как пришёл и идентификатором; метка одна и навсегда,
  повтор с другим идентификатором её не меняет.
- [ ] Метка не ставится на других площадках, при повторном входе посреди
  работы и для других видов параметра.
- [ ] Занятый слот (реферер или партнёр) метку не пускает; помеченного
  игрока реферер и партнёр по коду не привязывают. Гонка метки и привязки
  реферала на живой базе всегда даёт одного победителя.
- [ ] `lockSourceSlot` возвращает `telegram` для помеченного; вызывающие код
  не менялся.
- [ ] Модель `TelegramAffiliateMark` есть в `WIPE_PLAN` со значением `keep`.
- [ ] В «Настройках» группа «Партнёрка Telegram» с двумя числовыми ключами,
  пределами и единицами; сохранение пишется в аудит, как у соседних ключей.
- [ ] Карточка игрока показывает названия видов касания и строку метки;
  воронка называет вид «Партнёрка Telegram»; карточка открывается и с
  сервером без поля.
- [ ] Новых событий словаря нет; метка и строки лога описаны в
  `docs/22`.
- [ ] ER и документы из раздела «Документы» обновлены.
- [ ] Миграция одна и только создаёт таблицу; существующие таблицы не
  переписываются.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; интеграционные тесты —
  на живом Postgres.

## PR

- **Заголовок:** `feat(api): Метка партнёрки Telegram у игрока`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МЕТКА ПАРТНЁРКИ TELEGRAM У ИГРОКА**

  Игрок, пришедший по ссылке партнёрской программы Telegram, теперь помечается навсегда, и слот источника у него занят ею: реферер и партнёр к нему не привязываются. В карточке игрока и в воронке источник называется «Партнёрка Telegram»; процент и срок программы появились в настройках, деньги по ним пока не считаются.

  🛠 **Метка и слот**

  • метка ставится при входе по ссылке программы и не меняется; занятый слот её не пускает
  • приглашение друга и код партнёра помеченному игроку больше не засчитываются как источник

  🛠 **Панель**

  • в карточке игрока — строка «Партнёрка Telegram» с кодом и датой
  • «Настройки» → «Партнёрка Telegram»: процент (в промилле, как у Telegram) и срок в месяцах

  ❓ **Нужно от команды**

  • @владелец — после выката вписать в настройки значения из программы Telegram вашего бота: они понадобятся бухгалтерии
  ```
