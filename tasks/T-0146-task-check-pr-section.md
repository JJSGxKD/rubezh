---
id: T-0146
title: «pnpm task check» сверяет метку и заголовок из раздела «PR» с шапкой
epic: E0
priority: P3
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - scripts/tasks/task-file.mjs
  - scripts/test/tasks-file.test.ts
shared:
  - tasks/README.md
  - .claude/skills/task-spec/SKILL.md
runner: any
executor: haiku-5.5
effort: medium
release: none
design: null
batch: 2
---

# T-0146. «pnpm task check» сверяет метку и заголовок из раздела «PR» с шапкой

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0146.json)](README.md#значки-статуса)

## Зачем

В спецификациях бывает расхождение внутри одной задачи. В T-0033 и T-0035 в
шапке стоял `release: patch`, а в разделе «PR» — `minor`. Верно `minor`:
заголовок `feat` (`tasks/inbox.md`, 11.10). Исполнитель берёт метку из одного
места, `pr-check` ловит ошибку уже на открытом PR, и PR уходит на доработку.
Реестр может поймать это раньше, при `pnpm task check`.

## Решения

Решение `claude-lead-1` от 15.10.2026. Проверяются только задачи `ready` и
`in-progress`: у `draft` спецификация не дописана, а `done` и `cancelled`
историю не меняют. Три ошибки:

1. В разделе `## PR` нет строки ``- **Заголовок:** `…` `` или
   ``- **Метка:** `release: …` ``.
2. Заголовок не проходит `parsePrTitle` из `scripts/release/pr-check.mjs`. Текст
   ошибки — его собственные ошибки.
3. Метка в разделе «PR» не равна полю `release` шапки, или поле `release` ниже
   `minimumReleaseLevel(разбор, 0)` для этого заголовка. Базовая версия — `0`:
   реестр версии не знает, а `major` поле `release` не принимает.

Тексты ошибок:

- `<файл>: раздел «PR» — нет строки «Заголовок»` (или «Метка»);
- `<файл>: раздел «PR» — заголовок: <ошибка parsePrTitle>`;
- `<файл>: поле release — в шапке patch, в разделе «PR» minor`;
- `<файл>: поле release — patch ниже minor для заголовка feat(app-shell): …`.

Сверка на 15.10.2026: все задачи `ready` и `in-progress` её проходят. Правка
существующих задач не нужна.

## Как сейчас

- `scripts/tasks/task-file.mjs:267` — `validateTask(fileName, data, context)`.
  При `context` (`{ body, fileNames }`) проверяет тело, сейчас — строку значков.
- `scripts/tasks/registry.mjs:46–54` — второй проход `readTasks` зовёт
  `validateTask` с телом.
- `scripts/release/pr-check.mjs:20` — `parsePrTitle(title)`, строка 57 —
  `minimumReleaseLevel({ type, scope, breaking }, baseMajor)`. Импорт безопасен:
  `main` запускается только при прямом вызове (строка 162).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`task-file.mjs`** — `export function checkPrSection(fileName, data, body): string[]`
   по трём правилам. Раздел — от строки `## PR` до следующего `## ` или конца
   файла. Значения берутся из обратных кавычек. Вызывать из `validateTask`,
   когда задан `context` и `data.status` — `ready` или `in-progress`.
3. **`tasks/README.md`** — в абзаце о том, что проверяет `pnpm task check`,
   добавить: «метка и заголовок из раздела «PR» сходятся с полем `release`».
4. **Скилл `task-spec`**, шаг 2 «Что сломается рядом» — пункт: «новое поле в
   общем типе тянет тесты, которые сравнивают объект целиком (`toEqual`), —
   их файлы в `zones`» (вторая половина той же строки входящих).

## Чего не трогаем

- `pr-check.mjs`: только импорт двух функций.
- Остальные проверки реестра и `pnpm task fix`: он метку не правит, решает автор.

## Тесты

`scripts/test/tasks-file.test.ts`, на `checkPrSection`:

- `ready`, `release: minor`, заголовок `feat(app-shell): Добавить X`, метка
  `release: minor` → `[]`;
- то же, метка `release: patch` → ошибка «в шапке minor, в разделе «PR» patch»;
- `release: patch`, заголовок `feat(app-shell): …`, метка `patch` → ошибка
  «patch ниже minor»;
- `release: patch`, заголовок `feat(dev): …` → `[]` (область инструментов);
- `release: none`, заголовок `docs(tasks): …` → `[]`;
- заголовок `Добавить X` без типа → ошибка с текстом `parsePrTitle`;
- нет строки «Метка» → ошибка «нет строки «Метка»»;
- `draft` с расхождением → `[]`;
- `done` с расхождением → `[]`.

Плюс прогон `pnpm task check` на реестре — зелёный.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Шаги 3 и 4.

## Критерии приёмки

- [ ] Задача `ready` с меткой, не совпадающей с шапкой, валит `pnpm task check`
  с понятной ошибкой.
- [ ] Метка ниже, чем требует тип заголовка, — тоже ошибка.
- [ ] Черновики и закрытые задачи не проверяются.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `chore(dev): Реестр сверяет метку из раздела «PR»`
- **Метка:** `release: none`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕЕСТР СВЕРЯЕТ МЕТКУ РЕЛИЗА**

  `pnpm task check` ловит расхождение метки в шапке задачи и в разделе «PR» и метку ниже, чем требует тип заголовка. Ошибка всплывает при написании спецификации, а не на PR исполнителя.
  ```
