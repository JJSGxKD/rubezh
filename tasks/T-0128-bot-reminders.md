---
id: T-0128
title: Напоминания через бота: обогнали в сезоне, сезон закрывается, награда дня
epic: E16
priority: P1
status: ready
owner:
author: claude-lead2-21
size: M
depends_on: [T-0010, T-0104, T-0110, T-0191]
zones:
  - backend/api/src/modules/reminders/**
  - backend/api/src/modules/notifications/notification-kinds.ts
  - backend/api/src/modules/notifications-bot/bot-notify-rules.ts
  - backend/api/src/modules/notifications-bot/bot-notify-sender.ts
  - backend/api/src/modules/notifications-bot/bot-notify-texts.ts
  - backend/api/src/modules/account-settings/account-settings.catalog.ts
  - backend/api/src/platforms/ports/messenger.ts
  - backend/api/src/platforms/telegram/telegram-messenger.ts
  - backend/api/src/platforms/telegram/reminders-off.command.ts
  - backend/api/test/reminders.test.ts
  - backend/api/test/reminders.integration.test.ts
  - backend/api/test/notifications-bot.test.ts
  - packages/app-shell/src/state/bot-notifications.ts
  - packages/app-shell/src/i18n/ru-bot.json
  - packages/app-shell/test/bot-notifications.test.ts
shared:
  - backend/api/src/app.module.ts
  - backend/api/src/platforms/telegram/bot-router.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/seasons/season-board.store.ts
  - packages/app-shell/src/screens/settings.tsx
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/39-retention-mechanics.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0128. Напоминания через бота: обогнали в сезоне, сезон закрывается, награда дня

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0128.json)](README.md#значки-статуса) [![T-0010](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0010.json&label=T-0010)](archive/T-0010-bot-write-access.md) [![T-0104](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0104.json&label=T-0104)](archive/T-0104-tasks-pool-rotation-new-kinds.md) [![T-0110](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0110.json&label=T-0110)](archive/T-0110-weekly-season-server.md) [![T-0191](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0191.json&label=T-0191)](T-0191-single-difficulty-server.md)

## Зачем

Игрок закрыл игру и забыл про неё: у недельного сезона и награды дня нет ничего, что позвало бы обратно. У Telegram есть прямой канал, у конкурентов в отчётах его нет (`docs/39-retention-mechanics.md` П5). После задачи бот пишет три вида напоминаний, не чаще раза в сутки, только тем, кто разрешил себе писать, с кнопкой «Не напоминать» прямо под сообщением.

## Решения

**Поправка `claude-lead-1` от 20.10.2026 (Р126, единая сложность).** Напоминание `season_overtaken` — только по доске `hard`; поле `difficulty` в событии и в ключах `reminders:snap` остаётся со значением `hard` (id не сводятся).

- **Ничего нового для доставки: используем ленту и дубль в бота (WP28).** `notifications-bot` уже умеет: очередь BullMQ с лимитером, проверку «можно ли писать» (`MessagingService.state`, T-0010), выбор игрока в настройках аккаунта, потолок вида, исход в `notification.bot_outcome`, блокировку бота. Три вида напоминаний становятся видами уведомлений и получают правила; свою очередь не заводим. Строка ленты у напоминания есть (так уже устроен дубль), знак «непрочитано» на колокольчике она ставит, как и остальные.
- **Три вида** (`notification-kinds.ts`), у всех свой `dedupeKey`, повтор тика строку не удвоит:

  | Вид | Когда | `dedupeKey` | Данные |
  |---|---|---|---|
  | `season_overtaken` | в таблице недели игрока обогнали | `season_overtaken:<ключ сезона>:<игровой день>` | `difficulty`, `place` |
  | `season_closing` | игровые сутки перед закрытием сезона, у игрока есть ранговый забег недели | `season_closing:<ключ сезона>` | `endsAt` (ISO) |
  | `daily_reward_ready` | награда дня сегодня не забрана | `daily_reward_ready:<игровой день>` | нет |

- **Одно напоминание в сутки на игрока на все три вида вместе.** Окно — ключ `reminders.min_gap_hours` (24), скользящее, а не «до полуночи»: между двумя напоминаниями не меньше суток даже на стыке дней. Выбирает вид планировщик по приоритету `season_overtaken` → `season_closing` → `daily_reward_ready`; потолок в отправителе — вторая линия защиты (две реплики, перезапуск).
- **Тихие часы — по часовому поясу игрового дня** (`GAME_DAY_TIME_ZONE`, Москва, `common/game-day.ts`), у аккаунта собственного пояса нет. Старт: тихо с 21:00 до 10:00, то есть пишем с 10:00 до 21:00 по Москве. Окно может переходить через полночь; `from == to` — тихих часов нет. Проверка и при планировании, и при отправке: задание, застрявшее в очереди до 21:00, в 21:05 не уходит.
- **Отписка кнопкой под сообщением, возврат — в настройках игры.** Ключ аккаунта `bot.reminders` (по умолчанию включён: игрок сам разрешил боту писать, а каждое сообщение несёт кнопку выхода). Один ключ на все три вида. Кнопка «Не напоминать» — кнопка обратного вызова (`callback_data: "rm:off"`) рядом со ссылкой «Открыть игру»; нажатие ставит `bot.reminders = false`.
- **Кнопка с действием — в порт, не в адаптер.** `OutgoingMessage` получает необязательное `action?: { text: string; data: string }`; `Messenger` площадки без такой кнопки отправляет сообщение без неё. Рассылки поле не заполняют, их поведение не меняется.
- **Включатель — ключ каталога настроек, по умолчанию выключен.** `reminders.enabled` (раздел «Флаги»): первый выкат без рассылки игрокам, команда включает сама после просмотра текстов на деве. База сильнее окружения (Р53), переменной окружения нет.
- **Ключи каталога настроек** (`setting-catalog.ts`, группа «Напоминания», «Часов» и «Дней» через `unit`):

  | Ключ | Старт | Диапазон | Смысл |
  |---|---|---|---|
  | `reminders.enabled` | выкл. | да/нет | включатель всех трёх видов |
  | `reminders.min_gap_hours` | 24 | 12–168 | не чаще одного напоминания за столько часов |
  | `reminders.quiet_from_hour` | 21 | 0–23 | начало тихих часов, час по Москве |
  | `reminders.quiet_to_hour` | 10 | 0–23 | конец тихих часов, час по Москве |
  | `reminders.lapse_days` | 14 | 1–60 | награду дня не напоминают тем, кто не забирал её дольше |

  Технические константы — в коде и в `docs/30`: тик раз в 10 минут (`SCAN_INTERVAL_MS`), до 500 кандидатов на вид за тик (`TICK_LIMIT`), снимок таблицы — первые 100 мест (`SNAPSHOT_TOP`).
- **Поток уведомлений команды — новый, `notify.chat.reminders`** («Напоминания»): раз в игровые сутки одно сообщение с итогом вчерашнего дня (отправлено по видам, не доставлено, заблокировали бота после напоминания); сильнее заметны блокировки, поэтому в тексте есть доля. Ключ через `chat(...)` в `setting-catalog.ts`; пусто — общий чат, переменной окружения нет.

## Как сейчас

- `notifications-bot/bot-notify-rules.ts`: `BOT_NOTIFY` — правила видов (`setting`, `byDefault`, `throttleSec`); `bot-notify-sender.ts`: `deliver` по порядку проверяет вид, аккаунт, бан, бота площадки, `canMessage`, выбор игрока, текст, потолок вида (`claim`, `SET NX EX`, ключ `bot-notify:<аккаунт>:<вид>`), отправляет, блокировку отмечает; `bot-notify-queue.ts`: очередь `notifications-bot`, задание на уведомление (`jobId` = id уведомления), до 5 в секунду; `bot-notify-texts.ts`: простой текст и кнопка-ссылка «▶ Открыть игру» с параметром `n-<вид>` (`attribution/start-param.ts`).
- `notifications.service.ts`: `notify(input)` пишет строку с `dedupeKey` и зовёт слушателя `onCreated("bot")`; вид, неизвестный `NOTIFICATION_KINDS`, в ленту не попадает.
- `platforms/ports/messenger.ts`: `OutgoingMessage { text, button }` (кнопка-ссылка), исходы `sent` / `blocked` / `retry` / `failed`; `telegram-messenger.ts` строит разметку ответа.
- Настройки аккаунта `bot.friendRequest`, `bot.friendGift`, `bot.teamMessage`: `account-settings.catalog.ts`, умолчания клиента — `app-shell/src/state/bot-notifications.ts`, расхождение ловит `scripts/test/account-settings-keys.test.ts`. Все места найти поиском по `bot.friendGift` и `friend_gift`.
- Обработка кнопок обратного вызова в Telegram: `platforms/telegram/role-confirm.command.ts` и `panel-login.command.ts`, подключение — `bot-router.ts` и модуль команды.
- Образец фонового тика под распределённым локом — `fx/fx.refresher.ts` (`setInterval`, `SET … NX PX` с токеном, снятие скриптом). Закрытие сезонов — `modules/seasons/**` (T-0110): `seasonOf(at)` → `{ key, startsAt, endsAt }`, живая таблица в Redis (`season-board.store.ts`: `top`, `best`, `rank`).
- Награда дня: таблица `daily_reward (account_id, claimed_days, last_claim_day)`, `last_claim_day` — игровые сутки последнего забора (`daily.service.ts`).
- Игровые сутки: `gameDayOf(at)` — чистая функция из `tasks/task-pool.ts` (T-0104); неделя и сезон — UTC, закрытие в понедельник 00:00 UTC (03:00 по Москве).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Виды и тексты.** Сначала `notification-kinds.ts`: три схемы Zod (`season_overtaken`: `difficulty` — одна из сложностей, `place` — целое от 1; `season_closing`: `endsAt` — строка ISO; `daily_reward_ready`: пустой объект). Потом `bot-notify-texts.ts`: тексты ниже; простой текст, без разметки; слово «сложность» подставляется русским названием (таблица `DIFFICULTY_NAMES`, значения как `difficulty.<id>.name` в словаре оболочки; тест сверки со словарём, как у цен бустов). Кнопка-ссылка — как у соседних видов; `n-season_overtaken`, `n-season_closing`, `n-daily_reward_ready` должны проходить разбор `attribution/start-param.ts` (тест).
3. **Правила и отправитель** (`bot-notify-rules.ts`, `bot-notify-sender.ts`): у правила необязательные поля `reminder: true` и `setting: "bot.reminders"`; три вида ссылаются на один ключ, `byDefault: true`. Для напоминаний отправитель: (а) если `reminders.enabled` выключен — исход `skipped("disabled")`; (б) если час по Москве в тихом окне — `skipped("quiet_hours")`, потолок не расходуется; (в) потолок берёт ключ `bot-notify:<аккаунт>:reminder`, общий на три вида, окно — `reminders.min_gap_hours`; (г) к сообщению добавляется кнопка действия «Не напоминать» (`data: "rm:off"`). Новые причины — в `SkipReason`. Остальные виды не меняются.
4. **Порт и Telegram.** `OutgoingMessage.action?` (разделы «Решения»); `telegram-messenger.ts` рисует его второй строкой разметки, `callback_data` не длиннее 64 байт. Новая команда `reminders-off.command.ts` по образцу `role-confirm.command.ts`: `rm:off` → аккаунт по `platformUserId` → `bot.reminders = false` через `AccountSettingsService` (вызов `merge` по образцу контроллера настроек) → `answerCallbackQuery` с текстом из раздела «Тексты». Повторное нажатие даёт тот же ответ; неизвестный игрок — тот же ответ без записи. Подключить в `bot-router.ts`.
5. **Модуль `reminders`** (`reminder-rules.ts`, `reminders.repository.ts`, `reminders.scanner.ts`, `reminders.report.ts`, `reminders.module.ts`; строка в `app.module.ts`):
   - `reminder-rules.ts` (чистые функции): `isQuietHour(at, from, to)`, `closingDay(season)` (игровые сутки перед `gameDayOf(season.endsAt)`), `overtaken(before, now)`, `chooseKind(candidates)` по приоритету. `overtaken`: из снимка `[{ accountId, rank, score }]` и текущих мест — игроки, у которых `score` тот же, а место хуже; игрок, чей результат вырос, не «обогнан»;
   - `reminders.scanner.ts`: `onApplicationBootstrap` запускает `setInterval(() => void this.tick(), SCAN_INTERVAL_MS)`; тик берёт лок `reminders:scan:lock` (`SET NX PX`, токен, снятие скриптом — как `fx.refresher.ts`; лок держит одну реплику). Тик ничего не делает, если `reminders.enabled` выключен, нет сезона (T-0110) или час в тихом окне — **снимок таблицы в такой тик не обновляется**, поэтому обгон за ночь утром виден. Иначе:
     1. **Обогнали.** Для каждой сложности: снимок первых `SNAPSHOT_TOP` мест из Redis (`reminders:snap:<ключ сезона>:<сложность>`, JSON, разбор Zod, TTL 8 суток) сравнивается с текущим: для каждого игрока снимка берутся `best` и `rank` из `season-board.store.ts`; потом снимок заменяется текущим. Первый тик сезона обгонов не даёт (снимка нет);
     2. **Сезон закрывается.** Если сегодня `closingDay`: страница игроков с ранговым забегом недели (`run.ranked`, `finished_at` в `[startsAt, endsAt)`), у которых можно писать, ключевой курсор по `account_id`, `TICK_LIMIT` на тик, курсор в Redis (`reminders:cur:closing:<ключ сезона>`, TTL 2 суток, конец — метка «готово»);
     3. **Награда дня.** Страница игроков из `daily_reward`, у которых `last_claim_day < сегодня` и не старше `reminders.lapse_days`, можно писать; тот же курсор (`reminders:cur:daily:<игровой день>`);
     4. каждому кандидату: аккаунт без бана, `account_messaging.can_message`, выбор игрока (`bot.reminders` не `false`, значение читается `AccountSettingsService.valueOf`), окно потолка не занято (`EXISTS bot-notify:<аккаунт>:reminder`); один вид на игрока по приоритету; `NotificationsService.notify({ accountId, kind, payload, dedupeKey })`. Дальше работает дубль в бота — очередь BullMQ под лимитером, задание идемпотентно по id уведомления.
     В конце — строка лога `reminders_tick` (JSON: кандидатов по видам, создано, пропущено по причинам). Сбой тика — в лог, следующий тик продолжит с курсора; все обращения к базе и Redis — с таймаутом;
   - `reminders.repository.ts`: два запроса с курсором (закрытие и награда дня; `ORDER BY account_id`, `LIMIT :TICK_LIMIT`) и итог вчерашнего дня для отчёта (`notification`, `kind IN (…)`, `bot_outcome`, число блокировок по `account_messaging` после отправки);
   - `reminders.report.ts`: раз в игровые сутки (первый тик после 00:10 по Москве, метка `reminders:report:<день>` по `SET NX`) сообщение в `notify.chat.reminders` по образцу `admin-notify/payments-alert-notifier.ts`; текст — раздел «Тексты».
6. **Клиент.** `bot-notifications.ts`: ключ `bot.reminders`, умолчание `true`; в настройках (`settings.tsx`) переключатель рядом с остальными видами бота; тексты — `ru-bot.json`, раздел «Тексты». Расхождение сервера и клиента ловит `account-settings-keys.test.ts`.
7. **Документы.** `docs/22` §3.3: возврат из напоминаний считается по `start_param = n-season_overtaken | n-season_closing | n-daily_reward_ready` и по `notification.bot_outcome`, события не вводятся (серверные отложены). `docs/21` (поток «тик → лента → очередь → бот», связь модуля). `docs/30`: строки про ключи, константы и поток. `docs/39` П5: пометка «сервер — T-0128».

## Тексты, дословно

Сообщения бота (простой текст, обращение «вы», как у соседних видов в `bot-notify-texts.ts`; кнопки «▶ Открыть игру» и «🔕 Не напоминать»):

- `season_overtaken`: `Вас обогнали в недельном сезоне «Рубежа»: на сложности «{difficulty}» вы теперь на {place}-м месте. До закрытия сезона можно отыграться.`
- `season_closing`: `Недельный сезон «Рубежа» закрывается завтра в {time} по Москве. Награды за порог и за место получат те, кто попал в таблицу, — успейте улучшить результат.` (`{time}` — `HH:mm` из `endsAt` по Москве)
- `daily_reward_ready`: `Награда дня ждёт вас в «Рубеже». Загляните и заберите её сегодня.`
- ответ на нажатие «Не напоминать»: `Напоминания выключены. Включить их снова можно в настройках игры.`

Настройки игры (`ru-bot.json`, ключи — рядом с ключами `friend_gift`): название `Напоминания`; описание `Сообщение от бота не чаще раза в сутки: вас обогнали в сезоне, сезон скоро закрывается или ждёт награда дня.`

Отчёт команде (поток «Напоминания», раз в сутки):

```
🔔 Напоминания за {день}
Вас обогнали: отправлено {n}
Сезон закрывается: отправлено {n}
Награда дня: отправлено {n}
Не доставлено: {n} · бота заблокировали: {n} ({доля}% от отправленных)
```

## Чего не трогаем

- Сезон, награды сезона и таблицу: T-0110 (только чтение; недостающий метод таблицы — минимальное добавление в `season-board.store.ts`).
- Рассылки команды (`broadcasts`), их очередь и тексты; уведомления «заявка», «подарок», «сообщение команды».
- Сообщения для MAX и VK: адаптеров с ботом пока нет, `Messengers.for()` вернёт `null` — писать некому.
- Экран входа и вопрос «Разрешить сообщения от бота» (T-0010): здесь только чтение разрешения.
- Награду дня и колесо; «Испытание дня» и пропуск (`docs/39` П4, Б9).

## Сценарий и интерфейс

- **Игрок в боте:** сообщение приходит между 10:00 и 21:00 по Москве, внизу «▶ Открыть игру» и «🔕 Не напоминать». Нажатие второй — всплывающий ответ, дальше сообщений нет. Включить обратно: настройки игры → «Напоминания».
- **Пока не разрешил писать или заблокировал бота:** напоминаний нет, строки ленты не создаются.
- **Лента в игре:** напоминание лежит строкой с тем же текстом.
- **Платформа без бота или без кнопки действия:** сообщение уходит без второй кнопки либо не уходит.
- **Панель:** ключи «Напоминания» в настройках; нет сети или ошибка — как у соседних ключей.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/reminders.test.ts` (чистые): `isQuietHour` для 21→10: 20:59 по Москве не тихо, 21:00 тихо, 09:59 тихо, 10:00 не тихо; `from == to` — никогда; 1→5 без перехода; `closingDay` для сезона до `2026-11-09T00:00Z` — день `2026-11-08`, а `2026-11-08T21:00Z` (понедельник по Москве) уже нет; `overtaken`: место ухудшилось при том же `score` — в списке; `score` вырос — нет; вышел за 100 мест при том же `score` — в списке; первый тик без снимка — пусто; `chooseKind`: обгон и награда дня → обгон; закрытие и награда → закрытие; игрок с занятым окном потолка, отписавшийся или без разрешения — не выбирается.
- Тексты: три сообщения дословно (с подстановкой), только простой текст, не длиннее 4096 символов; `callback_data` `rm:off` не длиннее 64 байт; `n-<вид>` проходит `start-param`; `DIFFICULTY_NAMES` совпадает со словарём.
- `backend/api/test/notifications-bot.test.ts`: напоминание в тихие часы — `skipped("quiet_hours")` и потолок цел; при выключенном `reminders.enabled` — `skipped("disabled")`; два разных вида напоминаний подряд — второй `throttled`; игрок с `bot.reminders = false` — `opted_out`; без разрешения писать — `not_allowed`; у напоминания в исходящем сообщении есть кнопка действия, у `friend_request` нет; остальные тесты файла зелёные.
- Тест порта и адаптера: `OutgoingMessage` с `action` даёт вторую строку разметки с `callback_data`; без `action` разметка прежняя (проверка рассылок).
- Команда `rm:off`: ставит `bot.reminders = false` и отвечает; повтор даёт тот же ответ; неизвестный пользователь — тот же ответ без записи; чужой формат данных кнопки — игнор.
- `backend/api/test/reminders.integration.test.ts` (живые Postgres и Redis, Redis тестов — 13): награда дня — 1 200 игроков с `last_claim_day` вчера: за три тика курсор проходит всех ровно по разу (`TICK_LIMIT` в тесте 500), второй проход ничего не создаёт (`dedupeKey`); игрок с `can_message = false`, с баном, не забиравший дольше `lapse_days` и забравший сегодня не выбираются; два сканера одновременно — работу делает один (лок); тик в тихий час снимок не обновляет; обгон: игрок A на 3-м месте, B прошёл его — A получает `season_overtaken` с новым местом, B нет; второй обгон в те же сутки новой строки не создаёт; закрытие сезона: только в игровой день перед закрытием и только игрокам с ранговым забегом недели; сутки без бота-разрешения — ни одной строки ленты; отчёт за вчера уходит один раз.
- `packages/app-shell/test/bot-notifications.test.ts`: `bot.reminders` по умолчанию `true`; ключи и умолчания совпадают с сервером (`account-settings-keys.test.ts`); тексты настроек есть в `ru-bot.json`.

## Аналитика

Новых событий нет: серверные события отложены (`docs/22` §3), доставка видна по `notification.bot_outcome`, возврат — по сессиям с `start_param = n-<вид>`. Метки Prometheus не вводим; для оператора есть лог `reminders_tick` и ежедневный отчёт в `notify.chat.reminders`. В `docs/22` §3.3 — пометка, как считать возврат и долю блокировок (раздел «Шаги», 7).

## Настройки и окружение

Пять ключей `reminders.*` и поток `notify.chat.reminders` (таблица в «Решениях»); ключ аккаунта `bot.reminders`. Переменных окружения нет. Строки в `docs/30-configuration-map.md`.

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: рассылка выключена, пока команда не включит `reminders.enabled` в панели; тексты смотрят на деве.
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: обращение «вы» (как в `bot-notify-texts.ts`), а не «тебя»; единый ключ `bot.reminders` на три вида.
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: пояс тихих часов — Москва (у аккаунта пояса нет); для Сибири и Дальнего Востока окно 10:00–21:00 по Москве сдвинуто, будет жалоба — вводить пояс аккаунта отдельной задачей.
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: «обогнали» считается по снимку первых 100 мест и только у тех, чей результат не менялся; игрок вне сотни обгонов не получает.
- Геймдизайнеру: окно 21→10, суточный потолок и срок `lapse_days` (14) подобраны без данных; смотреть долю блокировок бота в ежедневном отчёте.

## Критерии приёмки

- [ ] Все тесты из раздела «Тесты» зелёные; миграций нет.
- [ ] На деве при `reminders.enabled = true` игрок с разрешением и вчерашней наградой дня получает одно сообщение в окне 10:00–21:00 по Москве; без разрешения, отписавшийся и заблокировавший — ничего.
- [ ] Не больше одного напоминания игроку за окно `reminders.min_gap_hours`, даже если подходят все три вида.
- [ ] Кнопка «Не напоминать» выключает ключ, переключатель в настройках игры возвращает; повторное нажатие безвредно.
- [ ] Отчёт приходит в `notify.chat.reminders` (или в общий чат, если поток пуст) раз в сутки.
- [ ] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Напоминания через бота`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: бот напоминает, если вас обогнали в недельном сезоне, сезон закрывается завтра или ждёт награда дня; не чаще раза в сутки, отключается кнопкой в сообщении и в настройках`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НАПОМИНАНИЯ ЧЕРЕЗ БОТА**

  Бот пишет игрокам, которые разрешили ему писать: «вас обогнали в сезоне», «сезон закрывается завтра», «награда дня ждёт». Не чаще раза в сутки, в окне 10:00–21:00 по Москве, с кнопкой «Не напоминать».

  🛠 **Бот и настройки**

  • три вида уведомлений идут через дубль в бота и общую очередь
  • в панели ключи «Напоминания» и поток `notify.chat.reminders` с суточным отчётом
  • рассылка выключена, пока не включён `reminders.enabled`

  ❓ **Нужно от команды**

  • @владелец — включить `reminders.enabled` на деве после просмотра текстов и откалибровать окно и потолок
  ```
