---
id: T-0293
title: Очки эффективности на сервере — пять осей против ожидаемого, стиль забега, веса ключами панели, пересчёт прошлых забегов
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0291, T-0292, T-0191]
zones:
  - backend/api/src/modules/rating/**
  - backend/api/src/cli/runs-rescore.ts
  - backend/api/test/rating-score.test.ts
  - backend/api/test/rating-score.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/package.json
  - backend/api/src/app.module.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/runs.module.ts
  - backend/api/src/modules/runs/run-verdict.ts
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: design/art/meta-v2.md
batch: 7
---

# T-0293. Очки эффективности на сервере — пять осей против ожидаемого, стиль забега, веса ключами панели, пересчёт прошлых забегов

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0293.json)](README.md#значки-статуса) [![T-0291](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0291.json&label=T-0291)](T-0291-rating-expected-table.md) [![T-0292](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0292.json&label=T-0292)](T-0292-run-result-hunt-and-build.md) [![T-0191](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0191.json&label=T-0191)](T-0191-single-difficulty-server.md)

## Зачем

Рейтинг сейчас — кто дольше продержался. По Р66 и Р152 он — кто сыграл
лучше для своей силы, и игрок видит за что. После задачи сервер у каждого
записанного забега считает:
- пять осей — Стойкость, Натиск, Охота, Чистота, Сборка;
- очки;
- стиль забега — сильнейшую ось.

Всё хранится в строке забега и уходит в ответ записи. Доски по очкам —
T-0294, экраны — T-0296, T-0297.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- Р66 — рейтинг эффективности;
- Р152:
  - пять осей против ожидаемого;
  - веса 0,40 / 0,20 / 0,20 / 0,10 / 0,10 и показатель Стойкости 1,3 — калибровкой, ключами каталога настроек;
  - ожидаемое — таблица `balance:sim`;
  - стиль у имени.

Формулы — `design/art/meta-v2.md` §2.2.

Решения `claude-lead-1` от 25.10.2026:

- **Полоса и минута** — полоса силы по `result.pressure.power` (T-0291),
  минута — `ceil(survivalSec / 60)`, от 1 до 20. Ожидаемое `E` — строка
  `expected-runs.json` для этой пары.
- **Оси** — индекс `I`, 1 — ровно ожидаемое:

  | Ось | Ключ | Индекс |
  |---|---|---|
  | Стойкость | `t` | `(survivalSec / 600) ^ p` |
  | Натиск | `k` | `(enemiesKilled / мин) / E.killsPerMin` |
  | Охота | `h` | `Σ(value × clamp(E.huntKillSec[rank] / aliveSec, 0,5, 2)) / мин / E.huntPerMin` |
  | Чистота | `c` | `clamp(E.damageTakenPerMin / max(damageTaken / мин, 1), 0,3, 2)` |
  | Сборка | `b` | `buildScore / max(E.buildScore, 1)` |

  - `мин` — `survivalSec / 60`, не меньше 0,5.
  - Охота, когда `E.huntPerMin = 0` (ранние минуты без элит), — 1.
  - Забег без `huntLog` или `buildScore` (старый клиент) — индекс оси 1.
- **Очки** — `round(1000 × Σ вес × min(I, cap))`:
  - `cap` — 3;
  - веса нормируются к сумме 1: сумма ключей не 1 — нормируется, в лог —
    предупреждение.
- **Ключи панели** (каталог настроек, значение панели сильнее умолчания):
  - `rating.weight-endurance` — 0,40;
  - `rating.weight-onslaught` — 0,20;
  - `rating.weight-hunt` — 0,20;
  - `rating.weight-clean` — 0,10;
  - `rating.weight-build` — 0,10;
  - `rating.endurance-exponent` — 1,3;
  - `rating.index-cap` — 3.
- **Стиль забега** — ось с наибольшим `min(I, cap)`; при равенстве — по
  порядку `t, k, h, c, b`. Имена:
  - `t` — Стена;
  - `k` — Ураган;
  - `h` — Охотник;
  - `c` — Тень;
  - `b` — Мастер.
- **Хранение** — в строке `run`:
  - `points int null`;
  - `axes jsonb null` — индексы с тремя знаками;
  - `style varchar(8) null`;
  - `band smallint null`.

  Считается при записи каждого забега, кроме пролога. Сбой подсчёта не
  мешает записи: очки `null`, в лог — ошибка.
- **Честность** — сырой индекс любой оси выше `2 × cap` — причина вердикта
  `axis_out_of_range` (подозрение): забег не идёт в рейтинг и ждёт разбора
  (`run-verdict.ts`). Это флаг, а не очки.
- **Таблица отстала** — `contentHash` файла не совпал с хэшем контента
  забега: очки считаются, в лог — предупреждение раз в час.
- **Ответ записи забега** — `score: { points, axes, style, band, expectedPoints }`.
  `expectedPoints` — очки забега той же длины, сыгранного ровно по
  ожидаемому: Стойкость — та же, остальные оси — 1, то есть
  `round(1000 × (w_t × min(I_t, cap) + (1 − w_t)))`. Это черта «ожидаемое»
  на карточке (T-0297).
- **Пересчёт прошлых** — `pnpm --filter backend-api runs:rescore [--since <дата>]`:
  - по сохранённым колонкам забега, пачками по 500;
  - идемпотентно;
  - в лог — сколько пересчитано.
- **Аналитика** — серверное событие `run_scored { run_id, points, axes,
  style, strength_band }` тем же писателем событий (`events/events.sink.ts`),
  что принимает пачки клиента. В Prometheus — гистограмма
  `rating_run_points` с меткой `band` (пять значений), без `run_id`.

## Как сейчас

- **Запись забега:**
  - `runs/runs.service.ts`;
  - вердикт — `run-verdict.ts` (причины `VerdictReason`);
  - схема — `runs/dto/runs.dto.ts`.
- **Строка забега** — модель `Run` в `schema.prisma`:
  - `survivalSec`, `weapons`;
  - `details` (`damageTaken`, `xpCollected`…);
  - `ranked`, `verdict`.
- **Ключи** — `settings/setting-catalog.ts` (имена через дефис:
  `telegram.link-host`).
- **События** — `events/events.sink.ts` (`EventsSink.write`), словарь —
  `events/event-dictionary.ts`, `docs/22` §3.3.
- **После T-0291** — `rating/expected-runs.json`. **После T-0292** — `huntLog`,
  `buildScore` в итоге.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — поля `run`; ER в `docs/21`.
3. **`rating/score-rules.ts`** — оси, очки, стиль (чистые); схема
   `expected-runs.json` (Zod) и загрузка при старте.
4. **`rating/run-scorer.service.ts`** — вызов при записи забега; ответ записи.
5. **Вердикт** — причина `axis_out_of_range`.
6. **Ключи** — в каталоге.
7. **Событие и метрика** — сначала словарь `docs/22` и Zod, потом код.
8. **`cli/runs-rescore.ts`** и скрипт в `package.json`.
9. **Документы:**
   - `docs/30` — ключи;
   - `docs/32` — раздел «Очки эффективности» с формулами.

## Чего не трогаем

- Доски и сезон — T-0294, T-0295.
- Клиент — T-0296, T-0297.

## Тесты

Первым коммитом.

- `rating-score.test.ts`:
  - забег ровно по ожидаемому на 10-й минуте → все индексы ≈ 1, очки ≈ 1000;
  - 20 минут → `I_t = 2 ^ 1,3 ≈ 2,46`;
  - индекс 5 по Натиску → в очки идёт 3;
  - индекс 7 → причина `axis_out_of_range`;
  - Охота при `E.huntPerMin = 0` → 1;
  - забег без `huntLog` → `I_h = 1`;
  - Чистота при нуле урона → 2 (верх коридора);
  - стиль — наибольшая ось, при равенстве — порядок;
  - веса с суммой 1,2 → нормированы.
- `rating-score.integration.test.ts`:
  - запись забега → `points`, `axes`, `style` в строке и в ответе;
  - пролог — без очков;
  - сбой загрузки таблицы → забег записан, очки `null`;
  - `runs:rescore` — повтор не меняет числа;
  - ключ `rating.weight-hunt` из панели меняет очки.

## Аналитика

По «Решениям»: `run_scored` и `rating_run_points{band}`.

## Настройки и окружение

Ключи `rating.*` — по шагу 6.

## Документы

`docs/21`, `docs/22`, `docs/30`, `docs/32` — по шагам.

## Критерии приёмки

- [ ] У каждого забега — пять осей, очки и стиль против ожидаемого для его силы и минуты.
- [ ] Веса и показатель — ключами панели; выброс оси — подозрение, а не очки.
- [ ] Прошлые забеги пересчитываются командой без двойного счёта.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Очки эффективности забега`
- **Метка:** `release: minor`
- **Для игроков:** пусто — очки покажут T-0296, T-0297.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОЧКИ ЭФФЕКТИВНОСТИ**

  Сервер считает у каждого забега пять осей против ожидаемого для силы игрока — Стойкость, Натиск, Охота, Чистота, Сборка, — очки и стиль (Стена, Ураган, Охотник, Тень, Мастер). Веса — ключи rating.* в панели. Прошлые забеги — pnpm runs:rescore.
  ```
