---
id: T-0110
title: Недельный сезон рейтинга — сервер: таблица недели, закрытие, награды, друзья
epic: E16
priority: P1
status: ready
owner:
author: claude-lead2-17
size: M
depends_on: []
zones:
  - backend/api/src/modules/seasons/**
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
shared:
  - backend/api/src/app.module.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/friends/friends.repository.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
version: v0.9
---

# T-0110. Недельный сезон рейтинга — сервер: таблица недели, закрытие, награды, друзья

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0110.json)](README.md#значки-статуса)

## Зачем

Рейтинг один и вечный: новичку не догнать лучших, а у лучших нет повода
возвращаться. Недельный сезон даёт дедлайн и новую точку отсчёта каждый
понедельник: таблица недели по сложностям, награда всем, кто дотянул до
порога, и за место, таблица друзей. Это серверная половина; экран делает
T-0111. Решение Р102, `docs/39-retention-mechanics.md` Р1: **без лиг** (на
закрытом тесте группы пустые), награды без боевой силы.

## Решения

- **Неделя календарная, UTC:** понедельник 00:00 включительно — следующий
  понедельник 00:00 исключительно. Не «игровой день»: у рейтинга такого
  понятия нет (ключи Redis по сложностям), а `CLAUDE.md` требует UTC. Ключ
  сезона — дата понедельника, `"2026-11-02"` (`seasonKey`), без номеров
  ISO-недель с их краями на стыке годов.
- **Включатель — ключ `seasons.startsAt`** в каталоге настроек (дата
  понедельника UTC, пусто — сезонов нет): «ключ задан — включено» (Р53). Забеги
  раньше этой даты в сезон не идут. Первый сезон тимлид ставит сам, по
  умолчанию понедельник после выката (`2026-11-02`); пока дата в будущем, API
  отвечает `enabled: true, season: null, startsAt`.
- **Что считается:** лучшее время на каждой сложности из забегов
  `ranked = true`, у которых `finished_at` в окне недели. **Источник истины —
  Postgres** (таблица `run`), Redis только проекция для живой таблицы
  (как лидерборд, `leaderboard.store.ts`); закрытие считает из базы, поэтому
  снятие забега модератором до закрытия учтено само.
- **Одна награда на аккаунт и сезон.** Порог — `лучшее время ≥ порог своей
  сложности` хотя бы на одной сложности; награда за место берётся с той
  сложности, где она больше (с множителем сложности), а не суммой по трём.
  Награда за место — только если в таблице сложности не меньше `MIN_BOARD`
  игроков (пустая таблица не отдаёт «первое место» одному игроку). Аккаунт с
  ограничением рейтинга на момент закрытия награду не получает
  (`rating-restrictions.ts`, `hold()`).
- **Числа стартовые, геймдизайнер калибрует** (константы в `season-rules.ts`,
  правка — PR; в панель выносим после замеров):

  | Что | Значение |
  |---|---|
  | `MIN_BOARD` | 10 игроков на сложности |
  | Порог времени (с), лёгкая / обычная / сложная | 180 / 150 / 90 |
  | Награда за порог | 150 монет, 5 престижа |
  | Место 1 | 1 000 монет, 100 престижа |
  | Места 2–3 | 600 монет, 50 престижа |
  | Места 4–10 | 400 монет, 25 престижа |
  | Места 11–50 | 250 монет, 10 престижа |
  | Множитель сложности (как `DIFFICULTY_REWARD_MUL`) | 1 / 1.3 / 1.7 |

  Награда за место **заменяет** награду за порог, а не прибавляется
  (место в таблице уже означает «дотянул»); множитель применяется к монетам и
  престижу, результат округляется `Math.round`. Мягкая валюта — монеты
  (`wallet`); для сравнения: полтора десятка забегов в день дают около 1 300
  монет (`progress-rules.ts`).
- **Награда не начисляется сама, а ждёт «Забрать»** (возврат к закрытию
  сезона — метрика `docs/39` §4.6). Начисление идемпотентно: один заказ на
  пару (сезон, аккаунт).
- **Престиж.** Хранилища очков престижа пока нет (достижения, К1 — отдельная
  задача). Здесь престиж только записывается в строку награды и в событие;
  суммировать его по аккаунту будет задача достижений. Хранилище не заводим.
- **Закрытие — идемпотентная задача под локом:** расписание BullMQ каждые 15
  минут (образец — `modules/export/retention.job.ts`, `upsertJobScheduler`),
  внутри Redis-лок на ключ сезона (образец — `RedisDailyStatsLocks`,
  `admin-notify/daily-stats.reporter.ts:45`: `SET NX PX` с токеном, снятие
  сравнением токена), внутри базы — уникальный `season_key`. Закрываются все
  просроченные сезоны подряд (сервер лежал две недели — закроет обе), по
  одному в транзакции.
- **Ничья.** В окончательных местах при равном времени выше тот, кто показал
  это время раньше (`finished_at` лучшего забега). Живая таблица (Redis ZSET)
  при равенстве держит порядок по id; расхождение живого и окончательного на
  равных временах допустимо, экран его не обещает.
- **Лиги, дивизионы, пропуск, «Испытание дня» — не здесь** (`docs/39` Р2,
  П4, Б9). Дивизион из карточки игрока (Р48) этой задачей не заводится.

## Как сейчас

- `backend/api/src/modules/runs/leaderboard.store.ts` — Redis ZSET
  `runs:leaderboard:<сложность>`, член — `accountId`, очки — лучшее время;
  `ZADD GT CH` не опускает время; `replace` пересобирает через временный ключ
  и `rename`; пересборка из базы — `leaderboard-rebuild.ts`
  (`pnpm --filter backend-api runs:rebuild-leaderboard`).
- `runs-view.service.ts:104-160` — `leaderboardFor(accountId, difficulty)`:
  строки таблицы с именами, оружием, уровнем, убийствами лучшего забега; форма
  ответа клиента — `leaderboardSchema` в `packages/app-shell/src/state/runs-api.ts:38`.
  `@Get("leaderboard")` — `runs.controller.ts:42`.
- `runs-hooks.ts` — `RunsHooks.onRecorded(name, listener)`; слушатель получает
  `RecordedRun` (`ranked`, `difficulty`, `survivalSec`, `finishedAt`) **только
  при первой записи** забега; вызов `void`, падение слушателя логируется.
- Таблица `Run` — `prisma/schema.prisma:416-460`: `ranked`, `difficulty`,
  `survivalSec`, `finishedAt`, `accountId`. Последняя миграция —
  `20261012100814_purchase_run_set_null`.
- Кошелёк: причины начисления — `EARN_REASONS` в `wallet/wallet-types.ts:27`;
  образец идемпотентного начисления — `daily.service.ts` (около строки 115,
  `repository.credit`). Как хранится причина (varchar или enum Postgres) —
  проверить, от этого зависит миграция (шаг 1).
- События: словарь — `events/event-dictionary.ts` и `docs/22-analytics-and-metrics.md`
  §3.3; серверный эмиттер — по образцу других серверных событий в
  `modules/events` (`events.sink.ts`); имя события берётся только из словаря.
- Друзья — `modules/friends` (`friends.service.ts`, `friends.repository.ts`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»), затем **миграция** (expand-only,
   новые таблицы, существующие не меняются; `prisma migrate dev --create-only`
   один раз, проверить, что папка одна):

   ```
   season          (season_key varchar(10) PK, starts_at, ends_at, closed_at,
                    players int, rewarded int)
   season_result   (season_key, account_id, difficulty, best_sec float, place int,
                    board_size int, PK (season_key, account_id, difficulty))
   season_reward   (season_key, account_id, coins int, prestige int,
                    difficulty null, place null, kind varchar(10) 'place'|'threshold',
                    status 'pending'|'claimed', claimed_at null,
                    PK (season_key, account_id))
   ```

   Индексы: `season_result (season_key, difficulty, place)`;
   `season_reward (account_id, status)`. Если у `run` нет индекса по
   `(difficulty, finished_at)` — добавить в той же миграции. Если причины
   кошелька — enum Postgres, `ALTER TYPE … ADD VALUE 'season_reward'` отдельным
   оператором (в транзакции его нельзя использовать в той же транзакции).
   Схему в `docs/21-diagrams.md` (ER) обновить в этом же PR.
2. **`season-rules.ts`** (чистые функции): `seasonOf(at: Date) => { key,
   startsAt, endsAt }`, `thresholdReached(difficulty, bestSec)`,
   `placeReward(place, boardSize, difficulty)`, `rewardFor(results)` (максимум
   по сложностям, порог один раз, ограничение — снаружи), константы из
   «Решений».
3. **Живая таблица.** `season-board.store.ts`: Redis ZSET
   `seasons:<seasonKey>:<сложность>` (`submit` с `GT`, `rank`, `best`, `top`,
   `count`, `replace`), TTL 21 день после конца сезона. Слушатель
   `RunsHooks.onRecorded("seasons", …)`: пропускает неранговые забеги, забеги
   до `seasons.startsAt` и при выключенных сезонах. Скрипт пересборки
   `seasons:rebuild` по образцу `leaderboard-rebuild.ts` (из базы, окно текущей
   недели). Снятие забега с рейтинга (`setRanked` в `runs.service.ts`, место
   вызова `leaderboard.set`) пересчитывает и недельную проекцию аккаунта из
   базы; это правка в зоне `runs`, поэтому делается **минимальным вызовом**
   сервиса сезонов, а не переписыванием модуля.
4. **Чтение.** `GET /api/v1/seasons` и `GET /api/v1/seasons/board`
   (контракт ниже). Таблица недели — по образцу `leaderboardFor`, с лучшим
   забегом **в окне недели** (если метод запроса «лучший забег аккаунта» не
   принимает окно, добавить вариант с `from/to` отдельным коммитом).
   `scope=friends` — принятые друзья + сам игрок (метод «id принятых друзей» в
   `friends.repository.ts`, если его нет — минимальное добавление). Все ответы
   парсятся Zod-схемами (`dto/`), параметры — тоже.
5. **Закрытие** (`season-close.job.ts`, `seasons-close.service.ts`): по «Решениям».
   Расчёт места — одним SQL с оконной функцией (`rank()` по `best_sec desc,
   first_at asc` в разрезе сложности), вставка `season_result` и
   `season_reward` — `INSERT … SELECT` с `ON CONFLICT DO NOTHING`; событие
   `season_closed` — только если вставка строки `season` прошла (то есть
   закрыли мы). Таймауты на каждый внешний вызов.
6. **Награда.** `POST /api/v1/seasons/:key/claim`: атомарный переход
   `pending → claimed` одним `UPDATE … WHERE status = 'pending'
   RETURNING`; начисление монет — через кошелёк с причиной `season_reward` и
   ключом идемпотентности `season:<key>:<accountId>`; событие
   `season_reward_claimed` — один раз. Повтор — `claimed: false` и нули.
7. **События** (сначала словарь и Zod-схема, потом код): `season_closed`
   (`season`, `players`, `rewarded`, `coins_total`, `prestige_total`, по
   сложностям `board_size`) и `season_reward_claimed` (`season`, `kind`,
   `difficulty`, `place`, `coins`, `prestige`). Никаких `account_id` в метках
   Prometheus.
8. **Ключ настроек** `seasons.startsAt` в `setting-catalog.ts`, строка в
   `docs/30-configuration-map.md`; переменной окружения нет.
9. **Документы:** `docs/21-diagrams.md` (ER и поток закрытия), `docs/22`,
   `docs/30`; в `docs/39` у Р1 пометить «сервер — T-0110».

### Контракт (Zod на сервере, зеркально на клиенте в T-0111)

- `GET /api/v1/seasons` →

  ```ts
  { enabled: boolean;
    startsAt: string | null;            // когда начнётся первый сезон, если ещё нет
    season: { key: string; startsAt: string; endsAt: string; secondsLeft: number } | null;
    minBoard: number;
    thresholds: Record<Difficulty, number>;                // секунды
    thresholdReward: { coins: number; prestige: number };
    placeLadder: { fromPlace: number; toPlace: number; coins: number; prestige: number }[];
    difficultyMul: Record<Difficulty, number>;
    mine: Record<Difficulty, number | null>;               // лучшее время недели
    pending: { seasonKey: string; kind: "place" | "threshold"; difficulty: Difficulty | null;
               place: number | null; coins: number; prestige: number }[];
    history: { seasonKey: string; startsAt: string; endsAt: string;
               results: { difficulty: Difficulty; bestSec: number; place: number; boardSize: number }[];
               reward: { coins: number; prestige: number; claimed: boolean } | null }[] }  // до 8 закрытых
  ```

- `GET /api/v1/seasons/board?difficulty=easy&scope=all|friends` →
  `{ seasonKey, difficulty, total, entries: […форма записи leaderboardSchema…], me: { rank, survivalSec } | null }`.
- `POST /api/v1/seasons/:key/claim` → `{ claimed: boolean, credited: { coins, prestige } }`;
  чужая или несуществующая награда — 404 `season_reward_not_found`.
- Ошибки — через `DomainError` с кодом, тексты на русском.

## Чего не трогаем

- Вечный рейтинг (`leaderboard.store.ts`, `GET /runs/leaderboard`, `leaderboard-rebuild.ts`) и его
  ключи Redis: недельная таблица живёт рядом, не вместо.
- Начисление награды за забег, задания, награду дня.
- Экран рейтинга и клиент: T-0111. Показ истории сезонов в профиле и карточке
  игрока (Р48) — отдельным шагом после T-0111; серверная история уже в `GET /seasons`.
- Лиги, группы, повышение и понижение; пропуск; хранилище престижа.
- Антифрод: этой задачей не меняется, сезон читает те же `ranked` и ограничение
  рейтинга.

## Сценарий и интерфейс

Нет экрана (T-0111). Для оператора: пока `seasons.startsAt` пуст, ручки
отвечают `enabled: false` и пустыми списками, слушатель забегов выключен,
закрытие ничего не делает. Админ-панель не меняется; вручную закрыть сезон
нельзя (закрытие идёт по расписанию), перезапуск задачи безопасен.

## Тесты

Первым коммитом. Чистые — `backend/api/src/modules/seasons/season-rules.test.ts`;
интеграционные на живых Postgres и Redis (`docs/17-testing-strategy.md` §4.2) —
`seasons.integration.test.ts` рядом.

- `seasonOf`: `2026-11-02T00:00:00Z` → ключ `2026-11-02`, конец `2026-11-09T00:00Z`;
  `2026-11-08T23:59:59.999Z` → тот же сезон; `2026-11-09T00:00:00Z` → следующий;
  воскресенье → понедельник до него; `2026-12-31` → `2026-12-28`; `2027-01-04` → свой.
- `thresholdReached`: ровно порог — засчитано, на 0.1 с меньше — нет.
- `placeReward`: место 1 на лёгкой при 20 игроках → 1000/100; на сложной →
  1700/170; место 10 → строка 4–10; место 11 → 250/10; место 51 → `null`;
  размер таблицы 9 → `null`.
- `rewardFor`: порог на двух сложностях → одна награда за порог; место на
  обычной и порог на лёгкой → награда за место с множителем 1.3; место на двух
  сложностях → большая.
- Слушатель: неранговый забег и забег до `startsAt` не пишутся; худшее время
  не опускает лучшее (`GT`); повтор итога из очереди клиента второй записи не даёт.
- Закрытие: три аккаунта в окне → `season_result` с местами, ничья решена
  ранним временем; повторное закрытие — ни новых строк, ни второго
  `season_closed`; два закрытия параллельно (`Promise.all`) → одна строка
  `season`, награды без дублей; аккаунт с ограничением рейтинга награды не
  получает; сезон ещё идёт (`endsAt` в будущем) → не закрывается; сервер
  «лежал» две недели → закрыты обе, по порядку.
- Награда: `claim` → `pending → claimed`, монеты начислены один раз (кошелёк
  +N); повтор → `claimed: false`; параллельные два `claim` → одно начисление;
  чужой аккаунт → 404; множитель и округление совпадают с `placeReward`.
- Таблица друзей: только принятые друзья и сам игрок; заявка не в счёт.
- Снятие забега модератором до закрытия → на закрытии время откатилось.
- `GET /seasons` при пустом `seasons.startsAt` → `enabled: false`.

## Аналитика

Два события из словаря (шаг 7): `season_closed`, `season_reward_claimed`.
Запись не блокирует ответ — через очередь событий, идемпотентно по `event_id`;
для `season_closed` ключ идемпотентности — `season_key`. Сначала словарь
(`docs/22` §3.3 и `event-dictionary.ts`) и Zod-схема, потом код. Метрики
Prometheus: счётчик закрытых сезонов и длительность закрытия, без меток
аккаунтов.

## Настройки и окружение

Ключ `seasons.startsAt` (каталог настроек, строка; пусто — выключено).
Переменных окружения и секретов нет. Числа наград — константы
`season-rules.ts` (геймдизайнер калибрует), в панель не выносятся.

## Документы

`docs/21-diagrams.md` (ER: `season`, `season_result`, `season_reward`; поток
закрытия), `docs/22-analytics-and-metrics.md` §3.3, `docs/30-configuration-map.md`,
`docs/39-retention-mechanics.md` (пометка у Р1).

## Критерии приёмки

- [ ] Миграция только добавляет таблицы; `prisma migrate` на чистой базе и на
      копии dev проходит.
- [ ] Закрытие идемпотентно и безопасно при двух репликах (тест с параллельным
      запуском).
- [ ] Награда начисляется один раз, остаток кошелька сходится с журналом.
- [ ] События из словаря, схемы в Zod; `account_id` в метках нет.
- [ ] Таблица друзей не показывает чужих; ограничение рейтинга действует.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check`, интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(api): Недельный сезон рейтинга — таблица, закрытие, награды`
- **Метка:** `release: minor`
- **Для игроков:** нет: экран сезона делает T-0111, раздела `## Для игроков` в PR нет.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НЕДЕЛЬНЫЙ СЕЗОН РЕЙТИНГА, СЕРВЕР**

  Сервер недельного сезона: таблица недели по сложностям, закрытие по
  понедельникам (UTC), награды за порог и за место, таблица друзей, история.
  Выключен, пока в настройках пуст seasons.startsAt.

  🛠 **Сервер**

  • три таблицы, события season_closed и season_reward_claimed
  • числа наград — стартовые, в season-rules.ts

  ❓ **Нужно от команды**

  • @участник1 — задать seasons.startsAt (понедельник) в панели
  • @участник2 — подтвердить пороги и награды
  ```

## Вопросы к тимлиду

- �Подтверждено `claude-lead-1` 13.10.2026: первый сезон — со следующего понедельника
  после выката (`2026-11-02`), без неполной недели; награда не сразу, а по
  «Забрать»; награда за место заменяет награду за порог.
- �Подтверждено `claude-lead-1` 13.10.2026: престиж пишется в `season_reward`, а
  хранилище очков заведёт задача достижений (К1); пока престиж видно только в
  истории сезона.
- Объём на верхней границе M. Если ревью сочтёт его большим, границы
  разреза уже заданы коммитами: (1) правила и миграция, (2) таблица и
  чтение, (3) закрытие и награды.
