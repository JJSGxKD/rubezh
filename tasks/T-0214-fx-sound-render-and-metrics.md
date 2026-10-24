---
id: T-0214
title: Рендер звуков в WAV и замеры — `pnpm fx:sound [звук…]`
epic: E0
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0212]
zones:
  - packages/app-shell/src/dev/fx-sound.ts
  - packages/app-shell/test/fx-sound.test.ts
  - packages/app-shell/src/state/dev-url.ts
  - packages/app-shell/test/dev-url.test.ts
  - packages/app-shell/src/index.tsx
  - scripts/fx/sound.mjs
  - scripts/fx/sound-core.mjs
  - scripts/test/fx-sound.test.ts
shared:
  - package.json
  - docs/31-audio-and-haptics.md
runner: local
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 3
---

# T-0214. Рендер звуков в WAV и замеры — `pnpm fx:sound [звук…]`

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0214.json)](README.md#значки-статуса) [![T-0212](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0212.json&label=T-0212)](T-0212-fx-scene-by-url.md)

## Зачем

Агент не слышит звук, а правит рецепты в `audio/recipes.ts` вслепую:
щелчок в конце, перегруз, звук длиннее частоты его запусков видны только
на слух. После задачи одна команда отрисовывает каждый звук в WAV тем же
синтезом, что игра, и пишет замеры и спектрограмму картинкой — их агент
читает, а WAV слушает человек.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р142: звук
рендерится в WAV без динамиков; пик, громкость, длина, хвост, спектрограмма
картинкой; сверка с правилами грани `docs/31-audio-and-haptics.md`; запуск по
требованию.

Решения `claude-lead-1` от 24.10.2026:

- **Синтез — тот же, что в игре**: `renderRecipe(sampleRate, recipe,
  variant)` из `audio/synth.ts` в браузере (Chromium через `playwright-core`,
  как `pnpm screens`), частота 48 000 Гц. Отрисовывается сухой звук — без
  общей реверберации и шин: замеряется рецепт, а не микс.
- **Страница** — `?fx=sound` на dev-сервере (тот же разбор адреса, что у
  сцен, T-0212): `sound` — особый id, сценой не считается. Страница
  отрисовывает звуки и отдаёт скрипту `window.__fxSound.render(ids)` →
  `[{ id, variant, samples: number[], spectrogramPng: string }]`, где
  `spectrogramPng` — `data:image/png;base64,…` из `<canvas>`.
- **Спектрограмма** — в странице: окно Ханна 1024, шаг 256, ось частот
  логарифмическая от 50 Гц до 20 кГц, яркость — дБ от −90 до 0. Картинка
  512×256 с подписями «100», «1k», «10k» слева и длиной в мс снизу. БПФ —
  своя функция в `fx-sound.ts` (radix-2), без библиотек.
- **Замеры — в Node**, чистыми функциями `scripts/fx/sound-core.mjs`:
  - `peakDbfs`, `rmsDbfs` (по звучащей части — от первого до последнего
    отсчёта выше −60 dBFS);
  - `audibleMs` — та же звучащая часть; `tailMs` — от пика до спада ниже
    −60 dBFS;
  - `clipped` — отсчёты с модулем от 1; `dcOffset` — среднее.
- **Сверка с рецептом и правилами** (`docs/31` §3, §8) — список пометок:
  - **ошибка** — `clipped > 0` («перегруз: N отсчётов», с формой числа)
    или пик ниже
    −60 dBFS («звук пустой»);
  - **предупреждение** — пик выше −1 dBFS («нет запаса до перегруза»);
    последние 5 мс громче −40 dBFS («хвост обрезан — щелчок в конце»,
    значит, `dur` рецепта короче звука); `audibleMs` больше `gap × voices
    × 1000` («звучит дольше, чем позволяют gap и voices — голоса будут
    гаситься»); `|dcOffset| > 0,01` («смещение постоянной составляющей»);
  - **заметка** — `audibleMs` меньше половины `dur` («буфер вдвое длиннее
    звука — можно укоротить dur»).
- **Выход** — `<out>/sound/<id>-<variant>.wav` (PCM 16 бит, моно),
  `<id>-<variant>.png` (спектрограмма) и `sound.json` со всеми замерами и
  пометками. В терминале — таблица: звук, шина, пик, громкость, длина,
  хвост, пометки. Код выхода 1 — если есть хоть одна ошибка.
- **Команда** `pnpm fx:sound [звук…] [--variant all|first] [--base …]
  [--out var/fx] [--browser …]`; без звуков — все из `SOUND_RECIPES`;
  `--variant` по умолчанию `first`. Нужен запущенный `pnpm dev`.

## Как сейчас

- `packages/app-shell/src/audio/synth.ts:145` — `renderRecipe(sampleRate,
  recipe, variant): Promise<AudioBuffer>` через `OfflineAudioContext`.
- `packages/app-shell/src/audio/recipes.ts:104–125` — `SoundRecipe`: `bus`,
  `level`, `voices`, `gap`, `send`, `duck`, `dur`, `variants`, `pitch`,
  `layers`; `SOUND_RECIPES` — с 126-й строки.
- `docs/31-audio-and-haptics.md` §3 — шины и правила грани, §8 — как
  добавить звук.
- После T-0212: `readDevUrl` разбирает `fx`; стенд подключается в
  `index.tsx` динамическим импортом.

## Шаги по порядку

1. **`dev-url.ts`** — `fx: "sound"` принимается как особый id.
2. **`fx-sound.ts`** — страница: отрисовка через `renderRecipe`,
   спектрограмма на `<canvas>`, `window.__fxSound`. Подключается из
   `index.tsx` динамическим импортом, только при `fx === "sound"` и
   `import.meta.env.DEV`; права `tools.dev` не нужно — страница ничего не
   меняет и в сборку не попадает.
3. **`scripts/fx/sound-core.mjs`** — замеры, пометки, кодирование WAV
   (заголовок RIFF и PCM 16 бит — своей функцией).
4. **`scripts/fx/sound.mjs`** — обвязка браузера и вывод.
5. **`package.json`** — `"fx:sound": "node scripts/fx/sound.mjs"`.
6. **`docs/31-audio-and-haptics.md`** §8 — новый пункт перед «Послушать в
   лаборатории»: «`pnpm fx:sound <id>` — замеры и спектрограмма; ошибок
   быть не должно, предупреждения — объяснить в PR».

## Чего не трогаем

- Рецепты и сам синтез: найденные пометки — отдельные задачи.
- Звуковую лабораторию.
- Гейт CI.

## Тесты

Первым коммитом.

- `scripts/test/fx-sound.test.ts`:
  - синус 1 кГц амплитудой 0,5 на 100 мс → пик ≈ −6,0 dBFS (±0,1), RMS ≈
    −9,0 dBFS (±0,1), `audibleMs` ≈ 100;
  - тишина → пометка-ошибка «звук пустой»;
  - один отсчёт 1,0 → ошибка «перегруз: 1 отсчёт»; пять — «перегруз: 5
    отсчётов»;
  - последний отрезок 5 мс на −20 dBFS → предупреждение «хвост обрезан»;
  - рецепт `gap: 0.05, voices: 2` и звук 150 мс → предупреждение про
    голоса;
  - WAV: 3 отсчёта → файл 50 байт, `RIFF`, `WAVE`, `fmt `, частота 48 000,
    16 бит, `data` 6 байт; 1,0 кодируется 32767, −1,0 — −32768.
- `packages/app-shell/test/fx-sound.test.ts` — БПФ: синус на 12-й корзине
  из 1024 даёт максимум в корзине 12; окно Ханна на краях — 0.
- `dev-url.test.ts` — `?fx=sound` → `fx: "sound"`.
- Ручной прогон: `pnpm fx:sound spark knife` — WAV, PNG и таблица; одна
  спектрограмма — в PR.

## Аналитика

Нет: инструмент разработчика.

## Настройки и окружение

Нет.

## Документы

`docs/31-audio-and-haptics.md` §8 — по шагу 6.

## Критерии приёмки

- [ ] `pnpm fx:sound` отрисовывает все звуки игры в WAV тем же синтезом.
- [ ] Замеры и пометки — в `sound.json` и в таблице терминала; ошибка даёт
  код 1.
- [ ] Спектрограмма — PNG у каждого звука.
- [ ] В сборке страницы `?fx=sound` нет (`pnpm budget` не вырос).
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(dev): Рендер звуков в WAV и замеры`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕНДЕР ЗВУКОВ В WAV И ЗАМЕРЫ**

  `pnpm fx:sound [звук…]` отрисовывает звуки тем же синтезом, что игра, в WAV и спектрограммы и пишет замеры: пик, громкость, длина, хвост, перегруз. Пометки сверяют звук с рецептом и правилами грани — обрезанный хвост, нет запаса до перегруза, звучит дольше, чем позволяют gap и voices. Агент правит звук по числам и картинке, человек слушает WAV.
  ```
