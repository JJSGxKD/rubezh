---
id: T-0322
title: Достижения v2 — «Без единой царапины», «Пацифист», стихийники, «Коллекционер», «Мастер Метеора», «Душа компании»; знаки у трудных
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0321, T-0106, T-0126, T-0235]
zones:
  - backend/api/test/achievements-v2.test.ts
  - backend/api/test/achievements-v2.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/src/modules/tasks/tasks.service.ts
  - backend/api/src/modules/tasks/tasks.repository.ts
  - backend/api/src/modules/achievements/achievements.service.ts
  - backend/api/src/modules/achievements/achievement-rules.ts
  - backend/api/test/tasks.test.ts
  - apps/admin/src/api/tasks.ts
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/src/ui/help.ts
  - apps/admin/test/tasks.test.ts
  - packages/app-shell/src/screens/meta/task-row.tsx
  - packages/app-shell/src/i18n/ru-tasks.json
  - packages/app-shell/test/tasks-api.test.ts
  - docs/39-retention-mechanics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0322. Достижения v2 — «Без единой царапины», «Пацифист», стихийники, «Коллекционер», «Мастер Метеора», «Душа компании»; знаки у трудных

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0322.json)](README.md#значки-статуса) [![T-0321](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0321.json&label=T-0321)](archive/T-0321-run-result-streaks-and-element-kills.md) [![T-0106](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0106.json&label=T-0106)](T-0106-achievements-prestige-server.md) [![T-0126](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0126.json&label=T-0126)](T-0126-tasks-kinds-bosses-elites-chests-evolutions.md) [![T-0235](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0235.json&label=T-0235)](T-0235-emblems-server.md)

## Зачем

У достижений нет испытаний мастерства — того, что делают не числом
забегов, а тем, как играют. Нет и стихий: «Повелитель огня» засчитывает
забеги с огненным оружием, а не убийства огнём. После задачи в каталоге:
- два испытания — «Без единой царапины» и «Пацифист»;
- четыре лестницы стихийников;
- «Коллекционер» — все «Мастера оружия», и «Мастер Метеора», которого не
  хватало;
- ступень «5 друзей» зовётся «Душа компании».

Знак у имени (Р149) получают только трудные.

## Решения

Решения владельца — `docs/35-stage4-plan.md` Р161 (25.10.2026):
- берём все четыре группы дизайнера (`design/art/meta-v2.md` §6.3);
- знак — только у «Без единой царапины», «Коллекционера» и верхних ступеней
  стихийников.

Решения `claude-lead-1` от 25.10.2026:

- **Четыре новых вида цели** (`task-rules.ts`):

  | Вид | Действие | Что считает | Фильтр |
  |---|---|---|---|
  | `no_hit_sec` | максимум | `counters.noHitSec` | нет |
  | `no_kill_sec` | максимум | `counters.noKillSec` | нет |
  | `element_kills` | сумма | `counters.killsByElement[element]` | стихия |
  | `weapon_masters` | максимум, `STATE_KINDS` | выполненные «Мастера оружия» | нет |

  Первые три — по итогу забега: `RecordedRun.counters` (T-0125, T-0321).
  `counters: null` (неправдоподобные или старая сборка) — 0, как у видов
  T-0126.
- **«Коллекционер» — цель считается, а не хранится.**
  - Значение — сколько активных достижений вида `weapon_runs` у игрока
    выполнено.
  - Цель — сколько их активно **сейчас**. Хранимый `target` строки для этого
    вида не читается; панель показывает «цель считается сама».
  - Новое оружие с «Мастером» поднимает цель.
  - Выполненное остаётся выполненным: `completed_at` не снимается, престиж и
    знак не пропадают (как у T-0106).

  Пересчёт — `syncState` T-0106 (при открытии витрины) и после каждого
  записанного забега, засчитанного заданиям: один запрос с `count`.
- **Строки каталога** — миграция `INSERT … ON CONFLICT (task_id) DO NOTHING`,
  `active = true`, `sort` — после последнего достижения с шагом 10.

  | id | Вид, фильтр, цель | Название | Категория, лестница | Престиж | Монеты | Знак |
  |---|---|---|---|---|---|---|
  | `ach_no_hit_10` | `no_hit_sec`, 600 | «Без единой царапины» | `mastery` | 40 | 800 | `legendary` |
  | `ach_pacifist` | `no_kill_sec`, 60 | «Пацифист» | `mastery` | 10 | 150 | — |
  | `ach_fire_500`, `ach_fire_2500`, `ach_fire_10k` | `element_kills`, `fire`, 500 / 2 500 / 10 000 | «Поджигатель», «Пламенный», «Огнепоклонник» | `combat`, `fire_kills` 1–3 | 5 / 10 / 20 | 100 / 200 / 400 | у 3-й `epic` |
  | `ach_cold_500`, `ach_cold_2500`, `ach_cold_10k` | `element_kills`, `cold` | «Иней», «Мороз», «Стужа» | `combat`, `cold_kills` 1–3 | 5 / 10 / 20 | 100 / 200 / 400 | у 3-й `epic` |
  | `ach_lightning_500`, `ach_lightning_2500`, `ach_lightning_10k` | `element_kills`, `lightning` | «Искрящий», «Грозовой», «Громовержец» | `combat`, `lightning_kills` 1–3 | 5 / 10 / 20 | 100 / 200 / 400 | у 3-й `epic` |
  | `ach_poison_500`, `ach_poison_2500`, `ach_poison_10k` | `element_kills`, `poison` | «Знахарь», «Ядовитый», «Отравитель» | `combat`, `poison_kills` 1–3 | 5 / 10 / 20 | 100 / 200 / 400 | у 3-й `epic` |
  | `ach_collector` | `weapon_masters` | «Коллекционер» | `collection` | 40 | 800 | `epic` |
  | `ach_weapon_meteor` | `weapon_runs`, `meteor`, 5 | «Мастер Метеора» | `collection` | 10 | 150 | `uncommon` |

  Итого 16 строк. Подсказки (`hint`) — только у скрытых; новых скрытых нет.
  Числа — стартовые, геймдизайнер калибрует в панели.
- **«Душа компании»** — та же миграция:
  `UPDATE task_def SET title = 'Душа компании' WHERE task_id = 'ach_friends_5'`.
  Второго достижения на «5 друзей» не заводим. Знака нет.
- **Знак** — колонка `emblem_tier` T-0235, в той же миграции. «Пацифист» и
  «Душа компании» — без знака: лёгкие (Р161).
- **Оружие Р157** (Кистень, Серп, Гусли, Рябиновые бусы) и их стихии — T-0323,
  после того как оружие появится.

## Как сейчас

- **Виды цели** — `RUN_KINDS` в `task-rules.ts:85` (`op`, `measure(run,
  filter)`), фильтр стихии — `filterKeyOf`, `element_runs` — образец фильтра.
- **После T-0106** — `STATE_KINDS`, `applyState`, `syncState`, витрина.
- **После T-0126** — виды по `counters` (`boss_kills` и т. д.): образец для
  `no_hit_sec` и `element_kills`.
- **После T-0235** — `emblem_tier`, список отобранных достижений со знаком.
- **Тексты цели** — клиент строит по виду: `task.kind.<вид>` в
  `ru-tasks.json:45`, подстановки `{count}`, `{time}`, `{element}`.
- **Панель** — подписи видов и фильтров: `apps/admin/src/ui/help.ts`,
  `apps/admin/src/api/tasks.ts`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`task-rules.ts`** — три вида в `RUN_KINDS`, `weapon_masters` в
   `STATE_KINDS`; `element_kills` — в виды с фильтром стихии; признак
   «цель считается» (`DYNAMIC_TARGET_KINDS`).
3. **Сервис** — `syncState` для `weapon_masters` (витрина и после забега);
   цель «Коллекционера» в ответах `/achievements` и `/tasks` — посчитанная.
4. **Миграция** — 16 строк, знаки, `UPDATE` «Душа компании».
5. **Клиент** — `task.kind.no_hit_sec` («Продержись {time} подряд без
   единого попадания»), `task.kind.no_kill_sec` («Продержись {time} подряд,
   никого не убив»), `task.kind.element_kills` («Победи {count} врагов
   стихией «{element}»»), `task.kind.weapon_masters` («Стань мастером
   каждого оружия — {value} из {count}») в `ru-tasks.json`; формы
   множественного числа — как у соседних ключей.
6. **Панель** — подписи видов; у `weapon_masters` поле цели только для
   чтения с подписью «считается сама».
7. **`docs/39`** §3 — строки испытаний, стихийников и «Коллекционера».

## Чего не трогаем

- Счётчики итога забега — T-0321.
- «Мастеров» оружия Р157 — T-0323.
- Значки знаков — дизайнер (`design/art/backlog.md`, п. 18); пока их нет,
  знак рисуется значком категории (T-0236).

## Тесты

Первым коммитом.

- `backend/api/test/achievements-v2.test.ts` (чистые):
  - `no_hit_sec`: забег с `noHitSec` 610 → 610; `counters: null` → 0;
  - `element_kills` с фильтром `fire` берёт только огонь;
  - `element_kills` без фильтра — отказ схемы;
  - `weapon_masters` забегом не двигается.
- `backend/api/test/achievements-v2.integration.test.ts` (живые Postgres и
  Redis):
  - после миграции — 16 новых строк; у трёх верхних ступеней стихий,
    «Без единой царапины» и «Коллекционера» знак есть, у «Пацифиста» — нет;
  - `ach_friends_5` зовётся «Душа компании», награда и цель прежние;
  - забег с `noHitSec` 600 → «Без единой царапины» выполнено; 599 — нет;
  - три забега по 200 убийств огнём → ступень 500 выполнена, 2 500 — нет;
  - «Коллекционер»: 6 из 7 «Мастеров» — не выполнен, цель 7; седьмой →
    выполнен; включили восьмого «Мастера» — цель 8, «Коллекционер» остаётся
    выполненным;
  - неправдоподобные счётчики (`counters: null`) испытаний не двигают.
- `packages/app-shell/test/tasks-api.test.ts` — тексты четырёх видов
  собираются, «{value} из {count}» у «Коллекционера».

## Аналитика

Новых событий нет: `achievement_unlocked` (T-0106) несёт `category` и
`prestige`.

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] В каталоге 16 новых достижений; знак — только у трудных.
- [ ] «Коллекционер» считает цель сам и остаётся выполненным с новым оружием.
- [ ] Ступень «5 друзей» зовётся «Душа компании».
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Испытания, стихийники и «Коллекционер»`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: достижения «Без единой царапины», «Пацифист», «Коллекционер» и стихийники — от «Поджигателя» до «Огнепоклонника»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОСТИЖЕНИЯ V2**

  В каталоге 16 новых достижений: испытания «Без единой царапины» (10 минут без попадания) и «Пацифист» (минута без убийств), четыре лестницы стихийников, «Коллекционер» всех «Мастеров оружия» и «Мастер Метеора». Знак у имени — только у трудных. Ступень «5 друзей» теперь «Душа компании».

  ❓ **Нужно от команды**

  • @владелец — геймдизайнеру откалибровать цели и награды новых достижений в панели
  ```
