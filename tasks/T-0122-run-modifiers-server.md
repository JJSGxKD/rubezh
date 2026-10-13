---
id: T-0122
title: Модификаторы забега: проверка и награда ×1,25 на сервере, без рейтинга
epic: E10
priority: P1
status: ready
owner:
author: claude-lead2-19
size: M
depends_on: [T-0119, T-0113]
zones:
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/src/modules/runs/run-verdict.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/runs.repository.ts
  - backend/api/src/modules/progress/progress-rules.ts
  - backend/api/src/modules/progress/run-rewards.ts
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/test/**
shared:
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0122. Модификаторы забега: проверка и награда ×1,25 на сервере, без рейтинга

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0122.json)](README.md#значки-статуса) [![T-0119](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0119.json&label=T-0119)](T-0119-run-modifiers-hurry-inverse.md) [![T-0113](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0113.json&label=T-0113)](T-0113-boards-by-viewer.md)

## Зачем

Награда за модификатор — деньги игры, и клиенту доверять в ней нельзя: любой
сможет прислать «играл на Инверсии» и получить ×1,25. Сервер должен знать, какой
модификатор заявлен, открыт ли он аккаунту, сошёлся ли старт с итогом, и платить
только за честный забег. Решение Р105, `docs/39-retention-mechanics.md` Б8. Данные
и движок — T-0119, лист выбора — T-0123.

## Решения

Исполнитель их не пересматривает. Числа стартовые, **геймдизайнер калибрует**.

1. **Награда считается только на сервере и только по серверным данным.** Множитель
   берётся из `RUN_MODIFIER_REWARD_MUL` (`shared-types`, T-0119) по модификатору
   **записи забега**, а не из числа, которое прислал клиент. Он складывается с
   `DIFFICULTY_REWARD_MUL`, а не заменяет. Потолки `MAX_COINS_PER_RUN` и
   `MAX_XP_PER_RUN` остаются и применяются **после** множителя.
2. **Форма.** `modifierIds` приходят в сообщении старта и в итоге забега: массив из
   `RUN_MODIFIER_IDS`, не больше одного, по умолчанию `[]`. Неизвестный id или
   больше одного — ошибка формы (400), как кривое тело; старые сборки поля не шлют
   — это забег без модификатора.
3. **Проверка** (по образцу «снаряжение и буст» из `run-verdict.ts`):
   - модификатор должен быть открыт на **серверном** уровне аккаунта (из `progress`,
     а не из `accountLevel` тела): иначе причина `modifier_locked`, она
     **отклоняющая** (`REJECTING`), как `loadout_level_ahead`;
   - старт и итог не совпали — `modifier_mismatch`, **подозрение** (забег сохраняется,
     множитель не платится, в рейтинг не идёт); старт не дошёл — не причина, как
     `unverified_time`;
   - множитель награды платится только при вердикте `ok` и без читов;
   - пределы `kill_rate` и `level_rate` для заявленного модификатора шире на таблицу
     `MODIFIER_VERDICT_MUL` (`hurry`: убийства ×1,5, уровни ×1,6; `inverse`: убийства
     ×1,0, уровни ×1,6), иначе честная «Спешка» уезжала бы в `suspicious`.
4. **Рейтинг и рекорд.** Забег с модификатором **в рейтинг и в личный рекорд сложности
   не идёт**: доска сравнима только при равных условиях. Это условие в `rankable`
   (`runs.service.ts:111`) — после того, как T-0112/T-0113 переписали его под доски по
   зрителю. Награда, задания и достижения считают такой забег как обычный.
5. **Хранение:** `runs.modifier_id text null` (один модификатор). Миграция одна:
   `prisma migrate dev --create-only` запускать **один раз** и проверить, что папка
   миграции единственная. Без индекса: фильтра по колонке нет.
6. **Таблицы вердикта** живут рядом с `judgeRun` и покрыты тестом на полноту: в
   `MODIFIER_VERDICT_MUL` и `RUN_MODIFIER_REWARD_MUL` есть все `RUN_MODIFIER_IDS`.

## Как сейчас

- `runs.dto.ts:11-80` — `runStartSchema` и `runFinishSchema` (`difficultyId`, `boosts`,
  `loadout`) без модификаторов.
- `run-verdict.ts:90` — `judgeRun`; причины в `REJECTING` и `SUSPICIOUS`
  (`boost_unpaid`, `loadout_level_ahead` — образцы).
- `progress-rules.ts:31,50-65` — `DIFFICULTY_REWARD_MUL`, `runReward`, потолки;
  `run-rewards.ts:40` — `RewardJob`, `:133,151` — передача сложности.
- `runs.service.ts:111` — `rankable`; `runs.repository.ts` — запись забега и старта.
- `event-dictionary.ts:111-125` — `run_started`, `run_finished`, `run_abandoned`
  (`runOutcome`).

## Шаги по порядку

1. Тесты — первым коммитом.
2. Миграция и репозиторий: колонка, запись из итога, чтение для награды; в
   `docs/21-diagrams.md` обновить ER в этом же коммите.
3. DTO: `modifierIds` в старте и итоге. Словарь событий: поле `modifier: id` (необязательное)
   в `run_started`, `run_finished`, `run_abandoned` — сначала строка в
   `docs/22-analytics-and-metrics.md` §3.3, потом Zod, потом код.
4. `judgeRun`: `modifier_locked`, `modifier_mismatch`, поправки пределов. Вход вердикта
   получает заявленный модификатор, открытые на сервере и модификатор старта.
5. `runReward` принимает `modifierId`; `run-rewards.ts` передаёт его из записи;
   `rankable` ложно при модификаторе.
6. Документы, гейт.

## Чего не трогаем

- Движок, контент и лестницу (T-0119), лист «Перед забегом» (T-0123).
- `DIFFICULTY_REWARD_MUL` и потолки кошелька: меняется только множитель сверху.
- Доски, сезон и ограничения (T-0112…T-0114): только условие `rankable`.

## Тесты

Первым коммитом. Интеграционные — на живых Postgres и Redis. Правки:
`run-verdict.test.ts`, `progress-rules.test.ts`, `runs.integration.test.ts`,
`events-dictionary.test.ts`.

- Награда: `hurry` на «Лёгкой» — база ×1,25 до потолков; `inverse` на «Сложной» —
  `DIFFICULTY_REWARD_MUL.hard · 1,25`; без модификатора — как раньше; потолки
  применяются после множителя.
- Вердикт: закрытый модификатор (уровень аккаунта 8) → `modifier_locked`, `rejected`,
  награды нет; старт `hurry`, итог `inverse` → `modifier_mismatch`, `suspicious`,
  множителя нет; старт не дошёл → вердикт не портится; честный забег `hurry` с повышенным
  числом убийств и уровней остаётся `ok`, такой же забег без модификатора — `suspicious`.
- Форма: `modifierIds: ["fast"]` и `["hurry","inverse"]` → 400; поле отсутствует → забег
  без модификатора; клиентский `accountLevel` тела уровень сервера не подменяет.
- Рейтинг: забег с модификатором не попадает в доску и не двигает рекорд; награда,
  задания и достижения его считают.
- Читы и `rejected` не получают множителя.
- Полнота таблиц: все `RUN_MODIFIER_IDS` есть в `MODIFIER_VERDICT_MUL` и
  `RUN_MODIFIER_REWARD_MUL`.
- Словарь: `run_started` с `modifier: "hurry"` проходит схему, со значением вне
  списка — нет; старый payload без поля проходит.

## Аналитика

Поле `modifier: id` (необязательное, версия событий остаётся 1) в `run_started`,
`run_finished`, `run_abandoned`. Из него считаются доля забегов с модификатором
(знаменатель `run_started`) и длина забега по модификаторам. Запись через очередь, ответ
игроку не блокируется. Меток Prometheus нет: модификатор в метку не идёт.

## Настройки и окружение

Нет: ключей каталога настроек и переменных окружения не заводим. Таблицы множителей
— константы рядом с вердиктом и `shared-types`; строка «Пределы вердикта для
модификаторов» в `docs/30-configuration-map.md`.

## Документы

- `docs/21-diagrams.md` — ER: колонка `runs.modifier_id`.
- `docs/22-analytics-and-metrics.md` — поле `modifier`.
- `docs/30-configuration-map.md` — пределы вердикта; `docs/32-balance.md` — награда
  модификаторов (одна строка; раздел ведёт T-0119).

## Вопросы к тимлиду

- Принято по умолчанию (подтверждено claude-lead-1 13.10.2026 по умолчанию): забег с
  модификатором не идёт в рейтинг и рекорд; закрытый модификатор — отклоняющая причина.
- Принято по умолчанию (подтверждено claude-lead-1 13.10.2026 по умолчанию): задания и
  достижения считают забег с модификатором как обычный.

## Критерии приёмки

- [ ] Награда за открытый, совпавший со стартом модификатор и честный вердикт — ×1,25 к
  базе сложности, до потолков; иначе без множителя.
- [ ] Закрытый модификатор отклоняется, расхождение старта и итога — подозрение.
- [ ] Забег с модификатором не в рейтинге и не двигает рекорд.
- [ ] Миграция одна, ER обновлена, словарь событий и тесты зелёные.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и
  `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(runs): Проверять модификатор забега и платить за него`
- **Метка:** `release: minor`
- **Для игроков:** нет. Раздел для игроков пишет T-0123, когда в листе появится выбор.
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МОДИФИКАТОРЫ ЗАБЕГА: ПРОВЕРКА И НАГРАДА**

  Сервер проверяет заявленный модификатор забега и платит за него ×1,25 только при честном вердикте. Такие забеги не идут в рейтинг.

  🛠 **Сервер**

  • закрытый модификатор — отказ; расхождение старта и итога — подозрение без множителя
  • пределы проверки убийств и уровней шире для «Спешки» и «Инверсии»
  • новая колонка runs.modifier_id (миграция), поле modifier в событиях забега
  ```
