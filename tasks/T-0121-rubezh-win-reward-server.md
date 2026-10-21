---
id: T-0121
title: Рубеж — цель забега, сервер: проверка победы, награда ×2, отметка в рейтинге
epic: E16
priority: P1
status: ready
owner:
author: claude-lead2-19
size: M
depends_on: [T-0120, T-0113, T-0191, T-0193, T-0196]
zones:
  - packages/shared-types/src/index.ts
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/src/modules/runs/run-verdict.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/runs.repository.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/runs/leaderboard.store.ts
  - backend/api/src/modules/runs/leaderboard-rebuild.ts
  - backend/api/src/modules/progress/progress-rules.ts
  - backend/api/src/modules/progress/run-rewards.ts
  - backend/api/test/**
shared:
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0121. Рубеж — цель забега, сервер: проверка победы, награда ×2, отметка в рейтинге

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0121.json)](README.md#значки-статуса) [![T-0120](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0120.json&label=T-0120)](T-0120-rubezh-guard-engine.md) [![T-0113](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0113.json&label=T-0113)](T-0113-boards-by-viewer.md) [![T-0191](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0191.json&label=T-0191)](T-0191-single-difficulty-server.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md) [![T-0196](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0196.json&label=T-0196)](T-0196-player-power-pressure-wiring.md)

## Зачем

Страж из T-0120 приходит на 10:00, и итог забега несёт `rubezh`, но сервер победу
не видит: не платит за неё, не проверяет и не отмечает в рейтинге. После задачи победа
оплачивается ×2 один раз за забег, неправдоподобная победа — подозрение без множителя,
в основной доске у победителя стоит отметка. Решение Р102, Р105,
`docs/39-retention-mechanics.md` Б6. Баннеры, карточка на экране смерти и «до рубежа
N с» — T-0124, та же пачка.

## Решения

**Поправка `claude-lead-1` от 20.10.2026 (Р126, единая сложность).** Рейтинговая сложность одна — `hard` (T-0191): доска рубежа — `lb:rubezh:hard`, награда победы считается от базы `hard`; для `easy` и `normal` победа рубежа не пишется в доску.

Исполнитель их не пересматривает. Числа стартовые, **геймдизайнер калибрует**.

1. **Награда за победу — ×2** (`RUBEZH_REWARD_MUL` в `shared-types`) к монетам и опыту
   аккаунта **один раз за забег**, поверх множителя сложности. Потолки `MAX_COINS_PER_RUN`
   и `MAX_XP_PER_RUN` остаются и применяются после множителя. Платится только при
   вердикте `ok`, без читов и только если победа правдоподобна (п. 2).
2. **Правдоподобие победы** (клиенту не верим, `run-verdict.ts`): итог несёт
   `rubezh: { reached, clearedSec, guardHpPercent }` (форма из T-0120). Причина
   `rubezh_implausible` — **подозрение**: забег сохраняется, множителя нет, в рейтинг не
   идёт, — если `clearedSec` задан при `reached: false`; `clearedSec` раньше
   `RUBEZH_AT_SEC + RUBEZH_MIN_FIGHT_SEC` (5 с: стража нельзя убить быстрее) или позже
   `survivalSec` (допуск 1 с); `reached: true` при `survivalSec` меньше
   `RUBEZH_AT_SEC − 1`. Отметка одна на сервер и контент — `RUBEZH_AT_SEC` из T-0120.
3. **Отметка в рейтинге:** в основной доске у имени победителя флаг `rubezh: true`, если
   у аккаунта на этой сложности есть засчитанная победа. Хранится Redis-набором
   `lb:rubezh:<сложность>` (accountId), запись — вместе с `submit`, чтение — **одним**
   `SMISMEMBER` на страницу доски (не запросом на строку). Пересборка доски
   (`leaderboard-rebuild.ts`) пересобирает набор по базе: победа засчитана, вердикт
   `ok`, забег шёл в рейтинг. Доски по зрителю (T-0113) набор не ломает: он отвечает
   только за аккаунты, уже попавшие в страницу зрителя, поэтому победа скрытого
   аккаунта другим не видна.
4. **Хранение:** `runs.rubezh_reached boolean not null default false`,
   `runs.rubezh_cleared_sec int null`. Миграция одна: `prisma migrate dev --create-only`
   запускать **один раз** и проверить, что папка миграции единственная.
5. **Ответ награды** получает `rubezhMul: number | null` (`2` — победа оплачена): по нему
   оболочка (T-0124) рисует «Награда ×2», не считая сама.
6. **Событие без нового имени:** в `run_finished` и `run_abandoned` (общая `runOutcome`)
   необязательные `rubezh: "none" | "reached" | "cleared"` и `rubezhClearedSec`. Из них
   доля дошедших и победивших (знаменатель `run_started`).
7. **Рекорд «до рекорда» не меняется:** победа — отдельное, рекорд по-прежнему секунды
   выживания. Забег с модификатором (T-0122) в рейтинг не идёт, и отметка его победу
   не ставит.
8. **Сезон (T-0110, T-0111) отметку не показывает**: награды сезона считаются по
   секундам, как раньше; сезонная отметка — отдельная задача после калибровки.

## Как сейчас

- `runs.dto.ts` — `runFinishSchema` без поля `rubezh`; `RunOutcome` — `died` или
  `abandoned`, победы нет.
- `run-verdict.ts:90` — `judgeRun`, причины в `REJECTING` и `SUSPICIOUS`.
- `progress-rules.ts:31,50-65` — `runReward`; `run-rewards.ts:40` — `RewardJob`.
- `leaderboard.store.ts:54-79` — `submit` (`zadd GT CH`), `top`, `rank`; ключи по сложности.
- `runs.service.ts:111` — `rankable`; `runs-view.service.ts` отдаёт доску игроку.
- Доски по зрителю (T-0113) переписывают чтение; перед правкой прочитать файлы заново.

## Шаги по порядку

1. Тесты — первым коммитом.
2. `shared-types`: `RUBEZH_REWARD_MUL`, `RUBEZH_MIN_FIGHT_SEC`.
3. Миграция, репозиторий, ER в `docs/21-diagrams.md` — одним коммитом.
4. DTO: `rubezh` необязательное, границы `clearedSec` 0–86 400, процент 0–100.
   Словарь событий: сначала `docs/22-analytics-and-metrics.md` §3.3, потом Zod, потом код.
5. `judgeRun`: `rubezh_implausible` в `SUSPICIOUS`. `runReward` принимает `rubezhCleared`;
   `run-rewards.ts` передаёт его из записи; ответ награды получает `rubezhMul`.
6. Доска: набор `lb:rubezh:*`, флаг в строках `top`, пересборка. Документы, гейт.

## Чего не трогаем

- Движок и контент рубежа (T-0120), модификаторы (T-0119, T-0122): только читаем.
- Оболочку: баннеры, карточку и экран смерти (T-0124).
- Доски по зрителю и ограничения (T-0112…T-0114), сезон (T-0110, T-0111).
- Рекорд по секундам.

## Тесты

Первым коммитом. Интеграционные — на живых Postgres и Redis. Правки: `run-verdict.test.ts`,
`progress-rules.test.ts`, `runs.integration.test.ts`, `leaderboard.test.ts`, тест словаря.

- Вердикт: победа на 650 с при 700 с выживания — `ok`; `clearedSec` 599 —
  `rubezh_implausible`; позже `survivalSec` — то же; победа при `reached: false` — то же;
  без поля `rubezh` — как раньше.
- Награда: победа = база сложности × 2 до потолков; `suspicious` без множителя; читы и
  `rejected` — без награды; потолки после множителя; повторная отправка итога не
  платит второй раз (идемпотентность по `runId`).
- Интеграция: засчитанная победа пишет колонки и набор рейтинга; `top` отдаёт флаг
  одним `SMISMEMBER` на страницу (счётчик вызовов Redis); победа скрытого аккаунта
  (T-0113) в общей доске зрителя не видна; пересборка доски восстанавливает набор;
  забег без победы набор не трогает.
- Словарь: `run_finished` с `rubezh: "cleared"` и секундой проходит схему, со значением
  вне списка — нет; старый payload без поля проходит.
- Ответ награды: `rubezhMul` равен `2` при оплаченной победе и `null` иначе.

## Аналитика

`rubezh` и `rubezhClearedSec` в `runOutcome` (версия событий остаётся 1). Сначала словарь,
потом код; запись через очередь, ответ игроку не блокируется. Меток Prometheus нет.

## Настройки и окружение

Нет: ключей каталога настроек и переменных окружения не заводим. Множитель награды —
`shared-types`, строка в `docs/30-configuration-map.md`.

## Документы

- `docs/21-diagrams.md` — ER: колонки `runs.rubezh_*`; поток «итог забега → награда →
  рейтинг» с набором победителей.
- `docs/22-analytics-and-metrics.md` — поля; `docs/32-balance.md` — награда рубежа;
  `docs/30-configuration-map.md` — множитель.

## Вопросы к тимлиду

- Принято по умолчанию (подтверждено claude-lead-1 13.10.2026 по умолчанию): награда ×2,
  отметка только в основной доске, сезонной отметки пока нет.
- Принято по умолчанию (подтверждено claude-lead-1 13.10.2026 по умолчанию): задача
  режется на движок (T-0120), сервер (эта) и оболочку (T-0124): целиком выходит за размер M.

## Критерии приёмки

- [ ] Победа оплачивается ×2 один раз, до потолков, только при честном вердикте;
  неправдоподобная победа — `suspicious` без множителя.
- [ ] У аккаунта с засчитанной победой в основной доске флаг `rubezh`, запрос к Redis на
  страницу один; скрытые аккаунты не светятся.
- [ ] Миграция одна, ER обновлена, словарь событий и тесты зелёные.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и
  `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(runs): Платить за победу над стражем рубежа`
- **Метка:** `release: minor`
- **Для игроков:** нет. Раздел для игроков пишет T-0124, когда победа станет видна.
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РУБЕЖ: ПРОВЕРКА И НАГРАДА НА СЕРВЕРЕ**

  Сервер проверяет победу над стражем рубежа, платит за неё ×2 и ставит отметку в основной доске.

  🛠 **Сервер**

  • неправдоподобная победа — подозрение без множителя и без рейтинга
  • отметка в рейтинге хранится набором в Redis, один запрос на страницу
  • новые колонки runs.rubezh_reached и runs.rubezh_cleared_sec (миграция)

  ❓ **Нужно от команды**

  • @участник2 — подтвердить множитель ×2 после первых данных теста
  ```
