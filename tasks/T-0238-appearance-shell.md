---
id: T-0238
title: Облики — экран «Облик» из арсенала и профиля, портрет в арсенале, голова облика в аватаре
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0237, T-0230, T-0236]
zones:
  - packages/app-shell/src/state/appearance-api.ts
  - packages/app-shell/src/screens/meta/appearance.tsx
  - packages/app-shell/src/screens/meta/appearance-art.ts
  - packages/app-shell/src/screens/meta/appearance-rules.ts
  - packages/app-shell/test/appearance-rules.test.ts
  - packages/app-shell/test/appearance-api.test.ts
shared:
  - packages/app-shell/src/design-system/components/Data.tsx
  - packages/app-shell/src/screens/meta/hero-portrait.ts
  - packages/app-shell/src/screens/meta/arsenal.tsx
  - packages/app-shell/src/screens/meta/profile.tsx
  - packages/app-shell/src/screens/meta/rating.tsx
  - packages/app-shell/src/screens/meta/friends-parts.tsx
  - packages/app-shell/src/state/runs-api.ts
  - packages/app-shell/src/state/friends-api.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/state/navigation.ts
  - packages/app-shell/src/app/lazy-screens.tsx
  - packages/app-shell/src/i18n/ru.json
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

# T-0238. Облики — экран «Облик» из арсенала и профиля, портрет в арсенале, голова облика в аватаре

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0238.json)](README.md#значки-статуса) [![T-0237](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0237.json&label=T-0237)](T-0237-appearance-server.md) [![T-0230](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0230.json&label=T-0230)](T-0230-draft-art-testers-flag.md) [![T-0236](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0236.json&label=T-0236)](T-0236-emblems-shell.md)

## Зачем

Сервер (T-0237) знает облики игрока, но выбрать облик негде, а в рейтинге
у всех фото или инициалы. После задачи у игрока есть экран «Облик»: десять
обликов с портретами, у закрытых — откуда их взять. Выбранный облик стоит в
арсенале. В кружке аватара — голова облика, у себя и у других, а фото из
Telegram — по выбору.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:

- **Р150** — выбор облика из арсенала и из профиля, на один экран; за деньги —
  только облик, видный до покупки (покупки здесь нет);
- **Р47** — аватар — голова персонажа;
- поправка от 24.10.2026: **по умолчанию в кружке — голова облика**, фото
  из Telegram — по выбору.

Решения `claude-lead-1` от 24.10.2026:

- **Облики — это арт, и они идут к игрокам вместе с ним** (Р143: тестерам,
  потом всем). Поэтому портреты, головы и экран «Облик» видит только тот,
  у кого черновой арт включён: `draftArtAllowed() && settings.art` (T-0230).
  Остальные видят то же, что сейчас: фигуру в арсенале и фото или инициалы
  в кружках.
  - Правило зрителя: смотрит игрок без арта на тестера с Князем — видит
    фото тестера, а не голову.
  - Включат арт всем флагом `art.sprites` — головы появятся у всех без
    релиза.
- **Экран `appearance.tsx`** — маршрут `appearance`, вход кнопкой «Облик»:
  - в арсенале — у портрета героя;
  - в профиле — рядом с «Знаки · N» (T-0236).

  Сетка карточек по две на 320–390 px и по три шире. Карточка:
  - портрет `card-hero-<id>.svg`;
  - рамка и свечение — тоном редкости (`RarityGlow`, `rarity-look.ts`);
  - название;
  - у закрытых — силуэт (портрет в `opacity` 0,35 без тона) и строка
    источника.

  Выбранный помечен «Надет». Нажатие на свой облик — «Надеть», на закрытый —
  лист с крупным портретом и источником.
- **Тексты источника** по `source.kind`:
  - `start` — «С самого начала»;
  - `level` — «{level} уровень аккаунта»;
  - `weekly_points` — «Верхняя ступень очков недели»;
  - `achievement` — «Достижение «{title}»»;
  - `event` — «Ярмарка — скоро»;
  - `vip` — «Пока активен VIP»;
  - `season` — «Топ-{maxPlace} недельного сезона».
- **Аватар:** переключатель «Фото из Telegram в кружке» внизу экрана
  `avatarPhoto`. `Avatar` (`Data.tsx`) получает необязательные `appearance` и
  `avatarPhoto`. Голова `avatar-hero-<id>.svg` рисуется, если зрителю арт
  разрешён, `appearance` задан и `avatarPhoto` не `true`. Иначе — как сейчас:
  фото, потом инициалы. Неизвестный id — голова `keeper`.
- **Портрет в арсенале** (`hero-portrait.ts`) — портрет **выбранного**
  облика, а не только `keeper`. Правило показа то же — арт зрителя.
- **Ассеты** — адреса через `new URL(…, import.meta.url)`, как сейчас в
  `hero-portrait.ts`, одной картой в `appearance-art.ts`. SVG грузятся по
  требованию и в первую загрузку не попадают — проверяет `pnpm budget`.
- **Ответ — без оптимизма:** «Надеть» ждёт сервер, на ошибке плашка, на 409
  — перечитать экран (владение могло пропасть, как у VIP).

## Как сейчас

- `screens/meta/hero-portrait.ts` — `HERO_PORTRAIT_URL` на
  `design/art/out/portrait-hero-keeper.svg`, показ за флагом разработчика;
  его рисует `arsenal.tsx`.
- `design-system/components/Data.tsx:118` — `Avatar({ name, url, size })`:
  фото с запасом на инициалы.
- После T-0230: `state/flags.ts` (`draftArtAllowed()`) и `graphics.art`.
- После T-0236: в профиле есть «Знаки · N», в строках рейтинга и друзей —
  знак. После T-0237 в строках есть `appearance` и `avatarPhoto`.
- Портреты, головы и карточки всех десяти обликов — `design/art/out/{portrait,avatar,card}-hero-<id>.svg`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`appearance-rules.ts`** (чистые):
   - `sourceText(source)` → ключ и параметры по «Решениям»;
   - `showHead(viewerArt, appearance, avatarPhoto)`;
   - `gridColumns(width)` → 2 до 400 px, иначе 3;
   - `sortAppearances(items)` — по порядку каталога сервера.
3. **`appearance-art.ts`** — карты id → адрес для портрета, головы и
   карточки; `keeper` — запасной.
4. **`state/appearance-api.ts`** — Zod-схемы (`z/mini`), `load()`,
   `choose({ id?, avatarPhoto? })`, коды `appearance_locked` и
   `appearance_not_found`.
5. **`appearance.tsx`** и экран в `state/navigation.ts` и `app/lazy-screens.tsx`; кнопки входа в
   `arsenal.tsx` и `profile.tsx` — только при арте зрителя.
6. **`Avatar`** — новые свойства. `rating.tsx` и `friends-parts.tsx`
   передают `appearance` и `avatarPhoto` из строк; схемы строк в
   `runs-api.ts` и `friends-api.ts` — с необязательными полями. Шапка и
   профиль — свой облик из `appearance-api`.
7. **`hero-portrait.ts`** — портрет выбранного облика.
8. **Витрина компонентов** — карточки всех редкостей, закрытая, аватар с
   головой и с фото.
9. **Событие** `appearance_changed` — клиентское, поля `appearance` и
   `avatarPhoto`. Сначала `docs/22` §3.3 и Zod в `event-dictionary.ts`, потом
   `state/analytics.ts`.
10. **Тексты `ru.json`**, дословно:
    - кнопки и экран: `"appearance.open": "Облик"`, `"appearance.title": "Облик"`;
    - состояния карточки: `"appearance.worn": "Надет"`, `"appearance.wear": "Надеть"`, `"appearance.locked": "Закрыт"`;
    - аватар: `"appearance.avatarPhoto": "Фото из Telegram в кружке"`, `"appearance.avatarPhoto.hint": "Иначе в кружке — голова облика"`;
    - источники:
      - `"appearance.source.start": "С самого начала"`;
      - `"appearance.source.level": "{level} уровень аккаунта"`;
      - `"appearance.source.weeklyPoints": "Верхняя ступень очков недели"`;
      - `"appearance.source.achievement": "Достижение «{title}»"`;
      - `"appearance.source.event": "Ярмарка — скоро"`;
      - `"appearance.source.vip": "Пока активен VIP"`;
      - `"appearance.source.season": "Топ-{place} недельного сезона"`;
    - загрузка и ошибки: `"appearance.loading": "Загружаем облики…"`, `"appearance.failed": "Не удалось загрузить облики — проверьте связь"`, `"appearance.chooseFailed": "Не удалось надеть облик — попробуйте ещё раз"`;
    - имена обликов (`appearance.<id>.name`):
      - Хранитель и окрасы: «Хранитель», «Хранитель · иней», «Хранитель · травник», «Хранитель · золото»;
      - архетипы: «Витязь», «Ведунья», «Охотница», «Скоморох», «Князь», «Навий страж».
11. **Документы:** `docs/27` — экран «Облик» в карте экранов §6, правило
    головы в аватаре в §4.6 (компонент `Avatar`).

## Чего не трогаем

- Сервер и каталог — T-0237. Облик в забеге — T-0239.
- Рамку дивизиона и галочки на аватаре (Р47) — дивизионов пока нет.
- Покупку облика — Ярмарка (Р154).
- Портреты и кадры — дизайнер (`design/art/backlog.md`, п. 7).

## Сценарий и интерфейс

Тестер с артом, 20-й уровень:

1. Арсенал → «Облик» → сетка. Хранитель и три окраса, Витязь — свои; Ведунья,
   Охотница, Скоморох, Князь, Навий страж — силуэтом с источником.
2. «Витязь» → «Надеть» → арсенал показывает портрет Витязя.
3. В рейтинге у этого игрока в кружке голова Витязя. Игрок без арта в том же
   рейтинге видит его фото.

Состояния:
- загрузка;
- ошибка с «Повторить»;
- гость — кнопки «Облик» нет;
- без арта — кнопки «Облик» нет, всё как сейчас.

Проверить 320, 390, 768, 1440, ландшафт 667×375 (`tasks/README.md`,
«Приёмка»).

## Тесты

Первым коммитом.

- `appearance-rules.test.ts`:
  - `sourceText` для всех семи видов;
  - `showHead`: без арта → `false`; с артом и `avatarPhoto: true` → `false`; с артом и обликом → `true`; без `appearance` → `false`;
  - `gridColumns(390)` → 2, `gridColumns(768)` → 3.
- `appearance-api.test.ts`:
  - разбор ответа сервера;
  - 409 → `appearance_locked`.
- Тесты рейтинга и друзей зелёные. Строка без `appearance` рисует фото, как
  сейчас.
- `pnpm budget` — первая загрузка не выросла больше чем на 1 КБ: SVG только
  по требованию.

Снимки экрана «Облик», арсенала и рейтинга с головами на 320 и 390 — в PR.

## Аналитика

`appearance_changed` — по шагу 9.

## Настройки и окружение

Нет. Показ — за флагами арта T-0230.

## Документы

По шагу 11.

## Критерии приёмки

- [ ] Экран «Облик» из арсенала и профиля: свои облики можно надеть, у закрытых видно, откуда их взять.
- [ ] Выбранный облик — в арсенале и головой в кружке у себя и у других, у зрителя с артом.
- [ ] Переключатель «Фото из Telegram в кружке» работает и виден другим.
- [ ] Без арта у зрителя всё выглядит, как сейчас.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Облики — экран выбора и голова в аватаре`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: облики героя — Витязь, Ведунья, Охотница, Князь, Навий страж и окрасы Хранителя; выбор в арсенале и профиле, голова облика в кружке аватара`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБЛИКИ В ОБОЛОЧКЕ**

  Экран «Облик» из арсенала и профиля: десять обликов, свои можно надеть, у закрытых видно, откуда их взять. Выбранный облик — в арсенале и головой в кружке аватара у себя и у других; фото из Telegram — по выбору. Видно тем, у кого включён черновой арт: тестерам по флагу, потом всем.
  ```
