---
id: T-0112
title: Скрытое ограничение «Отдельная доска»: вид, право, панель
epic: E16
priority: P1
status: done
owner: claude-1 / sonnet-5.5 / high
author: claude-lead2-18
size: M
depends_on: []
zones:
  - backend/api/src/modules/restrictions/**
  - backend/api/src/modules/runs/rating-restrictions.ts
  - backend/api/src/modules/roles/roles.service.ts
  - backend/api/src/modules/admin/admin-restrictions.controller.ts
  - backend/api/src/modules/admin/admin-players.service.ts
  - backend/api/src/modules/player-list/**
  - backend/api/test/restrictions.test.ts
  - backend/api/test/restrictions.integration.test.ts
  - backend/api/test/rating-restrictions.test.ts
  - backend/api/test/helpers/memory-restrictions.ts
  - apps/admin/src/api/restrictions.ts
  - apps/admin/src/screens/players/RestrictDialog.tsx
  - apps/admin/src/screens/players/RestrictionsPanel.tsx
  - apps/admin/test/restrictions.test.ts
shared:
  - backend/api/test/admin-players.test.ts
  - backend/api/test/admin.test.ts
  - docs/29-admin-panel.md
  - backend/api/src/modules/roles/permissions.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/src/ui/help.ts
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 2
---

# T-0112. Скрытое ограничение «Отдельная доска»: вид, право, панель

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0112.json)](README.md#значки-статуса)

## Зачем

Нужен вид ограничения, который меняет только то, какую доску рейтинга читает
аккаунт, и которого не видит ни сам игрок, ни сотрудники без особого права.
Эта задача заводит вид, право и панель; сами доски по зрителю — T-0113, награды
— T-0114, метки в отчётах — T-0115.

## Решения

Р104 (`docs/35-stage4-plan.md`), Р75 (ограничения), решение владельца от
13.10.2026. Исполнитель их не пересматривает.

- **Вид — `separate_board`**, название в панели «Отдельная доска». Игрок не
  видит ничего: ни плашки, ни строки «не в рейтинге», ни пункта в профиле. Вид
  всегда накладывается молча (`notify: false`) и **никогда не попадает в ответ
  игроку**, даже если строка в базе вдруг записана с `notify: true`.
- **Право — новое `players.board.restrict`**: видеть вид в панели, накладывать,
  снимать. Есть только у владельца (`owner = PERMISSIONS`); ни `admin`, ни
  `moderator` его не получают. Право `players.restrict` нужно на маршруте, как у
  остальных видов, но его одного мало.
- **Для сотрудников без права вида не существует**: его нет в каталоге, в
  истории ограничений игрока, в списке игроков и фильтре «ограничен», в журнале
  аудита. Попытка наложить его без права отвечает так же, как на неизвестное
  поле, а не «нет права» — иначе сам ответ подсказывает, что вид есть.
- **Ограничение не меняет игру игрока**: забеги остаются рейтинговыми
  (`run.ranked = true`), награды за забеги приходят как обычно. Меняется только
  доска — это T-0113.
- **Срок, снятие, замена** — как у остальных видов: `endsAt`, `lift`, повторное
  наложение заменяет действующее, истёкшее снимает задача раз в минуту.
- **Миграции БД нет**: `account_restriction.kind` — `varchar(32)`
  (`prisma/schema.prisma:1520`), `separate_board` — 14 знаков. Причина — из
  существующих шаблонов `RESTRICTION_REASONS`, новых не заводим.
- **Смешивать с другими видами нельзя**: у вида общие `notify`, причина и срок
  на всё наложение, а скрытый вид должен идти молча и отдельно.

## Как сейчас

- `restrictions/restriction-catalog.ts`: `RESTRICTION_KINDS` (16),
  `RestrictionKindInfo` (20–30), `RESTRICTION_CATALOG` (32–93). Вид
  `leaderboard` (33–40) с `notify: false` — другая вещь: «тень», игрок пропадает
  из досок.
- `restrictions/restriction-rules.ts`: `imposeProblem` (55–59), `SHADOW_TEXT`
  (100), `shownText` (106–110), `playerView` (125).
- `restrictions/account-restrictions.ts`: `status` (56–59) при вопросе о любом
  виде отдаёт ещё и блокировку целиком; `visibleFor` (73–75) фильтрует только
  по `notify`.
- `restrictions/restrictions.service.ts`: `catalog()` (51), `preview` (63),
  `impose` (71, право по виду — строка 72), `afterImposed` (102, журнал
  `players.restrict`), `lift` (115, `players.unrestrict`), `history` (140).
- `admin/admin-restrictions.controller.ts`: `catalog` (31), `preview` (37),
  `history` (44) — без актора в `catalog` и `preview`.
- `admin/admin-players.service.ts`: `restrictions: RestrictionView[]` (74),
  `restrict` (около 158).
- `player-list/player-list.repository.ts`: `ACTIVE_RESTRICTION` (82), список
  видов игрока (87), фильтр `restricted === "any"` (116);
  `player-list-query.ts:4` берёт `RESTRICTION_KINDS` для проверки фильтра.
- `roles/permissions.ts`: `players.restrict` (40), `owner: PERMISSIONS` (127),
  список «право есть, а в роли не отмечено» проверяет тест ролей.
- `roles/roles.service.ts:109` — чтение журнала аудита (`audit.view`).
- `runs/rating-restrictions.ts`: `hold` (74–77) — как runs читает ограничения.
- Контрактный тест каталога: `test/restrictions.test.ts:573–582` требует, чтобы
  в модулях из `checkedIn` были `AccountRestrictions` и строка `"<вид>"`.
- Панель: `apps/admin/src/api/restrictions.ts:14` (схема вида),
  `screens/players/RestrictDialog.tsx`, `RestrictionsPanel.tsx`,
  `api/audit.ts:88–89` (подписи действий), `ui/help.ts`.

## Шаги по порядку

Пункт — коммит.

1. **Тесты** (раздел «Тесты») — первым коммитом.
2. **Право.** `permissions.ts`: `"players.board.restrict"` после
   `"players.restrict"` с комментарием «скрытое ограничение «Отдельная доска»:
   видеть, накладывать, снимать». Ни в `admin`, ни в `moderator` не добавлять.
3. **Каталог.** `restriction-catalog.ts`: в `RestrictionKindInfo` поле
   `hidden: boolean` (у всех существующих видов `false`); `"separate_board"` в
   `RESTRICTION_KINDS` **сразу после `"leaderboard"`** (тесты на `at(-1)` и
   `at(-2)` остаются зелёными); запись каталога: `title: "Отдельная доска"`,
   `effect` — «Игрок остаётся в рейтинге и читает полную доску, остальные видят
   общую без него. Места и награды за места считаются по доске того, кто
   смотрит. Игрок не видит ничего. Призы — только внутриигровые»,
   `checkedIn: "runs"`, `permission: "players.board.restrict"`,
   `silentAllowed: true`, `hidden: true`. Рядом: `HIDDEN_KINDS` и
   `isHiddenKind(kind)`.
4. **Правила.** `restriction-rules.ts`: `imposeProblem` — скрытый вид только с
   `notify: false` и только один в наложении, текст «Скрытое ограничение
   накладывается молча и отдельно от других»; `shownText` для скрытого —
   «Ничего: игрок не видит ни плашки, ни изменений в интерфейсе».
   `AccountRestrictions.visibleFor` и `playerView` пропускают скрытые виды
   **независимо от `notify`**.
5. **Сервис** (`restrictions.service.ts`, он 213 строк — не раздувать, лишнее в
   `restriction-visibility.ts`):
   - `catalog(actor)`: скрытые виды — только тому, у кого есть право вида
     (`roles.can`);
   - `preview(actor, input)` и `impose`: скрытый вид без права → тот же
     `ValidationError("Некорректное ограничение: нужны виды, срок и причина")`,
     что и на кривое тело;
   - `lift`: строка скрытого вида без права → `RestrictionNotFoundError`;
   - `history`: строки скрытых видов отдаются только с правом;
   - журнал: если все наложенные (снятые) виды скрытые, действие
     `players.board.set` (`players.board.unset`) вместо `players.restrict`
     (`players.unrestrict`); поля `after`/`before` те же.
6. **Журнал аудита.** `roles.service.ts` (около 109): строки с действиями
   `players.board.*` не отдавать без права `players.board.restrict`.
7. **Контроллер.** `admin-restrictions.controller.ts`: в `catalog` и `preview`
   передать `accountOf(request)`.
8. **Карточка игрока.** `admin-players.service.ts`: список ограничений в
   карточке и ответ `restrict` фильтруются по праву актора.
9. **Список игроков.** `player-list.repository.ts` и `player-list-query.ts`:
   параметр «видит скрытые» от актора. Без права скрытый вид исключён из
   массива видов (87) **и из фильтра `restricted === "any"` (116)**, а
   фильтр по скрытому виду отвечает как на неизвестный. С правом — всё как
   у остальных видов.
10. **Как runs спрашивает вид.** `rating-restrictions.ts`:
    `boardOf(accountId, at = new Date()): Promise<"full" | "common">` —
    `"full"` только когда `restrictions.status(accountId, "separate_board")`
    вернул строку с `kind === "separate_board"` (блокировка целиком, которую
    `status` подставляет вместо любого вида, — `"common"`). Метод нужен T-0113,
    а здесь он закрывает контрактный тест каталога.
11. **Панель.** `RestrictDialog.tsx`: скрытый вид рисуется, только если он
    пришёл в каталоге; при выборе переключатель «сообщить игроку» выключен и
    недоступен, остальные виды снимаются с выбора (и наоборот); подписи —
    нейтральные, как в каталоге. `RestrictionsPanel.tsx` и шапка карточки
    ничего не знают о виде — сервер отдаёт строки только держателям права.
    `api/audit.ts`: подписи `players.board.set` — «Отдельная доска:
    наложена», `players.board.unset` — «Отдельная доска: снята». `ui/help.ts`:
    подсказка к виду в одну фразу.
12. **Документы** (раздел «Документы»).

## Чего не трогаем

- Доски рейтинга, Redis, `leaderboard.store.ts`, `runs.service.ts`,
  `runs-view.service.ts` — T-0113. `boardOf` здесь никто не вызывает.
- Награды за места, сезон — T-0114. Метки в сводке и отчётах — T-0115.
- Существующий вид `leaderboard` («тень» и видимое ограничение рейтинга) — не
  меняется.
- Клиент игрока (`packages/app-shell`) и маршрут «мои ограничения» игрока:
  форма ответа та же, меняется только фильтр внутри `visibleFor`.
- Миграции Prisma. Новые шаблоны причин. Новые события аналитики.

## Сценарий и интерфейс

Только панель; у игрока ничего не появляется.

1. Владелец открывает карточку игрока, «Ограничить». В списке видов есть
   «Отдельная доска»; сотруднику без права этого пункта нет вовсе.
2. Выбор вида снимает остальные галочки и выключает «сообщить игроку»;
   срок и причина — как у остальных видов. Предпросмотр: «Ничего: игрок не
   видит ни плашки, ни изменений в интерфейсе».
3. После наложения строка видна в истории карточки владельцу; снятие — с
   обязательным комментарием, как у остальных.
4. Состояния — как у диалога ограничений: загрузка каталога, ошибка загрузки
   с повтором, нет сети (сообщение панели), «ограничение аккаунта» — недоступно
   (игрок не может ограничить себя, как и раньше).

## Тесты

Первым коммитом. Хелперы — `test/helpers/memory-restrictions.ts`.

- `restrictions.test.ts`:
  - каталог: у `separate_board` `hidden`, `silentAllowed`, право
    `players.board.restrict`, `checkedIn: "runs"`; порядок — сразу после
    `leaderboard`; у остальных видов `hidden: false`; тесты на `at(-1)`,
    `at(-2)` и `silentAllowed` (93, 275) зелёные;
  - `imposeProblem`: скрытый вид с `notify: true` → проблема; скрытый вместе с
    другим видом → проблема; один и молча → `null`;
  - `visibleFor`: строка скрытого вида с `notify: true`, записанная напрямую,
    игроку **не отдаётся**;
  - `catalog(owner)` содержит вид, `catalog(moderator)` и `catalog(admin)` — нет;
  - `impose` модератором: тот же `ValidationError`, что на кривое тело, в базу
    ничего; владельцем — строка, кеш сброшен, действие журнала
    `players.board.set`, поля прежние; смешанный набор — отказ;
  - `lift` модератором — `RestrictionNotFoundError`, владельцем — снято,
    `players.board.unset`; `history` модератора без строки, владельца — со строкой;
  - наложение вызывает слушателей `emitImposed` с видом в `kinds`; истёкшее
    снимает задача (`settleDue`) и зовёт `emitSettled`.
- `rating-restrictions.test.ts`: `boardOf` — без ограничения `"common"`; с
  `separate_board` `"full"`; блокировка целиком `"common"`; снятое и истёкшее
  `"common"`; сразу после `forget` — без ожидания полминуты.
- Тест ролей (рядом с `ROLE_PERMISSIONS`, искать по имени): `players.board.restrict`
  есть у `owner` и ни у одной другой роли.
- `admin-players.test.ts`: карточка модератора без скрытой строки, владельца — с
  ней; список игроков: модератор с фильтром `any` не получает аккаунт, у
  которого только скрытый вид; владелец получает; фильтр по скрытому виду у
  модератора — как неизвестное значение.
- Журнал аудита (рядом с существующим тестом `audit.view`): `admin` не видит
  строк `players.board.*`, владелец видит.
- HTTP (`restrictions.test.ts`, блок про маршруты): `GET catalog` модератора без
  вида, `POST` наложения модератором — 400, владельцем — 200; маршрут игрока
  «мои ограничения» при действующем скрытом виде отдаёт пустой список.
- Контрактный тест каталога (573–582) зелёный для `separate_board`.
- `apps/admin/test/restrictions.test.ts`: диалог с видом — переключатель
  «сообщить» выключен и недоступен, остальные виды сняты; в каталоге без вида
  пункта нет.

## Аналитика

Нет. Наложение пишется в журнал аудита и структурный лог, как у остальных видов.
Событие в общий поток аналитики раскрыло бы вид всем, у кого есть доступ к
выборкам; метка в отчётах — T-0115 и только измерением при выборке.

## Настройки и окружение

Нет. Право — код (`permissions.ts`), не ключ каталога настроек.

## Документы

- `docs/29-admin-panel.md`: таблица прав — строка `players.board.restrict`
  (только владелец); раздел про ограничения — вид «Отдельная доска» одной
  строкой: что меняет, что виден только держателям права. Ничего сверх этого.
- Схемы `docs/21-diagrams.md` не меняются: таблиц и связей нет.

## Вопросы к тимлиду

- �Подтверждено `claude-lead-1` 13.10.2026: право `players.board.restrict` только у
  владельца, `admin` его не получает — чем меньше людей знают о виде, тем он
  надёжнее скрыт.
- �Подтверждено `claude-lead-1` 13.10.2026: вид стоит в `RESTRICTION_KINDS` после
  `leaderboard`, миграции БД нет.

## Критерии приёмки

- [ ] Вида нет ни в каталоге, ни в истории, ни в списке и фильтре игроков, ни в
  журнале у сотрудников без права; наложение без права отвечает как на кривое тело.
- [ ] Игроку вид не отдаётся ни одним маршрутом, даже при `notify: true` в базе.
- [ ] Наложение и снятие — с аудитом (`players.board.set` / `players.board.unset`),
  срок и замена работают как у остальных видов.
- [ ] `boardOf` различает `"full"` и `"common"`; контрактный тест каталога зелёный.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и
  `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(restrictions): Добавить скрытое ограничение «Отдельная доска»`
- **Метка:** `release: minor`
- **Для игроков:** нет. Раздела `## Для игроков` в описании PR нет, в журнал
  «Что нового» ничего не заводить.
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОГРАНИЧЕНИЕ «ОТДЕЛЬНАЯ ДОСКА»**

  В панели появился вид ограничения «Отдельная доска»: накладывается молча, видно только владельцу. Сами доски по зрителю — в следующих задачах.

  🛠 **Панель**

  • новое право players.board.restrict — только у владельца
  • вид не виден игроку и сотрудникам без права: ни в каталоге, ни в списках, ни в журнале
  ```
