---
id: T-0427
title: Карачун в гайдбуке и аналитике — «его нельзя убить — уходи», событие stalker_ended
epic: E10
priority: P1
status: in-progress
owner: claude-lead-1 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: [T-0424]
zones:
  - packages/app-shell/test/guide-stalker.test.ts
  - packages/app-shell/test/run-stalker-event.test.ts
shared:
  - packages/app-shell/src/screens/guide/guide-data.ts
  - packages/app-shell/src/screens/guide/GuideScreen.tsx
  - packages/app-shell/src/screens/guide/scenes.tsx
  - packages/app-shell/src/i18n/ru-guide.json
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/test/**
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/test/**
  - docs/22-analytics-and-metrics.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: design/art/concepts/stalker/README.md
batch: 5
---

# T-0427. Карачун в гайдбуке и аналитике — «его нельзя убить — уходи», событие stalker_ended

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0427.json)](README.md#значки-статуса) [![T-0424](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0424.json&label=T-0424)](T-0424-stalker-in-run.md)

## Зачем

Первый же игрок, встретив Карачуна, будет стрелять в него до смерти, если
нигде не сказано, что его не убить. Гайдбук должен сказать это простыми
словами, показать предвестие и рассказать миф (Р204, Р205). А команде нужно
видеть, как часто Карачун догоняет и убивает, — иначе его числа не
откалибровать по живым игрокам.

## Решения

- **Р204** (`docs/35-stage4-plan.md`): имя врага — ключ i18n, миф — в
  гайдбуке простыми словами.
- **Р205**: гайдбук — «его нельзя убить — уходи»; событие аналитики
  `stalker_ended` — по одному на появление (решение тимлида в Р205).
- **Неубиваемые — отдельный блок гайдбука**, после элиты и боссов, а не
  среди обычных врагов: у него нет здоровья, урона числом и опыта, и строка
  со статами врала бы (решение тимлида).
- Тексты ниже — дословно.
- Событие: имя из словаря `docs/22` §3.3 — сначала словарь и Zod-схема
  сервера, потом клиент (`CLAUDE.md`, «Аналитика»).

## Как сейчас

- Гайдбук: данные — `packages/app-shell/src/screens/guide/guide-data.ts`
  (`regularEnemies` берёт врагов без `rank` — Карачун сейчас попадает туда,
  `eliteEnemies`, `rubezhGuide`); экран — `GuideScreen.tsx` (строки ~223–224:
  обычные и элита); сцены паттернов — `scenes.tsx` (ветка `stalker` —
  заглушка из T-0421, фигура `hood` — T-0425); тексты —
  `app-shell/src/i18n/ru-guide.json` (`guide.pattern.stalker.*` уже есть,
  T-0421).
- Числа Карачуна — `STALKER` (`content/stalker.ts`), экспорт из
  `@bh/core-game` — проверить, при необходимости добавить в индекс пакета
  (`packages/core-game/src/index.ts` — тогда это вынужденный файл в
  `shared`).
- Аналитика: словарь — `docs/22-analytics-and-metrics.md` §3.3 (строка
  «Забеги» около 160 — список событий раздела; образец строки —
  `ring_ended`); схема сервера — `backend/api/src/modules/events/event-dictionary.ts`
  (образец `ring_ended`, строка ~210); список клиента —
  `packages/app-shell/src/state/analytics.ts`; отправка —
  `packages/app-shell/src/state/run.ts` (строка ~718: `created.on("ringEnded", …)`).
- Событие шины `stalkerEnded` — T-0424, поля: `index`, `outcome`
  (`faded`/`cut`/`died`), `hits`, `pushes`, `relocations`, `lifeSec`,
  `elapsedSec`.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **Словарь** `docs/22` §3.3: `stalker_ended` — в список раздела «Забеги» и
   строкой таблицы после `ring_ended`:

   | `stalker_ended` | Появление Карачуна закончилось (T-0424, Р205): растворился по времени, растворён строем стражей или игрок погиб во время погони. Доля `died` по минутам и среднее `hits` показывают, не слишком ли он смертелен; `pushes` и `relocations` — отталкивают ли его и не уходит ли он «за экран» слишком часто — калибровка `content/stalker.ts`. Одно событие на появление; забег, брошенный во время погони, события не даёт | `index` — номер появления в забеге с нуля, `outcome` — `faded` / `cut` / `died`, `hits` — сколько раз коснулся, `pushes` — сколько толчков оружием, `relocations` — сколько раз возникал ближе, `lifeSec` — сколько длилось появление, `elapsedSec` |
3. **Сервер:** Zod-схема `stalker_ended` в `event-dictionary.ts` по образцу
   `ring_ended`: `index` — целое ≥ 0, `outcome` — перечисление,
   `hits`, `pushes`, `relocations` — целые ≥ 0, `lifeSec`, `elapsedSec` —
   целые ≥ 0.
4. **Клиент:** `stalker_ended` в `analytics.ts`; в `run.ts` —
   `created.on("stalkerEnded", …)` → `track("stalker_ended", { …, lifeSec:
   Math.round(lifeSec), elapsedSec: Math.round(elapsedSec) })`.
5. **Гайдбук, данные:** `regularEnemies` не берёт врагов паттерна с
   признаком `unkillable` (через `PATTERN_TRAITS`, а не по id);
   `unkillableEnemies()` — их список; `stalkerGuide()` — `{ fromSec }` из
   `STALKER.appear`.
6. **Гайдбук, экран:** во вкладке врагов после элиты — блок «Неубиваемые»:
   заголовок, общий текст, для каждого — фигура той же формой и цветом, что
   на канве (лунная кайма), имя, миф, «когда приходит», предвестие и сцена
   паттерна. Тексты (`ru-guide.json`):
   - `"guide.unkillable.title": "Неубиваемые"`;
   - `"guide.unkillable.text": "Их нельзя убить — уходи. Удары только отталкивают, и каждый следующий подряд слабее. Касание снимает треть здоровья. Скоро он растворится сам."`;
   - `"guide.enemy.karachun.myth": "Дух внезапной смерти и самой длинной ночи в году. Недаром говорят: «пришёл карачун» — значит, конец пришёл без спроса."`;
   - `"guide.enemy.karachun.when": "Приходит после {time}, внезапно и с любой стороны, и гонится 10–20 секунд."` — `{time}` из `STALKER.appear.fromSec` через `formatDuration` («4:00»);
   - `"guide.enemy.karachun.omen": "Перед ним на земле проступает иней звездой и стелется холодный туман. Видишь иней — уходи с этого места."`.
7. **Сцена `stalker`** в `scenes.tsx` вместо заглушки: герой, Карачун фигурой
   `hood` в лунной кайме, между ними пунктир толчка назад и иней звездой у
   края — по образцу сцены `cordon`.

## Чего не трогаем

- Движок и шину — T-0421–T-0424.
- Кодекс врагов (T-0127): Карачун попадёт в него как любой враг — запись
  открывает встреча, а не убийство, и это для него верно.
- Остальные блоки гайдбука и их тексты.

## Сценарий и интерфейс

Гайдбук → «Враги»: после «Элита и боссы» — блок «Неубиваемые» с Карачуном.
Пустого и загрузочного состояния нет: данные из контента. Проверить на
320 px: миф и тексты переносятся, фигура не наезжает на текст. Снимки на 320,
390, 768, 1440 и в ландшафте 667×375 делает тимлид на приёмке; тест
разметки держит структуру.

## Тесты

`packages/app-shell/test/guide-stalker.test.ts`:

- `regularEnemies()` и `eliteEnemies()` не содержат `karachun`;
  `unkillableEnemies()` — содержит, ровно один раз;
- все ключи шага 6 есть в словаре, `{time}` подставляется «4:00» из
  `STALKER.appear.fromSec`;
- блок «Неубиваемые» рисуется после элиты, в нём имя «Карачун», миф и фраза
  «Их нельзя убить — уходи»;
- фигура в блоке — форма `hood` и цвет тела из `ENEMY_LOOKS.stalker`.

`packages/app-shell/test/guide.test.ts` — тест «показывает всех врагов ровно
по одному разу» учитывает третий блок.

Аналитика:

- клиент: новый `packages/app-shell/test/run-stalker-event.test.ts` по
  образцу `run-ring-event.test.ts` — `stalkerEnded` из шины уходит
  `track("stalker_ended", …)` с округлёнными секундами, по одному на
  появление;
- сервер: в `backend/api/test/events.test.ts` (схемы `event-dictionary.ts`) — корректное `stalker_ended` принимается,
  `outcome: "fled"` и отрицательный `hits` отклоняются.

## Аналитика

`stalker_ended` — шаги 2–4.

## Настройки и окружение

Нет.

## Документы

`docs/22-analytics-and-metrics.md` §3.3 — шаг 2.

## Критерии приёмки

- [ ] В гайдбуке Карачун — в своём блоке «Неубиваемые» с мифом, временем
      прихода, предвестием и советом уходить; среди обычных врагов его нет.
- [ ] `stalker_ended` есть в словаре, в схеме сервера и уходит с клиента по
      одному на появление.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и `pnpm task check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Карачун в гайдбуке и событие stalker_ended`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: в гайдбуке — блок «Неубиваемые»: кто такой Карачун, откуда он берётся и почему от него надо уходить`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРАЧУН В ГАЙДБУКЕ И АНАЛИТИКЕ**

  В гайдбуке появился блок «Неубиваемые»: Карачун, миф простыми словами, когда приходит и как выглядит его предвестие. Событие stalker_ended показывает, чем кончается каждое появление — растворился, разрезан строем или убил игрока, — сколько раз он коснулся и сколько его толкали.
  ```
