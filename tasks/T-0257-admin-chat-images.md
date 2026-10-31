---
id: T-0257
title: Сводка дня и тревоги в чате администраторов картинкой
epic: E5
priority: P3
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0252]
zones:
  - backend/api/src/modules/admin-notify/daily-card.ts
  - backend/api/src/modules/admin-notify/alarm-card.ts
  - backend/api/test/admin-cards.test.ts
shared:
  - backend/api/src/modules/admin-notify/daily-stats.reporter.ts
  - backend/api/src/modules/admin-notify/payments-alert-notifier.ts
  - backend/api/src/modules/admin-notify/fx-alert-notifier.ts
  - backend/api/src/modules/admin-notify/server-error-alarm.ts
  - backend/api/src/modules/admin-notify/chart-scale.ts
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/mockups/bot-images-v2.html
batch: 4
---

# T-0257. Сводка дня и тревоги в чате администраторов картинкой

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0257.json)](README.md#значки-статуса) [![T-0252](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0252.json&label=T-0252)](T-0252-bot-cards-foundation.md)

## Зачем

Ежедневная сводка и тревоги приходят в чат команды текстом, и главное число
приходится искать глазами. После задачи:
- **сводка дня** — картинка: четыре числа с изменением к прошлой неделе,
  тренд 14 дней и плашки «что заметить»;
- **тревога** — та же раскладка с красной полосой слева и одним главным
  числом.

Текст остаётся подписью под картинкой.

## Решения

Числа раскладки на 1200×675 — `design/art/meta-v2.md` §3.4 (дизайнер,
31.10.2026); макет — в поле `design`.

Решение владельца — `docs/35-stage4-plan.md` Р156: в чате админов — сводка
дня и тревога картинкой (`design/art/meta-v2.md` §3.3: тот же язык, плотнее
и без героя).

Решения `claude-lead-1` от 24.10.2026:

- **Картинки** — на `svg.ts` (T-0252), без героя и без сцены: тёмная
  подложка `PALETTE`, заголовок Russo One, числа крупно, тренд — тем же
  масштабом, что карточки забегов (`chart-scale.ts`).
- **Отправка** — `sendPhoto` с подписью: подпись — нынешний текст, обрезанный
  до лимита подписи Telegram (1024). Длиннее — фото с короткой подписью и
  полный текст следом отдельным сообщением.
- **Сбой фото → текст,** как сейчас. Сводка и тревога доходят всегда.
- **Какие тревоги:** платежи (`payments-alert-notifier.ts`), курсы
  (`fx-alert-notifier.ts`), ошибки сервера (`server-error-alarm.ts`).
  Карточки разбора забегов и нагрузки уже картинками — не трогаем.

## Как сейчас

- `admin-notify/daily-stats.reporter.ts:110–155` — сводка и `/stats`
  текстом (`sendMessage`).
- Тревоги — `payments-alert-notifier.ts`, `fx-alert-notifier.ts`,
  `server-error-alarm.ts` — текстом.
- Картинки в том же чате уже есть: `run-card.ts`, `stress-card.ts`
  (образец отправки фото и масштаба графика).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`daily-card.ts`, `alarm-card.ts`** — картинки.
3. **Отправка** — фото с подписью в сводке, `/stats` и трёх тревогах; запасной
   путь — текст.
4. **`docs/29`** — сводка и тревоги картинкой.

## Чего не трогаем

- Числа и правила сводки и тревог.
- Карточки разбора забегов и нагрузки.

## Тесты

Первым коммитом, `admin-cards.test.ts`:
- сводка с ростом и падением чисел — стрелки и знаки верные;
- тревога — красная полоса и главное число;
- подпись длиннее 1024 → фото с короткой подписью и текст следом;
- сбой `sendPhoto` → `sendMessage` с прежним текстом.

## Аналитика

Нет: сообщения команде.

## Настройки и окружение

Нет.

## Документы

По шагу 4.

## Критерии приёмки

- [ ] Сводка дня и три вида тревог приходят картинкой с подписью; при сбое — текстом.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin-notify): Сводка и тревоги картинкой`
- **Метка:** `release: minor`
- **Для игроков:** пусто — это чат команды.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СВОДКА И ТРЕВОГИ КАРТИНКОЙ**

  Ежедневная сводка и тревоги (платежи, курсы, ошибки сервера) приходят в чат команды картинкой: главные числа крупно, тренд, у тревоги — красная полоса. Текст остаётся подписью; если фото не ушло — придёт текстом.
  ```
