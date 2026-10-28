---
id: T-0178
title: Отписка от канала после награды — перепроверка 7 суток, списание, закрытие заданий
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0177, T-0167, T-0169, T-0345]
zones:
  - backend/api/src/modules/tasks/channel-watch-rules.ts
  - backend/api/src/modules/tasks/channel-watch.repository.ts
  - backend/api/src/modules/tasks/channel-watch.service.ts
  - backend/api/src/modules/tasks/channel-watch.job.ts
  - backend/api/src/modules/tasks/tasks.service.ts
  - backend/api/src/modules/tasks/tasks.module.ts
  - backend/api/test/channel-watch.test.ts
  - backend/api/test/channel-watch.integration.test.ts
  - backend/api/test/tasks.test.ts
shared:
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0178. Отписка от канала после награды — перепроверка 7 суток, списание, закрытие заданий

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0178.json)](README.md#значки-статуса) [![T-0177](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0177.json&label=T-0177)](archive/T-0177-unsubscribe-penalty-building-blocks.md) [![T-0167](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0167.json&label=T-0167)](T-0167-admin-sortable-list-tasks-order.md) [![T-0169](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0169.json&label=T-0169)](T-0169-player-tasks-panel-order.md) [![T-0345](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0345.json&label=T-0345)](T-0345-system-restriction-under-lock.md)

## Зачем

Партнёр платит за подписчиков, а не за тех, кто подписался ради награды и ушёл.
Сейчас забор награды один раз спрашивает бота, подписан ли игрок, и дальше
отписка ничего не стоит (`docs/35-stage4-plan.md`, часть 4 Р52: «Отписка после
награды её не отнимает»). По Р115 сервер неделю перепроверяет подписку,
списывает награду отписавшимся и при повторе закрывает им партнёрские задания.

## Решения

Р115 (`docs/35-stage4-plan.md`, таблица решений после Р111), дословно: «После
награды за подписку сервер 7 суток перепроверяет, что игрок в канале.
Отписался — та же награда списывается, но не ниже нуля, игрок получает
уведомление. Повторная отписка в том же задании закрывает партнёрские задания
аккаунту на 30 суток. Проверка — через порт площадки: у Telegram — участник
канала у бота-администратора; у площадок без такой проверки штрафа нет».

Как это читается в коде (исполнитель не пересматривает; спорное — вопрос в PR):

- **Что под наблюдением.** Награда за задание вида `channel` — каждая выданная
  награда, то есть каждая строка прогресса (`task_progress`) с отметкой забора.
  Ежедневная и еженедельная подписка (Р82) даёт по награде за срок — у каждой
  своё окно в 7 суток. Награда за переход по ссылке и запуск бота
  (`link`, `bot`) не наблюдается: проверить нечем.
- **Площадка без проверки.** Порт берётся по площадке задания
  (`params.platform`), как в `checkJoined`. Если для неё нет порта
  `ChannelMemberships.for(platform)` (MAX и VK сейчас), окно не заводится.
- **Окно** — 7 суток с момента забора награды. Проверка идёт по расписанию
  (раздел «Шаги»), последняя — на исходе окна.
- **Одно событие отписки.** Если окон у пары «игрок + задание» несколько
  (ежедневная подписка, забранная несколько дней подряд), одна отписка — одно
  событие: награды всех открытых окон пары списываются разом и считаются
  **одним** нарушением. Иначе игрок, забиравший награду два дня и отписавшийся
  один раз, получал бы закрытие за «повтор».
- **Повтор** — нарушение в том же задании (`task_id`) после того, как по нему
  уже было нарушение: второе и дальше событие отписки. Номер события хранится
  у окон. У разового задания-достижения награда выдаётся однажды, и повторить
  отписку после новой награды нельзя — закрытие происходит только у
  повторяемых (ежедневных и еженедельных) подписок.
- **Не ниже нуля** — отзыв начисленного `WalletService.revokeUpTo` с причиной
  `task_revoke` (T-0177): не больше начисленного записью награды и не больше
  баланса. Что игрок уже потратил, не возвращается; об этом уведомление
  говорит словами «награда уже потрачена».
- **Что списывается:** монеты, самоцветы и осколки той награды (поля `coins`,
  `gems`, `shards` задания, ресурсы `coins`, `gems`, `shard_common`). Очки
  пасса не списываются: их игроку на забор не выдаёт этот модуль.
- **Закрытие** — `RestrictionsService.imposeBySystemFor` из T-0177: вид
  `partner_tasks`, причина `task_unsubscribe`, 30 суток; если у игрока уже
  действует не более слабое ограничение этого вида, оно остаётся.
- **Нет ответа площадки — нет штрафа.** Сбой сети, таймаут и ошибка настройки
  задания (бота нет в канале, нет права видеть участников) никогда не
  считаются отпиской: окно ждёт следующей проверки.
- **Константы** живут в `channel-watch-rules.ts`, а не в каталоге настроек:
  срок окна 7 суток и закрытие 30 суток записаны решением Р115 и меняются
  решением. Остальные значения предложил `claude-lead2-1`, принял `claude-lead-1`
  (19.10.2026); в коде это константы с комментарием:
  `RECHECK_EVERY_MS` = 6 часов, `GIVE_UP_AFTER_MS` = 1 сутки после конца окна,
  `TICK_MS` = 5 минут, `BATCH` = 200 окон за проход, `ASK_TIMEOUT_MS` = 5 000.

Решение claude-lead-1 от 19.10.2026: константы перепроверки приняты: `RECHECK_EVERY_MS` = 6 часов,
проход раз в 5 минут (`TICK_MS`), до 200 окон за проход (`BATCH`), таймаут
вопроса площадке 5 секунд (`ASK_TIMEOUT_MS`), отказ от окна через сутки после
его конца (`GIVE_UP_AFTER_MS`).

Решение claude-lead-1 от 19.10.2026: трактовка «повторной отписки в том же задании» принята как
записана выше (пункты «Повтор» и «Одно событие отписки»).

Решение claude-lead-1 от 19.10.2026: награды, выданные до выката, не отслеживаются (раздел «Чего не
трогаем»).

Решение claude-lead-1 от 19.10.2026: очки пасса при отписке не списываются.

Решение claude-lead-1 от 19.10.2026: T-0178 зависит от T-0167 и T-0169: все три правят
`tasks.service.ts` и `tasks.test.ts`, параллельно их не берут.

## Как сейчас

- `backend/api/src/modules/tasks/tasks.service.ts:142` — `claim`: для
  партнёрской цели `checkJoined` (строка 236) спрашивает порт один раз,
  `repository.complete` помечает цель выполненной, затем награда кошельком по
  ключу `task:${accountId}:${taskId}:${periodStart}:${resource}` (строка 178), и
  `markClaimed` (строка 183); `claimed === true` — награда выдана этим запросом.
  Повторный забор уже забранного возвращает `claimed: false` и ничего не
  выдаёт. Конструктор (строка 123) принимает репозиторий, кошелёк, хуки забегов,
  роли, `ChannelMemberships`, медиа и ограничения.
- `backend/api/src/modules/tasks/tasks.service.ts:55` — комментарий модуля:
  «подписку проверяет бот площадки в момент забора»; `task_checked` и
  `task_claimed` пишутся в лог (строки 159, 184).
- `backend/api/src/platforms/ports/channel-membership.ts` — порт
  `ChannelMembership.isMember(chat, platformUserId)`; ошибки
  `MembershipUnavailableError` (повтор может помочь) и `MembershipRejectedError`
  (ошибка настройки); `ChannelMemberships.for(platform)` — `null`, если площадка
  не умеет. `backend/api/src/platforms/telegram/telegram-channel-membership.ts` —
  `getChatMember`; `dev-…` аккаунты отвечают «не состоит».
- Параметры задания — `params.chat` и `params.platform` (`task-rules.ts:157`,
  `taskParamsSchema`); название — `def.title` (до 120 знаков или `null`);
  каталог целиком, и выключенное, — `TasksRepository.catalog()`
  (`tasks.repository.ts:115`).
- Модель данных: `backend/api/prisma/schema.prisma:1566` — `TaskParticipant`,
  строка 1585 — `TaskProgress` (ключ `account_id, task_id, period_start`,
  `claimed_at`); последняя миграция заданий —
  `prisma/migrations/20261014074456_task_pool_rotation`.
- Образец расписания: `backend/api/src/modules/export/retention.job.ts` —
  очередь BullMQ, `upsertJobScheduler` с постоянным id (при нескольких
  репликах работает одна), `concurrency: 1`, подключения из
  `infra/queues.ts`, закрытие в `onModuleDestroy`; включено только при
  `config.databaseUrl !== ""`.
- Модуль: `backend/api/src/modules/tasks/tasks.module.ts` — импорты `AuthModule`
  (экспортирует `ACCOUNT_REPOSITORY`), `WalletModule`, `RestrictionsModule`
  (экспортирует `RestrictionsService`), без `NotificationsModule`;
  `PlatformsModule` глобальный.
- `NotificationsService.post/notify` и вид `task_unsubscribed` — T-0177.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема.** `schema.prisma` — блок в конце файла с комментарием-заголовком;
   связь с `Account` — одной строкой. Модель `TaskChannelWatch`, таблица
   `task_channel_watch`:

   | Поле | Тип | Смысл |
   |---|---|---|
   | `account_id`, `task_id`, `period_start` | uuid, varchar(48), date | ключ окна; внешние ключи на аккаунт (`ON DELETE CASCADE`) и `task_def`; `period_start` — как в `task_progress` |
   | `started_at` | timestamptz | момент забора награды |
   | `watch_until` | timestamptz | `started_at + 7 суток` |
   | `next_check_at` | timestamptz | когда проверить в следующий раз |
   | `checked_at` | timestamptz null | последняя проверка с ответом площадки |
   | `state` | text, `CHECK` в `watching`, `kept`, `expired`, `penalized` | `kept` — досидел окно, `expired` — окно кончилось без ответа площадки, `penalized` — отписался |
   | `event_no` | int null | номер события отписки пары (1, 2, …); задан только у `penalized` |
   | `penalized_at` | timestamptz null | момент штрафа |
   | `revoked` | jsonb null | сколько списано по ресурсам: `{ "coins": n, "gems": n, "shards": n }` |

   Первичный ключ `(account_id, task_id, period_start)`. Индекс по
   `next_check_at` только для `state = 'watching'` (частичный) и индекс по
   `(account_id, task_id)` для разбора пары. Миграция — только создание таблицы
   (expand), откат — `DROP TABLE`. `migrate dev --create-only` запускается один
   раз, папка миграции должна получиться одна.
3. `channel-watch-rules.ts` — константы из «Решений» и чистые функции:
   - `watchUntil(startedAt)`; `nextCheckAfter(now, watchUntil)` — `min(now +
     RECHECK_EVERY_MS, watchUntil)`, но не раньше `now`;
   - `isFinalCheck(now, watchUntil)` — `now >= watchUntil`;
   - `shouldGiveUp(now, watchUntil)` — `now >= watchUntil + GIVE_UP_AFTER_MS`;
   - `closesPartnerTasks(eventNo)` — `eventNo >= 2`.
4. `channel-watch.repository.ts` — интерфейс и токен `CHANNEL_WATCH_REPOSITORY`,
   реализация на `$queryRaw`/`$executeRaw` с разбором строк Zod-схемой (как в
   `network-tasks.repository.ts`):
   - `start(row)` — `INSERT … ON CONFLICT DO NOTHING`, `false` на повторе;
   - `due(now, limit)` — окна `state = 'watching'` и `next_check_at <= now`,
     по возрастанию `next_check_at`;
   - `openOf(accountId, taskId)` — все окна пары в `watching`;
   - `lastEventNo(accountId, taskId)` — наибольший `event_no` пары или 0;
   - `postpone(keys, nextCheckAt, checkedAt)`, `close(keys, state, at)` для
     `kept` и `expired`, `markPenalized(keys, eventNo, revoked, at)` — каждая
     пишет только окна в `watching` (повтор безопасен).
5. `channel-watch.service.ts` — `ChannelWatchService`:
   - `start(account, def, periodStart, at)` — вызывается после выдачи награды:
     окно заводится, только если у `def.kind === "channel"`, у `def.params`
     есть `chat` и `memberships.for(def.params.platform)` не `null`.
     Лог `channel_watch_started`;
   - `tick(now)` — берёт `due(now, BATCH)`, группирует по паре (аккаунт,
     задание), для каждой пары по очереди (не параллельно: площадка
     ограничивает темп):
     1. аккаунт — через `ACCOUNT_REPOSITORY.byId`, определение задания — из
        `TasksRepository.catalog()` (один запрос на проход); нет аккаунта или
        у задания больше нет `params.chat` — окна закрываются как `expired`,
        лог `channel_watch_orphaned`;
     2. `isMember(chat, platformUserId)` под `withTimeout(…, ASK_TIMEOUT_MS)`;
        - `MembershipUnavailableError`, таймаут → окна откладываются
          (`postpone`), лог `channel_watch_unavailable`;
        - `MembershipRejectedError` → то же, лог уровня error
          `channel_watch_misconfigured` (как `task_check_misconfigured`);
        - в обоих случаях окна, у которых `shouldGiveUp`, закрываются
          `expired`;
     3. состоит → окна с `isFinalCheck` закрываются `kept`, остальные
        откладываются на `nextCheckAfter`;
     4. не состоит → **событие отписки** по всем `openOf` окнам пары, не
        только по тем, что подошли по времени:
        `eventNo = lastEventNo + 1`; для каждого окна и каждого ресурса награды
        `revokeUpTo({ grantKey: task:<acc>:<task>:<periodStart>:<ресурс>,
        idempotencyKey: taskrevoke:<acc>:<task>:<periodStart>:<ресурс>, reason:
        "task_revoke", source: "task:<task>", at })`; затем, если
        `closesPartnerTasks(eventNo)`, `imposeBySystemFor(acc, "partner_tasks",
        "task_unsubscribe", комментарий, 30 суток, now)`; затем уведомление
        `task_unsubscribed` (`title`, суммы списанного, `closedUntil` — конец
        нового ограничения, если оно наложено этим событием, иначе `null`),
        `dedupeKey` = `task_unsubscribed:<acc>:<task>:<eventNo>`; и **последним**
        `markPenalized` по окнам. Порядок важен: всё до `markPenalized`
        идемпотентно по ключам, поэтому оборвавшийся проход при повторе
        доделывает событие, а не удваивает его. Лог `channel_unsubscribed`
        (аккаунт, задание, номер события, суммы, закрыто ли);
   - сбой на одной паре пишется в лог (`channel_watch_failed`, причина) и не
     останавливает остальные.
6. `channel-watch.job.ts` — по образцу `retention.job.ts`: очередь
   `channel-watch`, планировщик `upsertJobScheduler("tick", { every: TICK_MS })`,
   `concurrency: 1`, включено при `config.databaseUrl !== ""`; сбой планировщика
   и воркера — в лог, а не в падение приложения; закрытие очереди и воркера в
   `onModuleDestroy`.
7. `tasks.service.ts`: в конструктор добавляется `ChannelWatchService`. В
   `claim` сразу после `markClaimed`, если `claimed === true` и `def.kind ===
   "channel"`, — `await watch.start(account, def, done.periodStart, at)` под
   `try/catch` с записью в лог `channel_watch_not_started` (сбой не должен
   отменять выданную награду: она уже выдана и отмечена). Комментарий модуля
   (строка 55) и описание `claim` дополнить: подписку проверяют в момент забора
   и ещё 7 суток после него (Р115).
8. `tasks.module.ts`: импорт `NotificationsModule`; провайдеры
   `ChannelWatchService`, `ChannelWatchJob` и
   `{ provide: CHANNEL_WATCH_REPOSITORY, useClass: PrismaChannelWatchRepository }`.
   Экспортировать их не нужно: другие модули службу не берут (проверить, что ни
   один `@Optional()`-потребитель не ждёт её).
9. Документы (раздел «Документы»).

## Чего не трогаем

- Кошелёк, ограничения, ленту уведомлений и их тексты — это T-0177. Если в
  них чего-то не хватает, вопрос в PR, а не правка здесь.
- Задания рекламных сетей (`network-tasks.service.ts`): Р115 говорит о
  подписке на канал, которую проверяет бот, а не о заданиях сетей.
- Забор награды и порядок проверок в `claim`: меняется только вызов постановки
  окна после выдачи.
- Награды, выданные до выката этой задачи: под наблюдение они не попадают, окна
  заводятся только у новых заборов.
- Экраны игры и панели: подсказка игроку о правиле — T-0183; столбец
  отписавшихся в панели — отдельное решение, не часть этой задачи.
- Каталог настроек (`setting-catalog.ts`): ключей нет.

## Тесты

Пишутся первым коммитом, до кода. Модульные — на фальшивых репозиториях и
портах (образец — `backend/api/test/tasks.test.ts`), интеграционные — на живых
Postgres и Redis (`docs/17-testing-strategy.md` §4.2). Время — инжектируемое
`at`/`now`.

`backend/api/test/channel-watch.test.ts`:

- **Заведение окна.** Забор награды за подписку (`channel`) на площадке с
  портом: окно с `started_at = at`, `watch_until = at + 7 суток`,
  `next_check_at = at + 6 часов`. Повторный забор той же награды окна не
  удваивает. Забор цели `link` или `bot` окна не заводит. Площадка без порта
  (`memberships.for` → `null`) — окна нет. Сбой постановки окна не отменяет
  выданную награду и пишет `channel_watch_not_started`.
- **Состоит до конца.** Две проверки подряд «состоит» → окно откладывается на
  6 часов; проверка на исходе окна (`now >= watch_until`) → `kept`, баланс не
  менялся, уведомления нет.
- **Первая отписка.** Награда 100 монет и 5 самоцветов, у игрока 100 монет и
  5 самоцветов; на третий день проверка «не состоит» → у игрока 0 и 0,
  окно `penalized` с `event_no: 1`, `revoked` равен списанному, уведомление
  `task_unsubscribed` с суммами, `closedUntil: null`, ограничения нет.
- **Не ниже нуля.** Тот же случай, но на счёте 40 монет: списано 40, баланс 0,
  не минус; в уведомлении 40. Баланс 0 — списано 0, уведомление «потрачена».
  Самоцветы и монеты списываются независимо.
- **Одно событие на пару.** Подписка ежедневная, награды забраны в понедельник
  и вторник (два окна), в среду «не состоит»: награды обоих дней списаны,
  `event_no: 1` у обоих окон, закрытия нет, уведомление одно.
- **Повтор.** Через несколько дней игрок снова подписался, забрал награду за
  новый день, снова отписался: `event_no: 2`, наложено ограничение
  `partner_tasks` на 30 суток с причиной `task_unsubscribe`, в уведомлении
  `closedUntil = now + 30 суток`. Если у игрока уже бессрочное `partner_tasks`
  — ограничение не заменено, `closedUntil: null`.
- **Другое задание — не повтор.** Нарушение по заданию A после нарушения по
  заданию B — `event_no: 1`, закрытия нет.
- **Нет ответа — нет штрафа.** `MembershipUnavailableError`, таймаут, и
  `MembershipRejectedError` — окно откладывается, баланс и ограничения не
  тронуты; для `Rejected` пишется `channel_watch_misconfigured`; окно старше
  `watch_until + 1 сутки` закрывается `expired`.
- **Идемпотентность.** Проход оборвался после списания, до `markPenalized`
  (фальшивый репозиторий бросает на первом вызове): повторный проход доделывает
  событие, списано один раз, уведомление одно, ограничение одно.
- **Разное.** Аккаунта нет или у задания пропали `params.chat` → `expired` и
  `channel_watch_orphaned`. Сбой на одной паре не мешает обработать
  следующую. За проход обработано не больше `BATCH` окон.
- **Правила.** `nextCheckAfter` не позже `watch_until`; `closesPartnerTasks(1)`
  — `false`, `(2)` — `true`.

`backend/api/test/channel-watch.integration.test.ts` (живая база,
`describe.skipIf` без `TEST_DATABASE_URL`):

- Миграция создаёт таблицу; `start` на повторе возвращает `false`; удаление
  аккаунта удаляет его окна.
- `due` отдаёт только `watching` с наступившим сроком, по возрастанию срока;
  окна в `kept`, `expired`, `penalized` не отдаёт.
- Полный круг с настоящим кошельком: награда выдана ключом задания, отписка →
  строки журнала `task_revoke`, баланс не ниже нуля, окно `penalized`; второй
  проход ничего не списывает.
- Два одновременных прохода (`Promise.all`) по одной паре: списание, уведомление
  и ограничение — по одному.

`backend/api/test/tasks.test.ts`: конструктор `TasksService` получает фальшивую
службу окон (все существующие кейсы проходят); забор `channel` вызывает
`start` ровно один раз и только когда награда выдана этим запросом
(`claimed: true`); повторный забор не вызывает.

## Аналитика

Событий словаря `docs/22-analytics-and-metrics.md` нет: проверку делает сервер,
а конверт события клиента привязан к устройству (как у ограничений). Всё
пишется в лог сервера JSON-строками модуля `tasks`: `channel_watch_started`,
`channel_unsubscribed` (аккаунт, задание, номер события, списанное по
ресурсам, закрыты ли задания), `channel_watch_unavailable`,
`channel_watch_misconfigured`, `channel_watch_expired`,
`channel_watch_orphaned`, `channel_watch_failed`, `channel_watch_not_started`.
Список имён — в абзаце про лог ограничений в `docs/22-analytics-and-metrics.md`
(около строки 350). Метки Prometheus не добавляются (идентификаторы игрока и
задания — высокая кардинальность).

## Настройки и окружение

Нет: ключей каталога настроек и переменных окружения нет; константы
(`channel-watch-rules.ts`) перечислены в `docs/30-configuration-map.md` строкой
«Отписка после награды за подписку» с путём к файлу.

## Документы

- `docs/21-diagrams.md` — ER-диаграмма: таблица `task_channel_watch` и связи; и
  схема потока «награда → окно → перепроверка → списание / закрытие»
  (sequence). Строка про модуль заданий (около 1985) — добавить таблицу.
- `docs/35-stage4-plan.md` — часть 4 Р52, абзац «Выполнение»: фразу «Отписка
  после награды её не отнимает» заменить на правило Р115 со ссылкой на
  T-0178; запись «Как сделано» для Р115.
- `docs/22-analytics-and-metrics.md` — имена логов (раздел «Аналитика»).
- `docs/30-configuration-map.md` — строка про константы окна.
- `pnpm docs:check` проходит.

## Критерии приёмки

- [ ] Каждая награда за подписку на канал на площадке с проверкой получает окно
      в 7 суток; награда за ссылку и бота, и площадка без порта — нет.
- [ ] Отписавшийся теряет награду, но баланс не уходит ниже нуля; потраченное не
      возвращается (тесты 100 из 100, 40 из 100, 0).
- [ ] Игрок получает одно уведомление на событие; повторная отписка в том же
      задании закрывает `partner_tasks` на 30 суток, не ослабляя более строгое
      ограничение.
- [ ] Сбой, таймаут и ошибка настройки задания не штрафуют.
- [ ] Оборванный проход при повторе не удваивает ни списание, ни уведомление,
      ни ограничение.
- [ ] Проверка идёт по одному запросу площадки за раз, с таймаутом, пачками не
      больше `BATCH`; две реплики не делают работу вдвое.
- [ ] Миграция только создаёт таблицу; ER-диаграмма и схема потока обновлены.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(tasks): Штраф за отписку от канала после награды`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: если отписаться от канала в течение 7 суток после награды за подписку, награда списывается; при повторе партнёрские задания закрываются на 30 суток`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ШТРАФ ЗА ОТПИСКУ ОТ КАНАЛА ПОСЛЕ НАГРАДЫ**

  Сервер неделю перепроверяет, что игрок остался в канале, за подписку на
  который получил награду. Отписался — награда списывается (не ниже нуля),
  игрок получает уведомление; повторная отписка в том же задании закрывает
  партнёрские задания на 30 суток.

  🛠 **Задания**

  • окно в 7 суток у каждой новой награды за подписку, проверка раз в 6 часов
  • на площадках без проверки (MAX, VK) штрафа нет
  • награды, выданные до выката, не проверяются
  • сбой Telegram или ошибка настройки канала штрафом не считаются

  ❓ **Нужно от команды**

  • @владелец — подтвердить частоту проверки (6 часов) и нужна ли подсказка о правиле на карточке задания
  ```
