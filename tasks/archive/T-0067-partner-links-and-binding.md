---
id: T-0067
title: Ссылки партнёра — ссылка кампании с владельцем-партнёром, привязка игрока по первому входу
epic: E14
priority: P1
status: done
owner: claude-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0057, T-0066]
zones:
  - backend/api/src/modules/links/links.service.ts
  - backend/api/src/modules/links/links.repository.ts
  - backend/api/src/modules/admin/admin-links.controller.ts
  - backend/api/src/modules/attribution/session-recorder.ts
  - backend/api/src/modules/attribution/attribution.module.ts
  - backend/api/src/modules/partners/**
  - backend/api/test/partner-links.test.ts
  - backend/api/test/partner-links.integration.test.ts
  - backend/api/test/links.test.ts
  - apps/admin/src/api/links.ts
  - apps/admin/src/api/partners.ts
  - apps/admin/src/screens/links/**
  - apps/admin/src/screens/partners/**
  - apps/admin/test/links.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/test/app-boot.integration.test.ts
  - docs/21-diagrams.md
  - docs/23-referral-and-partner-program.md
  - docs/24-attribution-and-sharing.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0067. Ссылки партнёра — ссылка кампании с владельцем-партнёром, привязка игрока по первому входу

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0067.json)](../README.md#значки-статуса) [![T-0057](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0057.json&label=T-0057)](T-0057-link-target-and-direct-links.md) [![T-0066](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0066.json&label=T-0066)](T-0066-partner-card-fields-and-status.md)

## Зачем

Сейчас партнёр приводит игроков только промокодами. Решение пользователя от
12.10.2026 (`docs/35-stage4-plan.md` Р96): партнёру уже сейчас выдаются
ссылки — для его постов и для закупки рекламы в AdsGram от его имени. Игрок,
вошедший по такой ссылке, записывается за партнёром.

## Решения

- **Ссылка партнёра — та же ссылка кампании** (`Link`) с владельцем
  `partnerId`:
  - всё прочее — как у любой ссылки: цель, прямая ссылка (T-0057), сеть
    закупки (WP43);
  - владелец задаётся при создании и потом не меняется: клики и привязки
    уже записаны за ним.
- **Привязка по первому входу.** Игрок пришёл по ссылке партнёра — кликом
  через переходник (`c-<клик>`) или прямой ссылкой (`l-<код>`) — и
  записывается за партнёром, если:
  - партнёр активен (`bindsNewPlayers`, T-0066);
  - аккаунт не старше `PARTNER_RULES.bindWindowDays` суток — то же правило,
    что у кодов: старый игрок, увидевший пост, приведённым не считается;
  - слот источника свободен (`lockSourceSlot`): реферер или другой партнёр
    раньше — привязки нет.
- **Привязка помнит, по какой ссылке** (`linkCode`), как сейчас помнит код
  (`campaignId`).
- **Ссылка с сетью и владельцем-партнёром** — закупка партнёра в AdsGram.
  - Конверсии в сеть уходят, как у любой ссылки с сетью (WP43, Р86).
  - Токен кабинета партнёра в этой задаче не заводится: если у партнёра
    своего токена нет, конверсии идут нашим токеном, как сейчас. Токен
    партнёра — отдельная задача по WP46 п. 4.

## Как сейчас

- **`backend/api/prisma/schema.prisma`:**
  - `model Link` — после T-0057 с `target`;
  - `model PartnerBinding` — `accountId`, `partnerId`, `campaignId`,
    `boundAt`.
- **`backend/api/src/modules/attribution/session-recorder.ts`:**
  - запись сессии из задания очереди → `this.sessions.record(session)`
    (строки ~89, ~97);
  - касание сессии — `startKind` и `startRef`: для `click` — id клика, для
    `link` — код ссылки (T-0057).
- **Слот** — `attribution/source-slot.ts`: `lockSourceSlot(tx, accountId)`
  под `pg_advisory_xact_lock`.
- **Образец привязки** — `promo-codes.repository.ts`: активация кода
  партнёра → `partner_binding` в транзакции под `lockSourceSlot`, с проверкой
  возраста аккаунта по `PARTNER_RULES.bindWindowDays`.
- **Ссылки** — `links.service.ts` (`create`, вид ссылки), `links.repository.ts`,
  `admin-links.controller.ts`. **Партнёры** — `partners.service.ts`
  (`detail`). **Панель** — `screens/links/`, `screens/partners/`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция:**
   - `Link.partnerId String? @map("partner_id") @db.Uuid`, связь с
     `Partner` `onDelete: Restrict`, индекс `@@index([partnerId])`;
   - `PartnerBinding.linkCode String? @map("link_code") @db.VarChar(16)`,
     связь с `Link` `onDelete: SetNull`.
3. **Новый `partners/partner-links.ts`:**
   - чистая функция:

     ```ts
     /** Привязывать ли по касанию: решение без базы. */
     export function linkBindingDecision(input: { partnerStatus: PartnerStatus | null; accountAgeDays: number; slot: SourceSlot }): "bind" | "no_partner" | "inactive" | "too_old" | "slot_taken";
     ```

   - `PartnerLinkBinder.bindFromTouch({ accountId, startKind, startRef, at })`:
     - `click` → код ссылки по `link_click`, `link` → `startRef`;
     - у ссылки нет `partnerId` — выход;
     - иначе транзакция: `lockSourceSlot`, возраст аккаунта, статус
       партнёра, `linkBindingDecision`;
     - `bind` → `partner_binding` с `linkCode`, `boundAt = at`;
     - повтор той же сессии — `ON CONFLICT DO NOTHING`.
4. **`session-recorder.ts`** — после `record` сессии с видом `click` или
   `link` зовёт `bindFromTouch`.
   - Ошибка привязки сессию не откатывает: сессия уже записана.
   - Ошибка — `warn` с `accountId` и причиной, задание очереди повторит
     только привязку — по образцу соседних побочных записей в этом файле.
5. **Ссылки:**
   - `create` принимает `partnerId` (партнёр есть, иначе 404);
   - вид ссылки += `partner: { partnerId, name } | null`;
   - список — фильтр `?partner=<id>`;
   - смены владельца нет: в `PATCH` поля нет, лишнее — 400.
6. **Партнёры** — `detail` += ссылки партнёра (код, кампания, цель,
   клики, запуски — те же числа, что в списке ссылок) и число игроков,
   привязанных по ссылкам.
7. **Панель:**
   - мастер ссылки — шаг «Чья ссылка»: «Наша» или «Партнёра» с выбором
     активного партнёра;
   - список ссылок — колонка «Партнёр»;
   - карточка партнёра — блок «Ссылки» с таблицей и кнопкой «Завести
     ссылку» (мастер с выбранным партнёром).
8. **Документы** — раздел «Документы».

## Чего не трогаем

- Привязку по кодам партнёра — только общий слот.
- Конверсии в сети (WP43), токен кабинета партнёра.
- Воронку партнёра — T-0068, постбэки партнёру — T-0069.

## Тесты

Первым коммитом.

- **`backend/api/test/partner-links.test.ts`** — `linkBindingDecision`:
  - партнёра нет → `no_partner`;
  - `paused` → `inactive`;
  - аккаунт 8 суток при окне 7 → `too_old`;
  - слот `referral` или `partner` → `slot_taken`;
  - активный, 1 сутки, слот свободен → `bind`.
- **`backend/api/test/partner-links.integration.test.ts`** (Postgres, Redis 13):
  - вход новым аккаунтом по клику ссылки партнёра → `partner_binding` с
    `linkCode`;
  - тот же вход по прямой ссылке `l-<код>` → привязка;
  - аккаунт уже привязан к рефереру → привязки нет;
  - две сессии одновременно → одна привязка;
  - повтор задания → одна привязка.
- **`backend/api/test/links.test.ts`:**
  - создание с несуществующим партнёром — 404;
  - `PATCH` с `partnerId` — 400.
- **`apps/admin/test/links.test.ts`** — разбор `partner` в виде ссылки.

## Аналитика

Нет новых событий: привязка видна в карточке игрока и партнёра, как у кода.

## Настройки и окружение

Нет.

## Документы

- **`docs/23-referral-and-partner-program.md`** — ссылки партнёра и
  привязка по первому входу; общий слот с кодами и реферером.
- **`docs/24-attribution-and-sharing.md`** — владелец ссылки.
- **`docs/21-diagrams.md`** — ER: `link.partner_id`,
  `partner_binding.link_code`.

## Критерии приёмки

- [ ] Ссылка заводится «нашей» или «партнёра»; у партнёра в карточке — его
  ссылки с кликами и запусками.
- [ ] Новый игрок по ссылке активного партнёра записывается за ним, если
  слот свободен и аккаунт не старше 7 суток.
- [ ] Гонка двух сессий и повтор задания дают одну привязку.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(api): Ссылки партнёра и привязка игрока по ним`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ССЫЛКИ ПАРТНЁРОВ**

  Партнёру теперь можно выдать свою ссылку — для постов или закупки рекламы в AdsGram. Новый игрок, пришедший по ней, записывается за партнёром по тем же правилам, что у промокодов: слот один, кто первый — того и игрок.
  ```
