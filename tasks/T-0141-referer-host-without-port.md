---
id: T-0141
title: Хост Referer без порта — проверки доступности отсекаются и с портом
epic: E14
priority: P3
status: in-progress
owner: claude-1 / haiku-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/links/links.service.ts
  - backend/api/src/modules/links/links.repository.ts
  - backend/api/test/links.test.ts
  - backend/api/test/links.integration.test.ts
shared: []
runner: local
executor: haiku-5.5
effort: medium
release: patch
design: null
batch: 2
---

# T-0141. Хост Referer без порта — проверки доступности отсекаются и с портом

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0141.json)](README.md#значки-статуса)

## Зачем

T-0073 не считает кликом запросы сервисов проверки доступности по хосту
Referer (`check-host.net`). Но `hostOf` пишет в базу `URL.host` — с портом,
если он нестандартный (`check-host.net:8443`), — а SQL сравнивает точное
совпадение. Такой клик не отсекается (находка ревью #328, `tasks/inbox.md`).

## Решения

- **Новые клики** — хост без порта: `hostOf` возвращает `URL.hostname`. Порт в
  аналитике источников не нужен.
- **Старые клики** — в SQL сравнивается хост без порта:
  `split_part(c.referer_host, ':', 1)`. Хост IPv6 в скобках этим не
  разбирается, но таких Referer у проверок доступности нет.

## Как сейчас

- `backend/api/src/modules/links/links.service.ts:199–206` — `hostOf`:
  `new URL(referer).host.slice(0, 255) || null`.
- `backend/api/src/modules/links/links.repository.ts:143` —
  `AND (c.referer_host IS NULL OR c.referer_host NOT IN (${Prisma.join(CHECKER_REFERER_HOSTS)}))`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`links.service.ts`** — в `hostOf` `.host` заменить на `.hostname`.
3. **`links.repository.ts:143`** — `c.referer_host NOT IN (…)` заменить на
   `split_part(c.referer_host, ':', 1) NOT IN (…)`; условие `IS NULL OR` оставить.

## Чего не трогаем

- Список сервисов проверки (`availability-checkers.ts`), `checkerOf`, классы
  устройств.

## Тесты

- `links.test.ts`: `hostOf("https://check-host.net:8443/check")` →
  `"check-host.net"`; `hostOf("https://t.me/x")` → `"t.me"`; мусор → `null`.
- `links.integration.test.ts` (живой Postgres, своя схема — `docs/17` §4.2):
  клик с `refererHost: "check-host.net:8443"`, записанный напрямую через
  `recordClick`, в цифры ссылки не входит, а клик с `"t.me"` — входит.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Нет.

## Критерии приёмки

- [ ] Новые клики пишутся с хостом без порта.
- [ ] Клик проверки доступности с портом в Referer не считается кликом ни у
  новых, ни у старых записей.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `fix(links): Хост Referer без порта`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОВЕРКИ ДОСТУПНОСТИ С ПОРТОМ — ТОЖЕ НЕ КЛИКИ**

  Хост Referer клика пишется без порта, а старые клики с портом отсекаются в подсчёте: проверка доступности с нестандартным портом больше не попадает в клики ссылки.
  ```
