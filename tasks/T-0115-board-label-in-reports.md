---
id: T-0115
title: Метка «Отдельная доска» в сводке, воронке и разборе забегов в панели
epic: E16
priority: P1
status: in-progress
owner: claude-13 / sonnet-5.5 / high
author: claude-lead2-18
size: M
depends_on: [T-0112]
zones:
  - backend/api/src/modules/restrictions/board-mark.ts
  - backend/api/src/modules/admin-notify/daily-stats.repository.ts
  - backend/api/src/modules/admin/admin-overview.service.ts
  - backend/api/src/modules/admin/admin-review.controller.ts
  - backend/api/src/modules/funnel/funnel-report.ts
  - backend/api/test/board-mark.test.ts
  - backend/api/test/board-mark.integration.test.ts
  - backend/api/test/board-mark-boundary.test.ts
  - backend/api/test/admin-overview.test.ts
  - backend/api/test/funnel.integration.test.ts
  - apps/admin/src/api/overview.ts
  - apps/admin/src/api/funnel.ts
  - apps/admin/src/api/review.ts
  - apps/admin/src/screens/overview/OverviewScreen.tsx
  - apps/admin/src/screens/funnel/FunnelScreen.tsx
  - apps/admin/src/screens/review/ReviewScreen.tsx
  - apps/admin/test/board-mark.test.ts
shared:
  - backend/api/test/daily-stats.test.ts
  - backend/api/test/ad-conversions.integration.test.ts
  - backend/api/test/partners.integration.test.ts
  - docs/22-analytics-and-metrics.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0115. Метка «Отдельная доска» в сводке, воронке и разборе забегов в панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0115.json)](README.md#значки-статуса) [![T-0112](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0112.json&label=T-0112)](archive/T-0112-separate-board-restriction.md)

## Зачем

Когда часть аккаунтов читает отдельную доску (T-0112, T-0113), команда должна
видеть в цифрах, сколько их и какую долю сводки они составляют: иначе средние и
воронка смешивают два поведения. Наружу — партнёрам, сетям, выплатам — эти
аккаунты уходят как обычные игроки.

## Решения

Р104 (`docs/35-stage4-plan.md`), решение T-0112 («метка в отчётах — T-0115 и
только измерением при выборке»), решение владельца от 13.10.2026. Исполнитель
их не пересматривает.

- **Метка — измерение при выборке, не поле события.** В поток событий, таблицы
  событий и Prometheus ничего не добавляется: поле раскрыло бы вид всем, у кого
  есть доступ к выборкам, а `account_id` в метках запрещён (`CLAUDE.md`).
- **Видит только держатель права `players.board.restrict`** (владелец, T-0112).
  У остальных поле `null` или не приходит, блока в панели нет. Образец —
  выручка: `OverviewDay.revenue` (`admin-overview.service.ts:36`) закрыта тем, у
  кого нет `analytics.revenue.view`.
- **Чаты не меняются.** `statsText`, `/stats`, `reviewCardText`, `runCaption`
  уходят туда, где сидят сотрудники без права: вида для них не существует.
- **Внешние цифры не меняются.** Постбэки сетям (`ad-conversions`), кабинет
  партнёров и выплаты (`partners`), рефералы, ссылки, атрибуция, платежи, кошелёк,
  друзья, главная читают аккаунт как обычного игрока и метку не знают.
- **Окно, не мгновение.** Аккаунт помечен, если вид действовал в окне отчёта
  хотя бы часть времени: `starts_at < to` и конец вида позже `from`, где конец —
  `LEAST(lifted_at, settled_at, ends_at)`, пусто — бесконечность. Снятый вид не
  стирает прошлые цифры.
- **Нейтральные формулировки.** Везде «Отдельная доска»; в коде, комментариях,
  тестах, подписях и документах нет слов «читер», «нарушитель», «контур»,
  «изоляция». Не путать с `run.cheats` — это забеги разработчика.
- Признаки, по которым ставят вид, в репозиторий не попадают (Р104): задача
  читает только сам вид.

## Как сейчас

- `account_restriction`: `kind`, `starts_at`, `ends_at`, `lifted_at`, `settled_at`,
  индекс `(account_id, starts_at)`; вид `separate_board` и `isHiddenKind` — T-0112.
- `daily-stats.repository.ts`: `day()` (57) — `account`, `account_session`, `run`
  (`status = 'finished' AND NOT cheats`), `purchase`, `account_funnel`; `DayStats` —
  `admin-notify/daily-stats.ts:25`. `day()` кормит чат — не трогаем.
- `admin-overview.service.ts`: `overview` (98) собирает `today`, `yesterday`,
  `series`, `ads`, `attention`; права — `permissionsOf`, чтение — `withTimeout` (15 с).
- `funnel-report.ts:61`: `funnelReport(prisma, from, to)` — строки по источникам;
  маршрут — `admin-review.controller.ts:75`, CLI — `cli/funnel-report.ts`.
- Панель: `api/overview.ts`, `funnel.ts`, `review.ts`; экраны `OverviewScreen.tsx`,
  `FunnelScreen.tsx`, `ReviewScreen.tsx`.

## Шаги по порядку

Пункт — коммит.

1. **Тесты** (раздел «Тесты») — первым коммитом.
2. **Ядро.** Новый `restrictions/board-mark.ts` (до 120 строк): `BOARD_MARK_LABEL =
   "Отдельная доска"`; `BoardMark { marked; active; newAccounts; runs }` — аккаунтов
   с видом в окне; из них с запуском; созданных в окне; завершённых забегов
   (условия `runs.finished`); `markedAccountIds(prisma, from, to)` — один запрос по
   правилу окна (таблица мала, индекс по `kind` не заводить, `EXPLAIN` в PR);
   `boardMark(prisma, window)` — сначала список id, затем счёты по
   `account_id = ANY($ids)`; пустой список — нули без запросов.
3. **Сводка.** `DailyStatsRepository.boardMark(window)` — новый метод (тестовые
   реализации интерфейса — по ошибке типов). `AdminOverviewService.overview`:
   `boardMark: { today; yesterday } | null`, считается только при праве, в том же
   `Promise.all` с `withTimeout`; не ответило — `null`, сводка живёт без него.
4. **Воронка.** `funnelMarked(prisma, from, to)`: одна сводная строка с числовыми
   полями `FunnelRow` (`Omit<FunnelRow, "platform" | "startKind" | "startRef" |
   "startSource">`) по `markedAccountIds`. Маршрут `admin-review.controller.ts:75`
   добавляет `marked` только держателю права; `funnelReport` и CLI не меняются.
5. **Разбор забегов.** Строки забегов в `admin-review.controller.ts`:
   `boardMarked: true` у аккаунтов из `markedAccountIds` за окно выборки, только
   по праву; один запрос на страницу, не по одному на строку.
6. **Панель.** `OverviewScreen.tsx`: при `boardMark !== null` блок «Отдельная
   доска» под карточками игроков — с видом / активны / новые / забегов, сегодня и
   вчера. `FunnelScreen.tsx`: последняя строка «Отдельная доска (все источники)».
   `ReviewScreen.tsx`: светлая метка рядом с игроком. Схемы Zod в `api/*.ts` берут
   поля как необязательные; без права нет ни блока, ни пустого места.
7. **Документы** (раздел «Документы»).

## Чего не трогаем

- События и словарь аналитики, Prometheus, схему БД; `statsText`, `dayReport`,
  `/stats`, карточки в чат, выгрузки `export/*`.
- Модули внешних цифр: `ad-conversions`, `ads`, `attribution`, `links`,
  `partners`, `referrals`, `payments`, `wallet`, `shop`, `friends`, `home`.
- `flag-split-report.ts`; доски и награды — T-0113, T-0114; вид и право — T-0112.

## Сценарий и интерфейс

Только панель, только владелец: в «Сводке» блок за период и прошлый, в «Воронке»
строка под таблицей, в «Разборе забегов» метка у нужных аккаунтов. Состояния
экранов прежние: загрузка, ошибка, нет сети; блок не ответил — экран без него,
тихая строка «Метка временно недоступна». Без права ничего не видно.

## Тесты

Первым коммитом. Интеграционные — на живых Postgres и Redis.

- `board-mark.integration.test.ts`: аккаунт, у которого вид снят до окна, —
  не помечен; с действующим и с начавшимся внутри окна — помечен; счёты `active`,
  `newAccounts`, `runs` на известных данных, забег с `cheats` не входит; пустой
  список — нули и ни одного запроса к `account_session`/`run`.
- `board-mark.test.ts`: границы окна (вид кончился ровно в `from` — не помечен;
  бессрочный — помечен); в `BOARD_MARK_LABEL` нет запрещённых слов.
- `admin-overview.test.ts`: владелец получает `boardMark`, `admin` и `moderator`
  — `null`; чтение упало — `null`, остальная сводка цела. `daily-stats.test.ts`:
  `statsText` и `dayReport` с аккаунтом под видом равны тексту без него.
- `funnel.integration.test.ts`: `funnelMarked` на известном наборе; маршрут отдаёт
  `marked` только владельцу; `funnelReport` без изменений. Разбор: `boardMarked`
  у нужных строк, одним запросом (счётчик в тестовом клиенте).
- `board-mark-boundary.test.ts` (по исходникам, как `scripts/test/layer-boundaries.test.ts`):
  в каталогах из «Чего не трогаем», а также в `daily-stats.ts`, `run-card.ts`,
  `run-review-card.ts` нет `separate_board`, `board-mark`, `boardMark`.
- `ad-conversions.integration.test.ts`, `partners.integration.test.ts`: по кейсу —
  те же данные, один аккаунт под видом; постбэк и строка кабинета равны
  результату без вида.
- `apps/admin/test/board-mark.test.ts`: блок сводки, строка воронки и метка на
  разборе есть при данных и нет при `null`.

## Аналитика

Нет: метка — измерение при выборке, не поле события (см. «Решения»). Новых
событий, полей и метрик нет.

## Настройки и окружение

Нет. Право — код (T-0112); ключей каталога настроек и переменных окружения нет.

## Документы

- `docs/22-analytics-and-metrics.md`: абзац про измерение «Отдельная доска» —
  где видно, кому, что внешних цифр оно не касается, правило окна.
- `docs/29-admin-panel.md`: в описании сводки, воронки и разбора — строка про
  блок для держателей права `players.board.restrict`.
- Схемы `docs/21-diagrams.md` не меняются: таблиц и связей нет.

## Вопросы к тимлиду

- Подтверждено claude-lead-1 13.10.2026 по умолчанию: в чат метка не уходит; если
  понадобится строка в ежедневной сводке, это отдельный поток
  `notify.chat.<поток>` без запасного «общего чата».
- Подтверждено claude-lead-1 13.10.2026 по умолчанию: метка считается по окну
  отчёта, прошлые сутки не меняются от снятия вида; разбивка по флагам метку не
  получает.

## Критерии приёмки

- [ ] Метка видна только держателю права: в сводке, воронке и разборе; у
  остальных ответ равен прежнему.
- [ ] Чат, выгрузки, постбэки, кабинет партнёров и выплаты метку не читают; тест
  по исходникам и интеграционные кейсы зелёные.
- [ ] Ни событий, ни метрик, ни миграций; запрещённых слов нет.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и
  `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Показать метку «Отдельная доска» в отчётах панели`
- **Метка:** `release: minor`
- **Для игроков:** нет. Раздела `## Для игроков` в описании PR нет, в журнал
  «Что нового» ничего не заводить.
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МЕТКА «ОТДЕЛЬНАЯ ДОСКА» В ОТЧЁТАХ**

  В сводке, воронке и разборе забегов у владельца появилась метка «Отдельная доска»: сколько таких аккаунтов и какая доля цифр на них приходится. Остальным ничего не видно, в чат и во внешние цифры метка не попадает.

  🛠 **Панель**

  • блок в сводке, строка в воронке, метка на разборе — только по праву players.board.restrict
  • постбэки сетям, кабинет партнёров и выплаты считают эти аккаунты как обычных игроков
  ```
