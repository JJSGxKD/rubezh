---
id: T-0260
title: Тайники рубежа — облик на канве, радар, круг стояния и окно благословения
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0259, T-0352]
zones:
  - packages/core-game/src/game/render/secrets-look.ts
  - packages/core-game/test/secrets-look.test.ts
  - packages/app-shell/src/screens/run/BlessingOverlay.tsx
  - packages/app-shell/test/blessing-overlay.test.ts
shared:
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/src/game/render/art-atlas.ts
  - packages/app-shell/src/screens/run/RunScreen.tsx
  - packages/app-shell/src/screens/run/Radar.tsx
  - packages/app-shell/src/screens/run/radar-looks.ts
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/gallery.tsx
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/meta-v2.md
batch: 4
---

# T-0260. Тайники рубежа — облик на канве, радар, круг стояния и окно благословения

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0260.json)](README.md#значки-статуса) [![T-0259](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0259.json&label=T-0259)](T-0259-secrets-tree-and-rift.md) [![T-0352](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0352.json&label=T-0352)](T-0352-secrets-run-wiring.md)

## Зачем

Движок (T-0258, T-0259) знает тайники, но игрок их не видит. После задачи:
- тайник стоит на земле: в режиме фигур — знаком, в режиме арта — кадром;
- найденный тайник отмечен на радаре;
- когда игрок стоит в круге, прогресс виден кольцом;
- капище открывает окно «Выбери благословение».

## Решения

Решение владельца — Р153; облик — `design/art/meta-v2.md` §5.3:
- тайник темнее героя, без красного и без жёлтого опыта;
- действующий тайник — бирюзой оберегов или фиолетом Нави, со столбом
  света;
- на радаре — только найденный или открытый указателем.

Решения `claude-lead-1` от 24.10.2026:

- **Фигуры** (`secrets-look.ts`): круг 24 единицы в тоне вида и знак вида
  внутри (капище — столб, клад — ромб, древо — ёлочка, разлом — трещина,
  камень — треугольник, огонёк — точка с хвостом). Тоны — из `looks.ts`,
  новые записи `SECRET_LOOKS`. Действующий — со столбом света: прозрачность
  вытянутого прямоугольника, без `ADD`.
- **Арт** — кадры атласа `env` готовы (31.10.2026, п. 8 и 14 очереди
  дизайнера): `secret/<вид>/found` и `secret/<вид>/active`, у огонька —
  `secret/wisp/hint` и `secret/wisp/active`; вид — как `SecretKind`
  (`shrine`, `hoard`, `stone`, `tree`, `rift`, `wisp`). Центр кадра — центр
  тайника, ячейка — `units` тайника × `ART_PPU` (`design/art/src/secrets.mjs`).
  Нет кадра — фигура.
- **Круг стояния** — дуга прогресса вокруг тайника, тон вида.
- **Радар** — точка тайника цветом вида, как сейчас отметки элит; закрытые
  невидимые не рисуются.
- **Окно благословения** (`BlessingOverlay.tsx`) — как окно уровня: три
  карточки с названием и прибавкой («Урон +10 %»), выбор закрывает окно.
  Сундучный путь паузы (`pauseOnChest`) — тот же флаг и для капища.
- **Настройки:** столб света и дуга — не под «Эффектами оружия»: тайник
  обязан читаться, это часть чтения боя. При «меньше движения» столб не
  мерцает.

## Как сейчас

- `render/WorldRenderer.ts`, `render/looks.ts`, `render/art-atlas.ts` — фигуры
  и кадры; отметки элит на радаре — `screens/run/Radar.tsx` и `radar-looks.ts`.
- Окно уровня — образец окна выбора; окно сундука — образец паузы.
- После T-0258, T-0259: события `secretFound`, `secretUsed`,
  `secretBlessing`, ответ `chooseBlessing`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`secrets-look.ts`** — фигуры, тоны, столб, дуга.
3. **`WorldRenderer.ts`** — слой тайников под врагами и над землёй; кадры
   арта при наличии.
4. **Радар** — отметки найденных.
5. **`BlessingOverlay.tsx`** и связь в `RunScreen.tsx`, `state/run.ts`.
6. **Витрина** — окно благословения на тестовых данных.
7. **События** `secret_found { kind, sec }`, `secret_used { kind, outcome }` —
   сначала `docs/22` §3.3 и Zod, потом `state/analytics.ts`.
8. **Тексты `ru.json`:**
   - заголовок окна: `"blessing.title": "Выбери благословение"`;
   - благословения:
     - `"blessing.fury": "Ярость"`;
     - `"blessing.wind": "Ветер"`;
     - `"blessing.harvest": "Жатва"`;
     - `"blessing.fortress": "Крепость"`;
     - `"blessing.keen": "Зоркость"` (перезарядка на 8% короче — T-0258, решение владельца 28.10.2026);
     - `"blessing.flame": "Пламя"`;
   - имена тайников (`secret.<kind>.name`):
     - `shrine` — «Капище»;
     - `hoard` — «Клад»;
     - `tree` — «Древо-оберег»;
     - `rift` — «Разлом Нави»;
     - `stone` — «Камень-указатель»;
     - `wisp` — «Блуждающий огонёк».
9. **`docs/27`** — окно благословения в карте экранов забега.

## Чего не трогаем

- Движок тайников. Кодекс — T-0261.

## Сценарий и интерфейс

Минута 1: в двух экранах на земле — капище с бирюзовым столбом. Игрок
подходит, стоит три секунды, дуга заполняется, мир останавливается, окно
«Выбери благословение» с тремя карточками. Выбор «Ярость» — забег
продолжается. Проверить окно на 320, 390 и в ландшафте 667×375 в витрине.

## Тесты

Первым коммитом.

- `secrets-look.test.ts`: тон каждого вида не совпадает с красным врага,
  жёлтым опыта и белым героя (те же проверки различимости, что у подборов).
- `blessing-overlay.test.ts`: три карточки, выбор зовёт `chooseBlessing` с
  id; прибавка строкой из модификатора.

Снимки тайников на канве и окна — в PR.

## Аналитика

По шагу 7.

## Настройки и окружение

Нет.

## Документы

По шагу 9.

## Критерии приёмки

- [ ] Тайники видны на земле фигурой или кадром; найденные — на радаре.
- [ ] Стояние видно дугой; капище открывает окно благословения.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Тайники рубежа — облик и благословение`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: тайники на карте забега — капище, клад, древо-оберег, разлом Нави, камень-указатель и огонёк`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ТАЙНИКИ НА КАРТЕ**

  Тайники видны на земле, найденные — на радаре, стояние — дугой. Капище открывает окно «Выбери благословение». События secret_found и secret_used покажут, находят ли игроки тайники и что выбирают.
  ```
