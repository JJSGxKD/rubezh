---
id: T-0279
title: Пролог — сервер: запись забега-пролога, награда один раз, признак «пролог пройден» и открытие награды дня и заданий
epic: E16
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0278, T-0191]
zones:
  - backend/api/src/modules/runs/prologue-rules.ts
  - backend/api/src/modules/runs/prologue.service.ts
  - backend/api/test/prologue-rules.test.ts
  - backend/api/test/prologue.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/run-rules.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/runs/runs.module.ts
  - backend/api/src/modules/runs/dto/**
  - backend/api/src/modules/daily/**
  - backend/api/src/modules/tasks/tasks.service.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/37-accounting.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 6
---

# T-0279. Пролог — сервер: запись забега-пролога, награда один раз, признак «пролог пройден» и открытие награды дня и заданий

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0279.json)](README.md#значки-статуса) [![T-0278](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0278.json&label=T-0278)](T-0278-prologue-engine.md) [![T-0191](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0191.json&label=T-0191)](T-0191-single-difficulty-server.md)

## Зачем

Пролог (T-0278) — первый забег аккаунта, который кончается победой. Серверу
нужно:
- принять такой забег;
- не пустить его в рейтинг и задания;
- выдать награду ровно один раз;
- запомнить, что пролог пройден.

До победы у новичка закрыты «Награда дня» и «Задания»: главная не
забрасывает его кнопками до первого забега. Победа открывает их — первая
цель вне забега.

## Решения

Решения владельца:
- Р151 — рейтинг и задания пролог не трогает;
- 25.10.2026, опрос:
  - за пролог — **монеты и самоцветы**, облик «Знахарка» остаётся за 10-й
    уровень (Р150);
  - «Награда дня» и «Задания» **закрыты до победы в прологе**, у старых
    аккаунтов всё открыто.

Решения `claude-lead-1` от 25.10.2026:

- **Признак** — `account.prologue_done_at timestamptz null`. Миграция ставит
  его `now()` каждому аккаунту, у которого есть хоть один забег: старые
  игроки пролог не проходят.
- **Запись забега** — `mode` (`endless` | `prologue`) в теле записи и в строке
  `run`. Старые клиенты без поля — `endless`. Пролог:
  - сложность только `easy`, иначе 400 `run_invalid`;
  - не идёт в рейтинг, сезон, задания и достижения (`countsForTasks` →
    `false`), опыт аккаунта — как у обучающего забега (T-0191);
  - принимается, только если `prologue_done_at` пусто. Повторный пролог
    пройденного аккаунта записывается как обычный забег без наград пролога —
    клиент старой сборки не ломается.
- **Победа** — `result.prologue.won = true` и вердикт перепроверки не
  «отклонён» (`run-verdict.ts`):
  - `prologue_done_at = now()`;
  - начисление 500 монет и 10 самоцветов (ключи `prologue.reward_coins`,
    `prologue.reward_gems`);
  - причина `prologue_reward`, ключ идемпотентности `prologue:<accountId>`.

  Всё — одной транзакцией с записью забега. Два запроса разом — одно
  начисление.
- **Выход без победы** — забег записан, признак пуст: следующий запуск снова
  пролог.
- **Закрытые разделы** — пока `prologue_done_at` пусто:
  - награда дня — 409 `prologue_required`;
  - забор задания — 409 `prologue_required`.

  Список заданий отдаётся как обычно — оболочка его просто не показывает.
- **Профиль** — `GET /api/v1/runs/me` получает `prologueDone: boolean`.
- **Потолок кошелька** — `prologue_reward`: 500 монет и 10 самоцветов в
  сутки (одно начисление на аккаунт и так).

## Как сейчас

- **Запись забега:**
  - `modules/runs/runs.service.ts`, правила — `run-rules.ts`;
  - `DIFFICULTIES` — строки 15–16, вердикт — `run-verdict.ts`.
- **Профиль** — `runs.controller.ts:50` (`GET /runs/me`), вид — `runs-view.service.ts`.
- **Обучающий забег** — после T-0191 `easy` не в рейтинге, награда за него
  прежняя.
- **Правило наград заданий** — `tasks/task-rules.ts` (`countsForTasks`).
- **Награда дня** — `modules/daily/`; задания — `tasks/tasks.service.ts`.
- **Кошелёк** — причины в `wallet-types.ts`, потолки в `wallet-limits.ts`.
- **После T-0278** — `RunResult.prologue` и режим в `shared-types`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция:**
   - `account.prologue_done_at` с заполнением старых;
   - `run.mode`;
   - ER в `docs/21`.
3. **`prologue-rules.ts`** — чистые правила:
   - принимать ли пролог;
   - победа;
   - закрыт ли раздел.
4. **`prologue.service.ts`** — победа и награда в транзакции записи забега.
5. **Запись** — `mode` в схеме тела и в `runs.service.ts`; пролог вне
   рейтинга и заданий.
6. **Закрытые разделы** — проверка в награде дня и заборе задания.
7. **Профиль** — `prologueDone`.
8. **Ключи и кошелёк:**
   - `prologue.reward_coins`, `prologue.reward_gems` в каталоге настроек;
   - причина и потолок.
9. **Документы** — `docs/30` (ключи), `docs/37` (причина), `docs/21`.

## Чего не трогаем

- Движок и оболочку — T-0278, T-0280.
- Опыт аккаунта за обучающий забег — как в T-0191.

## Тесты

Первым коммитом.

- `prologue-rules.test.ts`:
  - пролог на `hard` → не принимается;
  - пролог при заполненном признаке → обычный забег без награды;
  - раздел закрыт при пустом признаке и открыт при заполненном.
- `prologue.integration.test.ts`:
  - новый аккаунт: пролог с победой → признак, 500 монет и 10 самоцветов,
    `prologueDone: true`;
  - два одинаковых запроса разом → одно начисление;
  - пролог без победы → признак пуст, наград нет;
  - пролог не появляется в рейтинге и не двигает задания;
  - награда дня и забор задания до победы → 409 `prologue_required`, после — проходят;
  - аккаунт с забегами до миграции → признак заполнен, разделы открыты;
  - старый клиент без `mode` → `endless`.

## Аналитика

Клиентские `tutorial_step`, `tutorial_completed` — T-0280. Сервер — лог
`prologue_won` с секундой победы.

## Настройки и окружение

Ключи — по шагу 8.

## Документы

По шагу 9.

## Критерии приёмки

- [ ] Пролог записывается вне рейтинга и заданий; победа ставит признак и даёт награду ровно один раз.
- [ ] До победы награда дня и задания закрыты; у старых аккаунтов всё открыто.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Пролог — запись, награда и открытие разделов`
- **Метка:** `release: minor`
- **Для игроков:** пусто — пролог включает T-0280.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОЛОГ, СЕРВЕР**

  Сервер принимает пролог — первый забег новичка: вне рейтинга и заданий, победа даёт 500 монет и 10 самоцветов ровно один раз и открывает награду дня и задания. У старых аккаунтов всё открыто. Числа — ключи prologue.* в панели.
  ```
