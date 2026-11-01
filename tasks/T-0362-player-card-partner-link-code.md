---
id: T-0362
title: Карточка игрока — привязка к партнёру по ссылке с кодом ссылки и переходом в её карточку
epic: E7
priority: P3
status: done
owner: claude-10 / sonnet-5.5 / low
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/partners/partners.repository.ts
  - backend/api/test/partners.integration.test.ts
  - apps/admin/src/api/players.ts
  - apps/admin/src/screens/players/SocialPanel.tsx
  - apps/admin/test/players.test.ts
shared:
  - backend/api/test/helpers/memory-partners.ts
  - backend/api/test/partner-links.integration.test.ts
  - docs/23-referral-and-partner-program.md
runner: any
executor: sonnet-5.5
effort: low
release: patch
merge: lead
design: null
batch: 4
---

# T-0362. Карточка игрока — привязка к партнёру по ссылке с кодом ссылки и переходом в её карточку

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0362.json)](README.md#значки-статуса)

## Зачем

Игрок пришёл к партнёру по ссылке (T-0067). Карточка игрока показывает
только имя партнёра и дату привязки. По какой из ссылок партнёра он пришёл,
не видно, хотя разбор спорной выплаты начинается именно с этого. После задачи
в карточке написано «по ссылке `k7f2a`», и код ведёт в карточку ссылки.

## Решения

Приёмка T-0067 (входящие 21.10). Решение `claude-lead-1` от 01.11.2026:

- `bindingOf` отдаёт ещё `linkCode` (`partner_binding.link_code`, может
  быть `null`).
- В `SocialPanel` строка привязки:
  - по коду: «Партнёр X, по коду ABC, 12.10» — как сейчас;
  - по ссылке: «Партнёр X, по ссылке `k7f2a`, 12.10»; код — кнопка, она
    открывает `navigate({ section: "links", id: linkCode })`;
  - нет ни кода, ни ссылки: «Партнёр X, 12.10».
- Право на раздел «Ссылки» — как у ссылки «Открыть» в других местах: без
  права код показывается текстом, без перехода.

## Как сейчас

- `backend/api/src/modules/partners/partners.repository.ts:283` — `bindingOf`:
  `partner_id`, `name`, `bound_at`, `campaign_title`, `code`.
- `apps/admin/src/api/players.ts:283` — схема `partner`.
- `apps/admin/src/screens/players/SocialPanel.tsx:46–60` — строка привязки.

## Шаги по порядку

1. Тесты первым коммитом.
2. Сервер — `b.link_code` в запросе и `linkCode` в `PartnerBindingView`.
3. Панель — схема и строка по «Решениям».

## Чего не трогаем

Слот источника и правила привязки (`docs/23`).

## Тесты

- `backend/api/test/partners.integration.test.ts` (запрос — SQL, проверка
  на живом Postgres, `docs/17-testing-strategy.md` §4.2):
  - привязка по ссылке → `linkCode` равен коду ссылки;
  - привязка по коду → `linkCode: null`.
- `apps/admin/test/players.test.ts`: схема разбирает `linkCode` и строку,
  и `null`.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

`docs/23-referral-and-partner-program.md` — в разделе карточки игрока: код
ссылки привязки виден.

## Критерии приёмки

- [x] Привязка по ссылке показывает код ссылки с переходом в её карточку.
- [x] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(admin): Код ссылки партнёра в карточке игрока`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ССЫЛКА ПАРТНЁРА В КАРТОЧКЕ ИГРОКА**

  В карточке игрока видно, по какой ссылке партнёра он пришёл, и код ведёт в карточку этой ссылки.
  ```
