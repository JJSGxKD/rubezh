---
id: T-0332
title: Тексты сервера и бота для игрока на «ты» — ошибки, ответы оплаты, сообщения бота; тест по исходникам
epic: E6
priority: P2
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/test/player-address.test.ts
shared:
  - backend/api/src/platforms/telegram/bot-commands.ts
  - backend/api/src/platforms/telegram/bot-fallback.ts
  - backend/api/src/modules/notifications-bot/bot-notify-texts.ts
  - backend/api/src/modules/friends/friend-notifier.ts
  - backend/api/src/modules/friends/friend-invite.service.ts
  - backend/api/src/modules/friends/friends.service.ts
  - backend/api/src/modules/friends/friends.controller.ts
  - backend/api/src/modules/payments/checkout-answer.ts
  - backend/api/src/modules/payments/payments-errors.ts
  - backend/api/src/modules/payments/payments.controller.ts
  - backend/api/src/modules/auth/auth.service.ts
  - backend/api/src/modules/auth/auth.controller.ts
  - backend/api/src/modules/auth/auth.guard.ts
  - backend/api/src/modules/tasks/tasks-errors.ts
  - backend/api/src/modules/tasks/tasks.controller.ts
  - backend/api/src/modules/promo-codes/promo-code-errors.ts
  - backend/api/src/modules/promo-codes/promo-codes.controller.ts
  - backend/api/src/modules/ads/ads-errors.ts
  - backend/api/src/modules/ads/ads.controller.ts
  - backend/api/src/modules/items/items.service.ts
  - backend/api/src/modules/items/items.controller.ts
  - backend/api/src/modules/restrictions/restrictions-errors.ts
  - backend/api/src/modules/restrictions/restrictions.controller.ts
  - backend/api/src/modules/runs/runs.controller.ts
  - backend/api/src/modules/runs/run-ad-continue.controller.ts
  - backend/api/src/modules/shop/shop-errors.ts
  - backend/api/src/modules/shop/shop.controller.ts
  - backend/api/src/modules/vip/vip-errors.ts
  - backend/api/src/modules/vip/vip.controller.ts
  - backend/api/src/modules/links/link-page.ts
  - backend/api/src/modules/feedback/feedback.service.ts
  - backend/api/src/modules/events/events.service.ts
  - backend/api/src/modules/diagnostics/diagnostics.service.ts
  - backend/api/src/modules/ingest/ingest.guard.ts
  - backend/api/src/modules/wipe/compensation.controller.ts
  - backend/api/src/modules/account-settings/account-settings.controller.ts
  - backend/api/src/modules/badges/badges.controller.ts
  - backend/api/src/modules/boosts/boosts.controller.ts
  - backend/api/src/modules/bot-mention/bot-mention.controller.ts
  - backend/api/src/modules/changelog/changelog.controller.ts
  - backend/api/src/modules/client-scripts/client-scripts.controller.ts
  - backend/api/src/modules/csp-reports/csp-reports.controller.ts
  - backend/api/src/modules/daily/daily.controller.ts
  - backend/api/src/modules/donations/donations.controller.ts
  - backend/api/src/modules/flags/flags.controller.ts
  - backend/api/src/modules/history/history.controller.ts
  - backend/api/src/modules/home/home.controller.ts
  - backend/api/src/modules/media/media.controller.ts
  - backend/api/src/modules/messaging/messaging.controller.ts
  - backend/api/src/modules/notifications/notifications.controller.ts
  - backend/api/src/modules/online/online.controller.ts
  - backend/api/src/modules/progress/progress.controller.ts
  - backend/api/src/modules/progress/run-double.controller.ts
  - backend/api/src/modules/referrals/referrals.controller.ts
  - backend/api/src/modules/roles/roles.controller.ts
  - backend/api/src/modules/seasons/seasons.controller.ts
  - backend/api/src/modules/test-notice/test-notice.controller.ts
  - backend/api/src/modules/wallet/wallet.controller.ts
  - backend/api/src/modules/wheel/wheel.controller.ts
  - backend/api/test/*.test.ts
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 2
---

# T-0332. Тексты сервера и бота для игрока на «ты» — ошибки, ответы оплаты, сообщения бота; тест по исходникам

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0332.json)](../README.md#значки-статуса)

## Зачем

Сервер говорит с игроком на «вы»: «Слишком часто — попробуйте позже», «{имя}
зовёт вас в друзья», «Счёт устарел — откройте покупку в игре заново». Владелец
решил: к игроку — на «ты», везде. После задачи всё, что сервер и бот говорят
игроку, — на «ты» и без рода игрока, а тест по исходникам не даёт вернуть «вы».
Оболочка — T-0331.

## Решения

- Владелец, 26.10.2026 — `docs/35-stage4-plan.md` Р163: к игроку — на «ты»
  везде; панель и инструменты команды — не игра, их не трогаем.
- Правила текста — скилл `ui-design`, `.claude/skills/ui-design/ux-writing.md`
  §1: «ты» без рода игрока — не «ты уже получил», а «уже получено».
- Решение `claude-lead-1`: тест разбирает исходники компилятором TypeScript
  (`ts.createSourceFile`) и проверяет только строковые литералы и куски
  шаблонных строк — комментарии и имена не проверяются. Тексты команды
  исключаются списком путей и поимённым списком строк в самом тесте.
- Коды ошибок (`ad_cooldown`, `task_not_joined`…) и HTTP-статусы не
  меняются — только текст сообщения.

## Как сейчас

Около 90 литералов на «вы» в `backend/api/src`. Найти все:

```
rg -n -i '"[^"]*\b(вы|вас|вам|ваш\p{L}*|\p{L}+ите|\p{L}+йте)\b[^"]*"|`[^`]*\b(вы|вас|вам|ваш\p{L}*|\p{L}+ите|\p{L}+йте)\b[^`]*`' backend/api/src
```

Большинство — одна строка лимита частоты в контроллерах игрока: «Слишком
часто — попробуйте позже» → «Слишком часто — попробуй позже»,
«— подождите» → «— подожди». Глаголы — по таблице T-0331 («Как сейчас»).

**Тексты команды — не трогаем** (это и есть список исключений теста):

| Что | Почему |
|---|---|
| `modules/admin/**`, `modules/broadcasts/**`, `modules/export/**`, `modules/secrets/**`, `modules/settings/**` | панель и инструменты команды |
| `platforms/telegram/panel-login.command.ts`, `role-confirm.command.ts` | вход в панель и выдача ролей — команде |
| `cli/**`, `config/**`, `infra/**`, `health/**` | консоль и окружение сервера |
| `modules/wipe/**`, кроме `compensation.controller.ts` | вайп запускает команда |
| `ads/ads-catalog.service.ts`, `ads/ad-networks.ts`, `ads/adsgram-reward.controller.ts` | настройка сетей в панели; колбэк сети — не игроку |
| `restrictions/restriction-rules.ts`, `media/image-rules.ts`, `media/media-errors.ts` | правила для панели |
| `promo-codes/promo-code-rules.ts`, `promo-codes.service.ts`, `changelog/changelog.service.ts` | правка кодов и журнала в панели |
| `roles/tools.controller.ts` | инструменты команды |
| `auth/display-name-words.ts` | слоги имени, а не текст («вы» — приставка) |

Поимённо внутри файлов игрока — тоже команде, не трогаем:
`ad_block_shape_locked` (`ads-errors.ts`), `task_shape_locked`
(`tasks-errors.ts`), `promo_code_taken` (`promo-code-errors.ts`),
`purchase_undeliverable` и `fulfill_failed` (`payments-errors.ts`), строка
для команды в `bot-commands.ts` (ветка `forAdmin`).

**Строки, где «вы» несёт род или звучит криво, — так:**

| Где | Стало |
|---|---|
| `promo-code-errors.ts`, `already` | Награда по этому коду уже получена |
| `friends.service.ts:242`, своя ветка | У тебя уже {N} друзей — это потолок |
| `bot-notify-texts.ts:29`, `friend-notifier.ts:26` | {имя} зовёт тебя в друзья в «Рубеже». … |
| `bot-notify-texts.ts:33` | {имя} дарит тебе подарок в «Рубеже» — забери его в разделе «Друзья» |

## Шаги по порядку

1. **Тест первым коммитом** — `backend/api/test/player-address.test.ts`
   (раздел «Тесты»). Он падает на нынешних исходниках — это ожидаемо.
2. Пройти файлы из `shared` и заменить тексты по таблицам. Строку, которая
   после замены несёт род игрока, — безлично.
3. Тесты бэкенда, сверяющие старый текст, — поправить ожидание:
   `rg -n -i 'попробуйте|зовёт вас|дарит вам|откройте покупку' backend/api/test`.
   Сейчас это как минимум `compensation.test.ts`, `friend-invite.test.ts`,
   `notifications-bot.test.ts`, `link-page.test.ts`,
   `rating-restrictions.test.ts`. Интеграционные тесты без Postgres локально
   не идут — их прогонит CI, смотреть его итог.
4. Прогнать гейт.

## Чего не трогаем

- Тексты команды — таблица выше.
- Оболочку — T-0331. Панель `apps/admin`.
- Коды ошибок, статусы, логи (`logger.*`) — их читает команда.
- Комментарии.

## Сценарий и интерфейс

Игрок жмёт слишком часто — «Слишком часто — попробуй позже». Друг зовёт —
бот пишет «Аня зовёт тебя в друзья в «Рубеже»». Счёт устарел — «Счёт
устарел — открой покупку в игре заново». Панель и чат команды говорят как
прежде.

## Тесты

Первым коммитом, до правки текстов.

- `backend/api/test/player-address.test.ts`:
  - обходит `backend/api/src/**/*.ts` (без `*.test.ts`), разбирает каждый
    файл `ts.createSourceFile` и собирает `StringLiteral`,
    `NoSubstitutionTemplateLiteral`, `TemplateHead`, `TemplateMiddle`,
    `TemplateTail`;
  - пропускает пути из `TEAM_PATHS` (таблица «не трогаем», глобы — через
    `path.relative` и префиксы, без новой зависимости) и литералы из
    `TEAM_TEXTS` — поимённо, с кодом ошибки в комментарии;
  - в остальном ни один литерал не содержит `вы|вас|вам|вами|ваш\p{L}*` целым
    словом и слов на `-ите` / `-йте`, кроме `NOT_PLURAL_IMPERATIVE`
    (существительные: `элите`, `орбите`, `защите`, `сайте`) → сообщение
    называет файл, строку и слово;
  - кейс на сам детектор: литерал «Слишком часто — попробуйте позже» ловится,
    «Слишком часто — попробуй позже» и «враг на орбите» — нет;
  - кейс на `TEAM_PATHS`: каждый путь из списка существует — иначе
    исключение устарело, и тест называет его.

## Аналитика

Нет: тексты не порождают событий.

## Настройки и окружение

Нет.

## Документы

Нет: правило записано в Р163 и `ux-writing.md` §1 (PR #489).

## Критерии приёмки

- [ ] Тексты, которые видит игрок (ошибки API, ответы оплаты, сообщения
  бота, страница ссылки), — на «ты» и без рода игрока.
- [ ] Тексты команды и коды ошибок не изменились.
- [ ] `player-address.test.ts` зелёный, а новая строка «попробуйте» в
  контроллере игрока его роняет.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(backend): Говори с игроком на «ты» в ответах и боте`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- изменено: бот и сообщения об ошибках обращаются к тебе на «ты»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЕРВЕР И БОТ ГОВОРЯТ С ИГРОКОМ НА «ТЫ»**

  Ошибки API, ответы оплаты, сообщения бота и страница ссылки — на «ты» и без рода игрока (решение владельца, Р163). Панель и чат команды — как прежде. Тест по исходникам не даёт вернуть «вы» в текст для игрока.

  🛠 **Для тех, кто пишет тексты**

  • текст для команды в новом файле — путь в `TEAM_PATHS` теста `player-address.test.ts`
  ```
