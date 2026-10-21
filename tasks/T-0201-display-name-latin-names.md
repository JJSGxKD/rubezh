---
id: T-0201
title: Фильтр ников — латинские имена не ловятся корнем после транслитерации
epic: E4
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/auth/display-name-words.ts
  - backend/api/test/display-name.test.ts
shared: []
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 2
---

# T-0201. Фильтр ников — латинские имена не ловятся корнем после транслитерации

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0201.json)](README.md#значки-статуса)

## Зачем

Игрок с обычным вьетнамским именем «Thuy» получает отказ: «ник не подходит». Причина в свёртке латиницы в кириллицу, а не в самом имени. После задачи имена из проверенного ниже списка проходят, а ловля настоящих слов не слабеет. Источник — находка приёмки #399 (T-0153), `tasks/inbox.md` от 21.10.

## Решения

- Точность важнее полноты (комментарий в шапке `display-name-words.ts`): ложное срабатывание лечится строкой в `ALLOWED_WORDS` (слово целиком) или `ALLOWED` (подстрока) с тестом, а не ослаблением корня.
- Корни в `ANYWHERE`, `WORD_START` и все регрессионные кейсы T-0153 в `display-name.test.ts` остаются без изменений.
- Формулировки в коде и тестах нейтральные; новых списков слов нет, кроме имён, которые должны проходить.

## Как сейчас

- `backend/api/src/modules/auth/display-name-words.ts`: `foldTranslitY` превращает конечное `y` в «й», а `yu` в конце в «уй»; затем `h` → «х». «Thuy» даёт «тхуй», и это содержит корень из `ANYWHERE`. Остальные свёртки «Thuy» не ловят.
- `hasProfanity` (конец файла) проверяет и склеенный ник, и каждое слово. Слова из `ALLOWED_WORDS` (`hue`, `huey`, `dick`, `ebi`, `suka`, `suki`) выкидываются до свёртки. Строки из `ALLOWED` вырезаются из свёртки (`foldWithoutAllowed`).
- Прогон текущей `hasProfanity` по списку латинских имён (21.10, функцией из кода, а не догадкой). **Ловятся:** Thuy, Khuy, Phuy, Huya, Huyu, Thuya, Xuyang, Mihuy, Luhuy, Hoang Thuy, Thuy Linh, Anh Thuy, Phuoc Thuy и Huy. **Не ловятся:** Duy, Tuy, Quy, Suhail, Nguyen, Huyen, Huynh, Hui, Louis, Bui, Guy, Duyen, Tuyen, Xuyen, Khuyen, Tuyet, Quyen, Thuyet, Hugh, Joshua, Oleksiy, Dmitry, Andrey, Alexey, Yuriy, Nikolay, Wei Hui.
- Из ловящихся настоящие имена: **Thuy** (частое), **Thuya**, **Xuyang** (китайское). «Huy» закреплён тестом (`display-name.test.ts`, около строки 207) как ловимый: не менять. Остальные (Khuy, Phuy, Huya, Huyu, Mihuy, Luhuy) редкие или искусственные, допускать их не надо.
- Тест допустимых имён — `it.each([...])` около строки 214 в `backend/api/test/display-name.test.ts` («Hue», «Huey», «Huyen» и т.д.).

## Шаги по порядку

1. Тест первым коммитом (раздел «Тесты»): красный на «Thuy», «Thuya», «Xuyang».
2. В `display-name-words.ts` по существующему механизму: `thuy`, `thuya`, `xuyang` в `ALLOWED_WORDS` (имя целиком, одним словом) и подстрока `thuy` в `ALLOWED` — для слитной записи «ThuyLinh» (`foldWithoutAllowed` вырезает её из свёртки). Если подстрока ломает регрессию ниже, оставить только `ALLOWED_WORDS` и написать об этом в PR. «nahuy» ловиться обязан в любом случае.
3. Перепроверить функцией весь список из «Как сейчас»: проходят Thuy, Thuya, Xuyang, «Thuy Linh», «Anh Thuy», «ThuyLinh»; ловятся по-прежнему Huy, nahuy, xuy, xyu, «huy Вася» и все кейсы T-0153.
4. Обновить комментарий у `ALLOWED_WORDS` (на русском, почему имена там).

## Чего не трогаем

- Корни `ANYWHERE`, `WORD_START`, `WORD_START_PREFIXED`, свёртки `foldTranslit*` и порядок `FOLDS`.
- `display-name.ts`, `display-name-links.ts`, смену ника в панели (T-0151).
- Другие языки и алфавиты, не вошедшие в проверенный список.

## Тесты

Первым коммитом, в `backend/api/test/display-name.test.ts`, рядом с `it.each` допустимых имён (около строки 214):

- допустимые: `Thuy`, `thuy`, `THUY`, `Thuya`, `Xuyang`, `Thuy Linh`, `Anh Thuy`, `ThuyLinh` → `hasProfanity` false (сначала красные);
- допустимые, уже зелёные, закрепить: `Duy`, `Tuy`, `Quy`, `Suhail`, `Nguyen`, `Huyen`, `Huynh`, `Hui`, `Khuyen`, `Duyen` → false;
- регрессия: все кейсы T-0153 остаются, в том числе `huy`, `Huy`, `nahuy`, `xuy`, `xyu`, `huy Вася` → true.

## Аналитика

Нет: чистая функция проверки ника.

## Настройки и окружение

Нет.

## Документы

Нет: список исключений описан только комментарием в коде.

## Критерии приёмки

- [ ] «Thuy», «Thuya», «Xuyang», «Thuy Linh» принимаются; проверено тестом.
- [ ] Все прежние тесты `display-name.test.ts` зелёные без правок ожиданий.
- [ ] В описании PR перечислено, что проверено и что ловится намеренно.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(api): Принимать латинские имена вроде Thuy в нике`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено: ник «Thuy» и похожие имена больше не отклоняются как недопустимые`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЛАТИНСКИЕ ИМЕНА В ФИЛЬТРЕ НИКОВ**

  Фильтр ников после транслитерации принимал за недопустимое вьетнамское имя Thuy. Имя и несколько похожих добавлены в исключения, ловля остальных слов не менялась.

  🛠 **Где**

  • только словарь `display-name-words.ts` и его тесты
  ```
