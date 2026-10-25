---
id: T-0323
title: «Мастера» оружия Р157 — Кистень, Серп, Гусли, Рябиновые бусы; стихии нового оружия в заданиях; тест, что у каждого базового оружия есть «Мастер»
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0322, T-0281, T-0288, T-0289, T-0290]
zones:
  - backend/api/test/weapon-masters.test.ts
  - backend/api/test/weapon-masters.integration.test.ts
shared:
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/tasks/task-rules.ts
  - CLAUDE.md
  - docs/39-retention-mechanics.md
runner: local
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 6
---

# T-0323. «Мастера» оружия Р157 — Кистень, Серп, Гусли, Рябиновые бусы; стихии нового оружия в заданиях; тест, что у каждого базового оружия есть «Мастер»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0323.json)](README.md#значки-статуса) [![T-0322](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0322.json&label=T-0322)](T-0322-achievements-v2-trials-elements-collector.md) [![T-0281](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0281.json&label=T-0281)](T-0281-ice-spirit-and-flail.md) [![T-0288](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0288.json&label=T-0288)](T-0288-sickle-boomerang.md) [![T-0289](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0289.json&label=T-0289)](T-0289-gusli-cone-knockback.md) [![T-0290](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0290.json&label=T-0290)](T-0290-rowan-beads-chain.md)

## Зачем

«Коллекционер» (T-0322) — все «Мастера оружия», а у четырёх новых видов
оружия Р157 «Мастера» нет. Гусли и Рябиновые бусы несут стихию, а задания
«сыграй с оружием стихии» о них не знают. После задачи у каждого базового
оружия есть «Мастер», стихии нового оружия засчитываются. Тест ловит
следующее оружие без «Мастера».

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р161: «Мастер» есть у каждого
базового оружия, новое оружие поднимает цель «Коллекционера».

Решения `claude-lead-1` от 25.10.2026:

- **Четыре строки** — миграция `INSERT … ON CONFLICT (task_id) DO NOTHING`,
  как «Мастер Метеора» в T-0322: вид `weapon_runs`, фильтр — id оружия,
  цель 5, категория `collection`, престиж 10, 150 монет, знак `uncommon`.

  | id | Название |
  |---|---|
  | `ach_weapon_flail` | «Мастер Кистеня» |
  | `ach_weapon_sickle` | «Мастер Серпа» |
  | `ach_weapon_gusli` | «Мастер Гуслей» |
  | `ach_weapon_rowan_beads` | «Мастер Бус» |

- **Стихии в `WEAPON_ELEMENTS`** (`task-rules.ts`):
  - `gusli` и эволюция `bayan_song` — `lightning`;
  - `rowan_beads` и эволюция `necklace` — `poison`;
  - Кистень, Серп и их эволюции стихии не несут — в карту не попадают.
- **Тесты-сторожа** — относительный импорт контента в тесте, как цены бустов
  в `boosts.test.ts`:
  - у каждого базового оружия (`WEAPONS` без `evolvedFrom`) есть
    `ach_weapon_<id>` в каталоге после миграций; сообщение называет оружие;
  - `WEAPON_ELEMENTS` совпадает со стихиями оружия и эволюций в контенте.
- **`CLAUDE.md`, «Как добавить оружие»** — строка: новое базовое оружие
  несёт строку «Мастера» (миграция в `backend`) и стихию в
  `WEAPON_ELEMENTS`; без них падают тесты-сторожа.

## Как сейчас

- **После T-0322** — «Мастер Метеора», «Коллекционер» с целью «сколько
  «Мастеров» активно».
- **После T-0281, T-0288–T-0290** — оружие `flail`, `sickle`, `gusli`,
  `rowan_beads` и эволюции `whirl`, `harvest`, `bayan_song`, `necklace` в
  `content/weapons.ts`. Сверить id с влитым кодом.
- **`WEAPON_ELEMENTS`** — `task-rules.ts:63`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — четыре строки.
3. **`WEAPON_ELEMENTS`** — четыре строки.
4. **`CLAUDE.md`** и **`docs/39`** §3.

## Чего не трогаем

- Сами виды оружия и их числа.
- «Коллекционера» — цель он считает сам (T-0322).

## Тесты

Первым коммитом.

- `backend/api/test/weapon-masters.test.ts` — `WEAPON_ELEMENTS` против
  контента; убрать `gusli` из карты → тест падает с именем оружия.
- `backend/api/test/weapon-masters.integration.test.ts` — у каждого базового
  оружия есть «Мастер»; у игрока без «Коллекционера» цель стала 11; игрок,
  выполнивший «Коллекционера» до миграции, его не теряет.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

По шагу 4.

## Критерии приёмки

- [ ] У каждого базового оружия — «Мастер»; стихии Гуслей и Бус засчитываются.
- [ ] Тесты-сторожа ловят оружие без «Мастера» и расхождение стихий.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Достижения «Мастер» нового оружия`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: достижения «Мастер» Кистеня, Серпа, Гуслей и Рябиновых бус`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МАСТЕРА НОВОГО ОРУЖИЯ**

  У Кистеня, Серпа, Гуслей и Рябиновых бус появились достижения «Мастер», «Коллекционер» теперь просит и их. Гусли и Бусы засчитываются в задания по стихии. Тест не даст добавить оружие без «Мастера».
  ```
