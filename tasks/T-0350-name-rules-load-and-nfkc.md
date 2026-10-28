---
id: T-0350
title: Фильтр имён — потолок регулярок, прогон один раз на шаблон, медленное правило видно в логе, NFKC до правил закреплён тестом
epic: E7
priority: P2
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: [T-0338]
zones:
  - backend/api/src/modules/name-rules/name-rules-limits.ts
  - backend/api/src/modules/name-rules/name-rules-engine.ts
  - backend/api/src/modules/name-rules/name-rules.service.ts
  - backend/api/src/modules/name-rules/name-rules.repository.ts
  - backend/api/test/name-rules-engine.test.ts
  - backend/api/test/name-rules.test.ts
  - backend/api/test/name-rules.integration.test.ts
  - backend/api/test/display-names-clean.test.ts
shared:
  - backend/api/src/modules/name-rules/name-rules-cache.service.ts
  - backend/api/test/name-rules.http.test.ts
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 4
---

# T-0350. Фильтр имён — потолок регулярок, прогон один раз на шаблон, медленное правило видно в логе, NFKC до правил закреплён тестом

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0350.json)](README.md#значки-статуса) [![T-0338](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0338.json&label=T-0338)](T-0338-name-rules-server.md)

## Зачем

Находки третьего ревью #536 (T-0338, claude-review-6), не блокирующие, но
про нагрузку и про то, на чём держится безопасность:

1. **Прогон регулярки повторяется на каждой пересборке набора** на каждой
   реплике: `compileOne` (`name-rules-engine.ts:83–92`) зовёт `probeRegex`
   для каждого правила, хотя шаблон уже прогнан при сохранении. Прогон —
   сотни строк; при 2000 правилах пересборка — секунды.
2. **Регулярок может быть 2000** (`rulesMax`): вход гоняет все. Потолок на
   регулярки отдельно от точных и словесных правил ограничит худший вход.
3. **Медленное правило на настоящем нике не видно**: прогон отсекает опасные
   формы, но если какое-то правило всё же тормозит на живом нике, команда об
   этом не узнает.
4. **Безопасность прогона держится на порядке «NFKC до правил»** в `clean`
   (`auth/display-name.ts:87`): знаки вроде знака Кельвина (U+212A), которые
   по `/iu` равны латинской букве, до правил не доходят. Порядок ничем не
   закреплён: поменяй его кто-то — вернётся медленный ввод.

## Решения

Решение `claude-lead-1` от 28.10.2026 по ревью #536 (в рамках Р168):

- `regexRulesMax: 100` — регулярок среди действующих правил не больше ста;
  создание или правка в вид `regex` сверх — конфликт «Регулярок уже 100 —
  нужно удалить лишние». Общий `rulesMax` (2000) не меняется.
- Результат прогона **запоминается по тексту шаблона** в памяти процесса
  (не больше 500 записей, вытеснение старейшей): пересборка прогоняет только
  новые шаблоны. Проверка структуры (`checkRegexSafety`) — каждый раз, она
  дешёвая.
- Правило, применение которого к одному нику заняло **больше 5 мс**, — `warn`
  `name_rule_slow` с `ruleId` и временем, **один раз на правило за жизнь
  процесса**. Шаблон и ник в лог не идут. Правило не пропускается.
- Тест закрепляет: правило видит ник **после** NFKC.

## Как сейчас

- `backend/api/src/modules/name-rules/name-rules-limits.ts:14–30` —
  `NAME_RULE_LIMITS` (`rulesMax: 2000`, `inputMax: 128`, `unboundedMax`,
  `repeatMax`).
- `name-rules-engine.ts:83–96` — `compileOne`: `checkRegexSafety`, затем
  `probeRegex` на каждой компиляции; `compileNameRules` — строка 102;
  применение — `applyNameRules`.
- `name-rules.service.ts:96–110` — лимиты в ответе панели, проверка
  `count() >= rulesMax` перед созданием; прогон при сохранении — строка ~197.
- `name-rules.repository.ts` — `count()`, `listActive()`.
- `auth/display-name.ts:83–95` — `clean`: NFC → NFKC → чистка знаков и
  ссылок → `applyNameRules`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»), красные.
2. `name-rules-limits.ts` — `regexRulesMax: 100`, `slowRuleMs: 5`,
   `probeCacheMax: 500`, у каждого — комментарий «почему».
3. Репозиторий — `countRegex(): Promise<number>` (действующие правила вида
   `regex`); память в тестах — то же.
4. Сервис: при создании правила вида `regex` и при правке вида в `regex` —
   проверка `countRegex() >= regexRulesMax` → `NameRuleConflictError` с
   текстом из «Решений». Лимит — в ответе панели рядом с прочими.
5. Движок: кеш результатов `probeRegex` по тексту шаблона (Map с
   вытеснением старейшей сверх `probeCacheMax`); `compileOne` берёт из кеша.
6. Движок: в `applyNameRules` мерить применение каждой регулярки
   (`performance.now()`); больше `slowRuleMs` — колбэк `onSlow(ruleId, ms)`,
   который сервис/кеш превращает в `warn name_rule_slow` один раз на
   `ruleId` (множество уже предупреждённых — как `warned` в кеше).
   Если колбэк не передан — ничего.
7. Документы (раздел «Документы»).

## Чего не трогаем

- Правила безопасности шаблонов и прогон (`name-rules-safety.ts`,
  `name-rules-probe-inputs.ts`) — их приняли в #536.
- Порядок шагов в `clean` — только закрепляем тестом.
- `rulesMax`, точные и словесные правила.

## Тесты

- `name-rules.test.ts`: сотая регулярка создаётся, сто первая — конфликт с
  текстом из «Решений»; правка точного правила в `regex` сверх потолка —
  конфликт; правка регулярки без смены вида — проходит.
- `name-rules-engine.test.ts`: две компиляции одного набора прогоняют шаблон
  один раз (подставной счётчик вызовов прогона); 501-й шаблон вытесняет
  первый; медленное применение (подставные часы) зовёт `onSlow` с `ruleId`,
  быстрое — нет.
- `display-names-clean.test.ts`: точное правило `kot` срабатывает на нике,
  где первая буква — знак Кельвина (U+212A): правила видят ник после NFKC.
- `name-rules.integration.test.ts`: `countRegex` на живой базе считает только
  действующие правила вида `regex`.

## Аналитика

Новых событий нет; лог `name_rule_slow` — уровень `warn`, только `ruleId` и
время, один раз на правило.

## Настройки и окружение

Нет: пределы — константы `NAME_RULE_LIMITS`.

## Документы

- `docs/29-admin-panel.md` — в описание фильтра имён: «регулярок — не больше
  ста».
- `docs/30-configuration-map.md` — новые пределы в строке `NAME_RULE_LIMITS`.

## Критерии приёмки

- [ ] Сто первая регулярка не создаётся, точные и словесные — до 2000, как раньше.
- [ ] Пересборка набора не прогоняет уже прогнанные шаблоны.
- [ ] Медленное правило видно в логе один раз, вход его не пропускает.
- [ ] Тест закрепляет NFKC до правил.

## PR

- **Заголовок:** `perf(names): Потолок регулярок и прогон один раз на шаблон`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  ⚙️ **СВОДКА: В DEV ВЛИТ PR #<номер> — ФИЛЬТР ИМЁН ЛЕГЧЕ НА НАГРУЗКЕ**

  Регулярок в фильтре имён — не больше ста (остальных правил по-прежнему до 2000). Пересборка набора на репликах не прогоняет заново уже проверенные шаблоны. Если правило всё же тормозит на настоящем нике, в логе появится `name_rule_slow` с его id.
  ```
