---
id: T-0341
title: Фильтр имён — кандидаты в правила из частых слов в никах
epic: E7
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0338, T-0339, T-0340]
zones:
  - backend/api/src/modules/name-rules/name-rule-candidates-rules.ts
  - backend/api/src/modules/name-rules/name-rule-candidates-tokens.ts
  - backend/api/src/modules/name-rules/name-rule-candidates.repository.ts
  - backend/api/src/modules/name-rules/name-rule-candidates.service.ts
  - backend/api/src/modules/name-rules/name-rule-candidates.job.ts
  - backend/api/src/modules/name-rules/name-rules.module.ts
  - backend/api/src/modules/admin/admin-name-rule-candidates.controller.ts
  - backend/api/src/cli/name-rule-candidates.ts
  - backend/api/package.json
  - backend/api/test/name-rule-candidates-tokens.test.ts
  - backend/api/test/name-rule-candidates.test.ts
  - backend/api/test/name-rule-candidates.integration.test.ts
  - apps/admin/src/api/name-rule-candidates.ts
  - apps/admin/src/screens/names/**
  - apps/admin/test/name-rule-candidates.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - apps/admin/src/ui/help.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0341. Фильтр имён — кандидаты в правила из частых слов в никах

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0341.json)](README.md#значки-статуса) [![T-0338](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0338.json&label=T-0338)](archive/T-0338-name-rules-server.md) [![T-0339](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0339.json&label=T-0339)](T-0339-name-rules-panel.md) [![T-0340](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0340.json&label=T-0340)](T-0340-name-rules-hits.md)

## Зачем

Чужие бренды и новый мат появляются в никах раньше, чем команда о них узнаёт.
Когда одно и то же слово или пара слов вдруг встречается у многих разных игроков,
это повод добавить его в стирания (или, наоборот, в исключения). Сервер каждую
ночь считает такие частые слова и показывает в панели только агрегаты.

## Решения

Решение владельца — `docs/35-stage4-plan.md`, **Р168** («Кандидаты — слово или
пара слов, встреченные у 20+ разных игроков за 30 дней, только агрегаты, без
ников и id; кнопки «в стирания» и «в исключения»»). Не пересматриваются:

- Окно — **30 суток** по `last_seen_at`; порог — **20 разных игроков**, и он
  **не понижается**: константа в коде, не настройка (приватность).
- В базе и в панели — только `слово или пара слов` + `число разных игроков`. Ники
  целиком, `accountId` и связь «слово → игрок» **нигде не сохраняются и не
  логируются**: игроки считаются в памяти прохода, наружу выходит число.
- Считается **исходный ник** (`platform_name`, а если его нет — `display_name`):
  в очищенном нике уже нет того, что мы вырезаем, а новый бренд ищем именно в
  исходнике.
- Расчёт — **ночное задание** BullMQ под распределённым замком в Redis; одна
  реплика считает, остальные пропускают.
- Слово, которое уже закрыто правилом (стирание, исключение) или встроенным
  словарём, **кандидатом не становится**.
- Кнопки: «**В стирания**» (выбор категории: бренды — по умолчанию, реклама и
  ссылки, мат, прочее) и «**В исключения**»; сверх просьбы владельца добавлена
  третья — «**Не нужно**» (скрыть кандидата навсегда): иначе безобидные частые
  слова («привет», имена) возвращались бы каждую ночь и засоряли список.
- Нажатие «в стирания»/«в исключения» создаёт обычное правило через
  `NameRulesService.create` (T-0338): те же проверки, лимиты и аудит
  `names.rule.create`.
- Права — `names.edit`; вкладка «Кандидаты» — шестая на экране «Фильтр имён»
  (T-0339 оставил пять категорий; блок статистики и колонки добавил T-0340).
- Списков слов в репозиторий не пишем: примеры в тестах — «пример-бренд»,
  «примерслово».

## Как сейчас

- Кандидатов нет. Источник данных — таблица `account` (`backend/api/prisma/schema.prisma`,
  `model Account`): `accountId`, `displayName` (очищенный), `platformName`
  (исходник, может быть `null` у старых аккаунтов), `lastSeenAt`, `nameLockedAt`.
  Индекс `@@index([lastSeenAt, accountId])` есть.
- Проход по аккаунтам пачками с курсором по `accountId` — образец
  `cleanAll` в `backend/api/src/cli/display-names-clean.ts` (`PAGE_SIZE = 500`,
  `orderBy: { accountId: "asc" }`, `accountId: { gt: cursor }`).
- Движок правил (T-0338): `loadNameRuleSet(prisma)`, `cleanNameDetailed(raw, rules)`
  → `{ name, verdict, hits, saved }`, `protectedSpans(rules, text)`,
  `foldForRules(text)`; создание правил — `NameRulesService.create(actor, input)`.
- Ссылки и упоминания в нике режет `stripLinksAndMentions` из
  `modules/auth/display-name-links.ts`.
- Образец ночного расписания, замка и воркера: `modules/bot-mention/bot-mention.job.ts`
  (`upsertJobScheduler`, `Worker`, `onModuleDestroy`) и `bot-mention-sweep.service.ts`
  (`LOCK_KEY`, `SET … PX NX` под `withTimeout`, освобождение сверкой токена,
  `clock` как поле для теста).
- Экран: `apps/admin/src/screens/names/` (T-0339 и T-0340): вкладки категорий,
  список, диалоги; API-слой `apps/admin/src/api/name-rules.ts`.

## Шаги по порядку

1. **Схема и миграция.** `schema.prisma` (shared), блок в конце:

   ```prisma
   enum NameCandidateKind { word pair }

   /// Частые слова и пары слов в никах (Р168, T-0341): только агрегат — слово и число разных игроков.
   model NameRuleCandidate {
     candidateId String            @id @map("candidate_id") @db.Uuid
     token       String            @db.VarChar(64)
     kind        NameCandidateKind
     /// разных игроков за окно на момент последнего расчёта; не меньше порога
     players     Int
     firstSeenAt DateTime          @map("first_seen_at") @db.Timestamptz(3)
     computedAt  DateTime          @map("computed_at") @db.Timestamptz(3)
     /// скрыт сотрудником: расчёт его не показывает и не воскрешает
     dismissedAt DateTime?         @map("dismissed_at") @db.Timestamptz(3)
     dismissedBy String?           @map("dismissed_by") @db.Uuid

     @@unique([kind, token])
     @@index([players])
     @@map("name_rule_candidate")
   }
   ```
   Миграция — один раз: `prisma migrate dev --create-only --name name_rule_candidate`
   после перебазирования на свежий `dev`; `ls backend/api/prisma/migrations | tail`.
   Только добавление. `wipe-plan.ts`: `NameRuleCandidate: keep("кандидаты в
   правила имён")`; `wipe-plan.test.ts` — счётчик «остаётся N» **+1** (число из
   файла на момент работы). `docs/21-diagrams.md` — сущность
   `NAME_RULE_CANDIDATE`.

2. **Константы** `name-rule-candidates-rules.ts`:

   ```ts
   export const CANDIDATE_RULES = {
     minPlayers: 20,        // порог приватности: ниже не показываем и не храним
     windowDays: 30,
     pageSize: 1_000,
     mapMax: 1_000_000,     // разных слов в памяти прохода; дальше новые не заводим
     keepMax: 500,          // строк в таблице: самые частые
     listMax: 200,          // строк в ответе панели
     dismissedKeepDays: 90, // скрытые забываются, если слово исчезло
     lockTtlMs: 1_800_000,
     schedule: "15 3 * * *", // каждую ночь, UTC
     tokenMin: 3, tokenMax: 32, wordsPerName: 12, digitsMax: 4,
   } as const;
   ```

3. **Разбор ника** `name-rule-candidates-tokens.ts` — чистые функции:

   ```ts
   export interface NameTokens { words: string[]; pairs: string[] }   // без повторов в пределах одного ника
   export function tokensOf(name: string): NameTokens
   ```
   `tokensOf`: NFKC → `stripLinksAndMentions` → `foldForRules` (нижний регистр,
   `ё` → `е`) → разбить по `/[^\p{L}\p{N}]+/u` → оставить слова длиной
   `tokenMin…tokenMax` знаков, хотя бы с двумя буквами, не более `digitsMax` цифр
   → взять первые `wordsPerName` → `words` без повторов → `pairs`: соседние слова
   исходного порядка, `"слово слово"`, без пар из одинаковых слов, без повторов,
   длиной ≤ 64 знаков. Слово, отброшенное фильтром, разрывает пару (соседними
   считаются только подряд идущие принятые слова).

4. **Расчёт** `name-rule-candidates.service.ts` — `NameRuleCandidatesService`
   (`@Injectable`), зависимости: `PRISMA`, `REDIS`, репозиторий кандидатов.
   `clock` — поле, как в `bot-mention-sweep.service.ts`.
   - `run(): Promise<CandidateRunResult>` (`{ status: "done" | "skipped"; scanned;
     kept; capped }`): замок `name-rules:candidates:lock` (`SET … PX 1_800_000 NX`
     под `withTimeout(…, 2000)`, токен `randomUUID()`); занят — `skipped`.
   - `rules = await loadNameRuleSet(prisma)` — свежий набор, не кэш.
   - Проход по `account` где `lastSeenAt >= now - 30 суток`, пачками по
     `pageSize`, курсор `accountId`; из строки берётся `platformName ?? displayName`;
     `select` — **только** `accountId` (для курсора), `platformName`, `displayName`.
     Для каждого ника — `tokensOf`; в `Map<string, number>` ключи `w:<слово>` и
     `p:<пара>` получают +1 (по одному на ник — это и есть «разные игроки»).
     Новые ключи сверх `mapMax` не заводятся (счёт существующих продолжается),
     `capped = true`. `accountId` из пачки наружу не уходит и в памяти не
     накапливается. Замок продлевается (`PEXPIRE`) на каждой пачке, если токен свой.
   - После прохода: ключи с счётом ≥ `minPlayers`; из них **выбрасываются**
     закрытые: `cleanNameDetailed(token, rules).verdict !== "ok"` (правило или
     встроенный словарь уже трогает строку) и те, у которых `protectedSpans(rules,
     token).spans.length > 0` (исключение уже есть). Оставшиеся — по убыванию
     счёта, не больше `keepMax`.
   - Запись одним проходом в транзакции: `repository.save(items, runStartedAt)`:
     `INSERT … ON CONFLICT (kind, token) DO UPDATE SET players = EXCLUDED.players,
     computed_at = EXCLUDED.computed_at` (через `unnest`, `first_seen_at` и
     `dismissed_at` при конфликте не трогаются); затем `DELETE` строк
     `computed_at < runStartedAt` без `dismissed_at` (слово упало ниже порога) и
     скрытых, у которых `computed_at` старше `dismissedKeepDays`.
   - Итог в Redis `name-rules:candidates:last` — JSON `{ computedAt, scanned, kept,
     capped }`, TTL 3 суток. В лог: `{ module: "name-rules", event: "candidates_computed",
     scanned, kept, capped }` — **без слов**.
   - Замок снимается в `finally` сверкой токена.
   - Пустая таблица `account` и ноль кандидатов — штатный исход (`kept: 0`).

5. **Расписание** `name-rule-candidates.job.ts` — `NameRuleCandidatesJob`
   (`OnApplicationBootstrap`, `OnModuleDestroy`): очередь `name-rule-candidates`,
   `upsertJobScheduler("nightly", { pattern: CANDIDATE_RULES.schedule, tz: "UTC" },
   { name: "compute", opts: { attempts: 1, removeOnComplete: 10, removeOnFail: 10 } })`,
   воркер `concurrency: 1` зовёт `service.run()`. Сбой расписания — `warn`, не
   падение (как в `bot-mention.job.ts`); при `databaseUrl === ""` ничего не
   поднимается. Провайдеры (`NameRuleCandidatesService`, `NameRuleCandidatesAdminService`, `NameRuleCandidatesJob`) — в `name-rules.module.ts` (зона T-0339, `depends_on`); админский сервис — ещё и в `exports`, иначе контроллер из `admin.module.ts` его не получит.

6. **Команда** `cli/name-rule-candidates.ts` + строка в `backend/api/package.json`
   `"names:candidates": "node --conditions=source --import @swc-node/register/esm-register src/cli/name-rule-candidates.ts"`
   (по образцу `names:clean`): без Nest создаёт Prisma и Redis, зовёт тот же
   `run()` и печатает одну строку JSON с `scanned`, `kept`, `capped` (**без слов**);
   `--dry-run` считает и не пишет. Нужна, чтобы проверить расчёт и не ждать ночи.

7. **Ручки панели** `modules/admin/admin-name-rule-candidates.controller.ts`,
   `@Controller("admin/name-rules/candidates")`, гарды как у остальных, на каждой
   `@RequirePermission("names.edit")`; сервис — `NameRuleCandidatesAdminService`
   (в том же модуле), `roles.require(actor, "names.edit")` внутри:

   | Метод | Тело | Ответ |
   |---|---|---|
   | `GET /` | — | `{ data: { computedAt: string \| null, minPlayers: 20, windowDays: 30, items: [{ candidateId, token, kind, players, firstSeenAt }] } }` — без скрытых, по убыванию `players`, не больше `listMax` |
   | `POST /:candidateId/accept` | `{ category: "profanity"\|"brand"\|"ads"\|"other"\|"allow", kind: "exact"\|"word" }` | `{ data: NameRuleView }` — правило с `pattern = token`; строка кандидата удаляется |
   | `POST /:candidateId/dismiss` | — | `{ data: { dismissed: true } }` |

   `accept`: найти кандидата (нет — `NameRuleNotFoundError`, 404), создать правило
   через `NameRulesService.create` (ошибка валидации или дубль всплывает как есть,
   кандидат **остаётся**), затем удалить кандидата. `dismiss`: `dismissed_at =
   now`, `dismissed_by = actor`; аудит `names.candidate.dismiss` с `target =
   candidateId`, `after: { kind }` — **без слова** (слово в журнал аудита не
   пишем: журнал видят шире, чем экран). Изменяющие — через `ADMIN_LIMITS.mutate`.
   `computedAt` берётся из `name-rules:candidates:last`; нет значения — `null`.
   Контроллер — в `admin.module.ts` (shared). Подпись `"names.candidate.dismiss":
   "Скрыт кандидат в правила имён"` — в `apps/admin/src/api/audit.ts` (shared) и
   в `audit.test.ts`; в `auditObject` — ветка `names.candidate.*`: `{ kind:
   "кандидат", label: short(target), route: { section: "names", id: null } }`.

8. **Панель.** `apps/admin/src/api/name-rule-candidates.ts`: Zod-схема ответа,
   `fetchCandidates(api)`, `acceptCandidate(api, id, body)`, `dismissCandidate(api, id)`,
   чистые функции `defaultKind(candidate)` (`word` для слова, `exact` для пары),
   `kindTitle(kind)` («Слово» / «Пара слов»), `candidatesNote(data)`.
   В `screens/names/` — шестая вкладка **«Кандидаты · N»** (счётчик — число
   `items`), компонент `CandidatesTab.tsx`:
   - подпись: «Слова и пары слов, которые встретились у <minPlayers> и более
     разных игроков за <windowDays> суток. Ники и аккаунты не сохраняются —
     только слово и число игроков. Считается каждую ночь. Посчитано: <дата и
     время>»;
   - таблица: «Слово или пара» (моноширинным), «Тип», «Игроков» (`formatNumber`),
     «Впервые замечено» (дата без времени — `Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" })` в `name-rule-candidates.ts`: в `apps/admin/src/format.ts` такой функции нет, файл не трогаем), кнопки «В стирания», «В исключения», «Не
     нужно»;
   - **«В стирания»** открывает небольшое окно: «Категория» (`Select`: Бренды —
     по умолчанию, Реклама и ссылки, Мат, Прочее — с подписью действия из
     `CATEGORY_ACTIONS`), «Как искать» (`Select`: «Слово целиком» / «Точная
     фраза», по умолчанию `defaultKind`), кнопка «Добавить правило»; перед ней
     — ссылка «Проверить на примерах» (окно T-0339 с подставленным правилом);
   - **«В исключения»** — подтверждение: «Добавить «<слово>» в исключения? Оно
     перестанет вырезаться правилами и встроенным словарём» → `accept` с `allow`;
   - **«Не нужно»** — подтверждение `ConfirmDialog`: «Скрыть «<слово>»? Оно не
     появится снова, пока его встречают у <minPlayers> и более игроков»; после
     — тост «Скрыто». Возврата скрытого в интерфейсе нет;
   - после успеха строка пропадает, счётчик вкладки уменьшается, тост «Правило
     добавлено — действует у новых входов»;
   - состояния: загрузка (`Loading`), ошибка (`ErrorNotice`, «Повторить»), нет
     расчёта (`computedAt: null`): «Расчёт ещё не запускался — он идёт каждую
     ночь в 03:15 UTC», пусто: «Пока ни одно слово не набрало <minPlayers> игроков»,
     ошибка действия — тост с текстом сервера (409 «Такое правило уже есть» —
     строка остаётся).
   `ui/help.ts` (shared): ключи `names.candidates` (что это и почему порог 20) и
   `names.candidatesPrivacy` (что хранится).
   Вёрстка — 360, 768, 1440 px, `phoneLayout` таблицы, цвета из токенов.

9. **Документы.** `docs/29-admin-panel.md` — абзац про вкладку; `docs/30-configuration-map.md`
   — строки: порог 20, окно 30 суток, расписание 03:15 UTC, потолок 500 строк,
   200 в ответе (все в `CANDIDATE_RULES`); `docs/22-analytics-and-metrics.md` —
   примечание к записи T-0340: кандидаты — агрегат без игроков, таблица
   `name_rule_candidate`, событий нет; `docs/21-diagrams.md` — сущность и поток
   «ночной расчёт → таблица → панель → правило».

## Чего не трогаем

- Движок правил и ручки CRUD — **T-0338**; экран, перечистка — **T-0339**;
  счётчики срабатываний — **T-0340**.
- `display-name-words.ts` и другие встроенные словари — не пополняем; кандидат
  становится правилом в базе, а не строкой в коде.
- Автоматическое добавление правил без человека — нет, только кнопки.
- Хранение ников, `accountId`, примеров ников у кандидата — нет.
- Настройка порога в панели — нет (приватность, константа).

## Сценарий и интерфейс

Сотрудник открывает «Фильтр имён» → вкладка «Кандидаты · 4» → видит слово,
которое появилось у 31 игрока → «В стирания» → оставляет «Бренды» и «Слово
целиком» → «Добавить правило» → кандидат исчез, на вкладке «Бренды» появилось
правило, перечистка (T-0339) вырежет слово из старых ников. Безобидное слово —
«Не нужно».

Состояния: загрузка, ошибка, нет расчёта, пусто, 409 при дубле, нет права
(раздел скрыт). Макета нет (`design: null`) — по образцу остальных вкладок.

## Тесты

Пишутся первым коммитом, до кода.

`backend/api/test/name-rule-candidates-tokens.test.ts` (чистые функции):
- «Вася Пример-Бренд 2024» → слова `вася`, `пример`, `бренд`, `2024` отсеян
  (только цифры), пары `вася пример`, `пример бренд`.
- Регистр и `ё`: «ЁЛКА Елка» → одно слово `елка`, пар нет (одинаковые слова).
- Повтор в одном нике («пример пример пример») → слово один раз.
- Длина: слово из 2 знаков и из 33 отброшены; слово из 3 — принято; отброшенное
  разрывает пару.
- Больше 12 слов — берутся первые 12.
- Ссылки и упоминания не дают слов: «t.me/chan_name @someone пример» → только `пример`.
- Предел цифр: `abc1234` (четыре цифры) принят, `abc12345` (пять) отброшен; токен только из цифр (`2024`) отброшен — в нём нет двух букв.
- Полноширинная запись и NFKC («ＰＲＩＭＥＲ») свернуты в `primer`.

`backend/api/test/name-rule-candidates.test.ts` (поддельные Prisma-фасад, Redis, репозиторий, часы):
- Порог: слово у 19 разных ников — нет, у 20 — да; одно слово дважды в одном
  нике считается один раз.
- Окно: аккаунт с `lastSeenAt` 31 сутки назад в выборку не попадает (проверяется
  условием запроса).
- Закрытое не предлагается: слово под действующим `brand`, слово под `allow`,
  слово, которое встроенный словарь признаёт матом (строка из
  `test/display-name.test.ts`) — в `save` не уходят.
- Скрытое остаётся скрытым после повторного расчёта; упавшее ниже порога — удалено;
  скрытое старше 90 суток забыто.
- Переполнение: при `mapMax` меньше числа разных слов `capped: true`, счёт
  уже заведённых продолжается.
- В `save` уходят только `token`, `kind`, `players`: ни `accountId`, ни ника
  (проверка структуры аргументов); в лог слов нет.
- Замок: второй `run()` при занятом замке — `skipped`; замок снят в `finally`
  даже при ошибке; чужой токен не снимается; на пачках вызывается `PEXPIRE`.
- Выбирается `platformName ?? displayName`: у аккаунта без исходника считается
  очищенный ник.
- Потолок `keepMax`: остаются самые частые.
- Ручки: без `names.edit` — 403; `accept` с неизвестным `candidateId` — 404; с
  неверной категорией — 400; `accept` создаёт правило и удаляет кандидата;
  при дубле правила — 409 и кандидат цел; `dismiss` пишет аудит без слова.

`backend/api/test/name-rule-candidates.integration.test.ts` (живые Postgres и Redis):
- 25 аккаунтов с исходником «пример-бренд», 19 с «примерслово» и 5 с «пример-бренд»
  вне окна: после `run()` кандидатов три — слова `пример`, `бренд` и пара
  `пример бренд`, у каждого `players = 25` (пять вне окна не считаются); у
  `примерслово` (19 игроков) строки нет.
- Таблица `name_rule_candidate` не содержит столбца с аккаунтом (запрос к
  `information_schema.columns`).
- `accept` как `brand`/`word`: правило есть в `name_rule`, кандидат удалён,
  следующий вход игрока с этим словом даёт ник без него.
- Скрытый кандидат после повторного `run()` по-прежнему скрыт.
- Два одновременных `run()` — один считает, второй `skipped`.

`apps/admin/test/name-rule-candidates.test.ts`: разбор ответа схемой;
`defaultKind` (слово → `word`, пара → `exact`); `candidatesNote` в трёх случаях
(нет расчёта, пусто, есть); `acceptCandidate` шлёт `POST` с нужным телом и
CSRF-заголовком, 409 приходит как текст ошибки; `SECTIONS` не менялся.

## Аналитика

Нет событий и метрик: расчёт агрегирует ники и не относится к действию игрока.
Данные — таблица `name_rule_candidate` (слово, число игроков), примечание в
`docs/22` — шаг 9. Лог расчёта — числа без слов.

## Настройки и окружение

Нет новых ключей и переменных. Константы — `CANDIDATE_RULES`; строки в
`docs/30`. Новая команда `pnpm --filter backend-api names:candidates [--dry-run]`
— в `docs/20-env-and-ports.md` не нужна (окружение то же).

## Документы

`docs/21-diagrams.md`, `docs/22-analytics-and-metrics.md`, `docs/29-admin-panel.md`,
`docs/30-configuration-map.md` — шаг 9. `pnpm docs:check` зелёный.

## Критерии приёмки

- [ ] В базе, логах, журнале аудита и ответах нет ников, `accountId` и слов из
      «стирающих» списков; хранится слово и число игроков, не меньше 20.
- [ ] «Разные игроки» считаются по одному на ник; окно — 30 суток по `last_seen_at`.
- [ ] Закрытые правилом, исключением или встроенным словарём слова не предлагаются.
- [ ] Ночное задание идёт под замком, один экземпляр на кластер; сбой не оставляет замок.
- [ ] «В стирания»/«в исключения» создают обычное правило с аудитом T-0338;
      «Не нужно» скрывает навсегда (до забывания через 90 суток).
- [ ] Команда `names:candidates` печатает только числа.
- [ ] Миграция одна, `wipe-plan`, ER и документы обновлены.
- [ ] Вёрстка читаема на 360, 768 и 1440 px.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(names): Кандидаты в правила фильтра имён`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАНДИДАТЫ В ПРАВИЛА ФИЛЬТРА ИМЁН**

  Каждую ночь сервер ищет слова и пары слов, которые встретились у 20 и более разных игроков за 30 суток, и показывает их в «Фильтре имён» на вкладке «Кандидаты».

  🛠 **Панель и сервер**

  • Хранятся только слово и число игроков — ников и id игроков нет ни в базе, ни в логах
  • Кнопки «В стирания» (с выбором категории), «В исключения» и «Не нужно»
  • Уже закрытые правилами или встроенным словарём слова не предлагаются
  • Команда names:candidates считает сразу, не дожидаясь ночи

  ❓ **Нужно от команды**

  • @участник1 — на следующий день после выката открыть вкладку «Кандидаты» и разобрать список
  ```
