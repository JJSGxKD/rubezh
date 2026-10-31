---
id: T-0113
title: Доски рейтинга по зрителю: полная и общая, место и профиль по доске смотрящего
epic: E16
priority: P1
status: done
owner: claude-14 / sonnet-5.5 / extra
author: claude-lead2-18
size: M
depends_on: [T-0112]
zones:
  - backend/api/src/modules/runs/leaderboard.store.ts
  - backend/api/src/modules/runs/leaderboard-rebuild.ts
  - backend/api/src/modules/runs/rating-restrictions.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/cli/runs-rebuild-leaderboard.ts
  - backend/api/src/cli/wipe.ts
  - backend/api/test/helpers/memory-runs.ts
  - backend/api/test/runs.test.ts
  - backend/api/test/runs.integration.test.ts
  - backend/api/test/rating-restrictions.test.ts
  - backend/api/test/boards-by-viewer.test.ts
shared:
  - backend/api/src/platforms/telegram/welcome-progress.ts
  - backend/api/test/friends.test.ts
  - backend/api/test/admin.test.ts
  - backend/api/test/compensation.test.ts
  - docs/14-scalability.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0113. Доски рейтинга по зрителю: полная и общая, место и профиль по доске смотрящего

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0113.json)](README.md#значки-статуса) [![T-0112](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0112.json&label=T-0112)](archive/T-0112-separate-board-restriction.md)

## Зачем

Рейтинг должен показывать каждому ту доску, которая ему положена: аккаунт со
скрытым ограничением «Отдельная доска» (T-0112) читает полную доску, все
остальные — общую, где таких аккаунтов нет. Места, профиль, карточки места и
ответ на конец забега считаются по доске смотрящего.

## Решения

Р104, `docs/14-scalability.md` (рейтинг — проекция в Redis), решение владельца
от 13.10.2026. Исполнитель их не пересматривает.

- **Две проекции одного источника.** Источник истины — Postgres, `run.ranked =
  true`; забеги аккаунта с ограничением остаются рейтинговыми. **Полная доска**
  — все рейтинговые аккаунты; **общая** — те же без аккаунтов с действующим
  ограничением. Зритель с ограничением читает полную, остальные — общую.
- **Ключи Redis.** Общая — **прежний** ключ `runs:leaderboard:<сложность>`:
  все остальные игроки читают её без перехода. Полная — новый
  `runs:leaderboard:full:<сложность>`. Читает полную только тот, кто под
  ограничением; пока никого нет, она никому не нужна, поэтому выкат безопасен:
  сначала код, потом пересборка (шаг 11), потом первое наложение.
- **Место считается по доске зрителя**: `rank`, `totalPlayers`, `me`,
  `countAbove`, `boardSize`. Форма ответов и схема клиента (`runs-api.ts`)
  не меняются — ни поля «доска», ни отличий в JSON.
- **Профиль для команды** (`profile(id, "team")`) показывает место так, как его
  видит владелец профиля: по доске аккаунта.
- **Ограничение рейтинга сильнее.** Аккаунт под видом `leaderboard` или
  блокировкой целиком не лежит ни в одной доске (`excluded`), как сейчас;
  «тень» (`hold === "silent"`) считается поверх доски, которую читает зритель.
- **Друзья видны как обычно.** Список друзей и всё, что строится по друзьям, не
  фильтруется по доске.
- **Согласованность самолечением.** Запись в две проекции не атомарна с
  чтением ограничения, поэтому обход раз в минуту (`RatingRestrictions.sweep`)
  убирает из общей доски всех, у кого действует вид. Гонка «забег принят в ту
  же секунду, что наложение» живёт не дольше минуты.

## Как сейчас

- `leaderboard.store.ts`: интерфейс (26–45), `submit` с `ZADD GT CH` (54),
  `rank/best/top/count/countAbove` (60–85), `set` (87), `remove` (92),
  `replace` через временный ключ `…:rebuild` и `rename` (99–113), `key()` (116).
  Один ключ на сложность.
- `leaderboard-rebuild.ts`: `rebuildLeaderboard(runs, leaderboard, excluded)` —
  одна проекция, возвращает `Record<string, number>`.
- `rating-restrictions.ts`: слушатели `onImposed/onSettled("rating")` (58–61),
  `hold` (74), `excluded` (80), `sweep` (105), `settled` возвращает лучший
  рейтинговый в доску (119–132). `boardOf` — из T-0112.
- `runs.service.ts`: `resultOf` (221–242) пишет `submit`, читает `best` и
  `rank`; `shadowResult` (251); `setRanked` (176–200) переписывает доску через
  `set`; `rebuildLeaderboard` (171).
- `runs-view.service.ts`: `leaderboardFor` (109), `fromShadow` (154), `profile`
  (182), `boardSize` (205), `boardBest` (219), `shadowBest` (224).
- `welcome-progress.ts:33–38` берёт место и размер доски через
  `RunsViewService` — для карточки приветствия бота.
- `cli/runs-rebuild-leaderboard.ts`, `cli/wipe.ts:43–47` вызывают пересборку с
  одним набором исключений.
- Друзья (`friends.service.ts`) мест и времён не показывают.

## Шаги по порядку

Границы коммитов: (1) хранилище и пересборка, (2) ограничения и обход, (3)
чтение и запись забегов. Каждый собирается и проходит тесты.

1. **Тесты** (раздел «Тесты») — первым коммитом.
2. **Хранилище.** `leaderboard.store.ts`: `export type Board = "common" | "full"`,
   `ALL_BOARDS = ["full", "common"]`, `COMMON_ONLY = ["common"]`,
   `key(difficulty, board)`. Все чтения получают `board` обязательным
   параметром (компилятор покажет всех вызывающих). Запись:
   - `submit(difficulty, accountId, survivalSec, boards: readonly Board[])`:
     `ZADD GT CH` по каждой доске одним `multi()/exec()`, `improved` — если
     изменилась хоть одна (лучшее время игрока на всех досках одно);
   - `set(difficulty, accountId, survivalSec | null, boards)`;
   - `remove(accountIds, boards)`; `replace(difficulty, board, entries)` — свой
     временный ключ на доску.
3. **Пересборка.** `leaderboard-rebuild.ts`:
   `rebuildLeaderboard(runs, leaderboard, excluded, separate)`; полная =
   `bestTimes` без `excluded`, общая = полная без `separate`; возвращает
   `Record<string, { full: number; common: number }>`. Вызывающие: `runs.service.ts`
   (171), `cli/runs-rebuild-leaderboard.ts`, `cli/wipe.ts` — набор `separate`
   берут из `restrictedAccounts("separate_board")`.
4. **Куда писать.** `rating-restrictions.ts`:
   `boardsFor(accountId, at): Promise<readonly Board[]>` — `["full"]` при
   `boardOf === "full"`, иначе `ALL_BOARDS`; `separate(at): Promise<string[]>`
   — `restrictions.restrictedAccounts("separate_board", at)`.
5. **Слушатели.** Второй пара `onImposed("board")` / `onSettled("board")`
   (имя уникально среди слушателей): вид `separate_board` в `kinds` — наложение
   убирает аккаунт из **общей** доски всех сложностей (полная не трогается);
   снятие или срок — если `boardOf` всё ещё `"full"` или `hold` не `null`,
   выйти; иначе вернуть в общую лучший рейтинговый забег каждой сложности
   (`bestRunOf(id, d, false)`). Существующий `settled` для `leaderboard` и `all`
   возвращает лучший забег в доски, которые положены аккаунту сейчас
   (`boardsFor`).
6. **Обход.** `sweep`: после снятия `excluded` из обеих досок добавить
   `remove(await this.separate(at), COMMON_ONLY)`; возвращаемое число — сумма;
   лог `rating_restricted_swept` без деления на доски.
7. **Запись забега.** `runs.service.ts`: `resultOf` — `submit(…, await
   rating.boardsFor(id))`; `best`/`rank` читать с `boardOf`; `shadowResult` —
   `countAbove(difficulty, best, board)`; `setRanked` — `set(…, boardsFor)`.
8. **Чтение.** `runs-view.service.ts`: один вызов `rating.boardOf(accountId)` в
   начале `leaderboardFor`, `profile`, `boardSize`, дальше `board` в каждое
   чтение; `fromShadow`, `shadowBest`, `boardBest` получают `board`.
   `profile(id, "team")` — доска владельца профиля, как в «Решениях».
9. **Остальные вызывающие.** `welcome-progress.ts` и всё, что сейчас читает
   `LeaderboardStore` напрямую (поиск: `leaderboard.rank(`, `.top(`, `.count(`,
   `.countAbove(`, `.best(`), — через `RunsViewService` или с `board` от
   `boardOf`. Прямого чтения без доски не остаётся.
10. **Тестовые хранилища.** `test/helpers/memory-runs.ts`: два набора вместо
    одного, по тем же правилам, что Redis.
11. **Выкат и документы.** Порядок: выкат кода → `node
    dist/cli/runs-rebuild-leaderboard.js` (наполняет полную доску) → первое
    наложение. Это строка «Нужно от команды» в сводке PR и в `docs/14`.
    Документы — раздел «Документы».

## Чего не трогаем

- Вид ограничения, право, панель — T-0112. Награды за места и таблицу недели —
  T-0114. Метки в отчётах — T-0115.
- Форма ответов, `packages/app-shell` (`runs-api.ts`, `rating.tsx`): клиент не
  знает про две доски и не должен.
- Лимиты `runs:leaderboard` (`runs-limits.ts`) и ключ самой общей доски.
- Список друзей и подарки: не фильтруются.
- Кто и по каким основаниям получает ограничение: ни в коде, ни в тестах, ни в
  комментариях.
- Постбэки сетям и партнёрам.

## Сценарий и интерфейс

Экранов нет; игрок видит прежний рейтинг.

- Зритель без ограничения: общая доска, его место и «всего игроков» — без
  аккаунтов с ограничением; пустая доска и нет сети — как сейчас.
- Зритель с ограничением: полная доска, место в ней, строки остальных как у
  всех, `isMe` на его строке; плашек и пометок нет.
- Ошибка чтения Redis — как сейчас (503 и повтор клиента).

## Тесты

Первым коммитом. Redis и Postgres живые (`docs/17-testing-strategy.md` §4.2),
остальное — в памяти.

- `runs.integration.test.ts` (хранилище): `submit(…, ["full"])` пишет только в
  полную; `ALL_BOARDS` — в обе; `GT` не опускает время; `improved` верно на
  `["full"]`; `rank/count/countAbove/top` на каждой доске независимы;
  `remove(ids, ["common"])` не трогает полную; `replace` на доске оставляет
  чужую нетронутой и не оставляет `…:rebuild`; существующий тест с
  `"runs:leaderboard:easy"` (143–149) остаётся зелёным.
- `boards-by-viewer.test.ts`:
  - трое обычных (60/90/120 с) и двое с ограничением (100/200 с): обычному
    `leaderboardFor` показывает трёх, `totalPlayers = 3`, место по общей;
    аккаунту с ограничением — пятерых, место по полной, `isMe` на своей строке;
  - место «как будто их нет»: для случайных наборов (20 seed) общая доска равна
    доске, посчитанной без аккаунтов с ограничением;
  - форма ответа одинаковая: набор ключей JSON у обоих зрителей совпадает;
  - `profile`: `best[d].rank` по доске владельца, у `"team"` — тот же;
    `boardSize` по доске владельца;
  - «тень» вместе с ограничением: зритель в тени и с ограничением видит себя на
    месте по полной доске, а в доске нет;
  - ответ на конец забега (`FinishResult.rank`) — по доске: обычный игрок
    не сдвигается забегом аккаунта с ограничением, а тот видит и обычных;
  - `setRanked`: снятие рекорда аккаунта с ограничением правит полную и не
    трогает общую, снятие рекорда обычного — обе.
- `rating-restrictions.test.ts`: наложение убирает из общей все три сложности и
  оставляет в полной; снятие возвращает лучший рейтинговый в общую; снятие при
  действующем `leaderboard` — не возвращает; срок истёк — то же, что снятие;
  `sweep` убирает из общей аккаунт, добавленный гонкой после наложения, и
  возвращает число; `boardsFor`.
- `runs.test.ts`: забег аккаунта с ограничением пишется в полную и не в общую;
  повтор итога не меняет доски.
- `runs.integration.test.ts` / пересборка: из базы получаются обе доски,
  `excluded` нет ни в одной, `separate` только в полной; счётчики в
  `{ full, common }`; `wipe` вызывает пересборку с двумя наборами.
- `friends.test.ts`: друг с ограничением остаётся в списке друзей обычного
  игрока, ответ того же вида.
- `welcome-progress` (рядом с существующим тестом): место и размер доски — по
  доске аккаунта.

## Аналитика

Нет. Чтение досок событий не порождает. Ограничение и доска в поток событий не
попадают (см. T-0115: метка — измерение при выборке, не поле события).

## Настройки и окружение

Нет. Ключи Redis — не настройки.

## Документы

- `docs/14-scalability.md`: раздел про лидерборд — две проекции, правило
  «читает доску смотрящего», порядок выката (код → пересборка → наложение).
- `docs/21-diagrams.md` около строки 2075: `ZADD GT` в две проекции; второй
  ключ `runs:leaderboard:full:{сложность}`.
- Описание доски в `docs/15-engineering-standards.md` не требуется.

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: прежний ключ остаётся общей доской, полная
  — новый `full`; после выката пересборка (`runs-rebuild-leaderboard`) обязательна
  до первого наложения. Обратный выбор потребовал бы пересобирать то, что
  читают все игроки.
- Подтверждено `claude-lead-1` 13.10.2026: размер задачи L; если ревью сочтёт
  большим — разрезать по коммитам из раздела «Шаги» на три PR.

## Критерии приёмки

- [ ] Зритель с ограничением читает полную доску, остальные — общую; место,
  профиль, размер доски, ответ на конец забега и карточка бота считаются по
  доске смотрящего.
- [ ] Прямого чтения `LeaderboardStore` без указания доски нет (типы).
- [ ] Наложение и снятие переносят аккаунт между досками, обход раз в минуту
  чинит расхождение; блокировка и ограничение рейтинга действуют как прежде.
- [ ] Пересборка из базы строит обе доски; форма JSON ответов не изменилась.
- [ ] Друзья видны как обычно.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и
  `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(runs): Читать рейтинг по доске зрителя`
- **Метка:** `release: minor`
- **Для игроков:** нет. Раздела `## Для игроков` в описании PR нет.
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОСКИ РЕЙТИНГА ПО ЗРИТЕЛЮ**

  Рейтинг теперь читается по доске смотрящего: у аккаунтов со скрытым ограничением своя полная доска, у остальных общая. Место, профиль и карточка бота считаются по доске зрителя.

  🛠 **Рейтинг**

  • в Redis две проекции: прежний ключ — общая, новый runs:leaderboard:full — полная
  • обход раз в минуту выравнивает доски после наложения и снятия
  • форма ответов клиента не изменилась

  ❓ **Нужно от команды**

  • @владелец — после выката выполнить пересборку рейтинга (node dist/cli/runs-rebuild-leaderboard.js) до первого наложения ограничения
  ```
