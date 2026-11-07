---
id: T-0377
title: Привязка аккаунта MAX и VK к игровому — основа заданий «подпишись через бота»
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/external-identity/**
  - backend/api/src/platforms/ports/external-link.ts
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/src/modules/tasks/tasks.service.ts
  - backend/api/src/modules/tasks/tasks-errors.ts
  - backend/api/src/modules/tasks/tasks.controller.ts
  - backend/api/src/modules/tasks/tasks.module.ts
  - backend/api/test/external-identity.test.ts
  - backend/api/test/external-identity.integration.test.ts
  - backend/api/test/tasks-external-channel.test.ts
  - packages/app-shell/src/screens/meta/tasks.tsx
  - packages/app-shell/src/state/tasks-api.ts
  - packages/app-shell/test/tasks-external-channel.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/src/app.module.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/src/i18n/ru.json
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0377. Привязка аккаунта MAX и VK к игровому — основа заданий «подпишись через бота»

## Зачем

Владелец хочет растить канал в MAX и сообщество во VK заданиями в игре, хотя
сама игра пока только в Telegram (Р188). Подписку на чужой площадке сервер
проверит, только если знает, кто этот игрок там. После задачи у игрока
Telegram есть задание «подпишитесь на канал MAX» (или «вступите в сообщество
VK»):
1. он открывает бота площадки по ссылке с одноразовым кодом;
2. бот связывает его id на площадке с игровым аккаунтом;
3. игрок подписывается;
4. игрок жмёт «Проверить» и получает награду.

Эта задача — общая основа: связь аккаунтов, код, видимость и проверка задания.
Боты площадок подключают T-0378 (VK) и T-0379 (MAX).

## Решения

Р188 (`docs/35-stage4-plan.md`, 31.10.2026):
- задания MAX и VK делаются сейчас;
- путь игрока: задание → бот по ссылке с одноразовым кодом → связь id
  площадки с игровым аккаунтом → канал → проверка подписки сервером;
- **один id площадки — один игровой аккаунт**;
- связь служит заданиям, а не входу.

Уточнения `claude-lead-1` (антифрод и устройство — по Р188, без нового
продуктового выбора):

- **Связь постоянная.** Связанный id площадки не освобождается и второй раз не
  связывается ни с кем. У игрового аккаунта на каждой площадке — одна связь.
  Перепривязка — только через поддержку, вне этой задачи. Иначе один аккаунт MAX
  по очереди закрыл бы задания многим игровым аккаунтам.
- **Код одноразовый:**
  - 16 случайных знаков `[A-Za-z0-9]`;
  - живёт 30 минут;
  - забирается атомарно (`GETDEL`): два бота не применят один код дважды.
  Выдача кодов ограничена лимитом частоты на аккаунт.
- **Видимость.** Канал другой площадки виден игроку, только если у этой площадки
  есть **и** проверка подписки (`ChannelMemberships.for`), **и** выдача ссылки на
  бота (порт этой задачи). Пока бот площадки не подключён (T-0378, T-0379), её
  каналы не видны никому, кроме игроков самой площадки.
- **Проверка.** У канала своей площадки — как сейчас, по `account.platformUserId`.
  У чужой — по связанному id. Связи нет — отказ `task_link_required` с текстом
  «сначала откройте бота».

## Как сейчас

- **Видимость.** `backend/api/src/modules/tasks/task-rules.ts:216` —
  `visibleOn(params, platform)`: цель канала видна только игрокам площадки
  `params.platform`. `CHANNEL_PLATFORMS = telegram | max | vk` (~185),
  `taskParamsSchema` (~198): `platform`, `chat`, `url`.
- **Проверка.** `backend/api/src/modules/tasks/tasks.service.ts`:
  - `checkJoined` (~291) берёт `this.memberships.for(params.platform)` и спрашивает
    `isMember(chat, account.platformUserId)`;
  - нет проверки → `TaskCheckUnavailableError`, не подписан → `TaskNotJoinedError`
    (`tasks-errors.ts:32`, 409 `task_not_joined`);
  - `visible()` (~426) фильтрует `visibleOn(def.params, account.platform)`.
- **Порт.** `backend/api/src/platforms/ports/channel-membership.ts` —
  `ChannelMembership { platform; isMember(chat, platformUserId) }`,
  `ChannelMemberships.for(platform)`. Адаптер есть только у Telegram
  (`platforms/telegram/telegram-channel-membership.ts`).
- **Аккаунт.** `Account` — `@@unique([platform, platformUserId])`
  (`schema.prisma` ~172-260): одна площадка на аккаунт. Связей с другими
  площадками нет.
- **Клиент.**
  - `packages/app-shell/src/screens/meta/tasks.tsx` — карточка партнёрского
    задания: «Перейти» открывает `params.url`, «Проверить» забирает награду;
  - `state/tasks-api.ts` разбирает ошибки (`task_not_joined` и др.);
  - открытие внешней ссылки — `PlatformAdapter.openLink?` (`packages/shared-types/src/index.ts` ~211).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** (одна папка, `--create-only` на свежем `dev`, только добавление).
   Таблица `external_identity`:

   ```sql
   "account_id" UUID NOT NULL REFERENCES "account"("account_id") ON DELETE CASCADE,
   "platform" "Platform" NOT NULL,
   "external_user_id" VARCHAR(64) NOT NULL,
   "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
   PRIMARY KEY ("account_id", "platform"),
   UNIQUE ("platform", "external_user_id"),
   CHECK ("platform" IN ('max', 'vk'))
   ```

   - Модель `ExternalIdentity` в `schema.prisma`, комментарии `///` на русском.
   - `wipe-plan.ts`: таблица в план вайпа, как остальные данные аккаунта, и его
     тест.
   - План отката — в описание PR. Миграция только добавляет, откат кода
     безопасен.
3. **Порт `platforms/ports/external-link.ts`:**

   ```ts
   /** Ссылка на бота площадки с одноразовым кодом: игрок открывает её, бот получает код вместе с id игрока. */
   export interface ExternalLinkStarter {
     readonly platform: PlatformId;
     /** `null` — площадка сейчас не настроена (нет бота или ключа) */
     startUrl(code: string): string | null;
   }
   export class ExternalLinkStarters {
     constructor(private readonly all: readonly ExternalLinkStarter[]) {}
     for(platform: PlatformId): ExternalLinkStarter | null;
   }
   ```

   Провайдер с пустым списком — в модуле этой задачи. Адаптеры добавят себя в
   T-0378 и T-0379. Модули домена импортируют только порт.
4. **Модуль `modules/external-identity/`** (новый, подключается в
   `app.module.ts`, сервис — в `exports`):
   - `external-identity.repository.ts`:
     - `find(accountId, platform)`;
     - `link(accountId, platform, externalUserId): "linked" | "already" | "taken"`.
     Это одна вставка `INSERT … ON CONFLICT DO NOTHING`, после неё — чтение, кто
     владеет парой: `already` — та же связь уже есть; `taken` — id площадки занят
     другим аккаунтом или у аккаунта другая связь на этой площадке.
   - `link-codes.ts` — коды в Redis:
     - ключ `ext-link:<code>` → `{ accountId, platform }`, `SET … EX 1800 NX`;
     - забор — `GETDEL`;
     - код — `randomBytes`, 16 знаков `[A-Za-z0-9]`.
   - `external-identity.service.ts`:
     - `startLink(account, platform): Promise<{ url: string }>`:
       - платформа аккаунта совпадает с `platform` → `ValidationError`;
       - связь уже есть → всё равно ссылка: бот ответит «уже связано» и даст
         канал;
       - лимит — не больше 10 кодов в час на аккаунт (`RateLimiter`, как у соседних
         модулей) → `RateLimitedError`;
       - `ExternalLinkStarters.for(platform)?.startUrl(code) ?? throw LinkUnavailableError`
         (503 `link_unavailable`, «Бот площадки сейчас недоступен — попробуйте позже»).
     - `consume(platform, code, externalUserId): Promise<"linked" | "already" | "taken" | "expired">` —
       зовут адаптеры ботов. Неверный или протухший код → `expired`. Аккаунт,
       которого больше нет (вайп) → `expired`.
     - `externalId(accountId, platform): Promise<string | null>`.
     - Событие аналитики `external_account_linked` на каждый исход `consume`, кроме
       `expired`. Поля — раздел «Аналитика».
5. **Задания — `task-rules.ts`, `tasks.service.ts`, `tasks-errors.ts`, контроллер:**
   - `visibleOn(params, platform, linkable: ReadonlySet<PlatformId>)`: канал своей
     площадки — как сейчас; канал другой площадки — если она в `linkable`. Остальные
     виды не меняются. `linkable` сервис собирает из площадок, у которых есть и
     `ChannelMemberships.for`, и `ExternalLinkStarters.for` со `startUrl` не `null`;
   - `checkJoined`: площадка канала совпадает с площадкой аккаунта — как сейчас.
     Иначе `externalId(account, platform)`: `null` → `TaskLinkRequiredError`
     (409 `task_link_required`, текст «Сначала откройте бота и нажмите «Начать» —
     так мы узнаем ваш аккаунт»); иначе `isMember(chat, externalId)`;
   - вид задания для клиента получает поле `link: "own" | "external"` у
     заданий-каналов. `external` — канал другой площадки: клиенту нужна кнопка бота;
   - `POST /tasks/:taskId/link` (игровой, под авторизацией игрока, лимит частоты
     как у `claim`) → `{ data: { url } }`. Задание не канал или канал своей
     площадки → 400.
6. **Клиент — `tasks-api.ts`, `tasks.tsx`, `ru.json`:**
   - у задания с `link: "external"` первая кнопка — «Открыть бота MAX» /
     «Открыть сообщество VK» (ключи `tasks.external.open.max`,
     `tasks.external.open.vk`): `POST …/link`, затем `adapter.openLink(url)`.
     Вторая — «Проверить», как у каналов;
   - подсказка под карточкой: «Бот спросит разрешение и пришлёт ссылку на канал.
     Подпишитесь и вернитесь сюда — нажмите «Проверить».» (ключ
     `tasks.external.hint`);
   - `task_link_required` → тост «Сначала откройте бота и нажмите «Начать»»;
     `link_unavailable` → «Бот площадки сейчас недоступен — попробуйте позже»;
     `rate_limited` — общий текст.
7. **Документы** — раздел «Документы».

## Чего не трогаем

- **Боты площадок:** вебхуки, отправка сообщений и проверка подписки MAX и VK —
  T-0379 и T-0378.
- **Вход по аккаунту MAX или VK:** связь — только для заданий. `Account` и вход не
  меняются.
- **Перепроверка отписки** (T-0178) — только Telegram, как в её спецификации.
  Отписку на MAX и VK — отдельной задачей после этих.
- **Панель:** просмотр и снятие связей в карточке игрока — позже, отдельной
  задачей.
- **Задания каналов своей площадки** — поведение прежнее.

## Сценарий и интерфейс

Игрок Telegram, вкладка «Партнёры», задание «Подпишитесь на канал в MAX»:

1. «Открыть бота MAX» → в MAX открывается бот, игрок жмёт «Начать». Бот отвечает:
   «Готово, аккаунт связан» и ссылкой на канал (T-0379).
2. Игрок подписывается, возвращается в игру, жмёт «Проверить» → награда.

Состояния:

- **ещё не связан** — «Проверить» → тост «Сначала откройте бота и нажмите «Начать»»;
- **связан, не подписан** — прежний `task_not_joined`: «Подписка не найдена —
  подпишись и нажми ещё раз»;
- **бот недоступен** — тост `link_unavailable`, кнопки не блокируются;
- **нет сети** — общий тост сети;
- **лимит** — общий текст лимита.

Снимки карточки — 320, 390 и ландшафт 667×375.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/external-identity.test.ts` (чистые и на подменах):
  - код — 16 знаков из алфавита, два кода разные;
  - `startLink`:
    - своя площадка → 400;
    - нет стартера → `link_unavailable`;
    - 11-й код за час → `rate_limited`;
  - `consume`:
    - неизвестный код → `expired`;
    - код применяется один раз — второй `consume` того же кода → `expired`.
- `backend/api/test/external-identity.integration.test.ts` (живые Postgres и
  Redis):
  - первая связь → `linked`, повтор той же пары → `already`;
  - тот же id MAX с другим аккаунтом → `taken`, у второго аккаунта связи нет;
  - у аккаунта уже есть связь MAX, новый id MAX → `taken`, прежняя связь цела;
  - два параллельных `consume` одного кода → ровно один `linked`, второй `expired`;
  - вайп аккаунта удаляет его связи (`wipe-plan`).
- `backend/api/test/tasks-external-channel.test.ts`:
  - канал MAX у игрока Telegram без стартера MAX → задание не видно;
  - со стартером и проверкой → видно, `link: "external"`;
  - канал Telegram у игрока Telegram → `link: "own"`, проверка по
    `platformUserId`, как раньше (существующие тесты заданий без правок);
  - «Проверить» без связи → `task_link_required`;
  - со связью → `isMember(chat, externalId)` с id площадки, а не Telegram;
  - не подписан → `task_not_joined`.
- `packages/app-shell/test/tasks-external-channel.test.ts`:
  - кнопка «Открыть бота MAX» зовёт `/link` и `openLink` с ответом;
  - `task_link_required` и `link_unavailable` показывают свои тексты.

## Аналитика

Новое событие `external_account_linked` — сначала в словарь
`docs/22-analytics-and-metrics.md` §3.3 и в словарь сервера с Zod-схемой
`backend/api/src/modules/events/event-dictionary.ts`, потом в код. Поля:
- `platform`: `max` | `vk`;
- `result`: `linked` | `already` | `taken`.

`account_id` — как у всех событий. Id площадки в событие **не** пишется.
Prometheus — счётчик `external_link_total{platform,result}`, низкая
кардинальность.

## Настройки и окружение

Нет: ключи ботов — в T-0378 и T-0379.

## Документы

- `docs/35-stage4-plan.md`: Р188 — «Как сделано»: таблица связей, код, видимость,
  отказ `task_link_required`.
- `docs/21-diagrams.md`: ER (`EXTERNAL_IDENTITY`), поток «задание → бот → связь →
  проверка».
- `docs/22-analytics-and-metrics.md` §3.3: событие `external_account_linked`.

## Критерии приёмки

- [ ] Один id площадки связан не больше чем с одним игровым аккаунтом, и связь
  постоянна. Параллельные коды это не ломают.
- [ ] Канал MAX или VK виден игроку Telegram, только когда площадка подключена
  ботом и проверкой.
- [ ] «Проверить» без связи отвечает `task_link_required`, со связью проверяет
  подписку по id площадки.
- [ ] Задания каналов своей площадки работают как раньше.
- [ ] Код одноразовый, живёт 30 минут, выдача ограничена лимитом.
- [ ] Гейт и `pnpm docs:check` зелёные. В PR — чек-листы `docs/15` §7 и §8 и
  план отката миграции.

## PR

- **Заголовок:** `feat(tasks): Связь аккаунта MAX и VK для заданий через бота`
- **Метка:** `release: minor`
- **Для игроков:** нет, пока боты не подключены (T-0378, T-0379). Раздела
  `## Для игроков` в описании PR нет.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОСНОВА ЗАДАНИЙ «ПОДПИШИСЬ ЧЕРЕЗ БОТА» ДЛЯ MAX И VK**

  Сервер научился связывать аккаунт игрока в MAX или VK с игровым: игрок открывает бота площадки по ссылке с одноразовым кодом, и проверка подписки на канал идёт по его id там. Каналы MAX и VK появятся у игроков, когда подключим ботов — следующими задачами.

  🛠 **Что внутри**

  • один аккаунт площадки — один игровой аккаунт, связь постоянная
  • код живёт 30 минут и применяется один раз
  • без связи «Проверить» просит сначала открыть бота
  ```
