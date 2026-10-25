---
id: T-0251
title: VIP глазами других — золотая галочка у аватара в списках и карточке, «Что увидят другие» на экране VIP
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0250]
zones:
  - packages/app-shell/src/screens/meta/vip-preview.tsx
  - packages/app-shell/test/vip-mark.test.ts
shared:
  - backend/api/src/common/public-identity.ts
  - backend/api/src/modules/achievements/emblems.service.ts
  - packages/shared-types/src/index.ts
  - packages/app-shell/src/design-system/components/Data.tsx
  - packages/app-shell/src/screens/meta/rating.tsx
  - packages/app-shell/src/screens/meta/friends-parts.tsx
  - packages/app-shell/src/screens/meta/player-card.tsx
  - packages/app-shell/src/screens/meta/shop.tsx
  - packages/app-shell/src/state/runs-api.ts
  - packages/app-shell/src/state/friends-api.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/gallery.tsx
  - backend/api/test/public-identity.integration.test.ts
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/mockups/identity-v2.html
batch: 4
---

# T-0251. VIP глазами других — золотая галочка у аватара в списках и карточке, «Что увидят другие» на экране VIP

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0251.json)](README.md#значки-статуса) [![T-0250](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0250.json&label=T-0250)](T-0250-vip-gift-shell.md)

## Зачем

Статус продаётся, когда его видно. VIP сейчас даёт выгоды только самому
игроку, а другие его не замечают. После задачи:
- у VIP в рейтинге, у друзей и в карточке у аватара золотая галочка;
- на экране VIP в магазине — «Что увидят другие»: карточка игрока с
  Князем, галочкой и знаком VIP, ещё до покупки.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- **Р155** — VIP виден другим: облик «Князь», золотая галочка, рамка, в
  магазине — «что увидят другие»;
- **Р47** — золотая галочка у аватара — VIP.

Решения `claude-lead-1` от 24.10.2026:

- **Поле `vip?: true`** — в `PublicMark` (порт T-0240). Источник — тот же
  метод списка VIP, что считает знак VIP (T-0235), запросов не добавляет.
  Строки рейтинга, сезона и друзей несут его тем же вызовом.
- **Галочка** — у `Avatar` (`Data.tsx`) новое свойство `vip`:
  - золотой кружок со значком галочки (тон `elite`, обводка цветом фона), справа снизу, 30 % размера аватара;
  - `aria-label` «VIP»;
  - в узкой строке (36 px) галочка остаётся (`meta-v2.md` §1.4).
- **«Что увидят другие»** — блок `vip-preview.tsx` на экране VIP в магазине:
  - уменьшенная карточка игрока (сцена, имя, знак) с его же именем;
  - облик — Князь, галочка и знак «VIP» — как будут видны другим;
  - без арта у зрителя — `Avatar` с галочкой и знак, без портрета.
- **Рамка аватара** по VIP — не делаем: рамка — дивизион сезона (Р47), а
  дивизионов пока нет.

## Как сейчас

- `design-system/components/Data.tsx:118` — `Avatar`; после T-0238 — с
  головой облика.
- После T-0240 и T-0247 — `PublicMark` с `emblem`, `appearance`,
  `publicId`; карточка T-0248.
- Экран VIP — в магазине (`shop.tsx`).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Сервер:** `vip` в `PublicMark` из `emblems.service.ts`; `shared-types` —
   поле у строк; интеграционный тест порта дополнить.
3. **`Avatar`** — свойство `vip`; рейтинг, друзья и карточка передают его.
4. **`vip-preview.tsx`** и место на экране VIP.
5. **Витрина компонентов** — аватары 36, 48 и 96 px с галочкой и без.
6. **Тексты `ru.json`**: `"vip.mark": "VIP"`, `"vip.preview.title": "Что
   увидят другие"`.
7. **`docs/27`** — `Avatar` в §4.6 (галочка VIP), строка экрана VIP.

## Чего не трогаем

- Синюю галочку доверенного аккаунта (Р47) — критерий не решён (О29).
- Рамку дивизиона.

## Сценарий и интерфейс

VIP в рейтинге — золотая галочка у кружка. Не-VIP открывает экран VIP и
видит «Что увидят другие»: свою карточку с Князем, галочкой и «VIP» под
именем. Проверить 320 и 390: галочка не закрывает лицо на 36 px.

## Тесты

Первым коммитом.

- `vip-mark.test.ts`:
  - `Avatar` с `vip` рисует галочку с `aria-label`, без `vip` — нет;
  - строка без поля `vip` (старый сервер) — без галочки.
- `public-identity.integration.test.ts`: VIP активен → `vip: true`; истёк —
  поля нет.

## Аналитика

Нет: вид, а не действие. Влияние — по покупкам VIP после открытия экрана
(`purchase_*`).

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Золотая галочка у VIP в рейтинге, у друзей и в карточке.
- [ ] Экран VIP показывает «Что увидят другие» до покупки.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): VIP виден другим`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: у VIP золотая галочка у аватара в рейтинге и у друзей`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — VIP ГЛАЗАМИ ДРУГИХ**

  У VIP в рейтинге, у друзей и в карточке — золотая галочка у аватара. На экране VIP в магазине блок «Что увидят другие»: своя карточка с Князем, галочкой и знаком VIP ещё до покупки.
  ```
