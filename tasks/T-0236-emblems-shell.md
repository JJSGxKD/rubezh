---
id: T-0236
title: Знаки у имени — клиент: все знаки в профиле, выбор знака, знак в рейтинге и у друзей
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0235, T-0240, T-0107, T-0111]
zones:
  - packages/app-shell/src/state/emblems-api.ts
  - packages/app-shell/src/screens/meta/emblem-chip.tsx
  - packages/app-shell/src/screens/meta/emblems.tsx
  - packages/app-shell/src/screens/meta/emblem-rules.ts
  - packages/app-shell/test/emblem-rules.test.ts
  - packages/app-shell/test/emblems-api.test.ts
shared:
  - packages/app-shell/src/screens/meta/profile.tsx
  - packages/app-shell/src/screens/meta/rating.tsx
  - packages/app-shell/src/screens/meta/friends.tsx
  - packages/app-shell/src/screens/meta/friends-parts.tsx
  - packages/app-shell/src/screens/meta/achievements-rules.ts
  - packages/app-shell/src/screens/meta/achievement-card.tsx
  - packages/app-shell/src/state/runs-api.ts
  - packages/app-shell/src/state/friends-api.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/i18n/ru-tasks.json
  - packages/app-shell/src/screens/gallery.tsx
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/mockups/identity-v2.html
batch: 4
---

# T-0236. Знаки у имени — клиент: все знаки в профиле, выбор знака, знак в рейтинге и у друзей

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0236.json)](README.md#значки-статуса) [![T-0235](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0235.json&label=T-0235)](T-0235-emblems-server.md) [![T-0240](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0240.json&label=T-0240)](T-0240-public-identity-in-lists.md) [![T-0107](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0107.json&label=T-0107)](T-0107-achievements-showcase-shell.md) [![T-0111](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0111.json&label=T-0111)](T-0111-weekly-season-screen.md)

## Зачем

Сервер (T-0235) знает знаки игрока и отдаёт выбранный в строках списков, но
клиент рисует только метку «Тестер». После задачи в профиле есть раздел
«Знаки · N»: все знаки каталога, полученные — цветом редкости, закрытые —
силуэтом с условием и «есть у N %». Игрок выбирает, какой знак носить, и этот
знак виден у его имени в рейтинге, сезоне и у друзей.

## Решения

Решения владельца — `docs/35-stage4-plan.md` Р149: в профиле и карточке
видны все знаки, закрытые — силуэтом с условием; в списках — один
выбранный; витрина — до трёх закреплённых. Макет — `design/art/mockups/identity-v2.html`,
описание — `design/art/meta-v2.md` §1.5.

Решения `claude-lead-1` от 24.10.2026:

- **Раздел знаков** — экран `emblems.tsx`, вход кнопкой «Знаки · N» в
  профиле, где N — сколько знаков держит игрок. Группы: «Статус», «Сезоны»,
  «Заслуги» (в этом порядке). Внутри группы — держимые сверху, затем
  закрытые; порядок — как отдал сервер.
- **Знак** — чип `EmblemChip`: значок и название, тон редкости. Тон
  берётся из `rarity-look.ts` (тот же, что у предметов), у `team` — тон
  `secondary` (бирюза оберегов). У сезонного знака к названию добавляется
  « · сезон N». Новых цветов нет.
- **Закрытый знак** — силуэт: значок и название в `text-muted`, без тона;
  под ним условие (`hint`) и «Есть у N % игроков», если сервер отдал
  `percent`.
- **Выбор:** нажатие на держимый знак открывает лист «Носить у имени».
  Выбранный помечен «Сейчас у имени». Строка «По умолчанию» сбрасывает выбор
  (`PUT … { id: null }`), а при `auto: true` подписана, какой знак сейчас
  показывается сам. Ответа ждём без оптимизма; ошибка — плашкой.
- **В списках** (рейтинг, таблица сезона, друзья) знак стоит **под
  именем**, одной строкой. Если строке тесно, остаётся только значок с
  `aria-label` по названию. Порог — правило `emblemFit(width)`: уже 360 px —
  только значок (`meta-v2.md` §1.5: «имя важнее»).
- **Старый сервер:** нет `emblem` в строке — рисуется прежняя метка «Тестер»
  (`tester-badge.tsx`), как сейчас. Есть `emblem` — прежнюю метку в этой
  строке не рисуем, чтобы знаков не было два.
- **Значки знаков** — готовы (31.10.2026, п. 11 и 18 очереди дизайнера):
  `screens/meta/emblem-glyphs.tsx`, карта `EMBLEM_GLYPHS` id знака → `Glyph`,
  рисуется `GameGlyph` из `game-glyphs.tsx`. Файл сгенерирован
  `design/art/src/emblem-glyphs.mjs` — задача его не правит. Лист значков —
  `design/art/mockups/emblems-v2.html`. Нет в карте — значок категории
  достижения из витрины T-0107.
- **Витрина T-0107** получает категории `status` и `season` в конце
  `CATEGORY_ORDER`: «Статус» и «Сезоны». Их карточки — без полосы прогресса,
  без «Забрать», с отметкой «Получено» или условием.
- **«Настройки не отстают»:** новых анимаций нет, кроме появления листа
  (существующий `sheet-in`).

## Как сейчас

- `screens/meta/tester-badge.tsx` — метка «Тестер» (`FlaskConical`, тон
  элиты). Её рисуют `profile.tsx`, `rating.tsx`, `friends.tsx`,
  `tester-thanks.tsx`.
- Строка рейтинга — `rating.tsx`, `LeaderboardRow`: `Avatar`, `entry.name`.
  После T-0107 там же `★ N`, после T-0111 — таблица сезона.
- Схемы строк — `state/runs-api.ts` (рейтинг, сезон), `state/friends-api.ts`
  (друзья). После T-0240 в строках необязательное `emblem: { id, title,
  tier, category, season? }`.
- Витрина — `screens/meta/achievements-rules.ts` (`CATEGORY_ORDER`,
  `groupByCategory`), `achievement-card.tsx` (T-0107).
- Тон редкости — `screens/meta/rarity-look.ts`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`emblem-rules.ts`** (чистые функции):
   - `GROUP_ORDER = ["status", "season", "merit"]`;
   - `groupEmblems(items)` → группы по порядку: держимые, затем закрытые;
   - `emblemLabel(emblem)` → название, у сезонного — с номером сезона;
   - `emblemFit(width)` → `"full"` от 360 px, иначе `"glyph"`;
   - `heldCount(items)`.
3. **`state/emblems-api.ts`** — Zod-схемы (`z/mini`), `load()` и `choose(id
   | null)`, коды ошибок `emblem_not_held` и `emblem_not_found`.
4. **`emblem-chip.tsx`** — по «Решениям», значок из `EMBLEM_GLYPHS`. У чипа
   два размера: строка списка и профиль.
5. **`emblems.tsx`** — экран: загрузка, ошибка с «Повторить», группы, лист
   выбора.
6. **`profile.tsx`** — у имени выбранный знак (`size` профиля), кнопка
   «Знаки · N». Прежняя `TesterBadge` остаётся только для старого сервера.
7. **Списки:**
   - `runs-api.ts`, `friends-api.ts` — необязательное `emblem` в схемах строк;
   - `rating.tsx`, `friends.tsx` и `friends-parts.tsx` — знак под именем по `emblemFit`.
8. **Витрина:** `achievements-rules.ts` — категории `status` и `season`;
   `achievement-card.tsx` — карточка без прогресса для них.
9. **Витрина компонентов** (`gallery.tsx`) — чипы всех редкостей и `team`,
   закрытый знак, строка рейтинга со знаком на 320 и 390.
10. **Событие** `emblem_shown_changed` — клиентское, поля `emblem` (id или
    `"auto"`) и `category`. Сначала `docs/22` §3.3 и Zod в
    `event-dictionary.ts`, потом `state/analytics.ts`.
11. **Тексты**, дословно:
    - `ru.json`:
      - `"emblems.open": "Знаки · {count}"`, `"emblems.title": "Знаки"`;
      - `"emblems.group.status": "Статус"`, `"emblems.group.season": "Сезоны"`, `"emblems.group.merit": "Заслуги"`;
      - `"emblems.season": "{title} · сезон {season}"`, `"emblems.rarity": "Есть у {percent}% игроков"`;
      - `"emblems.wear": "Носить у имени"`, `"emblems.current": "Сейчас у имени"`;
      - `"emblems.auto": "По умолчанию"`, `"emblems.autoNow": "По умолчанию — сейчас «{title}»"`, `"emblems.autoNone": "По умолчанию — без знака"`;
      - `"emblems.loading": "Загружаем знаки…"`, `"emblems.failed": "Не удалось загрузить знаки — проверьте связь"`, `"emblems.chooseFailed": "Не удалось сменить знак — попробуйте ещё раз"`;
    - `ru-tasks.json`: `"achievements.category.status": "Статус"`, `"achievements.category.season": "Сезоны"`.
12. **Документы:** `docs/27` — строка экрана «Профиль»: раздел «Знаки» и
    знак у имени в списках.

## Чего не трогаем

- Сервер, каталог и редкости знаков — T-0235.
- Карточку чужого игрока (Р48): её задача придёт отдельно, чип для неё готов.
- Облик и аватар — T-0237, T-0238.
- Окно «Спасибо за тест» (`tester-thanks.tsx`).

## Сценарий и интерфейс

Профиль тестера после выката: у имени «Тестер» (по умолчанию). «Знаки · 1»
→ экран: «Статус» — «Тестер» цветом, «VIP» и «Меценат» силуэтом с условием;
«Сезоны» — три силуэта; «Заслуги» — 24 силуэта с «есть у N %». Игрок
выполнил «Последний рубеж» → знак цветом → нажатие → «Носить у имени» → в
рейтинге под его именем «Последний рубеж» тоном `epic`.

Состояния: загрузка, ошибка с «Повторить», гость (профиль без входа —
кнопки «Знаки» нет), нет сети (плашка связи, как у остальных экранов).
Проверить 320, 390, 768, 1440, ландшафт 667×375 (`tasks/README.md`,
«Приёмка»): на 320 в рейтинге — только значок, имя не обрезается сильнее,
чем сейчас.

## Тесты

Первым коммитом.

- `emblem-rules.test.ts`:
  - `groupEmblems`: порядок групп, держимые раньше закрытых, пустая группа опускается;
  - `emblemLabel` сезонного — «Чемпион · сезон 3»;
  - `emblemFit(359)` → `"glyph"`, `emblemFit(360)` → `"full"`;
  - `heldCount`.
- `emblems-api.test.ts`:
  - разбор ответа с держимыми, закрытыми и сезонным;
  - ответ без `percent` — разбирается;
  - 409 → код `emblem_not_held`.
- Существующие тесты рейтинга и друзей — зелёные. Строка без `emblem`
  рисует прежнюю метку «Тестер».

Снимки профиля, экрана знаков и рейтинга на 320 и 390 — в PR.

## Аналитика

`emblem_shown_changed` — по шагу 10.

## Настройки и окружение

Нет.

## Документы

По шагу 12.

## Критерии приёмки

- [ ] В профиле — все знаки каталога: держимые цветом, закрытые силуэтом с условием.
- [ ] Игрок выбирает знак или «По умолчанию»; выбранный виден в рейтинге, сезоне и у друзей.
- [ ] На узкой строке — только значок с подписью для диктора.
- [ ] Без поля `emblem` от сервера всё выглядит, как сейчас.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Знаки у имени`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: знаки у имени — за достижения, статус и места в сезоне; выбери, какой носить, в профиле`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗНАКИ У ИМЕНИ**

  В профиле — раздел «Знаки»: все знаки каталога, полученные цветом редкости, закрытые силуэтом с условием и «есть у N %». Игрок выбирает, какой знак носить, — его видно под именем в рейтинге, сезоне и у друзей. Не выбрал — показывается статус: Команда, VIP, Меценат или Тестер.
  ```
