---
id: T-0217
title: Роль «партнёр» — аккаунт привязан к карточке, вход в свой кабинет, без самопривязки
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0216, T-0068, T-0070, T-0071, T-0181]
zones:
  - backend/api/src/modules/roles/role-levels.ts
  - backend/api/src/modules/partners/partners.service.ts
  - backend/api/src/modules/partners/partners.repository.ts
  - backend/api/src/modules/partners/partner-links.ts
  - backend/api/src/modules/partners/partner-cabinet.ts
  - backend/api/src/modules/admin/admin-partners.controller.ts
  - backend/api/src/modules/admin/admin-cabinet.controller.ts
  - backend/api/src/modules/admin/admin-roles.service.ts
  - backend/api/src/modules/promo-codes/promo-codes.repository.ts
  - backend/api/src/modules/ad-conversions/conversions.repository.ts
  - backend/api/test/partners.test.ts
  - backend/api/test/partners.integration.test.ts
  - backend/api/test/partner-links.test.ts
  - backend/api/test/partner-links.integration.test.ts
  - backend/api/test/promo-codes.integration.test.ts
  - backend/api/test/roles.test.ts
shared:
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/admin/admin.module.ts
  - docs/21-diagrams.md
  - docs/23-referral-and-partner-program.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 4
---

# T-0217. Роль «партнёр» — аккаунт привязан к карточке, вход в свой кабинет, без самопривязки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0217.json)](README.md#значки-статуса) [![T-0216](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0216.json&label=T-0216)](T-0216-role-levels.md) [![T-0068](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0068.json&label=T-0068)](T-0068-partner-funnel.md) [![T-0070](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0070.json&label=T-0070)](T-0070-postback-s2s-and-partner.md) [![T-0071](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0071.json&label=T-0071)](T-0071-postback-events-and-selection.md) [![T-0181](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0181.json&label=T-0181)](T-0181-direct-ad-link-network-label.md)

## Зачем

Партнёр — внешний промоутер — должен видеть свои ссылки, воронку и
начисления сам, а не через команду (Р136). Для этого его игровой аккаунт
связывается с карточкой партнёра и получает роль `partner`, которая пускает
в панель, но только в его кабинет. Эта задача — сервер: роль, связь,
защита от того, чтобы партнёр приводил сам себя, и точка входа кабинета.
Экран кабинета — T-0218.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р136:

- партнёр входит в панель с ролью `partner` и видит только свой кабинет;
- выдают роль владелец и администратор, сам партнёр ролей не выдаёт;
  выдача и снятие — в журнале;
- аккаунт партнёра — **игрок, а не команда**: он есть в аналитике и
  рейтинге, но привязаться к самому себе не может, и его покупки процента
  не дают (начисления — T-0220).

Решения `claude-lead-1` от 24.10.2026:

- **Роль** `partner`, уровень 20 в `ROLE_LEVELS` (T-0216): её выдают
  владелец и администратор. Право одно — `partner.cabinet`, других прав у
  роли нет.
- **Связь — колонка `partner.account_id`** (`uuid`, уникальная, может быть
  пустой, внешний ключ на `account`). Выдаётся **только из карточки
  партнёра**: «Открыть кабинет» ищет аккаунт по `telegram_id` карточки
  (площадка `telegram`), выдаёт роль через `RolesService.grant` — с его
  проверкой уровней и журналом — и записывает `account_id`. «Закрыть
  кабинет» снимает роль, а `account_id` **оставляет**: связь нужна защите
  от самопривязки и после закрытия кабинета. В разделе «Роли» роль
  `partner` не выдаётся (`grantable: false` с подсказкой «Выдаётся в
  карточке партнёра»).
- **Ошибки «Открыть кабинет»**: у карточки нет Telegram ID — «Сначала
  укажите Telegram ID партнёра»; аккаунта с таким ID нет — «Партнёр ещё не
  заходил в игру — пусть откроет её один раз»; аккаунт уже связан с другим
  партнёром — «Этот аккаунт уже привязан к партнёру «<имя>»».
- **Без самопривязки.** Игрок, чей `account_id` записан у партнёра, не
  привязывается к этому партнёру ни по ссылке, ни по промокоду: новое
  решение `own_account` в `linkBindingDecision`, и проверка в погашении
  промокода. Промокод при этом гасится как обычный — отказ касается только
  привязки.
- **Не командный аккаунт.** Сейчас любая роль делает аккаунт «командным»:
  его конверсии не уходят в сети (`conversions.repository.ts`, `reason:
  'team'`). Роль `partner` в этом счёте не участвует. Других мест, где
  роль делает аккаунт командным, нет — проверить поиском `account_role`
  и, если найдутся, поправить так же.
- **Точка входа кабинета** — `GET /api/v1/admin/cabinet`, право
  `partner.cabinet`: `{ partner: { partnerId, name, status, sharePercent,
  payoutCurrency } }` — карточка без контактов и заметок команды.
  Аккаунт без связи — `ForbiddenError` «Аккаунт не привязан к партнёру».
  Владельцу и администратору — `?partnerId=<id>` (право `partners.view`):
  кабинет глазами партнёра для поддержки, только чтение.
- **Резолвер для будущих разделов** — `PartnerCabinet.partnerOf(actor,
  query)` в `partner-cabinet.ts`: одна точка, где решается, чей кабинет
  открыт. Разделы кабинета (T-0218, T-0219, T-0221) берут партнёра только
  через неё.

## Как сейчас

- `backend/api/src/modules/roles/permissions.ts:113–122` — `ROLES` без
  `partner`; тест матрицы — `backend/api/test/roles.test.ts`.
- `backend/api/prisma/schema.prisma:2017–2042` — `model Partner`:
  `telegramId` (уникальный), `status`, `sharePercent` и другие; связи с
  аккаунтом нет.
- `backend/api/src/modules/partners/partner-links.ts:26–32` —
  `linkBindingDecision(input)`; `bindFromTouch` (68–92) записывает
  `partner_binding`.
- `backend/api/src/modules/promo-codes/promo-codes.repository.ts:294–330` —
  `redeem`: привязка к партнёру кода (строка 316, `partnerBinds`).
- `backend/api/src/modules/ad-conversions/conversions.repository.ts:130–131`
  и `183–184` — `EXISTS (SELECT 1 FROM account_role r WHERE …)` → `skipped`,
  `team`.
- `backend/api/src/modules/admin/admin-partners.controller.ts` — карточка
  партнёра: список, деталь, создание, правка, статус.
- `backend/api/src/modules/admin/admin-session.service.ts:104` — в панель
  пускают аккаунт с любой ролью.

## Шаги по порядку

1. **Миграция** — `partner.account_id` по «Решениям», имя миграции —
   `partner_account`; поле `accountId` в `model Partner` и обратная связь в
   `model Account` одной строкой.
2. **Роли** — `partner` в `ROLES`, `partner.cabinet` в `PERMISSIONS`
   своим блоком с комментарием, `ROLE_PERMISSIONS.partner =
   ["partner.cabinet"]`; уровень 20 в `role-levels.ts`; в
   `admin-roles.service.ts` — `grantable: false` и подсказка для `partner`.
3. **Карточка** — `POST /admin/partners/:partnerId/cabinet` с телом
   `{ open: boolean }`, право `partners.edit`; в `partners.service.ts` —
   `openCabinet`/`closeCabinet` с ошибками из «Решений»; ответ карточки
   получает `cabinet: { accountId, open }`.
4. **Самопривязка** — `own_account` в `LinkBindingDecision` и
   `linkBindingDecision` (новое поле входа `ownAccount: boolean`, проверка —
   сразу после «нет партнёра»); `bindFromTouch` читает `account_id`
   партнёра в той же транзакции; `redeem` не привязывает игрока к партнёру,
   чей `account_id` — он сам.
5. **Конверсии** — в обоих местах `AND r.role <> 'partner'`.
6. **Кабинет** — `partner-cabinet.ts` и `admin-cabinet.controller.ts`
   (`GET /admin/cabinet`), подключение в `admin.module.ts`.
7. **Документы:**
   - `docs/21-diagrams.md` — `partner.account_id` в ER-диаграмме;
   - `docs/29-admin-panel.md` §3.1 — строка `partner` в таблице ролей и
     права;
   - `docs/23-referral-and-partner-program.md` §4.4 — как партнёр получает
     доступ: карточка → «Открыть кабинет».

## Чего не трогаем

- Экран кабинета и кнопки в карточке — T-0218.
- Воронку, начисления и материалы — T-0219, T-0220, T-0221.
- Прежние привязки `partner_binding`: самопривязка запрещается на будущее,
  записанные раньше не пересматриваются.

## Тесты

Первым коммитом.

- `roles.test.ts` — у `partner` ровно одно право `partner.cabinet`;
  администратор может выдать `partner` по уровням.
- `partner-links.test.ts` — `linkBindingDecision` с `ownAccount: true` →
  `own_account` раньше проверки слота и возраста.
- `partner-links.integration.test.ts` — партнёр с `account_id` = игрок,
  касание по его ссылке → привязки нет, решение `own_account`; другой
  игрок по той же ссылке → привязан.
- `promo-codes.integration.test.ts` — партнёр гасит свой промокод: код
  погашен, привязки к партнёру нет.
- `partners.integration.test.ts`:
  - «Открыть кабинет» без Telegram ID → ошибка; с ID, которого нет среди
    аккаунтов, → ошибка; с ID игрока → роль `partner` есть, `account_id`
    записан, запись в журнале;
  - «Закрыть кабинет» → роли нет, `account_id` на месте;
  - второй партнёр с тем же аккаунтом → ошибка про первого;
  - `GET /admin/cabinet` под партнёром → его карточка без `contact` и
    `note`; под игроком без связи → отказ; под владельцем с `?partnerId=` →
    карточка этого партнёра.
- Конверсия регистрации игрока с ролью `partner` уходит в сеть
  (`pending`), с ролью `analyst` — `skipped`/`team` (интеграционный тест
  рядом с текущими тестами конверсий).

## Аналитика

Нет новых событий. Выдача роли — в журнале аудита; отказ в привязке
`own_account` — в логе, как остальные решения привязки.

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Роль `partner` выдаётся только из карточки партнёра, владельцем или
  администратором, и пускает только в `GET /admin/cabinet`.
- [ ] Партнёр не привязывается к себе ни ссылкой, ни промокодом.
- [ ] Конверсии аккаунта партнёра не помечаются командными.
- [ ] ER-диаграмма обновлена.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(partners): Роль партнёра и вход в его кабинет`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РОЛЬ ПАРТНЁРА И ВХОД В ЕГО КАБИНЕТ**

  Партнёр получает роль `partner` из своей карточки: «Открыть кабинет» находит его аккаунт по Telegram ID и пускает в панель, но только в кабинет. Привести самого себя партнёр не может ни ссылкой, ни промокодом, а его аккаунт больше не считается командным. Экран кабинета — следующей задачей.
  ```
