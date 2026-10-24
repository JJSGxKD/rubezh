---
id: T-0096
title: Убрать тень под врагами
epic: E12
priority: P1
status: done
owner: claude-7 / haiku-5.5 / medium
author: claude-lead2-13
size: S
depends_on: []
zones:
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/test/enemy-shadow.test.ts
shared:
  - docs/27-design-system-and-app-shell.md
  - design/README.md
runner: any
executor: haiku-5.5
effort: medium
release: patch
design: null
batch: 1
---

# T-0096. Убрать тень под врагами

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0096.json)](../README.md#значки-статуса)

## Зачем

На живом тесте тень под врагами в нынешнем виде смотрится плохо. После задачи у
врагов в бою нет тёмного эллипса под телом; размер, положение и хитбокс врагов
те же.

## Решения

- **Решение участника 1 от 13.10.2026 (тест):** нынешнюю тень у врагов убрать.
  Вернуть в другом виде — потом, вместе с дизайнером. Это отдельная работа, её
  тимлид заведёт записью во входящих; здесь её нет.
- **Убираем только у врагов.** Тень героя, кристаллов опыта и подборов остаётся:
  замечание про врагов. Если про героя скажут то же, это отдельная правка.
- **Только рендер.** Симуляция, баланс и golden-тесты не меняются; запрет
  тригонометрии из `CLAUDE.md` на рендер не распространяется, но здесь она и не
  нужна.
- **Настройки не добавляем:** это не анимация и не эффект, а статичная часть
  текстуры. Умолчания не пересматриваются.

## Как сейчас

- `packages/core-game/src/game/render/WorldRenderer.ts:109-124` — текстуры
  врагов делаются по паре «тип и ступень»:

  ```ts
  world.enemyTypes.forEach((type, index) => {
    const rim = enemyRim(rankOf(type));
    for (let stage = 0; stage < this.stageCount; stage++) {
      const key = `bh-enemy-${type.id}-s${String(stage)}`;
      // Тень запечена в текстуру: отдельный спрайт на тень удвоил бы число
      // объектов. Тело рисуется прежним радиусом, поэтому размер врага на
      // экране и хитбокс не меняются.
      ensureShapeTexture(scene, key, type.radius, stageColor(colorByType[index], stage), ENEMY_LOOKS[type.pattern].shape, {
        core: stageCore(stage),
        shadow: true,
        rim: rim === null ? null : { color: rim.color, width: rim.width * unitScale },
      });
      this.textureKeyByType.push(key);
    }
  });
  ```

- `packages/core-game/src/game/render/textures.ts:27-55` — `ensureShapeTexture`
  с `shadow: true` рисует эллипс тени (`SHADOW_ALPHA = 0.35`) и берёт размер
  текстуры из `shadowLayout` (`shadow-layout.ts`) с полем вокруг тела. Без
  `shadow` текстура ровно `ceil(radius * 2)`, тело в углу `(0, 0)` без сдвига:
  так уже сделаны снаряды (`WorldRenderer.ts:135-138`). Спрайт врага привязан по
  центру, а в обоих видах тело стоит в центре текстуры, поэтому на экране оно
  не двигается. Кайма (`rim`) идёт внутрь от границы тела (`shapes.ts:46-49`) и
  в текстуру без поля помещается.
- Тень с `shadow: true` ещё у героя (`WorldRenderer.ts:134`) и у кристаллов и
  подборов (`pickups.ts:40` и `:43`). Их не трогаем.
- `combat-feedback.ts:214` — `setShadow` у цифр урона: это тень текста, не
  тело врага. Не трогаем.
- `design/README.md:62` и `docs/27-design-system-and-app-shell.md:823` пишут,
  что тень есть «у всех сущностей» и «у героя, врагов, кристаллов и подборов».

## Шаги по порядку

1. **Тест первым коммитом** (раздел «Тесты»): создать
   `packages/core-game/test/enemy-shadow.test.ts`. Он падает, пока в блоке
   врагов есть `shadow: true`.
2. **`WorldRenderer.ts`, строки 114-121:** убрать `shadow: true`, комментарий
   заменить. Получится:

   ```ts
   // Тени под врагом нет: на живом тесте запечённая тень смотрелась плохо.
   // Текстура ровно по размеру тела, тело в её центре, как у снарядов, поэтому
   // размер врага на экране и хитбокс прежние.
   ensureShapeTexture(scene, key, type.radius, stageColor(colorByType[index], stage), ENEMY_LOOKS[type.pattern].shape, {
     core: stageCore(stage),
     rim: rim === null ? null : { color: rim.color, width: rim.width * unitScale },
   });
   ```

   Слово `shadow` в этом блоке, в том числе в комментарии, не писать: тест
   ищет его в блоке врагов.
3. **`docs/27-design-system-and-app-shell.md`, около строки 823** (искать
   «мягкая тень, запечённая в»): фраза «у героя, врагов, кристаллов и подборов
   мягкая тень, запечённая в текстуру.» (в файле она переносится на новую
   строку) заменяется на «у героя, кристаллов и подборов мягкая тень,
   запечённая в текстуру; у врагов тени нет — на живом тесте она смотрелась
   плохо (решение участника 1 от 13.10.2026).»
4. **`design/README.md`, строка 62 таблицы «Вид боя»** заменить на:

   ```
   | Тень | Мягкая тень снизу у героя, кристаллов и подборов: «ставит» фигуру на землю. У врагов тени нет — на живом тесте она смотрелась плохо; вернуть её в другом виде — отдельная работа с дизайнером |
   ```

   Найти поиском по «Тень» и остальные упоминания тени «у всех сущностей» в этом
   файле; если они есть, поправить тем же смыслом. Других правок в файле нет.

## Чего не трогаем

- `textures.ts`, `shadow-layout.ts`, `test/shadow-layout.test.ts`: опция
  `shadow` и раскладка нужны герою и подборам.
- `pickups.ts`, строка героя в `WorldRenderer.ts:134`: их тень остаётся.
- `combat-feedback.ts` (тень цифр урона), `looks.ts`, цвета врагов и ступеней.
- Всё в `game/sim/*`, `patterns/*`, `content/*`: симуляция не меняется, golden
  баланса остаются прежними.
- Новую форму тени: её рисует дизайнер позже, отдельной задачей.

## Тесты

Первым коммитом. Новый файл `packages/core-game/test/enemy-shadow.test.ts`:
тест читает исходники рендера как текст, как `sim-purity.test.ts`, потому что
Phaser в тестовой среде (`node`) не поднимается.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Тень врагов убрана на живом тесте (решение участника 1 от 13.10.2026);
// у героя, кристаллов и подборов она остаётся. Рендер без Phaser не создать,
// поэтому проверка идёт по исходнику.
const source = (name: string): string => readFileSync(new URL(`../src/game/render/${name}`, import.meta.url), "utf8");

/** Кусок исходника между двумя метками. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`В исходнике нет меток «${from}» и «${to}»`);
  return text.slice(start, end);
}

describe("тень в текстурах рендера", () => {
  const renderer = source("WorldRenderer.ts");

  it("у врагов тени нет", () => {
    const enemies = between(renderer, "world.enemyTypes.forEach", "this.textureKeyByType.push(key)");
    expect(enemies).toContain("ensureShapeTexture(");
    expect(enemies).not.toMatch(/shadow/i);
  });

  it("у героя тень осталась", () => {
    expect(between(renderer, 'ensureShapeTexture(scene, "bh-player"', "\n")).toMatch(/shadow:\s*true/);
  });

  it("у кристаллов и подборов тень осталась", () => {
    expect(source("pickups.ts")).toMatch(/shadow:\s*true/);
  });
});
```

- блок врагов содержит вызов `ensureShapeTexture(` и не содержит слова
  `shadow` → первый кейс;
- строка героя содержит `shadow: true` → второй;
- в `pickups.ts` есть `shadow: true` → третий.

## Аналитика

Нет: меняется только вид врагов.

## Настройки и окружение

Нет (см. «Решения»).

## Документы

- `docs/27-design-system-and-app-shell.md` — фраза про тень в разделе вида боя
  (шаг 3).
- `design/README.md` — строка «Тень» (шаг 4).

## Вопросы к тимлиду

- **Входящие:** запись «вернуть тень врагам в другом виде, вместе с
  дизайнером» заводит тимлид в `tasks/inbox.md`. Исполнитель её не заводит и
  ответа не ждёт.
- �Подтверждено `claude-lead-1` 13.10.2026: тень героя, кристаллов и подборов остаётся
  как есть. Если на тесте скажут про героя — правка одной строки
  `WorldRenderer.ts:134`.

## Критерии приёмки

- [ ] В блоке врагов `WorldRenderer.ts` нет `shadow`; тест из раздела «Тесты»
  зелёный.
- [ ] В забеге у врагов нет тёмного эллипса под телом; размер, положение и
  каймы врагов те же. У героя, кристаллов и подборов тень на месте.
- [ ] Дифф только в зонах задачи и двух документах из «Документы».
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(core-game): Убрать тень под врагами`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- исправлено: под врагами в бою больше нет тени`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НЕТ ТЕНИ ПОД ВРАГАМИ**

  Тень под врагами убрана: на живом тесте в нынешнем виде она смотрелась плохо. Размер и положение врагов те же, у героя, кристаллов и подборов тень осталась.

  🛠 **Вид боя**

  • текстуры врагов без запечённой тени; тест по исходнику следит, что у героя и подборов она на месте
  • в `docs/27` и `design/README.md` описано, у кого тень есть

  ❓ **Нужно от команды**

  • @участник1 — вернуть тень врагам в другом виде позже, вместе с дизайнером (запись во входящих заводит тимлид)
  ```
