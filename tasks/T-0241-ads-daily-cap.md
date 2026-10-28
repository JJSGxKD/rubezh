---
id: T-0241
title: Дневной кап роликов на все места — реклама не становится работой
epic: E1
priority: P1
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0199]
zones:
  - backend/api/test/ads-daily-cap.test.ts
  - backend/api/test/ads-daily-cap.integration.test.ts
shared:
  - backend/api/src/modules/ads/ads-rules.ts
  - backend/api/src/modules/ads/ads.service.ts
  - backend/api/src/modules/ads/ads.repository.ts
  - backend/api/src/modules/ads/ads-errors.ts
  - backend/api/src/modules/ads/ads.controller.ts
  - backend/api/src/modules/progress/run-double.service.ts
  - backend/api/src/modules/wheel/wheel.service.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - apps/admin/src/ui/help.ts
  - docs/07-monetization-and-ads.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0241. Дневной кап роликов на все места — реклама не становится работой

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0241.json)](README.md#значки-статуса) [![T-0199](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0199.json&label=T-0199)](T-0199-reroll-for-ad.md)

## Зачем

Кулдаун у каждого места свой: колесо, удвоение за забег, второй шанс. Вместе
с новыми местами (T-0242, T-0243) роликов в день станет слишком много, и
реклама превратится в работу. После задачи у роликов за награду есть общий
кап на игровые сутки: досмотрел N — до завтра кнопки «за ролик» не
предлагаются. Число меняется в панели без релиза.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р155: новые места
наградной рекламы — под общим дневным капом роликов на все места, числа — в
панели (Р79).

Решения `claude-lead-1` от 24.10.2026:

- **Что считается:** досмотренные ролики за награду в текущие игровые сутки
  (`common/game-day.ts`) — во всех местах с `rewarded: true`, кроме `task`.
  - Задание сети — не ролик, его делают руками.
  - Межстраничная без награды в кап не входит, её держит своя политика.
  - Сессии пропуска VIP (`createPassSession`) — не ролики, не считаются.
- **Ключ панели** `ads.rewarded.daily-cap` в `setting-catalog.ts`: целое,
  по умолчанию **12** (`design/art/meta-v2.md` §7.2), от 0. 0 — без капа.
- **Упёрся в кап:**
  - `readiness` отдаёт `available: false` и новое поле `capped: true`;
  - `POST /ads/sessions` для такого места — 409 `ad_daily_cap`;
  - VIP с пропуском (`pass` не `null`) получает награду без ролика и в кап
    не упирается.
- **Поле `capped`** доходит до клиента во всех ответах с готовностью места —
  у удвоения за забег (`run-double.service.ts`, объект `ad`) и у колеса.
  Клиенту оно нужно, чтобы сказать «ролики на сегодня кончились», а не
  молча спрятать кнопку (T-0244).
- **Второй шанс за ролик — тоже под капом.** Упёрся — остаётся второй шанс
  за звёзды, как сейчас без рекламы.

## Как сейчас

- `ads/ads-rules.ts` — `AD_PLACES`, `PLACE_RULES` (`rewarded`, `pass`,
  `cooldown`), `nextRewardAt`, `placeState`.
- `ads/ads.service.ts:309` — `readiness(viewer, place, at)` →
  `{ available, readyAt, pass }`; история места —
  `repository.history(accountId, place, at)` (сессии с начала суток).
- `ads/ads.repository.ts:142,288` — `history`, `historyWithin`;
  `createSession`, `createPassSession`.
- `progress/run-double.service.ts` — `view` отдаёт `ad: { available,
  readyAt, pass }`; колесо — `wheel/wheel.service.ts` так же.
- Ключи панели рекламы — `settings/setting-catalog.ts`, около стр. 337–410
  (`ads.interstitial.*`).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`ads-rules.ts`** — `CAPPED_PLACES` (места с `rewarded: true`, кроме
   `task`) и чистая `dailyCapReached(watchedToday, cap)` (`cap === 0` →
   `false`).
3. **`ads.repository.ts`** — `rewardedWatchedToday(accountId, at)`: одним
   запросом — число досмотренных сессий мест из `CAPPED_PLACES` с начала
   игровых суток, без сессий пропуска. Граница суток — та же, что в
   `historyWithin`.
4. **`ads.service.ts`:**
   - `readiness` → `capped`;
   - создание сессии при капе — `AdDailyCapError` (409, `ad_daily_cap`, в `ads-errors.ts`);
   - ключ читается из каталога настроек, как соседние `ads.*`.
5. **`run-double.service.ts` и `wheel.service.ts`** — `capped` в объекте
   `ad`.
6. **Панель:** подсказка ключа в `help.ts` — «Сколько роликов за награду
   игрок смотрит за игровые сутки во всех местах вместе. 0 — без капа».
7. **Документы:** `docs/07` (раздел наградной рекламы — общий кап),
   `docs/30` (строка ключа).

## Чего не трогаем

- Кулдауны мест (`PLACE_RULES.cooldown`) — работают как раньше, кап поверх.
- Межстраничную и её политику.
- Клиент — T-0244.

## Тесты

Первым коммитом.

- `backend/api/test/ads-daily-cap.test.ts` (чистые):
  - `dailyCapReached(11, 12)` → `false`; `(12, 12)` → `true`; `(100, 0)` → `false`;
  - `CAPPED_PLACES` без `task` и `interstitial`.
- `backend/api/test/ads-daily-cap.integration.test.ts` (живые Postgres и Redis):
  - 12 досмотренных роликов в разных местах → `readiness` колеса `available: false`, `capped: true`; `POST /ads/sessions` → 409 `ad_daily_cap`;
  - сессии пропуска VIP и задания сети в счёт не идут;
  - VIP с пропуском при 12 роликах — награда места проходит;
  - новые игровые сутки — кап снова пуст;
  - ключ панели 3 → кап на третьем; 0 → кап выключен;
  - `GET` удвоения за забег несёт `ad.capped`.

## Аналитика

Новых событий нет: досмотры уже в `ad_session` и `ad_shown`. Кап в
«Рекламе» панели видно по распределению роликов на игрока в сутки.

## Настройки и окружение

Ключ `ads.rewarded.daily-cap` — по шагу 4, строка в `docs/30`.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] После N роликов за награду в сутки места «за ролик» недоступны с `capped: true`; сессию не создать.
- [ ] Пропуск VIP, задания сети и межстраничная в кап не входят.
- [ ] N меняется в панели; 0 — без капа.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(ads): Дневной кап роликов на все места`
- **Метка:** `release: minor`
- **Для игроков:** пусто — сообщение о капе придёт с клиентом (T-0244).
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДНЕВНОЙ КАП РОЛИКОВ**

  У роликов за награду общий кап на игровые сутки по всем местам: колесо, удвоение, второй шанс и новые места. По умолчанию — 12, ключ ads.rewarded.daily-cap в панели, 0 — без капа. VIP с пропуском, задания сетей и межстраничная в кап не входят.
  ```
