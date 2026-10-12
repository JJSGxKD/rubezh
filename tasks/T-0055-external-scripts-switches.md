---
id: T-0055
title: Выключатели внешних скриптов клиента в панели — Graspil, учёт аудитории, всё сразу
epic: E14
priority: P1
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/ads/ad-audience.ts
  - backend/api/src/modules/ads/ads.service.ts
  - backend/api/src/modules/client-scripts/**
  - backend/api/test/client-scripts.test.ts
  - backend/api/test/ads.test.ts
  - apps/web-telegram/src/graspil.ts
  - apps/web-telegram/test/graspil.test.ts
  - vitest.config.ts
shared:
  - backend/api/src/app.module.ts
  - docs/30-configuration-map.md
  - docs/22-analytics-and-metrics.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
---

# T-0055. Выключатели внешних скриптов клиента в панели — Graspil, учёт аудитории, всё сразу

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0055.json)](README.md#значки-статуса)

## Зачем

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р93): чужой
скрипт может сломать клиент или затормозить первый экран, и выключать его
надо из панели, без релиза.

Сейчас так нельзя:

- **Graspil** грузится в каждой сборке с ключом `VITE_GRASPIL_KEY` — ключ
  зашит при сборке;
- **SDK учёта аудитории** (Taddy) поднимается у каждого игрока, пока у сети
  есть ключи, — даже если сеть в панели выключена
  (`backend/api/src/modules/ads/ad-audience.ts`, комментарий к классу).

SDK показа рекламы уже выключается: выключенная в разделе «Реклама» сеть
не попадает в показ, и её скрипт клиент не грузит.

## Решения

- **Три настройки** в каталоге, группа «Внешние скрипты клиента»:

  | Ключ | Название | Умолчание |
  |---|---|---|
  | `client.scripts.graspil` | Аналитика Graspil | `true` |
  | `client.scripts.ad-audience` | SDK учёта аудитории рекламных сетей | `true` |
  | `client.scripts.all` | Внешние скрипты клиента | `true` |

  - `client.scripts.all = false` — аварийный выключатель: ни Graspil, ни SDK
    учёта, ни показов рекламы;
  - умолчание `true` — сейчас всё работает так же.
- **Graspil клиент спрашивает у сервера** публичным маршрутом. Ответ не
  пришёл — Graspil не грузится: аналитика необязательна, а выключатель на
  то и нужен, чтобы не тянуть скрипт в сомнении.
- **SDK учёта и показы** выключает сервер: клиент получает пустой список
  сетей и показ без рекламы, как сейчас при отсутствии блоков.

## Как сейчас

- **`backend/api/src/modules/settings/setting-catalog.ts`:**
  - каталог `SETTINGS`;
  - образец булевой настройки — `adsTestMode` (`ads.test-mode`): `kind: "boolean"`,
    `schema: z.boolean()`, `fromEnv: () => null`;
  - чтение — `SettingsService.get(SETTINGS.<ключ>)`.
- **`backend/api/src/modules/ads/ad-audience.ts`** — `launchSetup(platform)`:
  сети с `trackAudience` и ключами.
- **`backend/api/src/modules/ads/ads.service.ts`** — `offer(viewer, place, now, moment)`:
  выдача показа. Ветка без подходящего блока уже есть — найди, что `offer`
  возвращает, когда ротации нечего отдать.
- **Публичный маршрут** — образец `backend/api/src/modules/media/media.controller.ts`:
  - `@Public()`;
  - лимит по адресу через `RateLimiter`; адрес — `addressOf(request)` из `common/request-address.ts`, как в маршрутах T-0022;
  - `RateLimitedError`.
- **`apps/web-telegram/src/graspil.ts`** — `loadGraspil(key)` ставит
  прослойку `Telegram.WebApp`, очередь и скрипт. Зовётся из `main.tsx` после
  запуска оболочки.
- **`vitest.config.ts`** — в `include` нет `apps/web-telegram/test`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`setting-catalog.ts`:**
   - группа `const CLIENT_SCRIPTS_GROUP = "Внешние скрипты клиента"`;
   - три настройки из таблицы «Решений», по образцу `adsTestMode`,
     `fromEnv: () => null`;
   - подсказки (`hint`) дословно:
     - `client.scripts.graspil` — «Сторонняя аналитика Mini App. Выключено —
       клиент не грузит её скрипт: на случай, если он ломает игру или
       тормозит первый экран. Вступает в силу при следующем запуске
       игры»;
     - `client.scripts.ad-audience` — «SDK рекламных сетей, которые
       поднимаются при запуске для учёта аудитории (Taddy). Выключено — сети
       не видят игроков, и рекламы от них может стать меньше. Показы рекламы
       выключаются в разделе «Реклама» у каждой сети»;
     - `client.scripts.all` — «Аварийный выключатель: выключено — клиент не
       грузит ни одного чужого скрипта — ни аналитики, ни SDK учёта, ни
       рекламы. Для случая, когда чужой скрипт уронил игру, а какой — ещё
       не ясно».
3. **Новый модуль `backend/api/src/modules/client-scripts/`** — по скиллу
   `new-backend-module`, без репозитория:
   - `client-scripts.service.ts`, `ClientScripts`:
     - `graspil(): boolean` — `all && graspil`;
     - `adAudience(): boolean` — `all && ad-audience`;
     - `ads(): boolean` — `all`;
   - `client-scripts.controller.ts`:
     - `GET /api/v1/client/scripts`, `@Public()`;
     - лимит 60 в минуту по адресу, scope `client-scripts`;
     - ответ `{ data: { graspil: boolean } }`;
     - заголовок `Cache-Control: public, max-age=60`: ответ одинаков у
       всех, и CDN (`docs/20-env-and-ports.md` §2.2) снимает его с сервера;
   - `client-scripts.module.ts` экспортирует `ClientScripts`; строка в
     `app.module.ts`.
4. **`ad-audience.ts`** — `launchSetup` при `!adAudience()` возвращает `[]`.
   Комментарий к классу дополнить: учёт выключается и настройкой
   `client.scripts.ad-audience`.
5. **`ads.service.ts`** — `offer` при `!ads()` отвечает той же веткой, что
   «нечего показать», до выбора блока. Сессия показа не заводится.
6. **`apps/web-telegram/src/graspil.ts`:**
   - чистая функция:

     ```ts
     /** Грузить ли Graspil по ответу сервера: только явное «да»; сбой, не тот ответ — нет. */
     export function graspilAllowed(body: unknown): boolean;
     ```

     По схеме `z.object({ data: z.object({ graspil: z.boolean() }) })`;
   - в `loadGraspil(key)`, после проверки пустого ключа и до прослойки:
     - `fetch("/api/v1/client/scripts", { signal: AbortSignal.timeout(5000) })`;
     - ответ — в `graspilAllowed`;
     - `false` или исключение — `console.info("Graspil выключен в панели или сервер не ответил — не грузим")`
       и выход.
7. **`vitest.config.ts`** — в `include` строка
   `"apps/web-telegram/test/**/*.test.ts"` с комментарием: логика клиента
   Telegram без DOM.
8. **Документы** — раздел «Документы».

## Чего не трогаем

- Включённость сетей и блоков в разделе «Реклама».
- Ключи сетей и ключ `VITE_GRASPIL_KEY`.
- Прослойку `webapp-compat.ts`.

## Тесты

Первым коммитом.

- **`backend/api/test/client-scripts.test.ts`:**
  - все три включены → `graspil()`, `adAudience()`, `ads()` — `true`;
  - `graspil` выключен → `graspil()` — `false`, остальные — `true`;
  - `all` выключен → все три — `false`, даже при включённых остальных;
  - HTTP:
    - `GET /api/v1/client/scripts` без токена — 200 и `{ data: { graspil } }`;
    - есть заголовок `Cache-Control: public, max-age=60`;
    - 61-й запрос с одного адреса за минуту — 429.
- **`backend/api/test/ads.test.ts`** — дописать к тестам `launchSetup`:
  - при `client.scripts.ad-audience = false` `launchSetup` → `[]`, хотя
    ключи Taddy заданы;
  - при `all = false` — тоже `[]`.
- **Выдача показа:** при `client.scripts.all = false` `offer` отвечает
  «нечего показать» и не заводит сессию — тест рядом с тестами `offer`.
- **`apps/web-telegram/test/graspil.test.ts`** — `graspilAllowed`:
  - `{ data: { graspil: true } }` → `true`;
  - `{ data: { graspil: false } }` → `false`;
  - `null`, `{}`, `{ data: { graspil: "yes" } }` → `false`.

## Аналитика

Нет: выключатель — настройка, её смена уже пишется в аудит панели.

## Настройки и окружение

Три настройки каталога — раздел «Решения». Окружения нет.

## Документы

- **`docs/30-configuration-map.md`** — три строки в таблице настроек
  без релиза: ключ, что меняет, умолчание.
- **`docs/22-analytics-and-metrics.md` §9 (Graspil)** — строка: Graspil
  выключается из панели настройкой `client.scripts.graspil` или
  `client.scripts.all`; клиент спрашивает `GET /api/v1/client/scripts`, без
  ответа не грузит.

## Критерии приёмки

- [ ] В панели «Настройки» — группа «Внешние скрипты клиента» из трёх
  переключателей с подсказками.
- [ ] Graspil выключен или сервер не ответил — клиент не грузит его скрипт.
- [ ] Учёт аудитории выключен — `GET /api/v1/ads/networks` отдаёт пустой
  список сетей.
- [ ] Всё выключено — ещё и показы отвечают «нечего показать».
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Выключатели внешних скриптов клиента`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВЫКЛЮЧАТЕЛИ ВНЕШНИХ СКРИПТОВ**

  Чужие скрипты клиента выключаются из панели без релиза: аналитика Graspil, SDK учёта аудитории рекламных сетей или всё сразу — на случай, если скрипт ломает игру или тормозит первый экран. Настройки — «Настройки» → «Внешние скрипты клиента».
  ```
