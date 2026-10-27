---
id: T-0340
title: Фильтр имён — статистика срабатываний правил
epic: E7
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0338, T-0339]
zones:
  - backend/api/src/modules/name-rules/name-rule-hits.ts
  - backend/api/src/modules/name-rules/name-rule-hits.repository.ts
  - backend/api/src/modules/name-rules/name-rules-stats.service.ts
  - backend/api/src/modules/name-rules/name-rules-core.module.ts
  - backend/api/src/modules/name-rules/name-rules.module.ts
  - backend/api/src/modules/admin/admin-name-rules-stats.controller.ts
  - backend/api/src/modules/auth/account.repository.ts
  - backend/api/test/name-rule-hits.test.ts
  - backend/api/test/name-rules-stats.test.ts
  - backend/api/test/name-rule-hits.integration.test.ts
  - apps/admin/src/api/name-rule-stats.ts
  - apps/admin/src/api/name-rules.ts
  - apps/admin/src/screens/names/**
  - apps/admin/test/name-rule-stats.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - apps/admin/src/ui/help.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0340. Фильтр имён — статистика срабатываний правил

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0340.json)](README.md#значки-статуса) [![T-0338](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0338.json&label=T-0338)](T-0338-name-rules-server.md) [![T-0339](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0339.json&label=T-0339)](T-0339-name-rules-panel.md)

## Зачем

Команда не знает, какие правила фильтра имён реально работают, а какие лежат
мёртвым грузом. Нужно видеть по каждому правилу: сколько раз сработало за период
и когда в последний раз, какие правила лидируют и какие не срабатывали вовсе, —
без хранения ников и идентификаторов игроков.

## Решения

Решение владельца — `docs/35-stage4-plan.md`, **Р168** («статистика срабатываний
по правилу»). Не пересматриваются:

- Чистка уже возвращает `hits` (правила, изменившие результат) и `saved`
  (исключения, спасшие строку) — это сделано в T-0338 (`storedNameDetailed`).
  Здесь они только считаются.
- **Вход не ждёт.** Счёт идёт в памяти процесса, раз в 5 секунд пачка уходит в
  очередь BullMQ, воркер дописывает суточные счётчики одним запросом.
- Счётчик — **по id правила и суткам (UTC)**, без ников, id игроков и их числа.
  «Сколько разных игроков» не считаем: нужен только порядок величин.
- Считаются **входы игроков**: игрок с брендом в нике, заходящий каждый день,
  даёт срабатывание каждый день. Перечистка (`names:clean`, T-0339) **не
  считается** — иначе одна кнопка исказила бы картину. Экран говорит это словами.
- **Закреплённый ник не считается** (поправка claude-lead-1, 27.10.2026): у
  аккаунта с `nameLockedAt` ник при входе не меняется, а статистика должна
  показывать, что правила реально убирают. Тест: вход аккаунта с закреплённым
  ником, в котором сработало бы правило, счётчик не трогает.
- Учёт **не точный, а оценочный**: пачка, которую не удалось поставить в очередь
  (Redis недоступен), и пачка при сбое воркера теряются (повторов нет —
  `attempts: 1`), потому что это статистика, а не деньги. Потеря пишется в лог.
- Хранение — **180 суток**, старше стирается.
- Событие в аналитику и метрика Prometheus **не заводятся**: событие на каждый
  вход с совпавшим правилом — это сотни тысяч строк в `analytics_event` ради
  числа, которое уже лежит агрегатом; метрик на бэкенде пока нет
  (`docs/22-analytics-and-metrics.md`, раздел про метрики). Это решение
  записывается в `docs/22` (шаг 8).

## Как сейчас

- Статистики срабатываний нет: чистка возвращала бы только `name` и `verdict`. После
  T-0338 `displayNameDetailed` / `storedNameDetailed` дают `hits: string[]` и
  `saved: string[]` (id правил); `PrismaAccountRepository.upsert`
  (`backend/api/src/modules/auth/account.repository.ts`, ~стр. 125-164) вызывает
  `storedNameFor` дважды (в `create` и для найденного аккаунта) — второй вызов
  идёт **всегда**, от него и берём `hits`.
- Конструктор `PrismaAccountRepository(prisma, @Optional() @Inject(NAME_RULES) rules?)`
  — T-0338. Пятнадцать тестов вызывают `new PrismaAccountRepository(prisma)` —
  новый параметр обязан быть необязательным.
- `NameRulesCoreModule` (T-0338) уже импортируется `AuthModule` и экспортирует
  `NAME_RULES`, `NameRulesCache`, `NAME_RULES_REPOSITORY`.
- Образец очереди и воркера: `modules/events/events.sink.ts` (очередь `events`,
  `Queue`/`Worker`, запись в базу пачкой, троттлинг логов сбоя Redis —
  `FAILURE_LOG_INTERVAL_MS = 60_000`) и `modules/bot-mention/bot-mention.job.ts`.
- Ответы панели строятся как у `AdminAdsController` (`@RequirePermission`,
  `parse`, `{ data }`); экран — `apps/admin/src/screens/names/` (T-0339):
  `NamesScreen.tsx`, список правил, `RuleDialog.tsx`; API-слой —
  `apps/admin/src/api/name-rules.ts`.

## Шаги по порядку

1. **Схема и миграция.** `schema.prisma` (shared), блок в конце:

   ```prisma
   /// Суточные счётчики срабатываний правил фильтра имён (Р168, T-0340):
   /// только id правила и сутки UTC — ни ников, ни id игроков.
   model NameRuleHitDay {
     ruleId String   @map("rule_id") @db.Uuid
     day    DateTime @db.Date
     hits   Int

     rule NameRule @relation(fields: [ruleId], references: [ruleId], onDelete: Cascade)

     @@id([ruleId, day])
     @@index([day])
     @@map("name_rule_hit_day")
   }
   ```
   В `model NameRule` (T-0338) — одна строка связи `hitDays NameRuleHitDay[]`.
   Миграция — один раз: `prisma migrate dev --create-only --name name_rule_hit_day`
   после перебазирования на свежий `dev`, проверь `ls backend/api/prisma/migrations | tail`.
   Только добавление (expand). `wipe-plan.ts`: `NameRuleHitDay: keep("счётчики
   срабатываний правил имён")`; `wipe-plan.test.ts` — счётчик «остаётся N» **+1**
   (число из файла на момент работы). `docs/21-diagrams.md` — сущность
   `NAME_RULE_HIT_DAY` и связь `NAME_RULE ||--o{ NAME_RULE_HIT_DAY : "считается по суткам"`.

2. **Порт и счётчик в памяти.** `modules/name-rules/name-rule-hits.ts`:

   ```ts
   export const NAME_RULE_HITS = Symbol("NAME_RULE_HITS");
   export interface NameRuleHitsSink {
     /** Синхронно, без ожидания и без исключений: вход игрока не должен зависеть от статистики. */
     record(hits: readonly string[], saved: readonly string[]): void;
   }
   export const NAME_RULE_HITS_LIMITS = {
     flushMs: 5_000,        // пачка уходит в очередь раз в 5 с
     retentionDays: 180,
     pruneEveryMs: 86_400_000,
     enqueueTimeoutMs: 2_000,
     bufferMax: 5_000,      // разных id в буфере; больше быть не может (правил ≤ 2000), но предел держим
   } as const;
   ```
   Класс `NameRuleHits` (`@Injectable`, `OnApplicationBootstrap`, `OnModuleDestroy`)
   реализует порт: `record` складывает `Map<ruleId, number>` (каждый id из `hits`
   и из `saved` — +1), пустой вызов — выход сразу, при переполнении буфера новые
   id молча пропускаются. Таймер `flushMs` (`unref`): буфер непуст → снимок и
   очистка → `queue.add("hits", { day, counts })` под `withTimeout(…, 2000)`,
   `attempts: 1`, `removeOnComplete: 100`, `removeOnFail: 100`. `day` — сутки UTC
   на момент отправки (`YYYY-MM-DD`, часы внедряются). Сбой постановки — пачка
   теряется, `warn name_rule_hits_dropped` не чаще раза в минуту. Очередь
   `name-rule-hits`, соединения — `createQueueConnection(config, "producer"|"worker")`,
   как в `events.sink.ts`; при `databaseUrl === ""` класс ничего не поднимает и
   `record` — пустая функция. `onModuleDestroy` отправляет остаток буфера
   (с тем же таймаутом), закрывает очередь, воркер и соединения.
   Воркер: `repository.addHits(day, counts)`; не чаще раза в `pruneEveryMs`
   после обработки пачки — `repository.prune(retentionDays)`; сбой воркера —
   `warn name_rule_hits_failed` с `reason: error.name`, без повтора.

3. **Хранилище.** `name-rule-hits.repository.ts`: `addHits(day, counts)` — **один** запрос:

   ```sql
   INSERT INTO name_rule_hit_day (rule_id, day, hits)
   SELECT u.rule_id, ${day}::date, u.hits
   FROM unnest(${ids}::uuid[], ${amounts}::int[]) AS u(rule_id, hits)
   JOIN name_rule r ON r.rule_id = u.rule_id
   ON CONFLICT (rule_id, day) DO UPDATE SET hits = name_rule_hit_day.hits + EXCLUDED.hits
   ```
   (`prisma.$executeRaw` с тегированным шаблоном; `JOIN name_rule` нужен, чтобы
   удалённое между отправкой и записью правило не уронило всю пачку внешним
   ключом). `prune(days)` — `DELETE … WHERE day < (current_date - ${days}::int)`.
   `statsFor(days)` — запрос статистики:

   ```sql
   SELECT r.rule_id,
          COALESCE(SUM(h.hits) FILTER (WHERE h.day >= ${since}::date), 0)::int AS hits,
          MAX(h.day) AS last_day
   FROM name_rule r LEFT JOIN name_rule_hit_day h ON h.rule_id = r.rule_id
   GROUP BY r.rule_id
   ```
   плюс `SELECT MIN(day) FROM name_rule_hit_day` для `trackedSince`. Строки
   разбираются Zod-схемой. Каждый вызов базы — под `withTimeout(…, 3000)`.

4. **Подключение.** `name-rules-core.module.ts`: `NameRuleHits`, `{ provide:
   NAME_RULE_HITS, useExisting: NameRuleHits }` и репозиторий; в `exports` —
   `NAME_RULE_HITS` (без экспорта необязательная зависимость в
   `PrismaAccountRepository` молча пуста — приёмка #249). `account.repository.ts`:
   третий параметр конструктора `@Optional() @Inject(NAME_RULE_HITS) private readonly
   hits?: NameRuleHitsSink`; в `upsert` второй вызов заменить на
   `storedNameDetailed(…)` и после определения ника — `this.hits?.record(detail.hits,
   detail.saved)`. Зовётся **один раз за вход**, не в ветке `create` отдельно.
   `names:clean` и перечистка (`cleanAll`) не записывают ничего.

5. **Ручка статистики.** `name-rules-stats.service.ts` — `NameRulesStatsService`:
   `stats(actor, days)` — `roles.require(actor, "names.edit")`, `days` ∈ {7, 30, 90}
   (иначе `ValidationError("Окно — 7, 30 или 90 суток")`), возвращает:

   ```ts
   interface NameRuleStatsView {
     days: 7 | 30 | 90;
     since: string;                 // YYYY-MM-DD, начало окна (UTC), включительно
     trackedSince: string | null;   // первые сутки, за которые вообще есть счётчики
     totalHits: number;             // сумма по правилам за окно
     rules: { ruleId: string; hits: number; lastDay: string | null }[];   // все правила, в том числе с нулём
   }
   ```
   `lastDay` — за всё время хранения (180 суток), `hits` — за окно. Контроллер
   `modules/admin/admin-name-rules-stats.controller.ts`: `GET /api/v1/admin/name-rules/stats?days=30`
   (по умолчанию 30), `@RequirePermission("names.edit")`, `{ data }`. Сервис — в
   `NameRulesModule`, контроллер — в `admin.module.ts` (shared).

6. **Панель.** `apps/admin/src/api/name-rule-stats.ts`: Zod-схема ответа,
   `fetchStats(api, days)`, окна `STATS_WINDOWS = [7, 30, 90]`, чистые функции:
   - `statsById(stats)` → `Map<ruleId, { hits, lastDay }>`;
   - `topRules(rules, stats, limit = 5)` — правила с `hits > 0`, по убыванию, при
     равенстве по `pattern`;
   - `unusedRules(rules, stats)` — **действующие** правила с `hits === 0`
     (выключенные не считаются «лишними»);
   - `lastHitText(lastDay, today)` — «сегодня», «вчера», «<число> <мес.>» через
     `Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" })`
     (функции даты без времени в `apps/admin/src/format.ts` нет, файл не трогаем), `—` если `null`;
   - `trackedNote(stats, today)` — строка-оговорка: если `trackedSince` позже
     начала окна или `null` — «Учёт ведётся с <дата>: раньше срабатывания не
     считались»; `null`, если окно целиком покрыто.
   В `screens/names/` (зона T-0339 — менять можно, `depends_on`):
   - над списком — блок **«Что срабатывает»**: переключатель окна (`Select`: «7
     суток», «30 суток», «90 суток»), 5 строк «Топ за период» (шаблон, категория,
     число) и строка «Не срабатывали: N» — кнопка-фильтр, оставляющая в списке
     только такие правила (повторное нажатие снимает); оговорка `trackedNote`;
   - в таблице списка две колонки: «Срабатываний» (число за окно, `—` у
     выключенного без данных) и «Последний раз» (`lastHitText`); сортировка
     «Сначала: недавно изменённые | чаще срабатывают | реже срабатывают»
     (`Select`, умолчание — недавно изменённые);
   - сноска под блоком: «Считаем входы игроков, а не людей: игрок, заходящий
     каждый день, даёт срабатывание каждый день. Перечистка не считается.
     Цифры приблизительные — при сбое очереди часть пачек теряется»;
   - загрузка статистики не блокирует список правил: пока грузится — в колонках
     «…», ошибка — `Notice` «Статистику загрузить не удалось» и кнопка «Повторить»,
     список работает как раньше.
   `ui/help.ts` (shared): ключи `names.stats` и `names.unused` (что такое
   «не срабатывало» и почему выключенные не считаются).

7. **Нейтральность.** В журналах, ответах и таблице нет ников и id игроков. В
   репозиторий слов из списков не пишем: примеры — «пример-бренд».

8. **Документы.** `docs/22-analytics-and-metrics.md` — примечание в конце §3.3:
   срабатывания правил имён — не события, а суточный счётчик `name_rule_hit_day`
   (id правила, сутки UTC, число), причина — объём и отсутствие игрока в
   данных; `docs/29-admin-panel.md` — абзац про блок «Что срабатывает»;
   `docs/30-configuration-map.md` — строки: пачка раз в 5 с, хранение 180 суток,
   окна 7/30/90 (все — `NAME_RULE_HITS_LIMITS` и `STATS_WINDOWS`);
   `docs/21-diagrams.md` — поток «вход → буфер → очередь → счётчик» одной
   диаграммой или строкой в существующей схеме модулей.

## Чего не трогаем

- Движок правил, `cleanNameDetailed`, ручки CRUD — **T-0338**: если не хватает
  поля в `hits`/`saved`, это вопрос, а не правка движка.
- Перечистка и её состояние — **T-0339**.
- Кандидаты в правила — **T-0341**.
- Счётчики «сколько разных игроков» — не вводим.
- Аналитические события и Prometheus — не заводим (решение выше).

## Сценарий и интерфейс

Сотрудник открывает «Фильтр имён» и сверху видит «Что срабатывает»: окно 30
суток, топ-5 и «Не срабатывали: 3». Нажимает «Не срабатывали: 3» — в списке
остаются эти правила, их можно проверить и удалить. В таблице у каждого правила
число срабатываний и «Последний раз». Состояния: загрузка статистики («…»
в колонках), пусто (нет ни одного срабатывания — «За выбранный период
срабатываний не было», топ скрыт), ошибка статистики (список работает), нет
права (раздел не показывается). Вёрстка — 360, 768, 1440 px.

## Тесты

Пишутся первым коммитом, до кода.

`backend/api/test/name-rule-hits.test.ts` (поддельные очередь, репозиторий, часы):
- `record(["a","b"], ["c"])` и `record(["a"], [])` → буфер `a:2, b:1, c:1`; пустой
  вызов ничего не меняет; `record` не бросает и не ждёт, даже если очередь
  отказывает.
- Таймер: пачка уходит раз в 5 с одним заданием с суммами, буфер очищается; пустой
  буфер — задания нет.
- Сутки UTC: пачка в 23:59:58Z и в 00:00:01Z получает разные `day`.
- Сбой постановки: пачка потеряна, исключения нет, лог `name_rule_hits_dropped`
  не чаще раза в минуту (два сбоя подряд — одна запись).
- `databaseUrl === ""` — ни очереди, ни таймера; `record` пуст.
- Воркер: вызывает `addHits(day, counts)`; `prune` — не чаще раза в сутки.
- Переполнение буфера: id сверх предела пропускаются, остальные считаются.

`backend/api/test/name-rule-hits.integration.test.ts` (живые Postgres и Redis):
- Вход игрока с правилом `brand` (через `PrismaAccountRepository` с `NAME_RULES` и
  `NAME_RULE_HITS` из модуля): после сброса таймера строка `(rule_id, сегодня,
  1)`; второй вход тем же игроком — 2.
- Исключение, спасшее строку, считается своим `ruleId` (`saved`).
- `cleanAll` и перечистка счётчик не меняют.
- Пачка с удалённым правилом записывается без ошибки: строки нет, остальные
  правила пачки учтены. Удаление правила каскадом убирает его строки.
- `prune`: строки старше 180 суток исчезают, моложе остаются.
- `addHits` двух процессов подряд складывает, а не затирает (`ON CONFLICT`).

`backend/api/test/name-rules-stats.test.ts` (поддельное хранилище или живая база):
- Окно 7: строки за 3 суток назад в счёт идут, за 40 — нет; `lastDay` — максимум
  за всё время; правило без строк — `hits: 0`, `lastDay: null`.
- `trackedSince` — минимальные сутки с данными, `null`, если данных нет.
- Требует `names.edit` (403 у `game_designer`); `days=3` и `days=abc` — 400;
  без параметра — 30.

`apps/admin/test/name-rule-stats.test.ts`:
- `fetchStats` разбирает ответ схемой; `statsById`; `topRules` — порядок и
  отсев нулей, ничья по шаблону; `unusedRules` пропускает выключенные;
  `lastHitText` — «сегодня», «вчера», дата, `—`; `trackedNote` в трёх случаях.
- Сортировка списка по трём режимам стабильна.

## Аналитика

Нет событий и нет метрик — осознанно (см. «Решения»): данные ложатся агрегатом в
`name_rule_hit_day` с первого дня, задним числом их не восстановить. Запись в
`docs/22` — шаг 8.

## Настройки и окружение

Нет новых ключей и переменных. Константы — `NAME_RULE_HITS_LIMITS` (пачка 5 с,
хранение 180 суток), `STATS_WINDOWS` (7/30/90); строки в `docs/30`.

## Документы

`docs/21-diagrams.md`, `docs/22-analytics-and-metrics.md`,
`docs/29-admin-panel.md`, `docs/30-configuration-map.md` — шаги 1 и 8.
`pnpm docs:check` зелёный.

## Критерии приёмки

- [ ] Вход игрока не ждёт ни очередь, ни базу ради статистики: `record` синхронный,
      без исключений; сбой Redis не ломает вход.
- [ ] Один вход — не больше одного `record`; перечистка и CLI ничего не считают.
- [ ] Счётчики лежат по `(rule_id, сутки UTC)`, без ников и id игроков; удалённое
      правило не роняет пачку.
- [ ] Хранение 180 суток, очистка раз в сутки.
- [ ] Экран показывает окно, топ, «не срабатывали» и две колонки; загрузка
      статистики не блокирует список; оговорка про начало учёта показывается.
- [ ] Миграция одна, `wipe-plan`, ER и `docs/22`, `docs/29`, `docs/30` обновлены.
- [ ] `PrismaAccountRepository` собирается без третьего параметра (пятнадцать
      существующих тестов зелёные); `NAME_RULE_HITS` экспортирован модулем.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(names): Статистика срабатываний правил фильтра имён`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СТАТИСТИКА СРАБАТЫВАНИЙ ПРАВИЛ ФИЛЬТРА ИМЁН**

  В «Фильтре имён» видно, какие правила работают: сколько срабатываний за период, когда было последнее, какие лидируют и какие не срабатывали вовсе.

  🛠 **Панель и сервер**

  • Счёт идёт по входам игроков, пачками раз в 5 секунд через очередь — вход не ждёт; ников и id игроков в счётчиках нет
  • Окна 7, 30 и 90 суток; топ-5, фильтр «Не срабатывали», сортировка по частоте
  • Данные хранятся 180 суток; учёт идёт с момента выката
  ```
