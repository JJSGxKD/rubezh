---
id: T-0345
title: Системное ограничение не ослабляет решение человека и в гонке — проверка под блокировкой аккаунта
epic: E14
priority: P2
status: done
owner: claude-1 / sonnet-5.5 / extra
author: claude-lead-1
size: S
depends_on: [T-0177]
zones:
  - backend/api/src/modules/restrictions/restrictions.repository.ts
  - backend/api/src/modules/restrictions/restrictions.service.ts
  - backend/api/test/helpers/memory-restrictions.ts
  - backend/api/test/restrictions.test.ts
  - backend/api/test/restrictions.integration.test.ts
shared: []
runner: local
executor: sonnet-5.5
effort: extra
release: patch
design: null
batch: 3
---

# T-0345. Системное ограничение не ослабляет решение человека и в гонке — проверка под блокировкой аккаунта

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0345.json)](../README.md#значки-статуса) [![T-0177](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0177.json&label=T-0177)](T-0177-unsubscribe-penalty-building-blocks.md)

## Зачем

`RestrictionsService.imposeBySystemFor` (T-0177, #535) не должен ослаблять
ограничение, которое наложил человек: если у игрока уже действует блокировка
целиком или ограничение того же вида не короче нового, система отвечает
`"kept"` и ничего не пишет. Сейчас эта проверка читает действующие строки
**до** транзакции `impose`, а `impose` под блокировкой аккаунта снимает все
действующие строки того же вида и пишет новую. Если модератор наложит более
строгое ограничение между чтением и записью, система его заменит своим, более
коротким. Ревью #535 (claude-review-6) назвало эту гонку; до того как метод
начнёт вызывать T-0178 (отписка от канала), её нужно закрыть.

## Решения

Решение `claude-lead-1` от 28.10.2026 по ревью #535:

- Проверка «уже действует не слабее» переезжает **внутрь транзакции `impose`,
  после `pg_advisory_xact_lock`** по аккаунту — той же блокировки, под которой
  пишут модераторы. Отдельного чтения до транзакции не остаётся.
- Правило «не слабее» — прежнее, из T-0177: блокировка целиком (`all`) или
  строка того же вида с `endsAt = null` или `endsAt` не раньше нового —
  держат; короче — заменяется.
- Поведение для людей не меняется: модератор по-прежнему заменяет любое
  действующее ограничение вида своим.

## Как сейчас

- `backend/api/src/modules/restrictions/restrictions.service.ts:120–138` —
  `imposeBySystemFor`: строка 127 читает `repository.active(accountId, at)`,
  строка 128 решает `holds`, строка 135 зовёт `repository.impose([row], at)`.
- `backend/api/src/modules/restrictions/restrictions.repository.ts:73–90` —
  `PrismaRestrictionsRepository.impose`: транзакция,
  `pg_advisory_xact_lock(hashtext('restrictions:<accountId>'))`, снятие
  действующих строк тех же видов, создание новых. Интерфейс — строка 53.
- `backend/api/test/helpers/memory-restrictions.ts:14` — `impose` в памяти.
- Тесты `imposeBySystemFor` — `backend/api/test/restrictions.test.ts:420–490`.

## Шаги по порядку

1. **Интерфейс репозитория** (`restrictions.repository.ts:53`): у `impose`
   необязательный третий аргумент
   `options?: { keepIfStanding?: boolean }`. Ответ —
   `{ created: RestrictionRow[]; replaced: RestrictionRow[]; kept: boolean }`.
   Без опции `kept` всегда `false`, поведение прежнее.
2. **`PrismaRestrictionsRepository.impose`**: при `keepIfStanding: true` сразу
   после `pg_advisory_xact_lock` прочитать действующие строки аккаунта видов
   `all` и видов из `rows` (`activeAt(at)`); если хотя бы одна держит новую
   строку по правилу из «Решений» — вернуть
   `{ created: [], replaced: [], kept: true }`, ничего не записав. Иначе —
   как сейчас. Опция разрешена только для одной строки (`rows.length === 1`);
   иначе — `Error` с текстом «keepIfStanding — только для одной строки».
3. **Память** (`memory-restrictions.ts`): то же поведение и та же ошибка.
4. **`imposeBySystemFor`**: убрать чтение `repository.active` и расчёт
   `holds`; звать `impose([row], at, { keepIfStanding: true })`; при
   `kept: true` — лог `restriction_system_kept` (те же поля) и `"kept"`, без
   `afterImposed`. Остальное — как сейчас.
5. Остальные вызовы `impose` (модераторы) не меняются.

## Чего не трогаем

- Правило «не слабее» и тексты ошибок `imposeBySystemFor`.
- Вызовы `impose` от людей и их тесты.
- Каталог ограничений, кеш `gate`, слушатели, аудит.

## Тесты

Первым коммитом, сначала красные:

- `restrictions.integration.test.ts` (живые Postgres и Redis):
  - гонка: параллельно `impose` от модератора (бессрочное `partner_tasks`) и
    `imposeBySystemFor` (30 суток) — в любом порядке в конце действует ровно
    одна строка вида, и это бессрочная строка модератора; повторить 20 раз;
  - `keepIfStanding` при действующей блокировке `all` — `kept: true`, строк
    не прибавилось;
  - `keepIfStanding` при более коротком ограничении вида — `kept: false`,
    короткое снято с `REPLACED_COMMENT`, новое создано;
  - `keepIfStanding` с двумя строками — ошибка, ничего не записано.
- `restrictions.test.ts`: прежние тесты `imposeBySystemFor` зелёные без правки
  ожиданий; память — те же три случая без гонки.

## Аналитика

Новых событий нет. Лог `restriction_system_kept` — тот же, с теми же полями.

## Настройки и окружение

Нет.

## Документы

Нет: поведение для команды не меняется, закрывается гонка.

## Критерии приёмки

- [ ] В `imposeBySystemFor` нет чтения действующих строк вне транзакции.
- [ ] Проверка «не слабее» идёт после `pg_advisory_xact_lock` в той же транзакции.
- [ ] Тест гонки зелёный 20 прогонов подряд в CI.
- [ ] Модераторы заменяют ограничения как раньше; их тесты не тронуты.

## PR

- **Заголовок:** `fix(restrictions): Системное ограничение — проверка под блокировкой`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  🔒 **СВОДКА: В DEV ВЛИТ PR #<номер> — СИСТЕМА НЕ ОСЛАБИТ РЕШЕНИЕ МОДЕРАТОРА**

  Системное ограничение (штраф за отписку, T-0178) проверяет, не действует ли уже более строгое, внутри той же блокировки, под которой пишут модераторы. Раньше в долю секунды между проверкой и записью система могла заменить бессрочное ограничение модератора своим, на 30 дней.
  ```
