---
id: T-0346
title: Второй шанс за самоцветы — отказ при занятом ключе списания без строки и свой шаг стирания в вайпе
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0324]
zones:
  - backend/api/src/modules/runs/run-gem-continues.repository.ts
  - backend/api/src/modules/runs/run-gem-continue.service.ts
  - backend/api/test/run-gem-continue.test.ts
  - backend/api/test/run-gem-continue.integration.test.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/test/wipe-runner.integration.test.ts
shared: []
runner: local
executor: sonnet-5.5
effort: extra
release: patch
design: null
batch: 3
---

# T-0346. Второй шанс за самоцветы — отказ при занятом ключе списания без строки и свой шаг стирания в вайпе

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0346.json)](README.md#значки-статуса) [![T-0324](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0324.json&label=T-0324)](T-0324-gem-continue-server.md)

## Зачем

Две находки ревью #538 (T-0324, claude-review-6), обе — про то, что держится
сейчас только совпадением, а не правилом:

1. `PrismaRunGemContinuesRepository.buy` создаёт строку продолжения и списывает
   самоцветы с ключом `continue:<runId>:<номер>`. Если ключ списания уже занят,
   а строки продолжения нет, `debitWithin` отвечает `duplicate`, и продолжение
   выдаётся **без списания**. Сейчас до этого не дойти: строку и проводку пишет
   одна транзакция, а забеги и журнал кошелька стирает только вайп, вместе. Но
   `runId` выбирает клиент, и любая будущая чистка забегов без чистки журнала
   откроет бесплатное продолжение.
2. В плане вайпа `RunGemContinue` помечена `keep` с пояснением «уходит каскадом
   вместе с забегом». Вайп держится на `ON DELETE CASCADE`, а не на своём шаге,
   как у `RunAdContinue`: поменяй кто-то каскад — строки переживут вайп.

## Решения

Решение `claude-lead-1` от 28.10.2026 по ревью #538:

- **Занятый ключ без строки — отказ**, а не выдача: транзакция откатывается
  вместе с новой строкой, игрок получает тот же ответ, что на занятый номер
  (`ContinueTakenError`, 409 `continue_taken`), в лог — `warn`
  `gem_continue_key_conflict` с `runId`, `continueNo`, `accountId`. Формат
  ключа не меняется.
- **`RunGemContinue` в вайпе — `wipe`**, своим шагом рядом с `RunAdContinue`,
  в той же блокировке таблиц.

## Как сейчас

- `backend/api/src/modules/runs/run-gem-continues.repository.ts:78–105` —
  `buy`: блокировка аккаунта, проверка строки и рекламного продолжения,
  `create`, затем `debitWithin` (строки 91–103), результат которого не
  читается.
- `backend/api/src/modules/wallet/wallet-ledger.ts:73` — `debitWithin`
  возвращает `{ status: "debited" } | { status: "duplicate"; firstKey }`.
- `backend/api/src/modules/runs/run-gem-continue.service.ts:111, 124` —
  `ContinueTakenError` на `status === "taken"`.
- `backend/api/src/modules/wipe/wipe-plan.ts:107` — `RunGemContinue: keep(…)`;
  строка 110 — `RunAdContinue: wipe(…)`; список в строке ~133 — порядок
  стирания; `WIPE_LOCK_TABLES` — в `wipe-runner.ts`; шаг `RunAdContinue` —
  `wipe-runner.ts:179`.
- Счётчики моделей «остаётся N / стирается M» — `backend/api/test/wipe-plan.test.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»), красные.
2. **`buy`**: прочитать ответ `debitWithin`; при `duplicate` — бросить внутри
   транзакции доменную ошибку (своя, например `GemContinueKeyConflict`), чтобы
   откатилась строка; снаружи транзакции поймать её, записать `warn`
   `gem_continue_key_conflict` и вернуть `{ status: "taken" }`. Нехватка
   самоцветов — как сейчас.
3. **Сервис**: ничего нового — `taken` уже даёт `ContinueTakenError`.
   Проверить, что ответ на повтор того же игрока (`repeat`) не задет.
4. **Вайп**: `RunGemContinue: wipe("второй шанс за самоцветы — часть забега")`;
   шаг стирания в `wipe-runner.ts` рядом с `RunAdContinue` и до `Run`; таблица
   `run_gem_continue` — в `WIPE_LOCK_TABLES`; счётчики в `wipe-plan.test.ts` —
   по факту (одна модель переходит из «остаётся» в «стирается»).

## Чего не трогаем

- Формат ключа списания и колонку источника.
- Покупку за звёзды, рекламные продолжения, цену.
- Компенсации тестерам (`compensation*`) — это T-0347.

## Тесты

- `run-gem-continue.integration.test.ts` (живые Postgres и Redis):
  - в журнале кошелька заранее есть проводка с ключом
    `continue:<runId>:1` (через `debitWithin` или `grant` в тесте), строки
    продолжения нет → `buy` отвечает `taken`, строки не появилось, баланс не
    изменился, в журнале по-прежнему одна проводка;
  - обычная покупка и повтор того же игрока — без изменений (прежние тесты
    зелёные без правки ожиданий).
- `run-gem-continue.test.ts`: сервис на `taken` от репозитория — 409
  `continue_taken`.
- `wipe-runner.integration.test.ts`: после вайпа строк `run_gem_continue` нет,
  даже если каскад с `run` снят (проверка — строка без забега в тесте не
  нужна: достаточно, что шаг стирания идёт до `Run` и считает строки).
- `wipe-plan.test.ts`: счётчики по факту.

## Аналитика

Новых событий нет; лог `gem_continue_key_conflict` — уровень `warn`, без
данных игрока сверх id.

## Настройки и окружение

Нет.

## Документы

`docs/30-configuration-map.md` не меняется. В `docs/21-diagrams.md` — ничего:
схема БД та же.

## Критерии приёмки

- [ ] Занятый ключ списания без строки продолжения не выдаёт продолжение и не создаёт строку.
- [ ] Повтор того же игрока и обычная покупка работают как раньше.
- [ ] `RunGemContinue` стирается своим шагом вайпа и входит в блокировку таблиц.
- [ ] Формат ключа списания не изменился.

## PR

- **Заголовок:** `fix(runs): Второй шанс за самоцветы — занятый ключ и вайп`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  🛡 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВТОРОЙ ШАНС ЗА САМОЦВЕТЫ НАДЁЖНЕЕ**

  Продолжение за самоцветы больше не выдаётся, если ключ списания уже занят, а строки продолжения нет: раньше в таком редком случае оно ушло бы без списания. Строки продолжений стираются в вайпе своим шагом, а не только каскадом с забегом.
  ```
