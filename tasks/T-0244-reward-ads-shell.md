---
id: T-0244
title: Клиент наградной рекламы — «Удвоить за ролик» в награде дня, самоцветы за ролик в магазине, сообщение о капе
epic: E1
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0243]
zones:
  - packages/app-shell/src/state/daily-double.ts
  - packages/app-shell/src/state/free-gems.ts
  - packages/app-shell/src/screens/meta/free-gems-card.tsx
  - packages/app-shell/src/screens/meta/ad-cap-rules.ts
  - packages/app-shell/test/daily-double.test.ts
  - packages/app-shell/test/free-gems.test.ts
  - packages/app-shell/test/ad-cap-rules.test.ts
shared:
  - packages/app-shell/src/state/daily-api.ts
  - packages/app-shell/src/state/shop-api.ts
  - packages/app-shell/src/state/run-double-api.ts
  - packages/app-shell/src/state/wheel-api.ts
  - packages/app-shell/src/state/ad-continue.ts
  - packages/app-shell/src/screens/meta/daily.tsx
  - packages/app-shell/src/screens/meta/shop.tsx
  - packages/app-shell/src/screens/meta/wheel.tsx
  - packages/app-shell/src/screens/run/RunDouble.tsx
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/gallery.tsx
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0244. Клиент наградной рекламы — «Удвоить за ролик» в награде дня, самоцветы за ролик в магазине, сообщение о капе

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0244.json)](README.md#значки-статуса) [![T-0243](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0243.json&label=T-0243)](T-0243-free-gems-for-ad.md)

## Зачем

Сервер умеет удваивать награду дня (T-0242), давать самоцветы за ролик
(T-0243) и держать дневной кап роликов (T-0241), а игрок этого не видит.
После задачи:
- после забора награды дня есть «Удвоить за ролик»;
- в магазине — карточка «Самоцветы за ролик»;
- если ролики на сегодня кончились, кнопки во всех местах говорят об этом,
  а не пропадают молча.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р155.

Решения `claude-lead-1` от 24.10.2026:

- **Награда дня** (`daily.tsx`). После успешного забора под кнопкой
  «Забрать» — кнопка «Удвоить за ролик · +N монет» по образцу удвоения за
  забег (`RunDouble.tsx`):
  - значок ролика; у VIP — корона и «Удвоить», без ролика;
  - после удвоения — строка «Удвоено: +N монет»;
  - `double.status === "unavailable"` — кнопки нет;
  - сутки сменились — кнопка уходит вместе с наградой (данные перечитываются, как сейчас на смене суток).
- **Магазин** (`shop.tsx`). Карточка `free-gems-card.tsx` первой в разделе
  самоцветов:
  - вид — тот же, что у пакетов, с ценой «Ролик» вместо звёзд;
  - взято — «Завтра снова» с обратным отсчётом до смены суток (та же функция, что у награды дня);
  - `unavailable` — карточки нет.
- **Кап роликов:** `ad.capped === true` (T-0241) — кнопка выключена, с
  подписью «Ролики на сегодня кончились — завтра снова». Подпись — у
  удвоения за забег, колеса, награды дня, самоцветов. У второго шанса за
  ролик при капе остаётся вариант за звёзды. Правило — чистая функция
  `adButtonState(ad)` → `"ready" | "cooldown" | "capped" | "none"`, общая для
  всех мест.
- **Ролик** — `watchAd(place)` и `trackAdReward(place, via)` из
  `state/ad-watch.ts`, как у удвоения за забег. Досмотрел, а сеть оборвалась
  — повтор той же сессией без второго ролика (образец `state/ad-continue.ts`,
  `watched`).
- **«Настройки не отстают»:** новых анимаций нет, кроме существующих
  отклика начисления (#460) — счёт и звук монет, как при заборе.

## Как сейчас

- `screens/run/RunDouble.tsx` и `state/run-double-api.ts` — образец кнопки
  «за ролик» с пропуском VIP.
- `screens/meta/daily.tsx:62–95` — `claim`, кнопка «Забрать» и обратный
  отсчёт `msUntilReset(now, "daily")`; данные — `state/daily-api.ts`.
- `screens/meta/shop.tsx:348–367` — разделы витрины, пакеты самоцветов
  (`kind === "gems"`); данные — `state/shop-api.ts`.
- `screens/meta/wheel.tsx`, `state/wheel-api.ts` — крутка за ролик;
  `state/ad-continue.ts` — второй шанс за ролик.
- После T-0241–T-0243: `ad.capped` в объектах готовности,
  `GET /daily` → `double`, `POST /daily/double`, витрина → `freeGems`,
  `POST /shop/free-gems`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`ad-cap-rules.ts`** — `adButtonState(ad)`.
3. **`state/daily-double.ts`** и схемы в `daily-api.ts` — `double` в
   ответе, `double(sessionId)`; поток «ролик → забор → перечитать».
4. **`state/free-gems.ts`** и схемы в `shop-api.ts` — то же для самоцветов.
5. **`daily.tsx`** — кнопка удвоения; **`free-gems-card.tsx`** и
   **`shop.tsx`** — карточка.
6. **Подпись капа** — `RunDouble.tsx`, `wheel.tsx`, `ad-continue.ts`,
   схемы `run-double-api.ts` и `wheel-api.ts` с необязательным `capped`.
7. **Витрина компонентов** — кнопка удвоения во всех состояниях, карточка
   самоцветов: есть, взято, кап.
8. **Тексты `ru.json`**, дословно:
   - награда дня:
     - `"daily.double.ad": "Удвоить за ролик · +{coins}"`;
     - `"daily.double.vip": "Удвоить · +{coins}"`;
     - `"daily.double.done": "Удвоено: +{coins}"`;
     - `"daily.double.failed": "Не удалось удвоить — попробуйте ещё раз"`;
   - самоцветы в магазине:
     - `"shop.freeGems.title": "Самоцветы за ролик"`;
     - `"shop.freeGems.price": "Ролик"`;
     - `"shop.freeGems.vip": "Бесплатно с VIP"`;
     - `"shop.freeGems.next": "Завтра снова · {time}"`;
     - `"shop.freeGems.failed": "Не удалось получить самоцветы — попробуйте ещё раз"`;
   - кап: `"ads.capped": "Ролики на сегодня кончились — завтра снова"`.
9. **`docs/27`** — строки экранов «Награда дня» и «Магазин» в карте экранов
   §6.

## Чего не трогаем

- Сервер — T-0241–T-0243.
- Межстраничную рекламу и переброс карточек за ролик (T-0199).
- Числа наград.

## Сценарий и интерфейс

Награда дня, 3-й день: «Забрать» → +100 монет со счётом → «Удвоить за ролик
· +100» → ролик → +100 → «Удвоено: +100». Магазин: «Самоцветы за ролик · 5» →
ролик → +5 самоцветов → «Завтра снова · 13:42:10». Двенадцатый ролик за
день досмотрен → в колесе «Ролики на сегодня кончились — завтра снова».

Состояния: загрузка, ошибка ролика (плашка, кнопка снова доступна), нет
сети, VIP (корона, без ролика), гость (кнопок нет). Проверить 320, 390, 768
и ландшафт 667×375 (`tasks/README.md`, «Приёмка»).

## Тесты

Первым коммитом.

- `ad-cap-rules.test.ts`:
  - `capped` → `"capped"`;
  - `readyAt` в будущем → `"cooldown"`;
  - `available` без пропуска → `"ready"`;
  - `available: false` без `capped` → `"none"`;
  - нет поля `capped` (старый сервер) → как раньше.
- `daily-double.test.ts`:
  - разбор `double` во всех трёх статусах;
  - досмотр → `POST /daily/double`;
  - обрыв после досмотра → повтор той же сессией без второго ролика;
  - 409 `daily_already_doubled` → перечитать и показать «Удвоено».
- `free-gems.test.ts` — то же для самоцветов, 409 `free_gems_claimed`.

Снимки награды дня, магазина и колеса с капом на 320 и 390 — в PR.

## Аналитика

`ad_shown` и `ad_reward_claimed` с местами `daily_double` и `free_gems` — через
`watchAd` и `trackAdReward`, как у других мест.

## Настройки и окружение

Нет.

## Документы

По шагу 9.

## Критерии приёмки

- [ ] После забора награды дня её можно удвоить за ролик; VIP — без ролика.
- [ ] В магазине раз в сутки — самоцветы за ролик с отсчётом до следующих.
- [ ] При капе кнопки всех мест «за ролик» выключены с понятной подписью; второй шанс за звёзды остаётся.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Награда дня ×2 и самоцветы за ролик`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: награду дня можно удвоить за ролик`
  - `- новое: в магазине раз в день — самоцветы за ролик`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НАГРАДА ДНЯ ×2 И САМОЦВЕТЫ ЗА РОЛИК**

  После забора награды дня — «Удвоить за ролик», в магазине раз в день — «Самоцветы за ролик». Когда ролики на день кончились (кап в панели), кнопки «за ролик» во всех местах говорят «завтра снова», второй шанс остаётся за звёзды. VIP — без роликов.
  ```
