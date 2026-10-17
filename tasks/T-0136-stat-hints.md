---
id: T-0136
title: Подсказки к параметрам снаряжения — что значит каждый
epic: E6
priority: P2
status: in-progress
owner: claude-7 / haiku-5.5 / medium
author: claude-lead-1
size: S
depends_on: [T-0135]
zones:
  - packages/app-shell/src/design-system/components/Hint.tsx
  - packages/app-shell/src/design-system/components/index.ts
  - packages/app-shell/src/screens/meta/arsenal-item.tsx
  - packages/app-shell/src/screens/meta/arsenal.tsx
  - packages/app-shell/src/screens/gallery.tsx
  - packages/app-shell/test/stat-hints.test.ts
shared:
  - packages/app-shell/src/i18n/ru-arsenal.json
  - packages/app-shell/src/i18n/ru-gallery.json
  - docs/27-design-system-and-app-shell.md
runner: any
executor: haiku-5.5
effort: medium
release: minor
design: null
batch: 2
---

# T-0136. Подсказки к параметрам снаряжения — что значит каждый

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0136.json)](README.md#значки-статуса) [![T-0135](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0135.json&label=T-0135)](T-0135-item-upgrade-preview.md)

## Зачем

В арсенале непонятно, что значат параметры: что такое «шанс состояния», чем
«урон огнём» отличается от «урона», что даёт броня (`tasks/inbox.md`, 05.10).
Игрок не может выбрать предмет, если не понимает, что тот даёт.

## Решения

- **Общий компонент `Hint`** в дизайн-системе. Рядом с названием кнопка «?»,
  нажатие раскрывает пояснение строкой под параметром, повторное — сворачивает.
  Подсказка при наведении на телефоне не работает, всплывающее окно поверх
  листа лишнее.
- **Где:** лист предмета (`arsenal-item.tsx`) и итог надетого в арсенале
  (`arsenal.tsx:469`).
- **Тексты — дословно ниже**, ключи `item.stat.<id>.hint` в `ru-arsenal.json`
  рядом с названиями. Если механика в коде расходится с текстом — вопрос в PR
  с цитатой кода. Текст не додумывать.

| Параметр | Пояснение |
|---|---|
| `damage` | Насколько сильнее бьёт всё ваше оружие |
| `cooldown` | Как часто срабатывает оружие: чем выше, тем короче пауза между атаками |
| `area` | Размер зон урона: аура, удары по площади, кольцо оберегов |
| `projectileSpeed` | Как быстро летят снаряды — раньше достают врага |
| `duration` | Сколько живут снаряды и действуют эффекты оружия |
| `moveSpeed` | Как быстро вы бегаете — легче уйти от толпы |
| `pickupRadius` | С какого расстояния к вам притягиваются кристаллы и подборы |
| `maxHp` | Запас здоровья |
| `regenPerSec` | Сколько здоровья возвращается каждую секунду |
| `armor` | Уменьшает урон от ударов врагов |
| `resistFire` | Меньше урона от огня и короче горение. Все сопротивления вместе — не больше 75% |
| `resistCold` | Меньше урона от холода и короче замедление. Все сопротивления вместе — не больше 75% |
| `resistLightning` | Меньше урона от молнии и короче шок. Все сопротивления вместе — не больше 75% |
| `resistPoison` | Меньше урона от яда и короче отравление. Все сопротивления вместе — не больше 75% |
| `damageFire` | Насколько сильнее бьёт оружие огня |
| `damageCold` | Насколько сильнее бьёт оружие холода |
| `damageLightning` | Насколько сильнее бьёт оружие молнии |
| `damagePoison` | Насколько сильнее бьёт оружие яда |
| `statusChance` | Как часто удар оружия со стихией накладывает на врага её состояние: горение, холод, шок или яд |

## Как сейчас

- Названия параметров — `item.stat.<id>` в `packages/app-shell/src/i18n/ru-arsenal.json`,
  их читает `statName` (`screens/meta/arsenal-parts.tsx:73`).
- Строка свойства в листе предмета — `screens/meta/arsenal-item.tsx:123`.
  Итог надетого — `screens/meta/arsenal.tsx:469`.
- Компоненты дизайн-системы — `design-system/components/`, общая витрина
  состояний — `screens/gallery.tsx`. Компонента подсказки нет.

## Шаги по порядку

1. **Тест первым коммитом** (раздел «Тесты»).
2. **`Hint.tsx`** — `Hint(props: { label: string; text: string; children: ReactNode })`.
   Строка: `children` (название), рядом кнопка «?» с `aria-label` «Что это:
   {label}» и `aria-expanded`. Раскрытая — текст под строкой, приглушённый,
   размер текста из токенов. Анимация — только `opacity`, без смены высоты
   анимацией. Экспорт в `components/index.ts`.
3. **`ru-arsenal.json`** — 19 ключей `item.stat.<id>.hint` по таблице «Решений».
4. **`arsenal-item.tsx` и `arsenal.tsx`** — название параметра обернуть в `Hint`,
   если ключ подсказки есть (`hasTranslation`); нет — как сейчас.
5. **Витрина** — `gallery.tsx` и подпись в `ru-gallery.json`: `Hint` свёрнутый и
   раскрытый.
6. **`docs/27`** — строка `Hint` в каталоге компонентов.

## Чего не трогаем

- Названия параметров и числа.
- Экран бустов и магазин — подсказки там отдельной задачей, если понадобятся.

## Тесты

- `packages/app-shell/test/stat-hints.test.ts`: у каждого ключа
  `item.stat.<id>` в `ru-arsenal.json` (кроме самих `….hint`) есть
  `item.stat.<id>.hint`, не пустой и не длиннее 120 знаков.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

`docs/27` — шаг 6.

## Критерии приёмки

- [ ] У каждого параметра в листе предмета и в итоге надетого есть «?»,
  нажатие раскрывает пояснение из таблицы дословно.
- [ ] Кнопка доступна диктору: `aria-label` и `aria-expanded`.
- [ ] `Hint` есть в витрине.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `feat(app-shell): Подсказки к параметрам снаряжения`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: у параметров снаряжения есть «?» — что значит каждый`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОДСКАЗКИ К ПАРАМЕТРАМ**

  В арсенале у каждого параметра есть «?»: нажал — видно, что он даёт. Общий компонент подсказки — в дизайн-системе, пригодится и на других экранах.
  ```
