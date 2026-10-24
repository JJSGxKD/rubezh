---
id: T-0250
title: VIP в подарок — клиент: «Подарить VIP» в карточке друга, уведомление получателю
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0249, T-0248]
zones:
  - packages/app-shell/src/state/vip-gift.ts
  - packages/app-shell/src/screens/meta/vip-gift-sheet.tsx
  - packages/app-shell/test/vip-gift.test.ts
shared:
  - packages/app-shell/src/screens/meta/player-card.tsx
  - packages/app-shell/src/screens/meta/player-card-rules.ts
  - packages/app-shell/src/screens/meta/notifications.tsx
  - packages/app-shell/src/state/notifications-api.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/i18n/ru.json
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 4
---

# T-0250. VIP в подарок — клиент: «Подарить VIP» в карточке друга, уведомление получателю

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0250.json)](README.md#значки-статуса) [![T-0249](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0249.json&label=T-0249)](T-0249-vip-gift-server.md) [![T-0248](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0248.json&label=T-0248)](T-0248-player-card-shell.md)

## Зачем

Сервер (T-0249) продаёт VIP в подарок, но кнопки нет. После задачи в
карточке друга есть «Подарить VIP». Лист показывает, что получит друг, и
цену, а оплата идёт звёздами. Получатель видит в уведомлениях, кто и что ему
подарил.

## Решения

Решения владельца — `docs/35-stage4-plan.md` Р155 и поправка 24.10.2026: VIP
в подарок из карточки, только друзьям.

Решения `claude-lead-1` от 24.10.2026:

- **Кнопка** «Подарить VIP» — в карточке (T-0248), только при `relation:
  "friend"` и на площадке с оплатой звёздами (как кнопка VIP в магазине).
  Рядом с «Вы друзья».
- **Лист** `vip-gift-sheet.tsx`:
  - заголовок «VIP для {name} на 30 дней»;
  - что получит друг — те же строки выгод, что на экране VIP магазина, без копии текстов: общий список ключей;
  - кнопка «{stars} ⭐», ниже — «Подарок не продлевается сам».
- **Оплата** — существующий путь счёта Stars (`state/shop-purchase.ts`):
  `POST /vip/gift { publicId }` → счёт → ожидание подтверждения.
  - Успех — «Подарок отправлен» и отклик начисления (#460) без чисел.
  - Отмена — тихо закрыть.
  - 409 `vip_gift_not_friend` — «Подарить можно только другу».
- **Уведомление получателю** — вид `vip_gift` в списке уведомлений:
  значок короны, «{name} подарил вам VIP на {days} дней», нажатие ведёт на
  экран VIP.

## Как сейчас

- После T-0248 — `player-card.tsx`, `player-card-rules.ts` (`actionFor`).
- Покупка звёздами — `state/shop-purchase.ts`; экран VIP и его выгоды — в
  магазине.
- Уведомления — `screens/meta/notifications.tsx`, `state/notifications-api.ts`;
  виды по образцу `friend_gift`.
- После T-0249 — `POST /vip/gift`, вид уведомления `vip_gift`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`state/vip-gift.ts`** — заказ и ожидание подтверждения, коды ошибок.
3. **Лист и кнопка** в карточке; `actionFor` получает вторую кнопку для
   друга.
4. **Уведомление** `vip_gift` — схема в `notifications-api.ts`, строка в
   `notifications.tsx`.
5. **Событие** `vip_gift_ordered` — клиентское, без полей. Сначала `docs/22`
   §3.3 и Zod, потом `state/analytics.ts`.
6. **Тексты `ru.json`**, дословно:
   - кнопка и лист: `"vipGift.button": "Подарить VIP"`, `"vipGift.title": "VIP для {name} на 30 дней"`, `"vipGift.noRenew": "Подарок не продлевается сам"`;
   - итог: `"vipGift.sent": "Подарок отправлен"`, `"vipGift.notFriend": "Подарить можно только другу"`, `"vipGift.failed": "Не удалось оформить подарок — попробуйте ещё раз"`;
   - уведомление: `"notifications.vip_gift": "{name} подарил вам VIP на {days} дней"`.
7. **`docs/27`** — строка «Карточка игрока».

## Чего не трогаем

- Сервер — T-0249. Облик в подарок — с Ярмаркой.

## Сценарий и интерфейс

Друзья → тап по другу → карточка → «Подарить VIP» → лист «VIP для Ани на 30
дней · 700 ⭐» → оплата → «Подарок отправлен». У Ани в уведомлениях: «Вася
подарил вам VIP на 30 дней» → нажатие → экран VIP.

Состояния: ожидание оплаты, отмена, ошибка, нет сети; площадка без звёзд —
кнопки нет. Проверить 320, 390, ландшафт 667×375.

## Тесты

Первым коммитом, `vip-gift.test.ts`:
- успех → «отправлен»;
- отмена счёта → тихо;
- 409 `vip_gift_not_friend` → текст;
- `actionFor("friend")` с оплатой → две кнопки, без оплаты → одна.

## Аналитика

`vip_gift_ordered` — по шагу 5; оплата — события `purchase_*` сервера.

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] В карточке друга — «Подарить VIP»; лист показывает выгоды и цену; оплата звёздами.
- [ ] Получатель видит уведомление о подарке.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): VIP в подарок другу`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: VIP можно подарить другу — из его карточки`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — VIP В ПОДАРОК**

  В карточке друга появилась кнопка «Подарить VIP»: лист показывает, что получит друг, оплата — звёздами. Друг видит уведомление «вам подарили VIP».
  ```
