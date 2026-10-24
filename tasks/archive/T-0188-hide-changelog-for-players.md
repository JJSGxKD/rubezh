---
id: T-0188
title: «Что нового» скрыт у игроков до пересмотра журнала
epic: E6
priority: P2
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - packages/app-shell/src/state/changelog-api.ts
  - packages/app-shell/src/app/MainMenu.tsx
  - packages/app-shell/src/screens/meta/notifications.tsx
  - packages/app-shell/src/screens/home-carousel.tsx
  - packages/app-shell/test/changelog-api.test.ts
  - packages/app-shell/test/home-carousel.test.ts
  - packages/app-shell/test/notifications.test.ts
  - backend/api/src/modules/changelog/changelog-rules.ts
  - backend/api/src/modules/changelog/changelog.service.ts
  - backend/api/src/modules/changelog/changelog-fanout.ts
  - backend/api/src/modules/admin/admin-overview.service.ts
  - backend/api/test/changelog.test.ts
  - backend/api/test/changelog.integration.test.ts
  - backend/api/test/admin-overview.test.ts
  - apps/admin/src/screens/changelog/ChangelogScreen.tsx
shared:
  - docs/29-admin-panel.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 2
---

# T-0188. «Что нового» скрыт у игроков до пересмотра журнала

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0188.json)](../README.md#значки-статуса)

## Зачем

Журнал «Что нового» сам не наполняется: черновики версий копятся в панели, а
публиковать их некому, и с 0.6 игроки не видели ни одной записи. Пустой
раздел в меню и уведомление про давнюю версию говорят игроку, что игра стоит на
месте. Пока команда не решит, как вести журнал, его не видно нигде у игрока;
панель и данные остаются как есть, чтобы вернуть журнал одной правкой.

## Решения

Р125 (`docs/35-stage4-plan.md`, 20.10.2026, решение участника 1):

- журнал **скрыт у игроков**: нет пункта меню и знака на нём, нет слайда на
  главной, уведомления о версиях никуда не ведут, новые не раздаются;
- **панель не трогаем по сути**: раздел «Что нового», черновики из выката,
  публикация и предпросмотр работают; на экране раздела — плашка, что журнал
  скрыт у игроков; напоминание «ждёт публикации» в сводке панели не показывается;
- **данные и API остаются**: таблицы, `/api/v1/changelog` и экран журнала в
  оболочке не удаляются — возврат журнала одна правка двух констант;
- переключатель — **константа в коде** с обеих сторон, без ключа настроек:
  вернуть журнал без пересмотра того, как его вести, всё равно нельзя.

## Как сейчас

Оболочка (`packages/app-shell/src`):

- `app/MainMenu.tsx:25` — `freshVersions` из `useBadges`; строки 68-75 — пункт
  «Что нового» со знаком числа новых версий;
- `screens/meta/notifications.tsx:101-102` — `app_update` ведёт в `changelog`
  (`target: "changelog"`, `over: true`);
- `screens/home-carousel.tsx:162-163` — слайд `changelog` и слайд команды с
  экраном `changelog` открывают журнал (`home-slide.tsx:65, 207` — его вид);
- `state/changelog-api.ts:37` — `changelogAvailable()` (журнал только с входом).

Сервер (`backend/api/src/modules`):

- `changelog/changelog.service.ts:73` — `badge(player)` — число новых версий: из
  него берутся знак меню (`changelog.controller.ts:49`, бейджи) и слайд главной
  (`home/home.service.ts:57` → `home-slides.ts:61`, слайд, пока `freshVersions > 0`);
- `changelog/changelog.service.ts:152` — публикация будит раздачу;
  `changelog/changelog-fanout.ts:69` `tick` — раздаёт `app_update` по ленте;
- `admin/admin-overview.service.ts:161, 168-173` — пункт сводки «„Что нового“
  ждёт публикации».

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Сервер:**
   - `changelog-rules.ts` — `export const CHANGELOG_FOR_PLAYERS = false;` с
     комментарием: журнал скрыт у игроков до пересмотра того, как его вести
     (Р125); что гасит константа — знак, слайд, раздачу, напоминание панели;
   - `changelog.service.ts` `badge` — при `!CHANGELOG_FOR_PLAYERS` сразу `0`, без
     запроса в базу. Слайд главной гаснет сам: `home-slides.ts` не трогать;
   - `changelog-fanout.ts` `tick` — при `!CHANGELOG_FOR_PLAYERS` ничего не раздаёт
     и возвращает `0` (до лока и запроса); `kick` после публикации остаётся
     безвредным;
   - `admin-overview.service.ts` — пункт `changelogDrafts` не собирается при
     `!CHANGELOG_FOR_PLAYERS`.
3. **Оболочка:**
   - `state/changelog-api.ts` — `export const CHANGELOG_FOR_PLAYERS = false;` с тем
     же комментарием; `changelogAvailable()` возвращает `false`, пока константа
     ложна;
   - `MainMenu.tsx` — пункт «Что нового» только при `changelogAvailable()` (вместо
     `withAccount`); `freshVersions` тогда не читается;
   - `notifications.tsx` — у `app_update` `target: null` и без `over`, пока
     журнал скрыт: старые уведомления о версии остаются в ленте текстом, но никуда
     не ведут;
   - `home-carousel.tsx` — слайд вида `changelog` и слайд команды с экраном
     `changelog` не показываются, пока журнал скрыт (сервер первого не пришлёт, а
     второй мог завести человек в панели).
4. **Панель** — `ChangelogScreen.tsx`: над списком плашка тем же компонентом
   уведомлений, что у соседних экранов: «Журнал скрыт у игроков (Р125):
   публикация сохранится, но игроки её не увидят, пока журнал не вернут».
5. **Документы:** `docs/29-admin-panel.md`, раздел «Что нового», — абзац о том,
   что журнал скрыт у игроков и почему; в `docs/35` у WP31 — строка «скрыт у
   игроков с 20.10.2026 (Р125)». Решение Р125 в таблицу решений уже вписал
   тимлид, его не трогать.

## Чего не трогаем

- Экран журнала `screens/meta/changelog.tsx`, его API, таблицы и миграции.
- Черновики из выката (`team-summary.yml` и строки «Для игроков» в PR):
  продолжают заводиться в панели.
- `home-slides.ts` и `home.service.ts` — их правит T-0157; слайд гаснет через
  `badge`.
- Список экранов для слайдов команды (`TEAM_SLIDE_SCREENS`) — в базе могут быть
  слайды с ним, схема не сужается.

## Сценарий и интерфейс

- Игрок открывает меню — пунктов «Уведомления», «История», «Промокод»,
  «Гайдбук», «Настройки», без «Что нового».
- В ленте уведомлений старое «Вышло обновление 0.6» — текстом, без перехода.
- На главной слайдов журнала нет.
- Команда открывает «Что нового» в панели — над списком плашка «скрыт у
  игроков»; публикация работает, раздачи нет.

## Тесты

- `backend/api/test/changelog.test.ts`: `badge` при скрытом журнале — `0` и без
  обращения к репозиторию (подмена падает при вызове); `tick` раздачи — `0`, без
  `deliverMany` и без лока.
- `backend/api/test/admin-overview.test.ts`: при черновиках версий пункта
  «„Что нового“ ждёт публикации» нет; остальные пункты сводки на месте.
- `packages/app-shell/test/changelog-api.test.ts`: `changelogAvailable()` — `false`
  и с входом.
- `packages/app-shell/test/notifications.test.ts`: `app_update` — текст есть,
  `target: null`.
- `packages/app-shell/test/home-carousel.test.ts`: слайд `changelog` и слайд
  команды с экраном `changelog` отфильтрованы, соседние слайды на месте.

## Аналитика

`changelog_opened` больше не порождается: экран не открыть. Событие в словаре
остаётся — оно вернётся вместе с журналом.

## Настройки и окружение

Нет: переключатель — константы `CHANGELOG_FOR_PLAYERS` в `changelog-rules.ts` и
`state/changelog-api.ts`.

## Документы

Шаг 5.

## Критерии приёмки

- [ ] У игрока нет ни одного входа в «Что нового»: меню, знак, слайд,
  уведомление.
- [ ] Публикация в панели не раздаёт `app_update`.
- [ ] Панель показывает плашку и не напоминает о черновиках в сводке.
- [ ] Данные журнала и API не тронуты.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Скрыть «Что нового» у игроков`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ЧТО НОВОГО» СКРЫТ У ИГРОКОВ**

  Журнал обновлений с 0.6 не пополнялся, и пустой раздел только путал игроков. Теперь его не видно у игрока нигде, а панель и данные остались: вернуть журнал — одна правка, когда решим, как его вести.

  🛠 **Что изменилось**

  • в меню нет пункта «Что нового», на главной нет его слайда
  • старые уведомления о версиях остались текстом, без перехода
  • публикация в панели работает, но игрокам не раздаётся; напоминания о черновиках в сводке панели нет
  ```
