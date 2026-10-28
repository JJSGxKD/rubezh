---
id: T-0338
title: Фильтр имён — правила в базе, чистка ников по ним и ручки панели
epic: E7
priority: P1
status: done
owner: claude-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/name-rules/**
  - backend/api/src/modules/admin/admin-name-rules.controller.ts
  - backend/api/src/modules/auth/display-name.ts
  - backend/api/src/modules/auth/account.repository.ts
  - backend/api/src/cli/display-names-clean.ts
  - backend/api/test/name-rules-engine.test.ts
  - backend/api/test/name-rules-safety.test.ts
  - backend/api/test/name-rules-cache.test.ts
  - backend/api/test/name-rules.test.ts
  - backend/api/test/name-rules.http.test.ts
  - backend/api/test/name-rules.integration.test.ts
  - backend/api/test/display-names-clean.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/src/modules/auth/auth.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/test/roles.test.ts
  - backend/api/test/admin-session.test.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
  - docs/08-web-and-identity.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0338. Фильтр имён — правила в базе, чистка ников по ним и ручки панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0338.json)](README.md#значки-статуса)

## Зачем

Слова, которые убираются из ников (чужие бренды, реклама, новый мат), сейчас
зашиты в код: чтобы добавить одно слово, нужен релиз. Команда должна править
их в панели без релиза, а чистка ников при входе и командой `names:clean`
должна учитывать эти правила и давать один и тот же результат. Это первая из
четырёх задач цепочки: экран (T-0339), статистика срабатываний (T-0340),
кандидаты (T-0341) строятся на ней.

## Решения

Решение владельца — `docs/35-stage4-plan.md`, **Р168** (к Р110 и Р111). Не
пересматриваются:

- Правила лежат **в базе**. Встроенный словарь в коде (`display-name-words.ts`,
  `display-name-links.ts`) остаётся базой и **идёт первым**; правила базу
  дополняют, ослаблять её (кроме исключений) они не могут.
- **Категории — фиксированный набор, действие задаёт категория:**

  | `category` | Что делает совпадение |
  |---|---|
  | `profanity` | **заменяет ник целиком**, как нынешний мат: вердикт `profanity`, запасной ход `fallbackName` |
  | `brand` | **вырезает** совпавшее из ника |
  | `ads` | вырезает (реклама и ссылки) |
  | `other` | вырезает |
  | `allow` | **исключение**: совпавшее не трогается ни правилами, ни встроенным словарём (как Thuy) |

- **Три вида правила (`kind`):** `exact` — точная фраза, ищется где угодно в
  нике; `word` — слово целиком; `regex` — регулярное выражение безопасного
  подмножества.
- **Регулярки — безопасным подмножеством** (§«Безопасность регулярки» ниже).
  Ни `re2`, ни `safe-regex`, ни другие зависимости не ставим: проверка своя,
  без нативных пакетов.
- Правит **новое право `names.edit`**: владелец, администратор, модератор.
- В базе списки мата и брендов хранятся только в базе; **в репозиторий
  (публичный) никакие слова не пишем**, в тестах и документах — нейтральные
  «пример-бренд», «примерслово». Для проверки встроенного мата тесты берут
  строки из уже существующего `test/display-name.test.ts`.
- Права на чтение у `names.edit` нет отдельного: кто видит экран, тот и правит.
- **Почему `sonnet-5.5` и `high`:** правила исполняются на горячем пути входа
  каждого игрока, а регулярка приходит от человека — ReDoS и «битое правило
  роняет вход» дороги и в тестах не видны сразу; плюс миграция и Redis-рассылка.
  `extra` не нужен: денег и конкурентной записи нет. `runner: local` — интеграционные
  тесты на живых Postgres и Redis.
## Как сейчас

- `backend/api/src/modules/auth/display-name.ts` (111 строк): `cleanName(raw)`
  и `displayNameFor(raw, username, accountId)`, обе зовут внутреннюю
  `clean(raw, limit)`. Конвейер `clean`: NFKC → `stripSymbols` →
  `stripLinksAndMentions` → `collapseSpaces` → проверка «нет букв» (`empty`) →
  `hasProfanity` (`profanity`, `name: null`) → обрезка до 24 графем.
  Вердикты: `ok | trimmed | symbols | empty | profanity`. Если `name === original`
  после чистки, вердикт `ok`, иначе `symbols` — **это правило остаётся**: вырезание
  правилом даёт `symbols`, нового вердикта не заводим.
- `display-name-words.ts`: `hasProfanity(name)` — встроенный словарь.
- `account.repository.ts`: `storedNameFor(raw, username, accountId)` (стр. 29) —
  обёртка над `displayNameFor` плюс обрезка до `DISPLAY_NAME_MAX = 128`; её
  зовёт `upsert` (стр. ~125-164) **два раза**: в ветке `create` и после upsert
  для найденного аккаунта (`cleanName`, стр. ~151); и CLI. Конструктор
  `PrismaAccountRepository(prisma)` вызывают руками пятнадцать тестов
  (`new PrismaAccountRepository(prisma)`) — сигнатуру сохраняем.
- `backend/api/src/cli/display-names-clean.ts`: `planCleanup(rows)` и
  `cleanAll(prisma, args, hooks)` — обе зовут `storedNameFor`. `CleanHooks` сейчас
  с одним `afterRead`.
- Образец кэша с рассылкой по Redis: `backend/api/src/modules/settings/settings.service.ts`
  (`SETTINGS_CHANNEL = "settings:changed"`, `REFRESH_MS = 60_000`,
  `DB_TIMEOUT_MS = 3_000`, `REDIS_TIMEOUT_MS = 2_000`, метод `subscribe()` на
  `redis.duplicate()`, предупреждение о битом значении один раз — `warned`).
- Образец CRUD с аудитом: `modules/ads/ads-catalog.service.ts`
  (`roles.require(actor, "ads.edit")`, `roles.audit({ actorAccountId, action,
  target, before, after })`), контроллер `modules/admin/admin-ads.controller.ts`
  (`@UseGuards(AdminSessionGuard, PermissionGuard)`, `@RequirePermission`,
  `parse(...)` из `admin-parse.ts`, лимит `ADMIN_LIMITS.mutate`).
- Права: `modules/roles/permissions.ts` — массив `PERMISSIONS` и роли `owner`
  (все), `admin` (стр. ~139), `moderator` (одна строка:
  `["players.view", "players.ban", "players.restrict", "players.message"]`).
- `RolesModule` — `@Global()`, импортирует `AuthModule`, поэтому **`AuthModule`
  не может импортировать модуль, который импортирует `RolesModule`** (цикл). Отсюда
  деление модуля правил на «ядро» и «админскую часть» ниже.

## Шаги по порядку

### 1. Схема и миграция

1. `backend/api/prisma/schema.prisma` — блок в конце файла с комментарием-заголовком:

   ```prisma
   enum NameRuleCategory { profanity brand ads other allow }
   enum NameRuleKind { exact word regex }

   /// Правило фильтра имён (Р168, T-0338): что убирается из ников игроков.
   model NameRule {
     ruleId    String           @id @map("rule_id") @db.Uuid
     category  NameRuleCategory
     kind      NameRuleKind
     pattern   String           @db.VarChar(100)
     active    Boolean          @default(true)
     note      String?          @db.VarChar(200)
     createdAt DateTime         @map("created_at") @db.Timestamptz(3)
     updatedAt DateTime         @map("updated_at") @db.Timestamptz(3)
     /// кто менял последним; без внешнего ключа — запись переживает аккаунт
     updatedBy String?          @map("updated_by") @db.Uuid

     @@unique([category, kind, pattern])
     @@index([active])
     @@map("name_rule")
   }
   ```
2. Миграция — **один раз**: `pnpm --filter backend-api exec prisma migrate dev
   --create-only --name name_rule` на отдельной тестовой базе после
   перебазирования на свежий `dev`; проверь `ls backend/api/prisma/migrations | tail`
   — папка одна. Миграция только добавляет (expand), существующих данных не трогает.
3. `modules/wipe/wipe-plan.ts` — строка `NameRule: keep("правила фильтра имён")`;
   `test/wipe-plan.test.ts` — счётчик «остаётся N модель» **+1** (число возьми
   из файла на момент работы: на 27.10.2026 было 63 → 64).
4. `docs/21-diagrams.md` — сущность `NAME_RULE` в конец блока `erDiagram` (поля
   как в модели, комментарий «правила фильтра имён, Р168»). Отдельной связи с
   другими таблицами нет.

### 2. Чистый движок правил

Файл `backend/api/src/modules/name-rules/name-rules-limits.ts` (константы с
комментариями «почему»):

```ts
export const NAME_RULE_CATEGORIES = ["profanity", "brand", "ads", "other", "allow"] as const;
export type NameRuleCategory = (typeof NAME_RULE_CATEGORIES)[number];
export const NAME_RULE_KINDS = ["exact", "word", "regex"] as const;
export type NameRuleKind = (typeof NAME_RULE_KINDS)[number];
export const NAME_RULE_LIMITS = {
  patternMax: 100,      // знаков в правиле
  noteMax: 200,
  rulesMax: 2000,       // правил всего: потолок работы на горячем пути входа
  inputMax: 128,        // знаков ника, которые смотрят правила (= DISPLAY_NAME_MAX)
  matchesPerRule: 20,   // совпадений одного правила в одном нике
  samplesMax: 20,       // строк в окне «проверить на примерах»
  sampleMax: 256,
  unboundedMax: 3,      // «*», «+», «{n,}» в одной регулярке
  repeatMax: 10,        // верхняя граница в «{n,m}»
  quantifierMax: 6,     // квантификаторов любого вида в одной регулярке
  probeBudgetMs: 2,     // на одну «злую» строку при сохранении
  probeTotalMs: 30,     // на все «злые» строки шаблона
} as const;
```

Файл `backend/api/src/modules/name-rules/name-rules-engine.ts` — **чистые функции без Nest, базы и настроек**
(в него импортирует `auth/display-name.ts`; сам он из `auth/` ничего не
импортирует):

```ts
export interface NameRuleDef { ruleId: string; category: NameRuleCategory; kind: NameRuleKind; pattern: string }
export interface Span { start: number; end: number }          // [start, end) в знаках UTF-16 исходной строки
export interface NameRuleSet { readonly size: number; readonly signature: string }   // непрозрачный скомпилированный набор
export const EMPTY_NAME_RULES: NameRuleSet                      // size 0, signature ""
export function compileNameRules(defs: readonly NameRuleDef[], onInvalid?: (def: NameRuleDef, reason: string) => void): NameRuleSet
export interface RulesVerdict {
  /** ник после вырезания правилами `brand`/`ads`/`other` (пробелы не свёрнуты) */
  text: string;
  /** правило `profanity` сработало: ник заменяется целиком */
  profane: boolean;
  /** id правил, которые изменили результат: вырезали или заменили ник */
  hits: string[];
  /** id исключений, которые спасли строку от срабатывания (см. ниже) */
  saved: string[];
}
```

Поведение (всё дословно, исполнитель не додумывает):

- **Нормализация для `exact` и `word`:** `foldForRules(text)` — по кодовым
  точкам: `char.toLowerCase()`, если длина результата в знаках UTF-16 совпала с
  длиной исходного знака, иначе знак как есть; затем `ё` → `е`, `Ё` → `е`.
  Индексы свёрнутой строки **совпадают** с индексами исходной — по ним режем
  исходник. Правило `exact`/`word` сворачивается тем же способом при компиляции.
- **`exact`:** все непересекающиеся вхождения свёрнутого шаблона (`indexOf` по кругу).
  **`word`:** то же, но знак до и после вхождения не буква, не цифра и не `_`
  (`/[\p{L}\p{N}_]/u`); начало и конец строки — граница.
- **`regex`:** `new RegExp(pattern, "giu")` запускается на **исходной** строке
  (не свёрнутой): `ё` и `е` в регулярке — разные буквы, это написано в подсказке
  экрана (T-0339). Пустые совпадения пропускаются. На правило — не больше
  `matchesPerRule` совпадений на ник.
- Общий вход: ник обрезается до `inputMax = 128` знаков **до** применения правил
  (всё равно в итоге останется 24 графемы).
- **Порядок и сборка** `applyNameRules(set, name): RulesVerdict`:
  1. Найти охранные участки: совпадения правил `allow`.
  2. Правила вырезания (`brand`, `ads`, `other`): собрать участки, **выбросив
     те, что пересекаются с охранными**; объединить пересекающиеся; каждый
     оставшийся участок заменить одним пробелом. `hits` — id правил, чьи участки
     остались хотя бы один раз.
  3. Правила `profanity`: на тексте **после вырезания**; совпадение, пересекающееся
     с охранным участком, не считается. Хотя бы одно оставшееся — `profane: true`,
     его id в `hits`.
  4. `saved` — id `allow`-правил, чей охранный участок пересёкся с отброшенным
     совпадением правила вырезания или `profanity` (пункты 2–3).
  5. Правила применяются в порядке `NAME_RULE_CATEGORIES`, внутри категории — по
     `ruleId`: результат не зависит от порядка строк в базе.
- Экспортируй ещё: `protectedSpans(set, text): { spans: Span[]; ids: string[] }`
  (шаг 1) и `maskSpans(text, spans): string` (каждый участок → один пробел) —
  `display-name.ts` нужен текст с замаскированными исключениями для встроенного
  словаря; и `previewMatches(def, text): Span[]` — совпадения одного правила
  (для окна проверки).
- `compileNameRules`: каждое определение проходит `checkRegexSafety` для `regex`
  (импорт из `name-rules-safety.ts`) и `new RegExp`; плохое — `onInvalid(def,
  причина)` и **пропуск**, остальные работают. `signature` — строка из `ruleId:`
  и отсортированных по `ruleId` пар `ruleId|category|kind|pattern`, свёрнутая в
  `sha256` hex (`node:crypto`); одинаковый набор — одинаковая подпись.

### 3. Безопасность регулярки

Файл `backend/api/src/modules/name-rules/name-rules-safety.ts`:

```ts
export type SafetyResult = { ok: true } | { ok: false; reason: string };
export function checkRegexSafety(pattern: string): SafetyResult
export function probeRegex(pattern: string, now?: () => number): SafetyResult   // now = performance.now
```

`checkRegexSafety` — один проход-сканер по шаблону (классы `[...]` пропускаются
целиком, экранирование `\x` — пара знаков; квантификаторы внутри класса
буквальные). Отказ с русской причиной (тексты — константы в файле):

| Условие | Причина |
|---|---|
| пусто или длиннее `patternMax` | «Регулярка — от 1 до 100 знаков» |
| `new RegExp(pattern, "iu")` бросает | «Регулярка не разбирается» |
| обратная ссылка: `\1`–`\9`, `\k<` | «Обратные ссылки не разрешены» |
| заглядывание: `(?=`, `(?!`, `(?<=`, `(?<!` | «Заглядывание вперёд и назад не разрешено» |
| группа, внутри которой есть квантификатор (`*`, `+`, `{`) **или** альтернатива `\|`, сразу за `)` которой стоит `*`, `+` или `{` | «Повтор группы с повтором или выбором внутри не разрешён» (`(a+)+`, `(a\|aa)*`, `(.*)*`) |
| неограниченных квантификаторов (`*`, `+`, `{n,}`) больше `unboundedMax` | «Не больше трёх повторов без предела» |
| `{n,m}` с `m` больше `repeatMax` или `{n}` с `n` больше `repeatMax` | «Предел повтора — не больше 10» |
| `new RegExp(pattern, "iu").test("")` истинно | «Регулярка совпадает с пустой строкой» |

Группа с `?` после неё (`(?:a\|b)?`) разрешена. Именованные группы `(?<name>…)`
— не заглядывание и разрешены. Флаги из шаблона не берутся (их нет).

`probeRegex` — прогон на «злых» строках: `"a".repeat(256) + "!"`,
`"ab".repeat(128)`, `" ".repeat(256) + "x"`, `"х".repeat(256) + "-"`,
`"1".repeat(255) + "я"`; для каждой замер `now()` до и после `RegExp.test`;
дольше `probeBudgetMs` — отказ «Регулярка слишком медленная на длинных строках».
Часы передаются параметром, чтобы тест не зависел от скорости машины.

**Поправка claude-lead-1 (28.10.2026).** Сканер и прогон выше пропускали шаблоны
с катастрофическим перебором; правила ниже заменяют прежние в тех местах, где
им противоречат.

- `?` внутри группы считается квантификатором для правила «повтор группы с
  повтором или выбором внутри»: `(?:жж?)+` — отказ. `?` сразу после `)` правило
  группы не включает: необязательная группа не повторяется, `(?:a|b)?`
  остаётся разрешённым. Ленивый суффикс `?` за квантификатором (`*?`, `+?`,
  `}?`) — часть того же квантификатора, не новый.
- Новый предел `quantifierMax = 6`: квантификаторов любого вида (`?`, `*`, `+`,
  `{…}`) в шаблоне — не больше шести; текст отказа «Не больше шести повторов в
  шаблоне».
- `repeatMax` 20 → 10, текст «Предел повтора — не больше 10». `unboundedMax`
  остаётся 3.
- `inputMax` 512 → 128 (= `DISPLAY_NAME_MAX`): правила смотрят только то, что
  игрок увидит.
- `probeRegex` строит строки и из знаков самого шаблона. Представители — **все
  знаки шаблона**: литералы, все члены каждого класса и **обе границы каждого
  диапазона** (пересечение двух диапазонов всегда содержит границу одного из
  них), плюс запасные: `а`, `a`, `1`, пробел и знак, которого в шаблоне нет
  (для `.`, `\w`, `\d`, `\s` и отрицательных классов). Каждый представитель —
  своей строкой: повтор до длины и завершающий знак, которого в шаблоне нет;
  плюс все представители по кругу. Длины и бюджеты — прежние (16, 32, 64,
  `inputMax`; 2 мс на строку, 30 мс на шаблон). Прежние фиксированные строки —
  обрезанные до `inputMax`. Бюджет — 2 мс на строку (при превышении —
  повторный замер, как сейчас), 30 мс на шаблон в целом; превышение — отказ
  «Шаблон слишком медленный на длинных никах», более длинные строки после
  отказа не гонять. `probeBudgetMs` = 2, новый `probeTotalMs` = 30. Уточнено
  28.10.2026 по повторному ревью.

### 4. Хранилище, ядро и кэш

Каталог `backend/api/src/modules/name-rules/`:

- `name-rules.repository.ts` — интерфейс `NameRulesRepository` и `PrismaNameRulesRepository`
  (токен `NAME_RULES_REPOSITORY`): `list(): Promise<StoredNameRule[]>` (все,
  по `createdAt`), `listActive()`, `findByKey(category, kind, pattern)`,
  `count()`, `insert(row)`, `update(ruleId, patch, at, by)` (возвращает строку
  или `null`), `remove(ruleId)` (возвращает `true`/`false`). `StoredNameRule` —
  как модель, даты `Date`. Запрос — только здесь.
  Дополнительно **функция без Nest** для CLI:
  `loadNameRuleSet(prisma: PrismaClient, onInvalid?): Promise<NameRuleSet>` —
  читает активные правила и компилирует их.
- `name-rules-cache.service.ts` — `NameRulesCache` (`@Injectable`, `OnModuleInit`,
  `OnModuleDestroy`), реализует порт:

  ```ts
  export const NAME_RULES = Symbol("NAME_RULES");
  export interface NameRulesSource { current(): NameRuleSet }
  ```

  Устройство — как `settings.service.ts`: `onModuleInit` — при `databaseUrl === ""`
  выходит; иначе `refresh()`, `setInterval(refresh, 60_000)` с `unref()`,
  подписка `redis.duplicate()` на канал **`name-rules:changed`** (константа
  `NAME_RULES_CHANNEL`), по сообщению — `refresh()`. `refresh()`: чтение
  `listActive()` под `withTimeout(…, 3_000, "правила имён")`; **если подпись
  набора не изменилась — старый объект остаётся тем же** (не пересобираем
  регулярки); при ошибке базы остаётся последний набор и в лог уходит
  `warn name_rules_refresh_failed` (не чаще раза в минуту). Битое правило:
  `warn name_rule_invalid` с `ruleId` и причиной — **один раз на `ruleId`**
  (`Set`), без шаблона в логе. `current()` синхронный; до первого чтения —
  `EMPTY_NAME_RULES`. Метод `publishChanged(ruleId)`: `redis.publish` под
  таймаутом 2 с, сбой публикации — `warn`, запись при этом **не** падает
  (реплики подхватят за минуту).
- `name-rules-core.module.ts` — `NameRulesCoreModule`: `providers: [NameRulesCache,
  { provide: NAME_RULES, useExisting: NameRulesCache }, { provide:
  NAME_RULES_REPOSITORY, useClass: PrismaNameRulesRepository }]`, **`exports:
  [NAME_RULES, NameRulesCache, NAME_RULES_REPOSITORY]`** — без экспорта
  необязательная зависимость в `PrismaAccountRepository` молча пуста везде,
  кроме этого модуля, и тест этого не заметит (приёмка #249). Модуль **не**
  импортирует `RolesModule` и `AuthModule`.

### 5. Подключение к чистке

`modules/auth/display-name.ts`:

- `clean(raw, limit, rules = EMPTY_NAME_RULES)` — после `stripLinksAndMentions`
  и `collapseSpaces` (то есть там, где сейчас вычисляется `name`), **до проверки
  «нет букв»**:
  1. `verdict = applyNameRules(rules, name)`; `name = collapseSpaces(verdict.text)`;
  2. «нет букв и цифр» → `empty` (как сейчас);
  3. **встроенный мат первым:** `hasProfanity(maskSpans(name, protectedSpans(rules,
     name).spans))` — исключения маскируются, чтобы дать пройти слову, которое
     словарь считает матом; затем `verdict.profane`. Любой из двух — `profanity`,
     `name: null`;
  4. дальше без изменений (обрезка, `ok`/`symbols`/`trimmed`).
  Если набор пуст, результат **побитово** тот же, что у прежней версии.
- Новый экспорт:

  ```ts
  export interface NameCleanDetail { name: string | null; verdict: NameVerdict; hits: string[]; saved: string[] }
  export function cleanNameDetailed(raw: string, rules?: NameRuleSet): NameCleanDetail
  ```
  `cleanName(raw, rules?)` и `displayNameFor(raw, username, accountId, rules?)`
  получают необязательный последний параметр и возвращают прежние формы
  (`{ name, verdict }`), **без** `hits`. Для `displayNameFor` запасной ход (чистый
  username площадки) чистится **теми же правилами**.
- Добавь `displayNameDetailed(raw, username, accountId, rules?)` → `CleanName &
  { hits: string[]; saved: string[] }` (тот же код, что у `displayNameFor`;
  `displayNameFor` — тонкая обёртка над ним). Эти `hits` — правила, сработавшие
  на **исходном нике** (на username — не включаются).

`modules/auth/account.repository.ts`:

- `storedNameFor(raw, username, accountId, rules?)` — как раньше, с необязательным
  параметром; новая `storedNameDetailed(…)` отдаёт ещё `hits` и `saved`. Одна
  функция на вход и CLI, как и было.
- `PrismaAccountRepository`: конструктор
  `constructor(@Inject(PRISMA) prisma, @Optional() @Inject(NAME_RULES) private readonly rules?: NameRulesSource)`.
  В `upsert` набор берётся **один раз**: `const rules = this.rules?.current()`
  и передаётся в оба вызова `storedNameFor`.
- `auth.module.ts` (shared): `imports: [OnlineCoreModule, NameRulesCoreModule]`.

`cli/display-names-clean.ts`:

- `planCleanup(rows, rules?)`, `cleanAll(prisma, args, hooks, rules?)`: набор
  передаётся в `storedNameFor`. Если `rules` не передан, `main()` строит его сам:
  `loadNameRuleSet(prisma, (def, reason) => console.warn(...))`. В итоговую строку
  лога добавь `rules: <size>` — сколько правил применялось.
- `CleanHooks` получает два необязательных поля: `onPage?: (progress: CleanResult)
  => Promise<void>` — после каждой обработанной пачки с нарастающими
  итогами; `shouldStop?: () => Promise<boolean>` — спрашивается перед каждой
  пачкой, `true` — выйти из цикла с тем, что набрано. Они нужны задаче T-0339
  (перечистка из панели), в CLI не используются.

### 6. Сервис, права и ручки панели

- `permissions.ts` (shared): `"names.edit"` в `PERMISSIONS` своим блоком с
  комментарием («Правила фильтра имён (Р168): слова и регулярки, которые
  убираются из ников игроков — поэтому не «настройки»»); в ролях `admin` и
  `moderator`. `owner` получает все права сам. В `test/roles.test.ts` — кейсы ниже.
- `name-rules.service.ts` — `NameRulesService` (`@Injectable`): зависимости —
  `NAME_RULES_REPOSITORY`, `NameRulesCache`, `RolesService`. Методы (все начинаются
  с `await this.roles.require(actor, "names.edit")`):
  - `view(actor): Promise<NameRulesView>` — `{ rules: NameRuleView[], limits }`;
    `NameRuleView` = `{ ruleId, category, kind, pattern, active, note, updatedAt
    (ISO), updatedBy }`; `limits` = `{ patternMax, noteMax, rulesMax, samplesMax,
    sampleMax }`.
  - `create(actor, input): Promise<NameRuleView>` — проверки в таком порядке:
    категория и вид из набора; `pattern` — после `trim()`, длина 1…100;
    `regex` → `checkRegexSafety`, затем `probeRegex`; число правил меньше
    `rulesMax` (иначе 409 «Правил уже 2000 — удалите лишние»); нет дубля по
    `(category, kind, foldForRules(pattern))` среди всех правил (иначе 409 «Такое
    правило уже есть»; для `regex` — сравнение буквальное). Вставка (`ruleId =
    crypto.randomUUID()`), `roles.audit({ action: "names.rule.create", target:
    ruleId, after: view })`, `cache.publishChanged(ruleId)`, лог
    `{ module: "name-rules", event: "name_rule_created", ruleId, actor }` — **без
    шаблона** в логе.
  - `update(actor, ruleId, patch)` — те же проверки на итоговое правило,
    `NameRuleNotFoundError` если нет; audit `names.rule.update` с `before` и
    `after`; публикация.
  - `remove(actor, ruleId)` — audit `names.rule.delete` с `before`; публикация.
  - `probe(actor, input): Promise<ProbeResult[]>` — **без записи и без аудита**:
    кандидат `{ ruleId?, category, kind, pattern }` (при `ruleId` он заменяет
    существующее правило в наборе, иначе добавляется как временное с
    `ruleId = "candidate"`); те же проверки безопасности, что у `create`;
    `samples` — от 1 до 20 строк по 256 знаков. Набор = все активные правила
    из базы + кандидат (`compileNameRules`). Для каждого образца возвращается
    `{ sample, name: string | null, verdict, candidateHit: boolean, saved: boolean }`,
    где `name`/`verdict` — результат `cleanNameDetailed(sample, набор)`, а
    `candidateHit` — есть ли `candidate` (или `ruleId`) в `hits`, `saved` — в
    `saved`.
  - Ошибки — доменные (`common/domain-error.ts`): `NameRuleInvalidError`
    (400, `name_rule_invalid`, сообщение — русская причина), `NameRuleNotFoundError`
    (404), `NameRuleConflictError` (409). Файл `name-rules-errors.ts`.
- `name-rules.module.ts` — `NameRulesModule`: `imports: [NameRulesCoreModule]`,
  `providers: [NameRulesService]`, `exports: [NameRulesService]`. `RolesService`
  берётся из глобального `RolesModule`.
- `modules/admin/admin-name-rules.controller.ts` — `@Controller("admin/name-rules")`,
  `@UseGuards(AdminSessionGuard, PermissionGuard)`, на каждой ручке
  `@RequirePermission("names.edit")`:

  | Метод и путь | Тело | Ответ |
  |---|---|---|
  | `GET /` | — | `{ data: NameRulesView }` |
  | `POST /` | `{ category, kind, pattern, active?: boolean, note?: string \| null }` | `{ data: NameRuleView }` |
  | `PATCH /:ruleId` | любое подмножество тех же полей, хотя бы одно | `{ data: NameRuleView }` |
  | `DELETE /:ruleId` | — | `{ data: { removed: true } }` |
  | `POST /test` | `{ ruleId?: uuid, category, kind, pattern, samples: string[] }` | `{ data: { results: ProbeResult[] } }` |

  Тела — Zod-схемы (`z.strictObject`), `parse(...)` из `admin-parse.ts`, русские
  сообщения («Некорректное правило»). Изменяющие ручки и `POST /test`
  — через `limiter.consume(ADMIN_LIMITS.mutate, actor.accountId)`, как
  `AdminAdsController.mutating`. `ruleId` в пути — `z.string().uuid()`.
- `admin.module.ts` (shared): `NameRulesModule` в `imports`, контроллер в
  `controllers`. Проверь `test/route-permissions.test.ts`: он требует
  `@RequirePermission` на каждом маршруте панели.
- `apps/admin/src/api/audit.ts` (shared): подписи `"names.rule.create": "Новое
  правило фильтра имён"`, `"names.rule.update": "Правка правила фильтра имён"`,
  `"names.rule.delete": "Удаление правила фильтра имён"`; префикс `"names."` — в
  область `support` (`AUDIT_AREAS`); в `auditObject` — ветка `names`: `{ kind:
  "правило", label: short(target), route: { section: "names", id: null } }`;
  `apps/admin/test/audit.test.ts` — по строке на каждое новое (образец — строки
  `ads.*` в тесте).

### 7. Документы

- `docs/29-admin-panel.md`: в матрицу §3.3 строка «Фильтр имён | И | И | | И | | | | |»
  (колонки как у соседних строк: владелец, админ, геймдизайнер, модератор…); в
  §2 «Модули» — строка про раздел (описание — из «Зачем»; экран делает T-0339).
- `docs/30-configuration-map.md`: строка «Правила фильтра имён» — где настраивается
  (таблица `name_rule`, панель «Фильтр имён», право `names.edit`), пороги в
  `name-rules-limits.ts`.
- `docs/08-web-and-identity.md` (стр. ~69-76, про `display-name.ts` и
  `names:clean`): одним абзацем — правила из базы применяются при входе и в
  `names:clean` одной функцией `storedNameFor`.
- `docs/21-diagrams.md`: сущность из шага 1; в схему модулей (раздел про
  бэкенд-модули) — `NAME_RULES` рядом с `AUTH`, связь «читает правила (кэш,
  канал name-rules:changed)».

## Чего не трогаем

- Встроенные словари `display-name-words.ts`, `display-name-links.ts` — не
  редактировать и не переносить в базу (ни слова).
- Экран панели, перечистка из панели — **T-0339**; счётчики срабатываний —
  **T-0340**; кандидаты — **T-0341**. Поле `hits` из `cleanNameDetailed` в этой
  задаче только возвращается, нигде не пишется.
- `apps/admin/src/routes.ts`, `screens/sections.tsx`, `ui/help.ts` — это T-0339.
- Закрепление и ручная смена ника (`admin-players.*`, T-0151) — не менять.
- Вердикты `NameVerdict` — новые не заводить.
- Клиентские пакеты игры (`packages/*`) — чистка живёт на сервере.

## Тесты

Пишутся первым коммитом, до кода. Все строки-примеры нейтральные: «пример-бренд»,
«примерслово». Мат из встроенного словаря в новых тестах **не пишется** — берётся
из `test/display-name.test.ts` (секции «мат» и «мат рядом с исключением»).

`backend/api/test/name-rules-engine.test.ts` (без базы):
- `exact`, `brand`, шаблон «пример-бренд»: ник «Вася пример-бренд» → `name`
  «Вася», вердикт `symbols`, `hits` = [id правила].
- Регистр и ё: правило `exact` «Ёлка Шоп» режет «Мир ЕЛКА ШОП» → «Мир».
- `word`, «бренд»: «Бренд Вася» → «Вася»; «Брендовый» не меняется; «Вася_бренд»
  не меняется (подчёркивание — часть слова); «Вася-бренд» → «Вася-» (дефис —
  граница слова, вырезано только слово).
- `regex` `пример\d{2,4}` (категория `ads`): «Вася пример2024» → «Вася»; «пример5»
  не режется.
- Несколько правил: два `brand` режут два участка; пересекающиеся объединяются;
  результат не зависит от порядка правил во входном массиве (перемешать).
- `profanity`, `exact` «примерслово»: `displayNameFor("Вася примерслово",
  "vasya", id, set)` → `name: "vasya"`, вердикт `profanity`; без `username` →
  «Игрок NNNN».
- `allow`, `exact` «пример-бренд-два» + `brand` «пример»: «Вася пример-бренд-два»
  не меняется, `saved` = [id исключения], `hits` пусто; без `allow` — режется.
- `allow` против встроенного словаря: взять строку, которую `cleanName` без правил
  признаёт матом (из `display-name.test.ts`), добавить `allow` `exact` на неё
  целиком → вердикт больше не `profanity`, `saved` содержит правило. Для
  соседнего ника с тем же корнем вне исключения — по-прежнему `profanity`.
- Вырезано всё: ник состоит только из совпадения `brand` → `name: null`,
  вердикт `empty`; `displayNameFor` падает на username, затем на «Игрок NNNN».
- Пустой набор не меняет ничего: все строки-примеры из `display-name.test.ts`
  дают тот же результат с `EMPTY_NAME_RULES` и без параметра (параметризованный
  прогон по тем строкам, что в файле; сам файл остаётся зелёным без правок).
- `compileNameRules`: плохие определения (`(`, `a*`, `(a+)+`) пропускаются, для
  каждого вызван `onInvalid` с причиной, годные работают, `size` верный;
  `signature` одинакова при перестановке входа и меняется при смене шаблона.
- Лимиты: ник в 600 знаков с совпадением на позиции 550 — не падает, результат ≤ 24
  графем; регулярка с 30 совпадениями режет не больше 20.
- Детерминизм: одинаковый вход и набор дают одинаковый результат при повторном вызове.

`backend/api/test/name-rules-safety.test.ts`:
- Отказы (по таблице шага 3, по строке на условие): 101 знак; пусто; `(`; `(a+)+`;
  `(a|aa)*`; `(.*)*`; `(\w+\s?)+`; `\1`; `\k<n>`; `(?=a)`; `(?!a)`; `(?<=a)b`;
  `(?<!a)b`; `a*a*a*a*`; `a{30}`; `a{1,30}`; `a*`; `^$`. У каждого проверяется
  `reason`.
- Принятые: `пример\d{2,4}`; `(?:free|пример)\s*(?:vpn|впн)`; `[а-я]{3}-shop`;
  `(?<год>\d{4})`; `(?:a|b)?`; `[+*]{1,3}x` (квантификаторы внутри класса
  буквальные); `\p{L}{3,5}x`.
- `probeRegex` с поддельными часами: быстрые часы — `ok`; часы, прибавляющие
  больше 2 мс за строку, — отказ «слишком медленный».

`backend/api/test/name-rules-cache.test.ts` (поддельные репозиторий и Redis):
- до `refresh` `current()` — пустой набор; после — набор с нужным `size`.
- Подпись не изменилась — `current()` возвращает **тот же объект**.
- Битое правило пропущено, `name_rule_invalid` в логе один раз на два `refresh`.
- Ошибка репозитория — остаётся прежний набор, лог `name_rules_refresh_failed`.
- Сообщение в канале `name-rules:changed` вызывает `refresh`.
- `onModuleInit` без `databaseUrl` ничего не читает и не подписывается.

`backend/api/test/name-rules.test.ts` (поддельные репозиторий, `RolesService`, кэш):
- Каждый метод вызывает `roles.require(actor, "names.edit")`; отказ роли — ошибка
  доступа, репозиторий не тронут.
- `create`: неизвестная категория и вид, пустой и длинный шаблон, опасная
  регулярка (`(a+)+`) → `NameRuleInvalidError` с русским текстом; дубль в другом
  регистре и с `ё`/`е` → `NameRuleConflictError`; 2000-е правило → конфликт; успех:
  audit `names.rule.create` с `after`, `publishChanged` вызван, лог без шаблона.
- `update`/`remove`: `before` и `after` в аудите; несуществующий → 404.
- Сбой `publishChanged` (бросает) не роняет запись и не отменяет аудит.
- `probe`: ничего не пишет и не аудирует; кандидат `brand` режет образец
  (`candidateHit: true`); образец без совпадения — `false`; больше 20 образцов и
  образец в 257 знаков → 400; опасная регулярка → 400; при `ruleId` кандидат
  заменяет существующее правило (старый шаблон уже не режет).

`backend/api/test/name-rules.http.test.ts` — по образцу `test/ads-catalog.test.ts`
(стр. ~300-340, `app.inject`, cookie сессии, CSRF-заголовок): без сессии — 401;
сессия роли без `names.edit` (геймдизайнер) — 403; модератор — 200 на `GET`; `POST`
с опасной регуляркой — 400; полный круг создать → список → `PATCH` → `DELETE`.

`backend/api/test/roles.test.ts` (shared): `moderator`, `admin`, `owner` имеют
`names.edit`; `game_designer`, `marketer`, `accountant` — нет.

`backend/api/test/name-rules.integration.test.ts` (живые Postgres и Redis,
`docs/17-testing-strategy.md` §4.2):
- Миграция создала таблицу; уникальность `(category, kind, pattern)`.
- Две реплики кэша на одной базе и одном Redis: запись и `publishChanged` в одной
  — другая видит правило за 2 с, **не дожидаясь** минутного опроса.
- Вход: `PrismaAccountRepository` с `NAME_RULES` из кэша; правило `brand` режет
  «Вася пример-бренд» в `displayName`, а `platformName` хранит исходник целиком;
  закреплённый ник (`nameLockedAt`) правило не меняет.
- **Один результат:** для набора строк (чистые, с брендом, с `profanity`-правилом,
  с исключением) ник после входа **равен** нику после `cleanAll` с теми же
  правилами; второй `cleanAll` даёт `planned: 0`.

`backend/api/test/display-names-clean.test.ts` (дополнить): `planCleanup` и
`cleanAll` с набором правил; `onPage` вызывается после каждой пачки с растущими
`scanned`; `shouldStop`, вернувший `true` после первой пачки, останавливает
проход (вторая пачка не читается).

## Аналитика

Нет событий: чистка ников не новое действие игрока. Счётчики срабатываний по
правилам — **T-0340** (там же обоснование). Серверные логи: `name_rule_created`,
`name_rule_invalid`, `name_rules_refresh_failed` — JSON, без шаблонов правил и без
ников.

## Настройки и окружение

Нет. Лимиты — константы `name-rules-limits.ts` (в `docs/30` строкой). Новых
переменных окружения и ключей `setting-catalog.ts` нет: правила — данные в
таблице, не настройка.

## Документы

См. шаг 7: `docs/29-admin-panel.md`, `docs/30-configuration-map.md`,
`docs/08-web-and-identity.md`, `docs/21-diagrams.md` (ER и схема модулей).
`pnpm docs:check` зелёный.

## Критерии приёмки

- [x] Правила вырезания не трогают ник при пустом наборе: `display-name.test.ts`
      проходит без правок, прогон с `EMPTY_NAME_RULES` даёт то же.
- [x] Встроенный словарь и ссылки применяются до правил; `allow` ослабляет только
      правила и встроенный мат на своём участке.
- [x] Вход и `names:clean` считают ник одной функцией, интеграционный тест «один
      результат» зелёный, второй проход CLI — `planned: 0`.
- [x] Битое правило в базе не роняет вход и не мешает остальным; в лог оно идёт
      один раз на `ruleId`, без шаблона.
- [x] Регулярка проходит `checkRegexSafety` и `probeRegex` при сохранении и ещё
      раз при компиляции; ни `re2`, ни другие зависимости не добавлены.
- [x] Реплики видят правку за секунды по `name-rules:changed`, а при недоступном
      Redis — не позже минуты.
- [x] Каждая ручка под `names.edit`, изменяющие — с лимитом; аудит пишет
      `names.rule.create|update|delete` с `before`/`after`; `POST /test` ничего не
      пишет.
- [x] `AuthModule` импортирует только `NameRulesCoreModule`, цикла модулей нет;
      `NAME_RULES` экспортирован.
- [x] Миграция одна, ER и `wipe-plan` обновлены, счётчик теста вайпа сходится.
- [x] В репозитории нет ни одного нового слова из списков мата или брендов.
- [x] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(names): Правила фильтра имён в базе и чистка по ним`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРАВИЛА ФИЛЬТРА ИМЁН В БАЗЕ И ЧИСТКА ПО НИМ**

  Слова и регулярки, которые убираются из ников, теперь хранятся в базе и правятся без релиза (Р168). Вход игрока и команда names:clean применяют их одинаково; экран в панели — следующая задача.

  🛠 **Сервер**

  • Таблица name_rule: мат (заменяет ник), бренды, реклама, прочее (вырезают), исключения (не трогают); точная фраза, слово целиком, регулярка
  • Встроенный словарь остаётся и применяется первым; битое правило пропускается с записью в лог
  • Регулярки — безопасное подмножество: до 100 знаков, без вложенных повторов, обратных ссылок и заглядываний, проверка на длинных строках
  • Новое право names.edit: владелец, администратор, модератор; ручки /api/v1/admin/name-rules с журналом действий и проверкой правила на примерах без записи
  • Правки доходят до всех реплик через Redis за секунды, страховка — перечитывание раз в минуту
  ```
