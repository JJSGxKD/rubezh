---
id: T-0246
title: «Набор хранителя» — клиент: предложение после первой победы и карточка в магазине с отсчётом
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0245, T-0124, T-0238]
zones:
  - packages/app-shell/src/screens/meta/keeper-set-card.tsx
  - packages/app-shell/src/screens/run/KeeperSetOffer.tsx
  - packages/app-shell/src/screens/meta/keeper-set-rules.ts
  - packages/app-shell/test/keeper-set-rules.test.ts
shared:
  - packages/app-shell/src/state/shop-api.ts
  - packages/app-shell/src/screens/meta/shop.tsx
  - packages/app-shell/src/screens/run/DeathOverlay.tsx
  - packages/app-shell/src/screens/meta/appearance-art.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/gallery.tsx
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/meta-v2.md
batch: 4
---

# T-0246. «Набор хранителя» — клиент: предложение после первой победы и карточка в магазине с отсчётом

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0246.json)](README.md#значки-статуса) [![T-0245](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0245.json&label=T-0245)](T-0245-keeper-set-server.md) [![T-0124](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0124.json&label=T-0124)](T-0124-rubezh-banners-and-death-screen.md) [![T-0238](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0238.json&label=T-0238)](T-0238-appearance-shell.md)

> **Облик готов** (`design/art/backlog.md`, п. 12, 26.10.2026): кадры
> `hero-dawn/…` в атласе `atlas-skin-dawn`, портреты `design/art/out/portrait-hero-dawn.svg`,
> `card-hero-dawn.svg` и голова `avatar-hero-dawn.svg`; портрет для картинок
> бота — `HERO_PORTRAITS.dawn` в `backend/api/src/common/card/brand-art.ts`.

## Зачем

Сервер (T-0245) открывает «Набор хранителя» на 48 часов после первой победы
над Рубежом. Игрок должен увидеть набор в момент победы и найти его потом в
магазине. После задачи итоги первой победы предлагают набор, а в магазине
до конца окна стоит карточка с портретом окраса и отсчётом.

## Решения

Решения владельца — `docs/35-stage4-plan.md` Р155 и поправка 24.10.2026
(«только 48 часов», без зачёркнутой цены).

Решения `claude-lead-1` от 24.10.2026:

- **Предложение в итогах** (`KeeperSetOffer.tsx`) — один раз, в итогах
  первого забега с победой над Рубежом (T-0124), под баннером Рубежа:
  - портрет `card-hero-dawn.svg` и строка «330 самоцветов + окрас «Хранитель · рассвет»»;
  - кнопка «250 ⭐» и подпись «Только 48 часов»;
  - «Не сейчас» закрывает.

  Показ запоминается локально (ключ `keeperSet.offered`): во второй раз
  набор живёт только в магазине.
- **Карточка в магазине** (`keeper-set-card.tsx`) — первой в разделе
  предложений, пока позиция есть в витрине: портрет, содержимое, цена, отсчёт
  до `until` («осталось 47:12:05»). Цены и проценты не зачёркиваются.
- **Портрет до покупки обязателен** (Р11): нет портрета в `appearance-art.ts`
  — карточку и предложение не показывать.
- **Покупка** — существующий путь заказа за звёзды магазина
  (`state/shop-purchase.ts`). После оплаты — отклик начисления (#460) и
  строка «Окрас в «Облике»».

## Как сейчас

- `screens/meta/shop.tsx:348–353` — раздел предложений, `SectionTitle`;
  покупка — `state/shop-purchase.ts`; витрина — `state/shop-api.ts`.
- После T-0124 — баннер Рубежа в итогах (`DeathOverlay.tsx`,
  `RubezhResult.tsx`). После T-0238 — `appearance-art.ts`.
- После T-0245 у позиции витрины `keeper_set` есть `until`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`keeper-set-rules.ts`:** `remaining(until, now)` → текст отсчёта и
   флаг «кончилось»; `shouldOffer(firstWin, offered, hasArt)`.
3. **`shop-api.ts`** — `until` и `appearance` в схеме позиции.
4. **Карточка и предложение** по «Решениям»; кончилось окно — карточка
   исчезает без перезагрузки.
5. **Витрина компонентов** — карточка и предложение.
6. **Событие** `offer_shown` — клиентское, поле `offer: "keeper_set"` и `place` (`results` или `shop`). Сначала `docs/22` §3.3 и Zod, потом `state/analytics.ts`.
7. **Тексты `ru.json`**, дословно:
   - `"keeperSet.title": "Набор хранителя"`;
   - `"keeperSet.contents": "330 самоцветов + окрас «Хранитель · рассвет»"`;
   - `"keeperSet.only": "Только 48 часов"`;
   - `"keeperSet.left": "Осталось {time}"`;
   - `"keeperSet.later": "Не сейчас"`;
   - `"keeperSet.bought": "Окрас — в «Облике»"`.
8. **`docs/27`** — строка «Магазин» и строка итогов забега.

## Чего не трогаем

- Сервер и окно — T-0245. Акции магазина.

## Сценарий и интерфейс

Первая победа над Рубежом → итоги → под баннером «Набор хранителя · только
48 часов · 250 ⭐» → «Не сейчас» → магазин → карточка с отсчётом «осталось
47:58:12». Проверить 320, 390, 768, ландшафт 667×375.

## Тесты

Первым коммитом, `keeper-set-rules.test.ts`:
- `remaining`: за 2 ч → «02:00:00»; прошло → «кончилось»;
- `shouldOffer`: первая победа без показа → да; уже показывали → нет; без
  портрета → нет.

Снимки итогов и магазина — в PR.

## Аналитика

`offer_shown` — по шагу 6; покупка — существующие события оплаты.

## Настройки и окружение

Нет.

## Документы

По шагу 8.

## Критерии приёмки

- [ ] После первой победы итоги один раз предлагают набор; в магазине он виден до конца окна с отсчётом.
- [ ] Без портрета окраса предложения нет.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Набор хранителя`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: после первой победы над Рубежом — «Набор хранителя» на 48 часов: самоцветы и окрас «Хранитель · рассвет»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НАБОР ХРАНИТЕЛЯ**

  После первой победы над Рубежом итоги предлагают «Набор хранителя», а в магазине 48 часов стоит его карточка с отсчётом: 330 самоцветов и окрас «Хранитель · рассвет» за 250 звёзд. Событие offer_shown покажет, сколько игроков набор увидели.
  ```
