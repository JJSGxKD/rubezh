---
id: T-0294
title: Доски рейтинга по очкам — общая, сезонная, друзья и скрытая; лучший забег периода, порог награды сезона в очках, переход с нового сезона
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0293, T-0114]
zones:
  - backend/api/src/modules/rating/rating-switch.ts
  - backend/api/test/rating-boards.integration.test.ts
shared:
  - backend/api/src/modules/runs/leaderboard.store.ts
  - backend/api/src/modules/runs/leaderboard-rebuild.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/runs.repository.ts
  - backend/api/src/modules/runs/rating-restrictions.ts
  - backend/api/src/modules/runs/dto/**
  - backend/api/src/modules/seasons/**
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/test/**
  - docs/10-progression-and-ladder.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: design/art/meta-v2.md
batch: 7
---

# T-0294. Доски рейтинга по очкам — общая, сезонная, друзья и скрытая; лучший забег периода, порог награды сезона в очках, переход с нового сезона

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0294.json)](README.md#значки-статуса) [![T-0293](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0293.json&label=T-0293)](T-0293-rating-run-score-server.md) [![T-0114](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0114.json&label=T-0114)](T-0114-season-rewards-by-viewer-board.md)

## Зачем

После T-0293 у каждого забега есть очки эффективности, а доски по-прежнему
ставят по лучшему времени. После задачи все доски ставят по очкам **лучшего
забега периода**:
- общая;
- сезонная;
- друзья;
- скрытая доска ограниченных (T-0112).

Время остаётся в строке как подпись. Награды сезона — по месту, как сейчас,
а порог «участника» — в очках.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- Р66 — рейтинг эффективности, не «кто дольше»;
- Р152 — очки по пяти осям;
- в рейтинг идёт лучший забег периода, а не сумма (`design/art/meta-v2.md` §2.5).

Решения `claude-lead-1` от 25.10.2026:

- **Счёт доски** — очки `run.points` лучшего рейтингового забега периода:
  - `ZADD GT` по очкам вместо времени;
  - член множества — аккаунт;
  - `survivalSec` лучшего по очкам забега — подписью в строке.

  Ничья по очкам — раньше поставленный выше (как сейчас со временем).
- **Переход — с начала следующего сезона.** Сезон, идущий в момент выката,
  дотягивается по времени: менять правила посреди недели — нечестно к тем,
  кто уже играл. Ключ `rating.points-from` — дата начала первого сезона по
  очкам:
  - пустой — понедельник UTC после выката, его ставит миграция;
  - сезоны с этой даты — по очкам, раньше — по времени (архив сезонов не
    пересчитывается).

  Общая доска всех времён переходит **сразу**: пересобирается по очкам
  пересчитанных забегов (`runs:rescore`, T-0293) командой
  `runs:rebuild-leaderboard`.
- **Ключи Redis** — новые, с приставкой `pts:`. Старые ключи по времени
  остаются до конца текущего сезона и потом истекают сами — переключение без
  окна, где доска пуста.
- **Порог награды сезона** — `THRESHOLD_SEC` по сложности заменяется
  `rating.season-threshold-points` (умолчание 800 — чуть ниже типичного
  забега) для сезонов по очкам. Лестница мест `PLACE_LADDER` и награды не
  меняются.
- **Ответы** — у строк досок и у «меня»:
  - `points` вместо `survivalSec` как главное число, `survivalSec` — рядом;
  - `style` лучшего забега (T-0293).

  Старые поля ответа остаются для старых клиентов до T-0296: `survivalSec`
  не пропадает.
- **Снятие забега модератором** — пересчёт лучшего по очкам из оставшихся
  (`set` хранилищ), как сейчас со временем.

## Как сейчас

- **Доски:**
  - общая — `runs/leaderboard.store.ts` (ZSET по `survivalSec`, `ZADD GT`);
  - пересборка — `runs/leaderboard-rebuild.ts`;
  - вид — `runs-view.service.ts` (`leaderboardFor`, `profile`, `boardBest`, `shadowBest`).
- **Сезон:**
  - доска — `seasons/season-board.store.ts`;
  - вид — `seasons-view.service.ts` (`board`, `allStanding`, `friendsStanding`, `shadowStanding`);
  - награды — `season-rules.ts`: `THRESHOLD_SEC`, `PLACE_LADDER`, `rewardFor`;
  - закрытие — `seasons-close.service.ts`.
- **Скрытая доска** — `runs/rating-restrictions.ts` (T-0112).
- **После T-0293** — `run.points`, `run.style`, `runs:rescore`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — ключ `rating.points-from` с понедельником после выката;
   индекс `run (difficulty, ranked, points)`.
3. **`rating/rating-switch.ts`** — по сезону или дате: доска по очкам или по
   времени (чистая).
4. **Хранилища** — очки, новые ключи, `set` при снятии.
5. **Виды** — `points`, `style`, подпись времени.
6. **Сезон** — порог в очках, закрытие сезона по очкам.
7. **Пересборка** — общая доска по очкам.
8. **Документы:**
   - `docs/10` §4 — рейтинг по очкам и переход;
   - `docs/30` — ключи.

## Чего не трогаем

- Лестницу наград сезона.
- Дивизионы и стиль игрока — T-0295. Клиент — T-0296.

## Тесты

Первым коммитом, `rating-boards.integration.test.ts`:
- два забега игрока: 900 с и 1 800 очков, 1 200 с и 1 500 очков → в доске
  1 800, подпись 900 с;
- текущий сезон до `rating.points-from` — по времени, следующий — по очкам;
- общая доска после пересборки — по очкам;
- снятый модератором лучший забег → в доске следующий по очкам;
- скрытая доска и друзья — по очкам;
- порог награды сезона по очкам: 799 — нет награды участника, 800 — есть;
- ответ содержит и `points`, и `survivalSec`.

## Аналитика

Нет новых событий.

## Настройки и окружение

Ключи `rating.points-from`, `rating.season-threshold-points`.

## Документы

По шагу 8.

## Критерии приёмки

- [ ] Все доски — по очкам лучшего забега периода; время — подписью.
- [ ] Сезон в момент выката дотягивается по времени, следующий — по очкам; общая доска пересобрана.
- [ ] Порог награды сезона — в очках; лестница мест прежняя.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Рейтинг по очкам эффективности`
- **Метка:** `release: minor`
- **Для игроков:** пусто — экран рейтинга с очками — T-0296.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕЙТИНГ ПО ОЧКАМ**

  Доски рейтинга ставят по очкам эффективности лучшего забега периода, время — подписью. Общая доска пересобрана сразу, сезон по очкам — со следующего понедельника (ключ rating.points-from). Награды сезона по местам прежние, порог участника — в очках.
  ```
