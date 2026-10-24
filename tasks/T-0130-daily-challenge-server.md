---
id: T-0130
title: Испытание дня: сервер — расписание, выдача попыток, проверка, награда, таблица дня
epic: E10
priority: P1
status: ready
owner:
author: claude-lead2-22
size: M
depends_on: [T-0129, T-0122, T-0191, T-0193]
zones:
  - backend/api/src/modules/challenge/**
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/src/modules/runs/run-verdict.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/runs-hooks.ts
  - backend/api/src/modules/ads/ads-rules.ts
  - backend/api/package.json
  - backend/api/test/challenge-rules.test.ts
  - backend/api/test/challenge.test.ts
  - backend/api/test/challenge.integration.test.ts
  - backend/api/test/run-verdict.test.ts
  - backend/api/test/runs.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/app.module.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/src/modules/settings/setting-catalog.ts
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

# T-0130. Испытание дня: сервер — расписание, выдача попыток, проверка, награда, таблица дня

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0130.json)](README.md#значки-статуса) [![T-0129](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0129.json&label=T-0129)](T-0129-daily-challenge-engine.md) [![T-0122](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0122.json&label=T-0122)](T-0122-run-modifiers-server.md) [![T-0191](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0191.json&label=T-0191)](T-0191-single-difficulty-server.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md)

## Зачем

Движок (T-0129) умеет сыграть забег по заданному набору, но кто задаёт набор,
сколько раз можно играть и кого считать в таблице, решает сервер: клиенту нельзя
доверять ни seed, ни число заходов, ни «я прошёл испытание». После задачи сервер
каждые игровые сутки выдаёт всем один набор, продаёт второй заход за рекламу,
проверяет итог, платит гарантированную награду за участие и ведёт таблицу дня.
Экраны и панель — T-0131. Решение Р105, `docs/39-retention-mechanics.md` Б9.

## Решения

**Поправка `claude-lead-1` от 20.10.2026 (Р126, единая сложность).** `CHALLENGE_DEFAULT_DIFFICULTY` — `hard`, а не `normal`: «Нормальную» новый клиент не выдаёт (T-0190), рейтинговая сложность одна (T-0191).

Исполнитель их не пересматривает. Числа стартовые, **геймдизайнер калибрует**.

1. **Сутки — игровые, по Москве**, как у заданий и награды дня: `dayKey`
   `YYYY-MM-DD`, граница в 00:00 по Москве (`GAME_DAY_TIME_ZONE`,
   `common/game-day.ts`). `dayKeyOf(at)` — чистая функция в `challenge-rules.ts`
   на `Intl.DateTimeFormat("en-CA", { timeZone })`. Своя, а не из `tasks/task-pool.ts`:
   T-0104 в зависимостях нет, а связывать модули ради трёх строк не нужно.
2. **Расписание — таблица `challenge_plan`**, одна строка на сутки. Строки
   рождаются двумя путями: из панели (`source = 'manual'`) или сервером при первом
   обращении к суткам по умолчанию (`source = 'generated'`, `INSERT … ON CONFLICT
   DO NOTHING`, потом `SELECT`). **Сгенерированная строка замораживается в базе**:
   прошлые таблицы не должны переехать, если позже поменяется генератор или
   список оружия.
3. **Генерация по умолчанию** — чистые функции в `challenge-generator.ts`, без
   Nest и базы, без `Math.random()`, `Date.now()`, степеней и тригонометрии:
   - `seed` = FNV-1a (32 бита, `Math.imul`) от строки `seed:<dayKey>`, `>>> 0`, 0
     заменяется на 1;
   - оружие и модификатор — «мешок»: `bagPick(items, salt, dayNumber)` берёт
     `dayNumber % n`-й элемент перемешанного (Фишер — Йейтс на mulberry32 с зерном
     FNV-1a от `<salt>:<цикл>`) списка, цикл = `floor(dayNumber / n)`. Внутри
     цикла каждый элемент ровно раз; если первый элемент нового цикла равен
     последнему прежнего, он меняется местами со вторым — подряд одинаковых нет.
     `dayNumber` — целое число суток от `2026-01-01` (арифметика `Date.UTC`);
   - модификатор есть каждый день (смысл испытания в нём), из `RUN_MODIFIER_IDS`;
     сложность `normal` (`CHALLENGE_DEFAULT_DIFFICULTY`); карта —
     `CHALLENGE_DEFAULT_MAP`, одна, та же, что оболочка даёт обычному забегу сегодня.
4. **Таблицы значений на сервере** (`challenge-rules.ts`): `CHALLENGE_WEAPONS`
   (все id оружия) и `CHALLENGE_MAP_IDS`, с тестом сверки с
   `packages/core-game/src/content/weapons.ts` и `maps.ts` — образец `WEAPON_ELEMENTS`
   в T-0104 и `boosts.test.ts`. Новое оружие роняет тест, пока строку не добавили.
5. **Два захода, второй за рекламу.** Заход 1 — бесплатно, заход 2 — по досмотренной
   сессии показа нового места рекламы `daily_challenge` (`AD_PLACES`:
   `{ rewarded: true, pass: true, cooldown: null }`); у VIP ролика нет, выдача
   показа отдаёт пропуск — как у второго шанса (`run-ad-continue.service.ts`:
   `ads.readiness`, `ads.claim`). Нет рекламы на площадке и нет VIP — второго
   захода нет (`no_ads`). Одна сессия показа оплачивает один заход:
   `challenge_attempt.ad_session_id` уникален. Третьего захода нет.
6. **Попытка тратится при выдаче.** Выдача создаёт `runId` вида
   `ch-<dayKey>-<uuid>` (префикс — `CHALLENGE_RUN_ID_PREFIX`, T-0129) и строку
   `challenge_attempt`. Повторный запрос того же захода возвращает ту же строку,
   пока забег не начался: `RunsRepository.find(runId)` вернул `null` и с выдачи
   прошло не больше 2 минут (обрыв сети не сжигает заход). Начатый или оставленный
   забег потрачен.
7. **Забег испытания не идёт в общий рейтинг и рекорд сложности**: `rankable`
   ложно при `isChallengeRunId(runId)` — признак по префиксу, без обращения к
   базе и без доверия к телу. Награда за забег, задания и достижения считают его
   как обычный (потолки кошелька остаются). Блокировки `modifier_locked`
   (T-0122) и любая проверка «оружие открыто уровнем» **пропускаются** для
   забега с префиксом: модификатор и оружие здесь назначены расписанием, а не
   выбраны. Где вердикт проверяет открытость оружия, найти по `startingWeaponId`
   в `run-verdict.ts`.
8. **Итог проверяет сервер, функция `judgeAttempt(attempt, plan, recorded)`**
   (чистая, `challenge-rules.ts`). Попытка идёт в таблицу и под награду только
   при **всех** условиях:
   - в `recorded` вердикт `ok`, нет читов, у аккаунта нет ограничения рейтинга
     (`rating-restrictions.ts`, `hold()`);
   - есть строка попытки по `runId`, и `challenge.dayKey` и `challenge.seed` итога
     равны плану, а `startingWeaponId`, `difficultyId`, `modifierIds` — плану;
   - набор не нарушен: снаряжения нет (`loadoutPresent = false`), бустов нет,
     продолжений нет;
   - `survivalSec` не больше «время приёма минус время выдачи» плюс
     `TIME_SLACK_SEC = 5` (сервер не знает ввода, но знает, сколько прошло);
   - забег закончен до конца суток плюс `LATE_GRACE_MIN = 10` минут: забег,
     начатый в 23:55, не наказывается, а сохранённый забег, дожитый на следующий
     день, в чужую таблицу не попадает.
   Нарушение — не отказ в записи: забег записан как обычно, попытка потрачена, в
   таблицу и под награду он не идёт. Причина — в строке попытки (`problem`).
9. **Таблица дня.** Источник истины — `challenge_result` в Postgres (лучшее время
   аккаунта за сутки), Redis ZSET `challenge:board:<dayKey>` — проекция (`ZADD GT CH`,
   член — `accountId`, очки — лучшее время в тех же единицах, что
   `leaderboard.store.ts`), TTL 4 суток. Ключа нет (сброс Redis, первый запрос) —
   пересборка из базы через временный ключ и `rename` (образец
   `leaderboard-rebuild.ts`), скрипт `challenge:rebuild-board` в `package.json`.
   При равном времени живая таблица держит порядок по id, окончательного порядка
   нет: мест за призы нет.
10. **Награда за участие — гарантированная**: `challenge.rewardCoins` монет
    (старт 200; для сравнения: полтора десятка забегов в день дают около 1 300 монет)
    один раз за сутки после первой попытки, прошедшей `judgeAttempt`. Лежит в
    `challenge_result.reward_coins` и ждёт «Забрать»; начисление идемпотентно по
    заказу `challenge:<dayKey>:<accountId>`, причина `challenge_reward` в
    `EARN_REASONS`; забрать можно за сегодняшние и вчерашние сутки. Второй заход
    награды не добавляет. Наград за места нет.
11. **Включатель — ключ `challenge.start-date`** в каталоге настроек: дата игровых
    суток числом ГГГГММДД, как `seasons.start-date` у сезона — формат ключей
    каталога не допускает заглавных, а вида «дата» нет; пусто — испытаний нет: «ключ задан — включено» (Р53). Награду меняет
    ключ `challenge.rewardCoins` без релиза. API выключенной функции отвечает
    `enabled: false`.

## Как сейчас

- `runs/dto/runs.dto.ts` — `runStartSchema`, `runFinishSchema` без поля испытания;
  после T-0122 в них есть `modifierIds`.
- `runs/run-verdict.ts` — `judgeRun`, причины `REJECTING`/`SUSPICIOUS`;
  `runs.service.ts:111` — `rankable`; `runs-hooks.ts` — `RecordedRun`,
  `onRecorded(name, listener)`: слушатель получает забег **один раз**, при первой
  записи. T-0104 и T-0122 расширяют `RecordedRun`: брать их поля, не дублировать.
- `run-ad-continue.service.ts` — образец продажи досмотренной сессии рекламы;
  `ads/ads-rules.ts:15` — `AD_PLACES`, `PLACE_RULES`.
- `leaderboard.store.ts`, `leaderboard-rebuild.ts`, `runs-view.service.ts:104-160`
  (`leaderboardFor`: имена, оружие, уровень игроков в строках) — образцы таблицы.
- Кошелёк: `wallet/wallet-types.ts:27` (`EARN_REASONS`), образец идемпотентного
  начисления — `daily.service.ts` (`repository.credit`). Как хранится причина
  (varchar или enum Postgres) — проверить: от этого зависит миграция.
- Каталог настроек — `settings/setting-catalog.ts` (образец ключа-включателя:
  `seasons.startsAt`, T-0110). События — `events/event-dictionary.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** (expand-only; `prisma migrate dev --create-only` один раз, проверить,
   что папка одна). Диаграмма в `docs/21-diagrams.md` — в том же коммите:

   ```
   challenge_plan    (day_key varchar(10) PK, seed bigint, weapon_id, modifier_ids text[],
                      difficulty_id, map_id, source 'generated'|'manual', note null,
                      updated_by null, created_at, updated_at)
   challenge_attempt (day_key, account_id, attempt_no smallint 1|2, run_id UNIQUE,
                      ad_session_id null UNIQUE, issued_at, finished_at null,
                      survival_sec null, counted bool null, problem null,
                      PK (day_key, account_id, attempt_no))
   challenge_result  (day_key, account_id, best_sec float, best_level, best_kills,
                      best_run_id, best_at, reward_coins null, reward_claimed_at null,
                      PK (day_key, account_id))
   ```
   `seed` лежит в `bigint` (32 бита без знака в `int4` не влезают), в коде это
   `number` с проверкой диапазона Zod-схемой.
3. **`challenge-rules.ts`, `challenge-generator.ts`:** константы, `dayKeyOf`,
   `dayNumberOf`, `bagPick`, `generatePlan`, `judgeAttempt`; сообщения на русском.
4. **Репозиторий и сервис** (`challenge.repository.ts`, `challenge.service.ts`,
   `challenge-board.store.ts`, не длиннее 300 строк каждый): `today(account)`,
   `issue(account, attemptNo, adSessionId?)`, `claimReward`, `board(day)`, а для панели
   `plans(from, days)`, `savePlan`, `resetPlan`. `ensurePlan(dayKey)` — по решению 2.
5. **Контроллер игрока** (`/api/v1/challenge`), по образцу контроллеров модуля `runs`,
   с теми же ограничителями частоты:
   - `GET /` → `{ enabled, dayKey, secondsLeft, set: { weaponId, modifierIds,
     difficultyId, mapId }, attempts: [{ no, state: "free" | "ad" | "taken" | "done",
     runId?, survivalSec? }], reward: { coins, state: "none" | "ready" | "claimed" },
     best, place, total }`; `seed` в этом ответе **нет** — он выдаётся только с
     попыткой;
   - `POST /attempts` `{ attemptNo, adSessionId? }` → `{ dayKey, attemptNo, runId,
     issuedAt, set: { seed, mapId, difficultyId, weaponId, modifierIds } }`;
     отказы классами ошибок (образец `run-continue-errors.ts`): `disabled`,
     `taken`, `order` (заход 2 раньше завершённого захода 1), `ad_required`,
     `no_ads`;
   - `POST /reward/claim` `{ dayKey }`; `GET /board?day=today|yesterday` → до 50
     строк `{ place, name, survivalSec, level, kills }` (имена — тем же приёмом,
     что `leaderboardFor`, запрос не копировать) и `me`, `total`.
6. **Контроллер панели** (`/api/v1/admin/challenge`): `GET /plans?from&days`
   (будущие 14 суток: для суток без строки — предпросмотр генератора с
   `source: "preview"`; прошлые 7 суток — со счётчиками `players`, `attempts`,
   лучшим временем), `PUT /plans/:dayKey`, `DELETE /plans/:dayKey`. Правка
   разрешена для суток не раньше сегодняшних, а для сегодняшних — пока выдано ноль
   попыток (иначе 409 `ChallengePlanLockedError`). Поля: оружие из
   `CHALLENGE_WEAPONS`, модификаторов 0 или 1, сложность, карта, `seed` (пусто —
   по генератору). Право доступа и запись в журнал панели — по образцу каталога
   заданий (`tasks`): найти, как он защищён и логируется, завести право
   `challenge` так же.
7. **Забег:** `runs.dto.ts` — `challenge: { dayKey, seed }` необязательное в
   итоге; `run-verdict.ts` и `runs.service.ts` — решение 7; `RecordedRun` получает
   `runId`, `startingWeaponId`, `modifierIds`, `challenge`, `loadoutPresent`,
   `continuesTaken` (то, что уже добавили T-0104 и T-0122, не дублировать).
   Слушатель `onRecorded("challenge", …)` ищет попытку по `runId`, вызывает
   `judgeAttempt`, пишет `challenge_attempt` и, если прошла, — `challenge_result`
   (лучшее время, награда, `ZADD GT CH`).
8. **Реклама:** `daily_challenge` в `AD_PLACES` и `PLACE_RULES`; компилятор покажет
   все `Record<AdPlace, …>`; как хранится `place` у сессий показа (varchar или enum) —
   проверить, при enum миграция расширяет его (в той же миграции).
9. **События, метрики, настройки, документы:** см. разделы ниже; `app.module.ts`
   подключает модуль; скрипт `challenge:rebuild-board`.

## Чего не трогаем

- Движок и набор (T-0129); экраны и панель (T-0131); сами модификаторы и их награда
  (T-0119, T-0122: меняем только пропуск `modifier_locked` и `rankable`).
- Общий рейтинг, доски, сезон (T-0110…T-0114); награду за место в таблице дня;
  лиги.
- Серверную перепроверку повтором ввода: сервер ввода не получает, вердикт и время от
  выдачи — всё, что есть.
- Уведомления бота «испытание готово» (`docs/39` П5).

## Тесты

Первым коммитом, до кода. Интеграционные — на живых Postgres и Redis.

- `challenge-rules.test.ts` (чистые функции): `dayKeyOf(2026-10-14T20:59:59Z)` →
  `2026-10-14`, `…T21:00:00Z` → `2026-10-15`; `generatePlan` одинаков при двух
  вызовах; `seed` в 1…4294967295; в любом окне из `n` подряд идущих суток внутри
  одного цикла оружие не повторяется; на 400 сутках подряд одинаковых оружия и
  модификатора не бывает; все `CHALLENGE_WEAPONS` и оба модификатора встречаются;
  сверка `CHALLENGE_WEAPONS`/`CHALLENGE_MAP_IDS` с контентом `core-game`.
- `judgeAttempt`: образцовый итог → засчитан; по одному нарушению на случай — чужие
  `seed`, `dayKey`, оружие, сложность, модификатор; снаряжение, буст, продолжение;
  `survivalSec` на секунду больше допуска и ровно на границе; конец забега в
  `dayEnd + 10 мин` засчитан, на минуту позже — нет; ограничение рейтинга; вердикт
  `suspicious`; читы; нет строки попытки при префиксе `ch-`.
- `run-verdict.test.ts`: забег с префиксом и закрытым модификатором не получает
  `modifier_locked`; без префикса — получает, как прежде. `runs.test.ts`:
  `rankable` ложно при префиксе, истинно у обычного забега.
- `challenge.test.ts` (сервис на заглушках): заход 1 бесплатный; заход 2 без
  `adSessionId` — `ad_required`; заход 2 раньше завершённого захода 1 — `order`;
  VIP получает пропуск; нет рекламы — `no_ads`; та же сессия показа на второй заход
  дважды — одна выдача; повтор запроса захода до старта возвращает тот же `runId`,
  после старта — `taken`; третий заход — `taken`; правка плана сегодняшних суток
  после выдачи попыток — `ChallengePlanLockedError`; прошлые сутки править нельзя.
- `challenge.integration.test.ts`: два аккаунта получают один `seed` и один набор;
  параллельные первые запросы суток создают **одну** строку плана; заморозка:
  после смены списка оружия в тесте уже созданные сутки не меняются; забег по
  выданному `runId` через `runs.service` → строка в `challenge_result`, ZSET и
  награда `ready`; забор награды дважды начисляет один раз; забор за позавчера —
  отказ; худший второй заход не снижает результат (`GT`); сброс Redis → `board()`
  пересобирает таблицу из базы; обычный забег не попадает в таблицу дня, а забег
  испытания — в общий рейтинг; аккаунт с ограничением рейтинга в таблицу и под
  награду не попадает; ключ `challenge.start-date` пуст → `enabled: false`.

## Аналитика

Сначала строки в `docs/22-analytics-and-metrics.md` §3.3 и Zod-схема словаря
(`event-dictionary.ts`), потом код; события шлёт сервер.

- `challenge_attempt_issued`: `day`, `attempt` (1 или 2), `source` (`free`, `ad`,
  `vip`).
- `challenge_finished`: `day`, `attempt`, `survivalSec`, `counted` (прошла ли
  `judgeAttempt`), `problem` (причина, если нет), `bestUpdated`.
- `challenge_reward_claimed`: `day`, `coins`.

Метрики Prometheus, только низкая кардинальность: `challenge_attempts_issued_total`
`{attempt, source}`, `challenge_results_total{outcome="counted|rejected"}`; никаких
`account_id` и `day_key` в метках.

## Настройки и окружение

Новые ключи каталога настроек: `challenge.start-date` (дата игровых суток, пусто —
выключено) и `challenge.rewardCoins` (целое, по умолчанию 200). Переменных
окружения нет. Константы кода: `TIME_SLACK_SEC`, `LATE_GRACE_MIN`, 2 захода.

## Документы

`docs/21-diagrams.md` (три таблицы), `docs/22-analytics-and-metrics.md` (три
события), `docs/30-configuration-map.md` (два ключа, константы, расписание в
базе), `docs/39-retention-mechanics.md` Б9 (сервер).

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: сутки игровые (Москва),
  а не UTC, как сказано в `docs/39` Б9: так «сегодня» совпадает с наградой дня и
  заданиями. Строку Б9 поправить в этом же PR.
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: наград за места нет, только
  гарантированная за участие; награды за места — после замеров аудитории
  (на закрытом тесте таблица будет короткой).
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: награда за сам забег
  (монеты и опыт аккаунта) платится за каждый заход как за обычный забег, потолки
  кошелька остаются.
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: свой FNV-1a и mulberry32 в
  `challenge-generator.ts`, общий `common/seeded-random.ts` — отдельным
  рефакторингом после влития T-0104.
- Размер на верхней границе M. Если исполнитель видит L (панельные контроллеры
  раздувают), вынести шаг 6 в отдельную задачу и написать тимлиду до работы.

## Критерии приёмки

- [ ] Все тесты из раздела «Тесты» зелёные; миграция одна, только добавляет таблицы.
- [ ] На деве два аккаунта получают один набор; второй заход без рекламы не выдаётся.
- [ ] Результат попадает в таблицу дня и под награду, только если прошёл `judgeAttempt`.
- [ ] Забег испытания не двигает общий рейтинг и рекорд; закрытый модификатор не отклоняет его.
- [ ] Таблица пересобирается из базы после сброса Redis; награда начисляется один раз.
- [ ] Сгенерированные сутки заморожены; правка сегодняшних суток после выдачи попыток запрещена.
- [ ] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Испытание дня на сервере`
- **Метка:** `release: minor`
- **Для игроков:** нет (экраны — T-0131)
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ИСПЫТАНИЕ ДНЯ: СЕРВЕР**

  Сервер выдаёт на игровые сутки один набор (seed, оружие, модификатор) всем, продаёт второй заход за рекламу, проверяет итог и ведёт таблицу дня с наградой за участие. До игроков дойдёт вместе с экранами.

  🛠 **Сервер**

  • расписание в базе: по умолчанию генерируется от даты, сутки замораживаются при первом обращении, правится из панели
  • забег испытания не идёт в общий рейтинг
  • включается ключом challenge.start-date в настройках

  ❓ **Нужно от команды**

  • @владелец — задать challenge.start-date, когда выйдут экраны, и откалибровать награду
  ```
