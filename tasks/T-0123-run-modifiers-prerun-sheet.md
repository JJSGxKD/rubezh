---
id: T-0123
title: Модификаторы забега: выбор в листе «Перед забегом»
epic: E10
priority: P1
status: ready
owner:
author: claude-lead2-19
size: M
depends_on: [T-0119, T-0122, T-0084, T-0094, T-0190, T-0193, T-0196]
zones:
  - packages/app-shell/src/screens/pre-run.tsx
  - packages/app-shell/src/screens/guide/guide-data.ts
  - packages/app-shell/src/screens/meta/level.tsx
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/state/meta.ts
  - packages/app-shell/src/state/runs-api.ts
  - packages/app-shell/src/state/level-unlocks.ts
  - packages/app-shell/src/state/modifier-choice.ts
  - packages/app-shell/test/**
shared:
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/i18n/ru-account.json
  - docs/27-design-system-and-app-shell.md
  - packages/app-shell/src/state/analytics.ts
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0123. Модификаторы забега: выбор в листе «Перед забегом»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0123.json)](README.md#значки-статуса) [![T-0119](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0119.json&label=T-0119)](T-0119-run-modifiers-hurry-inverse.md) [![T-0122](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0122.json&label=T-0122)](T-0122-run-modifiers-server.md) [![T-0084](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0084.json&label=T-0084)](archive/T-0084-segmented-small.md) [![T-0094](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0094.json&label=T-0094)](archive/T-0094-prerun-no-sideways-scroll.md) [![T-0190](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0190.json&label=T-0190)](T-0190-single-difficulty-shell.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md) [![T-0196](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0196.json&label=T-0196)](T-0196-player-power-pressure-wiring.md)

## Зачем

Движок (T-0119) и сервер (T-0122) уже знают про «Спешку» и «Инверсию», но игрок
их не видит. После задачи в листе «Перед забегом» под сложностью есть выбор
модификатора: что даёт, сколько награды, с какого уровня открывается. Решение
Р105, `docs/39-retention-mechanics.md` Б8.

## Решения

**Поправка `claude-lead-1` от 20.10.2026 (Р126, единая сложность).** Переключателя сложности в листе «Перед забегом» нет (T-0190): блок модификаторов стоит **под выбором оружия**; модификатор ложится поверх единой сложности (`hard`).

Исполнитель их не пересматривает.

1. **Блок стоит под переключателем сложности** — `SegmentedControl` «Без / Спешка /
   Инверсия» в той же обёртке (`NARROW_SEGMENTS`), что у сложности: после T-0084 и
   T-0094 сегменты узкие, боковой прокрутки нет. По умолчанию выбран «Без».
2. **Закрытые пункты** отключены и подписаны «с уровня N» тем же ключом, что закрытое
   оружие (`weapon.select.locked.short`); N берётся из `unlocksAt` (T-0119), не из
   копии чисел в оболочке.
3. **Блок есть только с серверным уровнем аккаунта** (подписанный снимок, `accountLevel`).
   Гость, нет сети, загрузка — блока нет совсем: награду платит сервер (T-0122), играть
   «вхолостую» незачем, а мелькающий блок хуже отсутствующего.
4. **Под переключателем** — описание выбранного (`modifier.<id>.description`, T-0119) и
   строка «Награда +25%, в рейтинг не идёт»; процент считается из
   `RUN_MODIFIER_REWARD_MUL`, а не пишется в тексте руками.
5. **Запоминание.** `meta.rememberModifier(id | null)` рядом с `rememberDifficulty`;
   выбор, ставший недоступным (уровень не вырос, но хранилище устарело; закрытый
   модификатор), сбрасывается молча на «Без». Логика выбора — чистая функция в
   `state/modifier-choice.ts`, чтобы её проверять без React.
6. **Старт.** `modifierIds` попадают в `RunStartOptions`, сообщение старта, итог и
   события `run_started`, `run_finished`, `run_abandoned` (поле `modifier`, словарь
   завёл T-0122). Продолженный забег берёт модификатор из снимка и выбора не показывает.
7. **Экран смерти.** Строка «Модификатор: Спешка» над наградой; награда с пометкой «×1,25»
   только если она пришла; без сети — без пометки, обещаний нет. Править
   `death-parts.tsx` не нужно: строка выводится из `RunResult.modifierIds`, а файл
   занят T-0078 и T-0079 — смотреть их состояние перед правкой `DeathOverlay.tsx`.
8. **Экран уровня** (`level-unlocks.ts`, «Дальше: …») умеет называть модификатор как
   открытие: вид `modifier` рядом с `weapon` и `passive`.
9. **Гайдбук:** раздел «Модификаторы» читает `RUN_MODIFIERS` сам; тест гайдбука
   падает на модификаторе без ключа имени.
10. **Звуков и анимаций новых нет**, нового переключателя настроек нет (`CLAUDE.md`,
    «Настройки не отстают от игры»): блок — обычный элемент листа.

## Как сейчас

- `pre-run.tsx:219-227` — переключатель сложности и строка описания; плитки оружия ниже
  (`:230-250`) уже показывают замок «с уровня N». **После T-0084 и T-0094 вёрстка листа
  другая — читать файл заново.**
- `state/meta.ts` — `lastDifficultyId`, `rememberDifficulty` (образец).
- `state/run.ts:76` — `RunStartOptions`; `:307,360,478,695` — где сложность уходит в
  движок, старт, диагностику и аналитику.
- `state/level-unlocks.ts` (T-0108) — `nextUnlockAfter`; `meta/level.tsx` — «Дальше: …».
- `guide-data.ts` — гайдбук собирается из контента.

## Шаги по порядку

1. Тесты — первым коммитом.
2. `state/modifier-choice.ts`: `resolveModifierChoice(saved, accountLevel)` — возвращает
   доступный выбор или `null`; `modifierRows(accountLevel)` — список пунктов с
   признаком «закрыт» и уровнем открытия.
3. `meta.ts`: хранение и `rememberModifier`.
4. `pre-run.tsx`: блок по решениям 1–4; `run.ts`: старт, итог, аналитика (`analytics.ts`).
5. `level-unlocks.ts` и `level.tsx`: вид `modifier`; гайдбук; строка на экране смерти.
6. Ключи в `ru.json`/`ru-account.json` (`modifier.title`, `modifier.none`, `modifier.reward`,
   `modifier.noRating`, `modifier.locked`, `death.modifier`); документы; гейт.

## Чего не трогаем

- Движок, контент и таблицы множителей (T-0119); сервер и вердикт (T-0122).
- Остальную вёрстку листа: её правят T-0084 и T-0094 (они идут раньше).
- Выбор сложности, оружия и бустов.

## Сценарий и интерфейс

Игрок открывает лист «Перед забегом»: сложность, ниже модификатор.

- **Загрузка:** уровень аккаунта ещё неизвестен — блока нет.
- **Пусто / не открыт:** на уровне ниже 9 оба пункта серые, «с уровня 9» и «с уровня 12»;
  нажатие ничего не меняет.
- **Выбрано:** пункт подсвечен, под ним описание и «Награда +25%, в рейтинг не идёт».
- **Ошибка / нет сети / гость:** блока нет, забег идёт без модификатора.
- **Ограничение аккаунта:** без изменений, модификатор их не обходит.
- **После забега:** строка «Модификатор: Спешка», награда с пометкой «×1,25».

Макета нет; экран строится из существующих `SegmentedControl` и токенов.

## Тесты

Первым коммитом. Новый `modifier-choice.test.ts`; правки: `pre-run` (тест листа, если
есть), `level-unlocks.test.ts`, `telemetry.test.ts`, тест гайдбука.

- `resolveModifierChoice`: сохранён `hurry` при уровне 9 — остаётся; при уровне 8 —
  `null`; неизвестный id — `null`; `null` — `null`.
- `modifierRows(8)` — оба закрыты, уровни 9 и 12; `modifierRows(12)` — оба открыты.
- Лист: без `accountLevel` блока нет; закрытый пункт не выбирается и `onSelect` не
  вызывается; выбор открытого вызывает `rememberModifier`; подпись награды берёт
  процент из `RUN_MODIFIER_REWARD_MUL`.
- `run.ts`: `modifierIds` в `RunStartOptions` и в событиях `run_started`/`run_finished`;
  продолженный забег берёт модификатор из снимка.
- `level-unlocks`: `nextUnlockAfter(8)` называет «Спешку» как открытие 9-го уровня.
- Гайдбук: раздел «Модификаторы» содержит оба; модификатор без ключа имени роняет тест.
- Экран смерти: строка модификатора есть при `modifierIds`, пометка «×1,25» только при
  пришедшей награде.

## Аналитика

Отправляется поле `modifier` из словаря T-0122 в `run_started`, `run_finished`,
`run_abandoned`; других событий нет. Через `track(...)`, без блокировки интерфейса.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md` — блок модификаторов в листе «Перед забегом»,
  правило «блок есть только с серверным уровнем».

## Вопросы к тимлиду

- Принято по умолчанию (подтверждено claude-lead-1 13.10.2026 по умолчанию): без
  серверного уровня блок не показывается; закрытые пункты видны с подписью уровня.

## Критерии приёмки

- [ ] В листе под сложностью выбор «Без / Спешка / Инверсия»; закрытые подписаны
  «с уровня 9» и «с уровня 12»; гостю и без сети блока нет.
- [ ] Выбранный модификатор уходит в движок, старт и итог; продолженный забег берёт свой.
- [ ] На экране смерти видна строка модификатора и пометка награды.
- [ ] Экран уровня и гайдбук называют модификаторы.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и
  `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Добавить выбор модификатора забега в лист`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: модификаторы забега «Спешка» (9-й уровень) и «Инверсия» (12-й) — больше риска и награда +25%; в рейтинг такие забеги не идут`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МОДИФИКАТОРЫ ЗАБЕГА В ЛИСТЕ «ПЕРЕД ЗАБЕГОМ»**

  В листе появился выбор модификатора: «Спешка» (с 9-го уровня) и «Инверсия» (с 12-го). Награда +25%, в рейтинг такие забеги не идут.

  🛠 **Интерфейс**

  • блок виден только с серверным уровнем аккаунта; закрытые пункты подписаны уровнем
  • на экране смерти видно, с каким модификатором шёл забег
  • в гайдбуке и на экране уровня модификаторы названы
  ```
