---
id: T-0447
title: Лента главной и карточка бота — рекорд по очкам, а не по времени
epic: E11
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / medium
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/feed/feed-events.ts
  - backend/api/src/modules/feed/feed-rules.ts
  - backend/api/src/modules/feed/feed.service.ts
  - backend/api/src/modules/feed/feed.repository.ts
  - backend/api/test/feed.test.ts
  - backend/api/test/feed.integration.test.ts
  - backend/api/src/platforms/telegram/welcome-card.ts
  - backend/api/src/platforms/telegram/welcome-texts.ts
  - backend/api/src/platforms/telegram/welcome-progress.ts
  - backend/api/test/welcome.test.ts
  - backend/api/test/welcome-progress.test.ts
  - packages/app-shell/src/state/feed-api.ts
  - packages/app-shell/src/screens/home-feed-rules.ts
  - packages/app-shell/test/feed-api.test.ts
  - packages/app-shell/test/home-feed-rules.test.ts
shared:
  - packages/app-shell/src/i18n/ru-home.json
  - docs/22-analytics-and-metrics.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
merge: lead
design: null
batch: 4
---

# T-0447. Лента главной и карточка бота — рекорд по очкам, а не по времени

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0447.json)](README.md#значки-статуса)

## Зачем

Рейтинг перешёл на очки эффективности, а лента главной по-прежнему пишет
«новый рекорд недели — 12:40», и карточка бота на `/start` крупно показывает
лучшее время рядом с местом на доске, которая уже по очкам. Игрок видит два
разных мерила одного рейтинга. После задачи и лента, и карточка говорят
очками, время — подписью.

## Решения

- `docs/35-stage4-plan.md`, **Р212**, п. 4:
  - **лента главной**: «рекорд недели» в сезоне по очкам считается по очкам
    и пишет очки; в сезоне по времени — как сейчас;
  - **карточка бота** на `/start`: лучший забег — очками, место — на доске
    очков (оно уже такое), время — подписью;
  - напоминания бота («обогнали», «закрывается») чисел не несут — не
    меняются;
  - плитка «Лучший забег» на главной (личный рекорд) — тоже по очкам, но
    отдельной задачей T-0451 (ответ владельца 12.11.2026); здесь не трогаем.
- Старые клиенты: поле `seconds` у событий ленты остаётся, новое поле
  `points` — дополнительное.

## Как сейчас

- `backend/api/src/modules/feed/feed.service.ts`, `beatsWeekTop` (строки
  ~90–96): `repository.bumpWeekTop(season.key, run.difficulty, run.survivalSec)` —
  лидер недели по времени, ключ Redis `feed:week-top:<сезон>:<сложность>`
  (`feed.repository.ts`, `weekTopKey`, `BUMP_SCRIPT`).
- `feed-rules.ts`, `feedEventsOf` (строка ~30): `week_record` несёт
  `seconds: run.survivalSec`. `RecordedRun` (`runs/runs-hooks.ts`) несёт
  `points?: number | null`.
- `feed-events.ts`: `FeedEvent` и `feedEventSchema` — `seconds`; события лежат
  строками в ZSET (`encodeFeedEvent`), разбор — схемой.
- `feed.service.ts` (строка ~143): наружу `{ id, kind, name, at, seconds }`.
- `SeasonSchedule` (`seasons/seasons-schedule.ts`): `scoringOf(season)`,
  `boardSeason(season)` — ключ доски `pts:<понедельник>` у сезона по очкам.
- Клиент: `packages/app-shell/src/state/feed-api.ts` — `eventSchema` с
  `seconds`; `screens/home-feed-rules.ts`, `feedTextOf` — `week_record` →
  `feed.weekRecord` «{name}: новый рекорд недели — {time}».
- Карточка бота: `platforms/telegram/welcome-progress.ts` — `best` из
  `RunsViewService.profile(...).best.hard`, где уже есть `points`, `survivalSec`,
  `rank` (доска очков); `welcome-card.ts` (строки ~96–110) рисует крупно
  `formatDuration(best.survivalSec)` и подпись `texts.recordLabel()`; ключ
  кэша `welcomeCacheKey` — из времени, места и размера доски; `CARD_VERSION`.

## Шаги по порядку

1. `feed-events.ts`: у `FeedEvent` новое поле `points: number | null` (у
   `week_record` в сезоне по очкам — очки, иначе `null`); в схеме
   `points: z.number().int().nonnegative().nullable().default(null)` —
   старые записи в Redis разбираются. `encodeFeedEvent` — поле в конце
   порядка.
2. `feed.service.ts`, `beatsWeekTop`: режим сезона `this.schedule.scoringOf(season)`;
   счёт — `scoreOf(run, scoring)` (`rating/rating-switch.ts`); счёта нет
   (забег без очков в сезоне по очкам) — не рекорд; ключ лидера —
   `this.schedule.boardSeason(season).key` (у сезона по очкам — с `pts:`,
   поэтому лидер по времени и по очкам не смешиваются). Вернуть и режим —
   `feedEventsOf` положит очки в событие.
3. `feed-rules.ts`: `week_record` — `seconds: run.survivalSec`,
   `points: scoring === "points" ? run.points : null`; остальные виды —
   `points: null`.
4. `feed.service.ts`: наружу ещё `points`.
5. Клиент, `feed-api.ts`: в `eventSchema` и `FeedItem` — `points: number | null`
   (`z.optional(z.nullable(z.number()))`, нет поля — `null`).
6. `home-feed-rules.ts`: `week_record` с `points !== null` — ключ
   `feed.weekRecordPoints`, параметры `name`, `points` (число с разрядами);
   без очков — прежний `feed.weekRecord`.
7. `i18n/ru-home.json`: `"feed.weekRecordPoints": "{name}: новый рекорд недели — {points} {points, plural, one {очко} few {очка} many {очков} other {очков}}"`.
8. Карточка бота:
   - `welcome-progress.ts`: в `best` — ещё `points: best.points`;
   - `WelcomeCard.progress.best` — `{ points: number; survivalSec: number; rank: number; total: number }`;
   - `welcome-card.ts`: крупно — очки (`formatNumber`, тот же размер 120, при
     ширине больше колонки — 96), подпись — `texts.pointsLabel(survivalSec)`;
     `CARD_VERSION` + 1; в ключе кэша — очки вместо времени и время
     (округлённое) рядом;
   - `welcome-texts.ts`: `pointsLabel(sec)` — ru «очков · за {м:сс}», en
     «points · in {m:ss}»; `recordLabel` убрать, если больше не нужен.
9. `docs/22-analytics-and-metrics.md` — если лента описана там (витрина, не
   аналитика), строка про очки у `week_record`; иначе не трогать.

## Чего не трогаем

- Виды `long_run`, `boss`, `chest` и их тексты.
- Плитку «Лучший забег» (`home-widget-rules.ts`, `recordFace`) — T-0451.
- Напоминания бота (`notifications-bot/bot-notify-texts.ts`) — в них нет чисел.
- Переход сезона на очки и пересборку таблицы недели — T-0446.

## Сценарий и интерфейс

- Главная, лента, неделя по очкам: «Иван: новый рекорд недели — 2 340 очков».
  Неделя по времени (до смены ключа T-0446): как сейчас, «— 12:40».
- Бот, `/start` у игрока с забегами: крупно «2 340», под ним «очков · за 12:40»,
  справа «#7 из 92» и число забегов. Новичок — карточка как сейчас.

## Тесты

Первым коммитом:

- `backend/api/test/feed.test.ts`:
  - сезон по очкам: забег с очками больше лидера — событие `week_record` с
    `points`, лидер пишется под ключ с `pts:`; забег с бо́льшим временем, но
    меньшими очками — не рекорд; забег без очков — не рекорд;
  - сезон по времени — как раньше, `points: null`;
  - старая запись без `points` разбирается схемой (`points: null`).
- `backend/api/test/feed.integration.test.ts` — поправить ожидания
  `toEqual`, если событие сравнивается целиком.
- `packages/app-shell/test/feed-api.test.ts` — ответ без `points` и с
  `points` разбирается.
- `packages/app-shell/test/home-feed-rules.test.ts` — `week_record` с очками →
  `feed.weekRecordPoints` и `points`; без очков → прежний ключ и `time`.
- `backend/api/test/welcome.test.ts` — карточка игрока с забегами содержит
  очки с разрядами и подпись со временем; ключ кэша меняется от очков и не
  меняется от долей секунды.
- `backend/api/test/welcome-progress.test.ts` — `best.points` из профиля.

## Аналитика

Нет новых событий: лента — витрина в Redis, событий в `analytics_event` не
порождает (`feed-events.ts`).

## Настройки и окружение

Нет.

## Документы

- `docs/22-analytics-and-metrics.md` — по шагу 9, если там описана лента.

## Критерии приёмки

- [ ] В неделе по очкам лента пишет рекорд недели очками, а рекордом
      считается забег с наибольшими очками.
- [ ] Старые события ленты и старый клиент не ломаются.
- [ ] Карточка бота показывает очки крупно и время подписью.
- [ ] Тесты из раздела «Тесты» есть и зелёные.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(feed): Рекорд недели и карточка бота по очкам`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено: лента главной и карточка бота показывают рекорд в очках, как рейтинг`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕКОРД НЕДЕЛИ И КАРТОЧКА БОТА ПО ОЧКАМ**

  Лента главной считает рекорд недели по очкам и пишет очки, если неделя по
  очкам; карточка бота на /start показывает лучший забег очками (Р212).

  🛠 **Что сделано**

  • лидер недели ленты — по режиму сезона, отдельный ключ для очков
  • у события week_record новое поле points, seconds остаётся для старых клиентов
  • карточка приветствия: очки крупно, время подписью
  ```
