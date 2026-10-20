---
id: T-0173
title: Положение радара в настройках игрока — справа сверху, слева сверху, выключен
epic: E6
priority: P2
status: in-progress
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - packages/app-shell/src/state/radar-setting.ts
  - packages/app-shell/src/screens/run/RunHud.tsx
  - packages/app-shell/src/screens/settings.tsx
  - packages/app-shell/src/index.tsx
  - packages/app-shell/test/radar-setting.test.ts
shared:
  - packages/app-shell/src/i18n/ru.json
  - docs/27-design-system-and-app-shell.md
  - docs/30-configuration-map.md
  - docs/22-analytics-and-metrics.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0173. Положение радара в настройках игрока — справа сверху, слева сверху, выключен

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0173.json)](README.md#значки-статуса)

## Зачем

Радар забега стоит вверху справа (T-0097): внизу его закрывала рука, ведущая
джойстик. Левше или игроку с другим хватом может быть удобнее слева, а кому-то
радар просто мешает. Игрок выбирает сам, в настройках.

## Решения

Р113 (`docs/35-stage4-plan.md`, 19.10.2026): в настройках игрока — **«Радар:
справа сверху / слева сверху / выключен»**, по умолчанию справа сверху. Низа
нет: там радар закрывает палец на джойстике. Закрывает пункты входящих «Положение
радара — настройкой игрока» и «Настраиваемое положение радара забега».

Уточнения `claude-lead2-1` по уже принятым правилам:

- **Хранится на устройстве**, как экран и эффекты оружия, а не в аккаунте:
  положение радара — вопрос хвата и размера конкретного телефона
  (`docs/27` §7.1, «Аккаунт или устройство»). Серверные настройки аккаунта
  (`account-settings.ts` и их каталог на сервере) не трогаем.
- **Свой подраздел «Радар»** в настройках: подпись раздела «Бой»
  («Сохраняется в аккаунте») к радару не подходит.
- **Радар выключен — он не рисуется.** Движок снимок радара считать не
  перестаёт: перестройка движка ради этого выходит за задачу.
- **Выбор — `SegmentedControl`** из трёх сегментов (до трёх сегментов
  компонент рисует одной строкой), не три переключателя.

Решение claude-lead-1 от 19.10.2026: радар — настройка устройства (хранится на
устройстве, не в аккаунте).

## Как сейчас

- `packages/app-shell/src/screens/run/RunHud.tsx:122–128` — радар лежит в
  потоке под верхней полосой и полосой босса: `<div className="flex justify-end
  pt-2 pr-[calc(1rem+var(--app-inset-right))]">` с `<Radar radar={hud.radar} />`.
- `packages/app-shell/src/state/graphics.ts` — образец стора на устройстве:
  `createPersistedValue` (`persisted.ts`), ключ с версией `bh.graphics.v1`,
  схема `zod/mini`, `hydrate()`, запись при смене, событие `settings_changed`
  с `scope: "device"`.
- `packages/app-shell/src/index.tsx:112` — `useGraphics.getState().hydrate()`:
  сюда же добавляется гидратация нового стора.
- `packages/app-shell/src/screens/settings.tsx:88–114` — разделы «Бой» и
  «Графика», подписи `settings.scope.account` / `settings.scope.device`
  (`i18n/ru.json:240–241`). Переключателя на несколько значений в экране ещё
  нет: `SegmentedControl` — `design-system/components/Layout.tsx:229`
  (`items`, `activeId`, `label`, `onSelect`).
- `docs/27-design-system-and-app-shell.md:193` — строка про радар («стоит
  вверху справа… решение участника 1 от 13.10.2026»); `:1425–1440` — таблица
  настроек §7.1.
- Тестов рендера `RunHud` и `SettingsScreen` в `packages/app-shell/test` нет
  (проверено поиском по именам) — положение проверяется чистой функцией.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`state/radar-setting.ts`** по образцу `graphics.ts`:
   ```ts
   export const RADAR_POSITIONS = ["right", "left", "off"] as const;
   export type RadarPosition = (typeof RADAR_POSITIONS)[number];
   export const DEFAULT_RADAR_POSITION: RadarPosition = "right";
   // ключ "bh.radar.v1", схема { position: z.enum(RADAR_POSITIONS) }
   // useRadarSetting: { position; hydrate(): void; set(position): void }
   // radarPlacementClass(position): string | null — null: не рисовать
   ```
   `set` пишет на устройство и шлёт `settings_changed` (`{ setting:
   "radar.position", value: position, scope: "device" }`). Повторный выбор
   того же значения ничего не пишет и события не шлёт. Битое значение в
   хранилище — умолчание (это делает `createPersistedValue`).
3. **`index.tsx`** — `useRadarSetting.getState().hydrate()` рядом с графикой.
4. **`RunHud.tsx`** — `"off"` → радар не рендерится вовсе (ни пустого блока,
   ни отступа); `"right"` — как сейчас; `"left"` — тот же блок с
   `justify-start` и отступом `pl-[calc(1rem+var(--app-inset-left))]` вместо
   правого. Отступы — только через `--app-inset-*` (`CLAUDE.md`). Радар
   остаётся в потоке: полоса босса по-прежнему над ним. Положение читается
   подпиской по селектору (`(s) => s.position`), чтобы HUD не перерисовывался
   от прочего. Классы отдаёт `radarPlacementClass`.
5. **`settings.tsx`** — после раздела «Графика» новый `SectionTitle`
   `settings.radar` и `SegmentedControl` из трёх сегментов; под ним подпись
   `settings.radar.hint`, ещё ниже `settings.radar.scope`.
6. **Тексты** (`i18n/ru.json`, дословно):

   | Ключ | Текст |
   |---|---|
   | `settings.radar` | Радар |
   | `settings.radar.label` | Положение радара в забеге |
   | `settings.radar.right` | Справа сверху |
   | `settings.radar.left` | Слева сверху |
   | `settings.radar.off` | Выключен |
   | `settings.radar.hint` | Круг с врагами и подборами вокруг героя. Внизу экрана его закрывает палец, поэтому места только сверху. |
   | `settings.radar.scope` | Только на этом устройстве: хват и экран у каждого телефона свои. |

7. **Документы.**
   - `docs/27` §7.1: строка таблицы «Радар — положение: справа сверху / слева
     сверху / выключен», умолчание «справа сверху»; абзац «Радар»
     (`state/radar-setting.ts`, `bh.radar.v1`, устройство, почему нет низа,
     Р113); в строке про радар (`:193`) — «положение выбирает игрок».
   - `docs/30`, строка про радар (`:114`): положение — `state/radar-setting.ts`.
   - `docs/22` §3.3, строка `settings_changed`: пример `radar.position`
     (поле `setting` свободное — версия схемы не меняется).

## Чего не трогаем

- Размер, цвета и рисование радара (`Radar.tsx`, `radar-looks.ts`) — только
  положение.
- Снимок радара в движке (`packages/core-game`): считается всегда.
- Серверные настройки аккаунта (`account-settings.ts`,
  `scripts/test/account-settings-keys.test.ts`).
- Положение внизу — его нет по Р113.
- Экран паузы и подсказки HUD (`HintBanner`).

## Сценарий и интерфейс

Настройки → раздел «Радар» → три сегмента; выбранный поднят плашкой, как везде
в `SegmentedControl`. Состояния:

- загрузка: нет, стор читается синхронно при старте;
- ошибка хранилища: площадка не дала хранилище — работает умолчание «справа
  сверху», выбор не переживает перезапуск (как у остальных настроек);
- нет сети и ограничение аккаунта на настройку не влияют.

В забеге: «справа» — как сейчас; «слева» — под верхней полосой у левого края;
«выключен» — радара нет. HUD читает стор живьём, поэтому смена действует и на
забеге на паузе.

## Тесты

Пишутся первым коммитом.

- `radar-setting.test.ts` (по образцу `graphics.test.ts`, память вместо
  хранилища):
  - по умолчанию положение `right`;
  - `set("left")` → после повторной `hydrate()` из того же хранилища снова
    `left`;
  - битый JSON и значение вне списка в хранилище → `right`, ключ стёрт;
  - `set("off")` шлёт ровно одно `settings_changed` с `setting:
    "radar.position"`, `value: "off"`, `scope: "device"`; повторный `set("off")`
    не шлёт ничего;
  - хранилища нет (`storage: undefined`) — не падает, значение держится в
    памяти;
  - `radarPlacementClass`: `right` → строка с `justify-end` и
    `--app-inset-right`; `left` → `justify-start` и `--app-inset-left`;
    `off` → `null`.
- В PR — скриншоты HUD на 320, 390, 768 и 1440 px, портрет и ландшафт
  телефона: радар слева не накрывает полосу здоровья и статусы игрока
  (радар в потоке ниже них).

## Аналитика

`settings_changed` (уже в словаре, `docs/22` §3.3): `setting: "radar.position"`,
`value: "right" | "left" | "off"`, `scope: "device"`. Нового события нет.

## Настройки и окружение

Ключ хранилища устройства `bh.radar.v1`. Серверных ключей и переменных
окружения нет.

## Документы

Шаг 7.

## Критерии приёмки

- [ ] В настройках три положения; по умолчанию справа сверху.
- [ ] «Слева» ставит радар слева сверху с отступом `--app-inset-left`, «выключен»
  не рисует его вовсе.
- [ ] Выбор переживает перезапуск, битое значение даёт умолчание.
- [ ] Выбор уходит в аналитику одним `settings_changed` со `scope: "device"`.
- [ ] Радара внизу экрана нет ни при каком значении.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Положение радара в настройках`
- **Метка:** `release: minor`
- **Для игроков:**
  - новое: радар забега можно переставить налево или выключить — в настройках, раздел «Радар»
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОЛОЖЕНИЕ РАДАРА В НАСТРОЙКАХ**

  Игрок выбирает, где стоит радар забега: справа сверху (как было), слева сверху или нигде. Выбор хранится на устройстве, внизу экрана радара по-прежнему нет — там рука на джойстике.
  ```
