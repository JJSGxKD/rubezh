---
id: T-0162
title: Юзернейм бота в имени и bio — модуль на сервере: проверка, награда, серия, ночной проход
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0159]
zones:
  - backend/api/src/modules/bot-mention/**
  - backend/api/test/bot-mention.test.ts
  - backend/api/test/bot-mention-sweep.test.ts
  - backend/api/test/bot-mention.integration.test.ts
  - backend/api/test/bot-mention.http.test.ts
shared:
  - docs/30-configuration-map.md
  - docs/21-diagrams.md
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/*_bot_mention/**
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/app.module.ts
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0162. Юзернейм бота в имени и bio — модуль на сервере: проверка, награда, серия, ночной проход

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0162.json)](README.md#значки-статуса) [![T-0159](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0159.json&label=T-0159)](T-0159-bot-mention-server.md)

## Зачем

Р110 (`docs/35-stage4-plan.md`): игрок вписывает юзернейм бота игры в своё имя
на площадке и, отдельно, в bio, а сервер каждые игровые сутки проверяет, что он
на месте, и платит за сутки. Так игра получает показы в профилях, а игрок
понятную ежедневную награду. Эта задача — серверный модуль поверх порта
`BotMentions` из T-0159: таблица состояния, проверка видов «имя» и «bio»,
награда и серия, ручная проверка, ночной проход, ключи настроек. Экран — T-0160.

## Решения

**Поправка `claude-lead-1` от 21.10.2026 (приёмка #400).** Порт T-0159 приводит `platformUserId` к числу (`Number(...)` в `platforms/telegram/telegram-bot-mention.ts`), а проверка `^\d{1,20}$` пропускает и 20 цифр — число больше `Number.MAX_SAFE_INTEGER` теряет точность. Реальные id Telegram укладываются в 52 бита, но раз модуль этой задачи зовёт порт: проверка id перед вызовом — не длиннее 15 цифр, или id передаётся строкой; кейс в тестах. Файл порта при необходимости — в зоны этой задачи.

- **Р110** (19.10.2026, `docs/35-stage4-plan.md`), дословно по сути: два
  задания с ежедневной проверкой — юзернейм бота в имени игрока на площадке и,
  отдельно, в bio. Награда за каждые сутки, пока юзернейм стоит, серия растёт;
  убрал — награды за сутки нет, штрафа нет. Проверяет сервер раз в игровые
  сутки только у начавших задание, пачками в пределах лимитов API площадки.
  Bio скрыто настройкой приватности — задание говорит, что проверить нельзя.
  Проверка — через порт площадки (T-0159); у площадок без такой возможности
  заданий нет.
- Решение claude-lead-1 от 19.10.2026: **размер награды за сутки** — ключи
  панели с умолчанием 0 и выключателем, выключено по умолчанию; значения
  ставит геймдизайнер в панели. Вид с нулевой наградой игроку не показывается.
  Для ориентира: из забегов активный игрок получает около 1 300 монет в сутки
  (`modules/daily/daily-rules.ts`), суточный потолок причины `task_reward` —
  10 000 монет, 50 самоцветов, 100 осколков (`modules/wallet/wallet-limits.ts:27`).
- Решение claude-lead-1 от 19.10.2026: **серия** — число игровых суток подряд
  с полученной наградой. Пропуск (убрал юзернейм, проверка не прошла, игрок не
  заходил) обнуляет серию без штрафа и награду не отнимает. Награда за сутки
  одинакова при любой серии, надбавки за длину серии нет; серия — счётчик на
  экране.
- Решение claude-lead-1 от 19.10.2026: **кнопка «Проверить»** у игрока есть —
  одна ручная проверка на вид в игровые сутки (с лимитом частоты). Иначе
  вписавший юзернейм днём терял бы сутки. Ночной проход по остальным суткам не
  отменяется.
- Решение claude-lead-1 от 19.10.2026: **«юзернейм стоит»** — `@юзернейм` бота
  без учёта регистра, с границами слова; без `@` не считается (реализовано в
  `containsMention`, T-0159).
- Решение claude-lead-1 от 19.10.2026: **бросивших не перестаём проверять**
  (одна проверка на аккаунт в сутки, пачками в пределах лимитов); нагрузку
  замерить после выката и вернуться к отсечке, если бросивших станет много
  (строка в разделе «Чего не трогаем»).
- Решение claude-lead-1 от 19.10.2026: пустое и закрытое bio неразличимы — один
  исход `hidden`, награды за такие сутки нет, как за `absent`.
- **Р111**: из показываемого ника юзернейм бота вырезается. Это не мешает
  проверке: она читает имя, пришедшее от площадки, а не `Account.displayName`.
- **Р53**: переключатель и числа, меняемые без релиза, — ключи каталога
  настроек (`setting-catalog.ts`), панель сильнее `.env`.
- **Платформенная нейтральность** (Р22, `docs/35-stage4-plan.md` §3.11): домен
  просит порт `BotMentions` (T-0159), Telegram знает только его адаптер.
- Уточнения `claude-lead2-1` по записанным решениям (механика, не продукт):
  - **Игровые сутки** — `gameDayOf` из `modules/tasks/task-pool.ts`, граница
    полночь по Москве. Награда за сутки платится один раз; ключ кошелька
    содержит дату.
  - **Одна проверка на аккаунт, а не на задание**: имя и bio приходят одним
    `getChat`, поэтому порт принимает список видов, а не один.
  - **Награда начисляется сразу**, без «забрать»: проверка идёт ночью, когда
    игрока в игре нет, а невзятая награда сгорала бы со сменой суток.
  - **Причина кошелька — `task_reward`** (суточный потолок общий с заданиями),
    источник `bot-mention:<вид>`. Новой причины не заводим: потолки — отдельное
    решение (`wallet-limits.ts`).
  - **Текст имени и bio нигде не сохраняется и не пишется в лог** — только
    итог проверки.
- Задача выделена из прежней T-0159 вместе с портом площадки (решение
  claude-lead-1 от 19.10.2026): порт и `getChat` — T-0159, этот модуль — здесь.

## Как сейчас

- Порт `BotMentions` (`platforms/ports/bot-mention.ts`: `MentionKind`,
  `MentionFinding`, `MentionOutcome`, `BotMention`, `BotMentions.for(platform)`)
  и адаптер Telegram приходят из T-0159; `BotMentions` экспортирует
  `@Global()`-модуль платформ (`platforms/platforms.module.ts`).
- `backend/api/src/platforms/ports/messenger.ts:19–40` — образец порта с темпом:
  поле `ratePerSec` и исходы `retry`/`blocked`/`failed`. Пачку по этому темпу
  отправляет `modules/broadcasts/broadcast-sender.ts:45–80` (пауза
  `1000 / ratePerSec` между вызовами, `retry` обрывает пачку).
- `backend/api/src/modules/tasks/tasks.service.ts:142–186` — образец выдачи
  награды: `wallet.grant` с ключом `task:<аккаунт>:<задание>:<срок>:<ресурс>`,
  потом отметка в базе. `network-tasks.service.ts:200–222` — то же для заданий
  сетей. Подписку на канал с повтором проверяет бот по нажатию игрока
  (`tasks.service.ts:236–253`) — наше задание другого рода: проверка идёт сама.
- `backend/api/src/modules/seasons/season-close.job.ts:1–70` и
  `export/retention.job.ts:50–66` — образец периодического задания BullMQ с
  `upsertJobScheduler`. Лок на время прохода — Redis `SET NX PX` с освобождением
  скриптом (`seasons-close.service.ts:27, 60, 102`).
- `backend/api/src/modules/tasks/task-pool.ts:26` — `gameDayOf(at)`: `YYYY-MM-DD`
  по Москве. `common/game-day.ts` — константа пояса.
- `backend/api/src/modules/settings/setting-catalog.ts:127–143` — помощники
  `integer(…)` и `feature(…)`; группа «Онлайн» (строка 115) — образец группы
  чисел.
- `backend/api/src/modules/tasks/tasks.controller.ts:14–40, 49–56` — образец
  маршрута: `@UseGuards(AuthGuard)`, `accountOf(request)`, `RateLimiter`.
- `Account.platformUserId` (`prisma/schema.prisma:165`) — id игрока на площадке
  (у Telegram — число; у аккаунта разработчика `dev-…`).

Чего не хватает: таблицы состояния, модуля с проверкой раз в сутки, ключей
настроек.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема и миграция** (`schema.prisma` блоком в конце с заголовком
   `// Задания «юзернейм бота» (T-0162)`; связь в `Account` — одной строкой).
   Миграция только добавляет таблицу (expand); откат — `DROP TABLE`:

   ```
   bot_mention_task
     account_id     uuid  PK, FK account ON DELETE CASCADE
     kind           varchar(4)  PK, CHECK in ('name','bio')
     started_at     timestamptz(3) not null
     streak         int not null default 0        -- серия на последние сутки с наградой
     best_streak    int not null default 0
     rewarded_days  int not null default 0
     last_day       date null                     -- последние игровые сутки с наградой
     checked_day    date null                     -- игровые сутки последней проверки с исходом
     checked_at     timestamptz(3) null
     last_result    varchar(11) null, CHECK in ('present','absent','hidden','unavailable')
     INDEX (checked_day)                          -- выбрать тех, кого пора проверять
   ```

   `CHECK` пишется в `migration.sql` руками, как в
   `20261014074456_task_pool_rotation`. Миграция генерируется один раз
   (`prisma migrate dev --create-only`), после перебазирования на свежий `dev`
   (`tasks/README.md`, «Общие файлы»); после — проверить, что новая папка
   `*_bot_mention` ровно одна.
3. **Ключи настроек** (`setting-catalog.ts`; группа `const BOT_MENTION_GROUP =
   "Юзернейм бота"`, переключатель — через `feature(…)`, без окружения):

   | Ключ | Название в панели | Пределы | Умолчание |
   |---|---|---|---|
   | `bot-mention.enabled` | Задания «юзернейм бота» | вкл/выкл | выкл |
   | `bot-mention.name.coins` | Имя: монеты за сутки | 0–10000 | 0 |
   | `bot-mention.name.gems` | Имя: самоцветы за сутки | 0–50 | 0 |
   | `bot-mention.name.shards` | Имя: осколки за сутки | 0–100 | 0 |
   | `bot-mention.bio.coins` | Bio: монеты за сутки | 0–10000 | 0 |
   | `bot-mention.bio.gems` | Bio: самоцветы за сутки | 0–50 | 0 |
   | `bot-mention.bio.shards` | Bio: осколки за сутки | 0–100 | 0 |

   Подсказка переключателя: «Игрок вписывает юзернейм бота в имя или bio, сервер
   раз в игровые сутки проверяет и платит за сутки. Вид без награды игрокам не
   показывается». Пределы — суточные потолки `task_reward`
   (`wallet-limits.ts:27`): награда больше потолка всё равно срезалась бы.
4. **Модуль `modules/bot-mention/`** (файлы короче 300 строк):
   - `bot-mention-rules.ts` — `BOT_MENTION_KINDS = ["name","bio"]`,
     `activeStreak(row, today)` (серия, если `last_day` — сегодня или вчера, иначе
     0), `rewardOf(kind, settings)`, `offered(kind, reward)` (сумма награды > 0);
   - `bot-mention.repository.ts` — интерфейс и Prisma-реализация на `$queryRaw`
     (образец — `network-tasks.repository.ts`), токен
     `BOT_MENTION_REPOSITORY`:
     - `ensure(accountId, kind, at)` — `INSERT … ON CONFLICT DO NOTHING`;
     - `rows(accountId)` — состояние игрока;
     - `markChecked(accountId, kind, day, result, at)` — пишет `checked_day`,
       `checked_at`, `last_result`; результат `present` здесь не используется;
     - `rewardDay(accountId, kind, day, at)` — **один `UPDATE`**, он же отметка
       проверки:
       `SET streak = CASE WHEN last_day = $day::date - 1 THEN streak + 1 ELSE 1 END,
       best_streak = GREATEST(best_streak, <новая серия>), rewarded_days = rewarded_days + 1,
       last_day = $day, checked_day = $day, checked_at = $at, last_result = 'present'
       WHERE account_id = … AND kind = … AND last_day IS DISTINCT FROM $day`;
       возвращает строку или `null`, если за эти сутки уже награждено — так две
       одновременные проверки дают один рост серии;
     - `due(platform, day, limit)` — аккаунты с хотя бы одним видом
       `checked_day IS DISTINCT FROM $day`: `account_id`, `platform_user_id`,
       массив видов; порядок `checked_day NULLS FIRST`, `started_at`; соединение с
       `account` по площадке; `LIMIT $limit`;
   - `bot-mention.service.ts`:
     - `view(account, at)` → `BotMentionView` (ниже);
     - `check(account, kind, at)` → `BotMentionCheck`: площадки без порта или
       выключенное/неоплачиваемое задание — `BotMentionUnavailableForPlatform`
       / `TaskNotOffered` (404); `ensure`; награждено за сегодня — `done_today`
       без вызова площадки; пауза (шаг 5) — `retry`; иначе `port.check(id,
       [kind])` и `settle`;
     - `settle(accountId, kind, finding, day, at)` — `present`: `wallet.grant` по
       каждому ненулевому ресурсу (`reason: "task_reward"`, `source:
       "bot-mention:<вид>"`, `idempotencyKey:
       "bot-mention:<аккаунт>:<вид>:<день>:<ресурс>"`), потом `rewardDay`;
       остальное — `markChecked`;
     - ночной проход (шаг 5) живёт в отдельном классе `bot-mention-sweep.service.ts`
       и зовёт тот же `settle`;
   - `bot-mention.controller.ts`:
     - `GET /api/v1/bot-mention` — лимит `{ scope: "bot-mention", limit: 300,
       windowSec: 3600 }`, ответ `{ data: BotMentionView }`;
     - `POST /api/v1/bot-mention/:kind/check` — `:kind` проверяется
       `z.enum(BOT_MENTION_KINDS)` (иначе `ValidationError`), лимит
       `{ scope: "bot-mention-check", limit: 20, windowSec: 3600 }`, ответ
       `{ data: BotMentionCheck }`. Тела у запроса нет — клиент ничего не
       присылает, награду и исход решает только сервер;
   - `bot-mention-errors.ts`, `bot-mention.module.ts` (импорты `AuthModule`,
     `WalletModule`), подключение в `app.module.ts` — одна строка импорта и одна
     в `APP_MODULES`.

   ```ts
   interface BotMentionView {
     /** что вписать, без «@»; `null` — у этой площадки заданий нет */
     botUsername: string | null;
     /** только показываемые: функция включена, награда вида > 0 */
     tasks: {
       kind: "name" | "bio";
       reward: { coins: number; gems: number; shards: number };
       started: boolean;
       streak: number;          // activeStreak на сегодня
       bestStreak: number;
       rewardedToday: boolean;
       lastResult: "present" | "absent" | "hidden" | "unavailable" | null;
       checkedAt: string | null;
     }[];
   }
   interface BotMentionCheck {
     outcome: "present" | "absent" | "hidden" | "unavailable" | "retry" | "done_today";
     /** сколько легло сейчас; нули — не начислялось */
     credited: { coins: number; gems: number; shards: number };
     view: BotMentionView;
   }
   ```
5. **Ночной проход `bot-mention-sweep.service.ts` и `bot-mention.job.ts`:**
   - планировщик BullMQ `upsertJobScheduler("every-5-min", { every: 300_000 })`,
     очередь `bot-mention`, воркер `concurrency: 1`, по образцу
     `season-close.job.ts`;
   - **лок прохода** в Redis (`bot-mention:sweep:lock`, `SET NX PX 600000`,
     снятие скриптом по токену): проход дольше интервала не должен идти на двух
     репликах разом;
   - проход: настройка выключена — выход; `today = gameDayOf(now)`; для каждой
     площадки из `BotMentions` берётся `limit = floor(ratePerSec * SWEEP_BUDGET_SEC
     / 2)`, где `SWEEP_BUDGET_SEC = 240` (**половина** темпа бота: вторая
     половина — рассылкам, уведомлениям и проверкам игроков); `due(…)` → по
     одному вызову `port.check(id, kinds)` с паузой `ceil(1000 / (ratePerSec / 2))`
     между вызовами (пауза подменяется в тесте, как `BroadcastSender.pause`);
   - исходы: `checked` → `settle` по каждому виду; `unavailable` →
     `markChecked(…, "unavailable")` на каждый вид (проверка раньше завтра не
     повторяется — иначе аккаунты без чата с ботом ели бы квоту каждые пять
     минут); `retry` → проход обрывается, в Redis `bot-mention:pause` ставится
     `PX afterSec*1000`, пока ключ жив, ни проход, ни ручная проверка не
     ходят на площадку (ручная отвечает `retry`);
   - виды, выключенные ценой (награда 0), в проход не берутся: строки таких
     видов `due` не отдаёт, если сумма их награды 0 — сумму считает сервис и
     передаёт в `due` список видов;
   - лог (JSON, без текстов имени и bio): `bot_mention_tick {platform, checked,
     retried, unavailable}`, `bot_mention_day_rewarded {accountId, kind, streak}`,
     `bot_mention_paused {afterSec}`.
6. **Документы:** `docs/30` — семь ключей, ключи Redis `bot-mention:sweep:lock`
   и `bot-mention:pause`, константы `SWEEP_BUDGET_SEC` и интервал; `docs/21` —
   сущность `bot_mention_task` в ER и диаграмма потока «игрок → проверка;
   планировщик → порт → Bot API → кошелёк».

## Чего не трогаем

- Порт `BotMentions`, `getChat` и адаптер Telegram — T-0159.
- Экран и тексты для игрока, события аналитики и их словарь — T-0160.
- Каталог заданий `task_def` и `TasksService`: наши задания не строки каталога,
  у них нет «забрать» и прогресса за срок (`tasks/task-rules.ts`). Виды `channel`
  с повтором (Р82) остаются как есть.
- Кошелёк: новую причину начисления и суточные потолки не заводим
  (`wallet-limits.ts`, `wallet-types.ts`).
- Очистка ника от упоминаний (Р111) — `auth/display-name.ts`, другая задача.
- Рассылки (`broadcast-sender.ts`) и их темп: проход берёт половину темпа бота,
  но настройки рассылок не меняет.
- Панель: ключи правятся в общем разделе настроек; своего экрана и сводки по
  заданиям нет.
- Отсечку бросивших: их проверяем без ограничения; нагрузку на проход замерить
  после выката и решить об отсечке отдельной задачей (решение claude-lead-1 от
  19.10.2026).
- Площадки MAX и VK: у них порта нет, заданий нет (Р110).

## Тесты

Пишутся первым коммитом. Юзернейм бота в тестах — вымышленный, `game_bot`.

- `bot-mention.test.ts` (подмены репозитория, порта и кошелька):
  - выключено или награда вида 0 → `view.tasks` без вида, `check` — 404;
  - площадка без порта (`web`) → `botUsername: null`, `tasks: []`, `check` — 404;
  - `present`, награда 100 монет и 2 осколка → два `grant` с причиной
    `task_reward`, источником `bot-mention:name`, ключами с датой и ресурсом,
    `credited` 100/0/2; самоцветов (0) в запросе нет;
  - повторная проверка в те же сутки → `done_today`, порт не вызван;
  - `absent`, `hidden`, `unavailable` → `grant` нет, `lastResult` записан;
  - `retry` → `grant` нет, `checked_day` не двигается; следом, пока пауза жива,
    ручная проверка отвечает `retry` без вызова порта;
  - `activeStreak`: `last_day` сегодня → серия; вчера → серия; позавчера → 0;
  - `kind = "avatar"` в контроллере → 400.
- `bot-mention-sweep.test.ts`:
  - три аккаунта, у одного оба вида → у него один вызов порта с двумя видами;
  - бюджет: `ratePerSec = 4`, `SWEEP_BUDGET_SEC` подменён на 2 → за проход не
    больше `floor(4 * 2 / 2) = 4` аккаунтов, остальные — в следующем проходе;
  - `retry` на втором аккаунте → проход оборван, третий не тронут, ключ паузы
    стоит; следующий проход под паузой делает ноль вызовов;
  - `unavailable` → `checked_day` стоит на сегодня, в этот же день аккаунт больше
    не выбирается;
  - выключенная настройка → ноль вызовов; лок занят другой репликой → ноль
    вызовов.
- `bot-mention.integration.test.ts` (живые Postgres и Redis, свой сдвиг Redis по
  `docs/17-testing-strategy.md` §4.2: занятые сдвиги найти `grep redisDatabase
  backend/api/test`, на момент написания 1–8 и 11, взять свободный):
  - серия: награда в сутки D → `streak` 1; D+1 → 2; D+3 → снова 1, `best_streak`
    2, `rewarded_days` 3;
  - 20 параллельных `check` одного аккаунта и вида при `present` → одна запись
    кошелька на ресурс, `rewarded_days` 1, `streak` 1;
  - граница суток: проход в 20:59 UTC и в 21:00 UTC (полночь по Москве) — разные
    игровые сутки, во втором аккаунт выбирается снова;
  - `due` не отдаёт аккаунты без начатого задания и аккаунты, у которых
    `checked_day` — сегодня; отдаёт по порядку `checked_day NULLS FIRST`;
  - аккаунт удалён → строка состояния ушла каскадом.
- `bot-mention.http.test.ts`: без токена `GET` и `POST` → 401; неверный `:kind`
  → 400; 21-й `POST` за час → 429; ответ `GET` соответствует `BotMentionView`
  (схема Zod в тесте).

## Аналитика

События словаря шлёт клиент после ответа сервера, а ночные награды проходят без
клиента, поэтому факты суток хранятся на сервере: таблица `bot_mention_task`
(`streak`, `best_streak`, `rewarded_days`, `last_result`), журнал кошелька с
источником `bot-mention:<вид>` и строки лога выше. Словарь и клиентские события —
T-0160. Метрик Prometheus в бэкенде пока нет: заготовка — число аккаунтов под
проверкой и доля исходов, без `account_id` в метках (`docs/22-analytics-and-metrics.md`).

## Настройки и окружение

Семь ключей каталога настроек (шаг 3), выключены по умолчанию. Переменных
окружения нет. Токен бота и имя бота — уже существующие `TELEGRAM_BOT_TOKEN` и
`getMe` на старте.

## Документы

Шаг 6: `docs/30-configuration-map.md`, `docs/21-diagrams.md`.

## Критерии приёмки

- [ ] Домен `bot-mention` ходит на площадку только через порт `BotMentions`,
  Telegram и grammY не импортирует; `scripts/test/layer-boundaries.test.ts`
  зелёный.
- [ ] Один вызов порта на аккаунт в сутки на проходе, оба вида вместе.
- [ ] Награда за сутки платится один раз, при любом числе проверок, в том числе
  параллельных; серия считается одним `UPDATE`.
- [ ] Убравший юзернейм не теряет полученное и не получает штрафа; награды за
  сутки нет.
- [ ] Закрытое bio не награждается и не помечается как «убрал»: исход `hidden`.
- [ ] Проход укладывается в половину темпа бота и останавливается на `429`.
- [ ] В базе, логе и ответах нет текста имени и bio.
- [ ] По умолчанию функция выключена, награды равны 0: пока геймдизайнер не
  назначил значения, игрок ничего не видит.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; интеграционные тесты — на
  живых Postgres и Redis.

## PR

- **Заголовок:** `feat(bot-mention): Задания с юзернеймом бота на сервере`
- **Метка:** `release: minor`
- **Для игроков:** нет — задания появятся с экраном (T-0160), а переключатель
  выключен
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАДАНИЯ С ЮЗЕРНЕЙМОМ БОТА: СЕРВЕР**

  Сервер умеет проверять, что юзернейм бота стоит в имени или bio игрока на площадке, и раз в игровые сутки платить за это. Проверка идёт через порт площадки в пределах половины темпа бота. Функция выключена, награды за сутки равны нулю до решения геймдизайнера.

  🛠 **Настройки**

  • Группа «Юзернейм бота» и переключатель «Задания «юзернейм бота»» в панели, семь ключей
  • Совпадение: @юзернейм без учёта регистра, с границами слова

  ❓ **Нужно от команды**

  • @участник1 — после выката замерить нагрузку ночного прохода; награду за сутки назначает геймдизайнер в панели
  ```
