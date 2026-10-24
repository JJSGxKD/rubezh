---
id: T-0177
title: Штраф за отписку — заготовки: списание награды, срочное закрытие, уведомление
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0188]
zones:
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/wallet/wallet.service.ts
  - backend/api/src/modules/wallet/wallet.repository.ts
  - backend/api/src/modules/restrictions/restriction-catalog.ts
  - backend/api/src/modules/restrictions/restrictions.service.ts
  - backend/api/src/modules/notifications/notification-kinds.ts
  - apps/admin/src/api/audit.ts
  - packages/app-shell/src/screens/meta/notifications.tsx
  - packages/app-shell/src/i18n/ru-account.json
  - packages/app-shell/src/i18n/ru-history.json
  - backend/api/test/wallet.integration.test.ts
  - backend/api/test/restrictions.test.ts
  - backend/api/test/notifications.test.ts
  - apps/admin/test/audit.test.ts
  - packages/app-shell/test/notifications.test.ts
shared:
  - docs/35-stage4-plan.md
  - docs/22-analytics-and-metrics.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0177. Штраф за отписку — заготовки: списание награды, срочное закрытие, уведомление

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0177.json)](README.md#значки-статуса) [![T-0188](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0188.json&label=T-0188)](archive/T-0188-hide-changelog-for-players.md)

## Зачем

Р115: игрок получил награду за подписку на канал и отписался — награда
списывается, а при повторе партнёрские задания закрываются на 30 суток. Это
первая половина работы: три кирпича, на которые сядет перепроверка подписки
(T-0178). Сами по себе они поведения игры не меняют. Деньги и ограничения
вынесены в отдельную задачу, чтобы их ревью не тонуло в расписании и очереди.

## Решения

Р115 (`docs/35-stage4-plan.md`, таблица решений после Р111): «Отписался — та же
награда списывается, но не ниже нуля, игрок получает уведомление. Повторная
отписка в том же задании закрывает партнёрские задания аккаунту на 30
суток».

Следствия для этой задачи (исполнитель их не пересматривает):

- **Списание — существующий отзыв начисленного** `WalletService.revokeUpTo`
  (он уже берёт не больше начисленного записью-ключом и не больше баланса, в
  минус не уходит, идемпотентен ключом отзыва, держит блокировку строки
  баланса). Меняется одно: причина записи. Сейчас она зашита как
  `refund_revoke` («Возврат звёзд за покупку»), а отзыв награды за задание в
  журнале и в истории игрока не должен называться возвратом звёзд.
- **Закрытие на срок накладывает система**, от своего имени, без автора — по
  образцу `imposeBySystem` (возврат оплаты, T-0024). Срок конечный, и закрытие
  не должно ослабить более строгое: если у игрока уже действует ограничение
  `partner_tasks`, которое кончается позже или бессрочно, новое не
  накладывается (повторное наложение того же вида заменяет действующее).
- **Уведомление — новый вид ленты** с суммой списанного и датой, до которой
  закрыты задания, если они закрыты. Вид и тексты ниже — предложение
  `claude-lead2-1`; **тексты для игрока подтвердил пользователь 21.10.2026**
  без правок — в код идут дословно.
- В бота такой вид не дублируется (`bot-notify-rules.ts` не меняется).

## Как сейчас

Кошелёк:

- `backend/api/src/modules/wallet/wallet-types.ts:58` — константа
  `REVOKE_REASON = "refund_revoke"`; строка 67 — `WalletReason` включает
  `GrantReason | SpendReason | typeof REVOKE_REASON`.
- `backend/api/src/modules/wallet/wallet.repository.ts:68` — `RevokeInput`
  (аккаунт, ресурс, `grantKey`, `idempotencyKey`, `source`, `at`), строка 185 —
  `revokeUpTo`: блокирует строку баланса, берёт начисление по `grantKey`
  (только своего аккаунта и ресурса), `take = min(начислено, баланс)`; нулевое
  взятие записи не создаёт (`status: "nothing"`, повтор позже заберёт остаток);
  строка 210 — повтор ключа проверяет `reason === REVOKE_REASON`; строка 222 —
  запись пишет `REVOKE_REASON`.
- `backend/api/src/modules/wallet/wallet.service.ts:143` — `revokeUpTo` и тип
  `RevokeRequest` (строка 55): единственный вызывающий — возврат звёзд,
  `backend/api/src/modules/shop/shop.service.ts:199`.
- Ключ награды за задание: `task:${accountId}:${taskId}:${periodStart}:${resource}`
  (`backend/api/src/modules/tasks/tasks.service.ts:178`), причина начисления
  `task_reward` или `achievement_reward` по сроку (`rewardReason`).
- `backend/api/src/modules/history/history-types.ts:52` — `PURCHASE_REASONS`
  включает `refund_revoke`: поэтому отзыв награды с этой причиной попал бы в
  «Покупки» истории. Новая причина должна остаться в `currency`/`shards`
  (по умолчанию так и есть). Тексты причин — `packages/app-shell/src/i18n/ru-history.json:37`.

Ограничения:

- `backend/api/src/modules/restrictions/restrictions.service.ts:102` —
  `imposeBySystem(accountId, kind, reason, comment, at)`: бессрочно (`endsAt: null`),
  `notify: true`, `imposedBy: null`; `kind === "all"` запрещён; после записи
  `afterImposed` (сведение заменённых, кеш, слушатели, аудит, лог).
- `backend/api/src/modules/restrictions/account-restrictions.ts:58` —
  `status(accountId, kind, at)` отдаёт действующее ограничение вида или
  блокировку целиком; в `RestrictionsService` оно доступно как `this.gate`.
- `backend/api/src/modules/restrictions/restriction-catalog.ts:123` —
  `RESTRICTION_REASONS` (шаблоны причин: заголовок для команды и текст для
  игрока); строка 90 — вид `partner_tasks`; `RESTRICTION_LIMITS.minTermMs`
  (строка 140) — нижняя граница срока.
- Названия причин в журнале аудита панели — `apps/admin/src/api/audit.ts:392`
  (`RESTRICTION_REASONS`).

Уведомления:

- `backend/api/src/modules/notifications/notification-kinds.ts:20` —
  `NOTIFICATION_KINDS` (Zod-схема на вид, `rare_loot` и `boosts_refunded` —
  образцы); запись — `NotificationsService.post/notify/deliver`
  (`notifications.service.ts:127–140`), повтор события гасит `dedupeKey`.
- `packages/app-shell/src/screens/meta/notifications.tsx:80` — `describe`:
  вид без ветки возвращает `null`, и строка в ленте не рисуется; тексты —
  `packages/app-shell/src/i18n/ru-account.json:71–78` (`notification.*`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Причина отзыва.** `wallet-types.ts`: константа
   `TASK_REVOKE_REASON = "task_revoke"`; `WalletReason` её включает.
   `wallet.repository.ts`: `RevokeInput` получает необязательное
   `reason?: typeof REVOKE_REASON | typeof TASK_REVOKE_REASON` (по умолчанию
   `REVOKE_REASON`); проверка повторного ключа (строка 210) и вставка
   (строка 222) используют переданную причину. `wallet.service.ts`:
   `RevokeRequest` пропускает `reason` как необязательное поле; лог
   `wallet_revoked` получает `reason`. Вызов из `shop.service.ts` не
   меняется (причина по умолчанию прежняя). Ключ отзыва, занятый записью с
   другой причиной, — `IdempotencyConflictError`, как сейчас.
3. `ru-history.json`: `history.reason.task_revoke` — «Списание награды за
   отписку». Проверить `history-types.ts`: причина не попадает в
   `PURCHASE_REASONS` и `BOOST_REASONS` (тест — ниже).
4. **Срочное закрытие.** `restriction-catalog.ts`: причина
   `task_unsubscribe: { title: "Отписка после награды", player: "Отписка от канала после награды за подписку" }`.
   `restrictions.service.ts`: метод
   `imposeBySystemFor(accountId, kind, reason, comment, termMs, at = new Date()): Promise<"imposed" | "kept">`:
   - `kind === "all"` — `ValidationError`, как в `imposeBySystem`; срок меньше
     `RESTRICTION_LIMITS.minTermMs` или больше `RESTRICTION_LIMITS.maxTermMs` —
     тоже `ValidationError`;
   - если `this.gate.status(accountId, kind, at)` отдаёт блокировку целиком
     (`all`) или ограничение этого же вида, которое бессрочно или кончается не
     раньше `at + termMs`, — ничего не накладывать, лог
     `restriction_system_kept` (аккаунт, вид, причина), ответ `"kept"`;
   - иначе строка `startsAt: at`, `endsAt: at + termMs`, `notify: true`,
     `imposedBy: null`, комментарий усечён до `RESTRICTION_LIMITS.commentMax`;
     дальше — `afterImposed` как у `imposeBySystem`; ответ `"imposed"`.
   `imposeBySystem` не меняется.
5. `apps/admin/src/api/audit.ts`: `task_unsubscribe: "отписка после награды"` в
   `RESTRICTION_REASONS`.
6. **Вид уведомления.** `notification-kinds.ts`:
   ```ts
   /** отписка от канала после награды: награда списана, при повторе задания закрыты */
   task_unsubscribed: z.object({
     title: z.string().min(1).max(120).nullable(),
     coins: z.number().int().nonnegative(),
     gems: z.number().int().nonnegative(),
     shards: z.number().int().nonnegative(),
     closedUntil: z.iso.datetime().nullable(),
   }),
   ```
   (`title` — название задания из каталога или `null`; суммы — сколько реально
   списано, все три нули — награда к тому времени потрачена.)
7. **Лента у игрока.** `notifications.tsx`: ветка `task_unsubscribed` с иконкой
   `LogOut` из `lucide-react`, `target: null`; данные читаются защитно
   (`typeof … === "number"`), как у `boosts_refunded`. Тексты в
   `ru-account.json` — дословно:
   - `notification.task_unsubscribed.head`: «Вы отписались от канала «{title}»»
   - `notification.task_unsubscribed.head.untitled`: «Вы отписались от канала партнёра»
   - `notification.task_unsubscribed.taken`: «{head}: награда за подписку списана — {returned}.»
   - `notification.task_unsubscribed.spent`: «{head}: награда за подписку уже потрачена, списывать нечего.»
   - `notification.task_unsubscribed.closed`: «Партнёрские задания закрыты до {date}.»
   - `notification.task_unsubscribed.coins`: «{amount} {n, plural, one {монета} few {монеты} many {монет} other {монеты}}»
   - `notification.task_unsubscribed.gems`: «{amount} {n, plural, one {самоцвет} few {самоцвета} many {самоцветов} other {самоцвета}}»
   - `notification.task_unsubscribed.shards`: «{amount} {n, plural, one {осколок} few {осколка} many {осколков} other {осколка}}»
   Склейка: `taken` или `spent`, затем, если `closedUntil` не `null`, через пробел
   `closed`; части списанного — через `notification.and`; дата — `formatWhen`
   из `state/notifications-api.ts` или другой готовый форматтер даты
   `i18n/index.ts` (новый не писать).
8. `docs/35-stage4-plan.md`: рядом с описанием наложения системой (строка про
   `payment_refund`, около 5594) дописать абзац: система умеет накладывать
   ограничение на срок и не ослабляет более строгое; причина
   `task_unsubscribe`; причина кошелька `task_revoke`; вид уведомления
   `task_unsubscribed` (Р115, T-0177).

## Чего не трогаем

- Перепроверку подписки, расписание, таблицы, миграции, вызов отзыва и
  уведомления, разбор «повторной отписки» — это T-0178. После этой задачи
  ничего из нового в игре не вызывается.
- `shop.service.ts`: возврат звёзд остаётся с причиной `refund_revoke`.
- `imposeBySystem` и `payment-confirmation.ts`: закрытие после возврата оплаты
  остаётся бессрочным.
- `bot-notify-rules.ts` и `bot-notify-texts.ts`: в бота вид не дублируется.
- Права панели и экран «Ограничения»: причина появляется в списке шаблонов сама
  (список строится от `RESTRICTION_REASONS`) — проверить, но не править экран.
- `wallet-limits.ts` (потолки начисления): отзыв их не касается.
- Схему Prisma и миграции: `wallet_entry.reason` — строка, миграций нет.

## Тесты

Пишутся первым коммитом, до кода. Интеграционные — на живых Postgres и Redis
(`docs/17-testing-strategy.md` §4.2), по образцу блока «отзыв начисленного» в
`wallet.integration.test.ts` (строка 260).

`backend/api/test/wallet.integration.test.ts`:

- Награда 100 монет (`task_reward`, ключ `task:A:t1:2026-10-20:coins`), на счёте
  60: `revokeUpTo` с `reason: "task_revoke"` забирает 60, баланс 0, в журнале
  строка −60 с причиной `task_revoke`, источник и ключ отзыва — как переданы;
  итог `{ status: "revoked", revoked: 60, granted: 100, balance: 0 }`.
- Баланс больше награды (на счёте 250): забрано 100, баланс 150 — не больше
  начисленного.
- Баланс 0: `status: "nothing"`, строка не создаётся; когда на счёте позже
  появилось 30, повтор того же отзыва забирает 30.
- Повтор того же ключа отзыва с той же причиной: `status: "duplicate"`, второй
  строки нет, баланс не менялся. Два одновременных одинаковых отзыва
  (`Promise.all`): одна строка журнала.
- Ключ отзыва занят записью с другой причиной (`refund_revoke`) — повтор с
  `task_revoke` бросает `IdempotencyConflictError`.
- Чужой ключ награды (другого аккаунта) ничего не отзывает: `granted: 0`.
- Без `reason` запись по-прежнему `refund_revoke` (существующие кейсы не
  меняются).

`backend/api/test/restrictions.test.ts` (новый блок «наложение системой на срок»):

- `imposeBySystemFor(id, "partner_tasks", "task_unsubscribe", "…", 30 суток, NOW)`
  → `"imposed"`; действующее ограничение вида: `endsAt = NOW + 30 суток`,
  `notify: true`, `imposedBy: null`, причина `task_unsubscribe`; в аудите
  запись наложения без автора; `status(id, "partner_tasks", NOW)` не `null`, а
  через 30 суток и минуту — `null`.
- Уже действует бессрочное `partner_tasks` (от человека) → `"kept"`, строка не
  заменена, записи аудита нет, лог `restriction_system_kept`.
- Уже действует `partner_tasks` на 60 суток → `"kept"`; на 10 суток → заменено
  новым на 30, прежнее снято (`replaced`).
- Блокировка целиком уже стоит → `"kept"`.
- `kind: "all"`, срок меньше `minTermMs`, срок больше `maxTermMs` → `ValidationError`.
- Комментарий длиннее `commentMax` усечён.
- `RESTRICTION_REASONS` содержит `task_unsubscribe`, и шаблон проходит тест
  контракта каталога (блок «контракт каталога», строка 899).

`backend/api/test/notifications.test.ts`:

- `task_unsubscribed` с суммами и `closedUntil: null` записывается; с
  `closedUntil` в формате ISO — тоже.
- Данные не по схеме не пишутся и не роняют вызывающего: отрицательная сумма,
  дробная сумма, `title` длиннее 120, `closedUntil` не датой, лишних полей нет в
  выдаче.
- Повтор с тем же `dedupeKey` строку не удваивает.

`apps/admin/test/audit.test.ts`: название причины `task_unsubscribe` в записи
наложения — «отписка после награды».

`packages/app-shell/test/notifications.test.ts`:

- Лента с `task_unsubscribed` (`title` «Рубеж», монеты 100, `closedUntil: null`)
  рисует строку «Вы отписались от канала «Рубеж»: награда за подписку списана —
  100 монет.».
- Все суммы нули: «…награда за подписку уже потрачена, списывать нечего.»
- `closedUntil` задан: строка заканчивается фразой «Партнёрские задания закрыты
  до …».
- `title: null`: «Вы отписались от канала партнёра: …».
- Данные другого вида (строка вместо числа) не роняют ленту.

## Аналитика

Нет событий словаря `docs/22-analytics-and-metrics.md`: наложение и снятие
ограничений и записи кошелька уже ведут журнал и лог сервера. Новый лог —
`restriction_system_kept` (аккаунт, вид, причина) и поле `reason` в
`wallet_revoked`; они перечисляются в абзаце про лог ограничений в
`docs/22-analytics-and-metrics.md` (рядом с `restriction_refused`, около
строки 350) — дописать два имени.

## Настройки и окружение

Нет: 30 суток и 7 суток живут константами в T-0178, ключей каталога настроек и
переменных окружения эта задача не добавляет.

## Документы

- `docs/35-stage4-plan.md` — абзац в разделе про наложение системой (шаг 8).
- `docs/22-analytics-and-metrics.md` — два имени лога (раздел «Аналитика»).
- `pnpm docs:check` проходит.

## Критерии приёмки

- [ ] `revokeUpTo` принимает причину; без неё запись `refund_revoke`, как
      раньше; с `task_revoke` — запись и проверка повтора по этой причине.
- [ ] Списание не уходит ниже нуля и не превышает начисленного (тесты 60 из 100,
      250 из 100, 0).
- [ ] `imposeBySystemFor` не ослабляет действующее более строгое ограничение
      вида; срок точный; аудит без автора.
- [ ] Вид `task_unsubscribed` проходит схему и рисуется в ленте всеми
      вариантами текста; незнакомое поле не роняет ленту.
- [ ] Возврат звёзд (`shop.service.ts`, `payment-confirmation.ts`) работает как
      раньше: их тесты зелёные без правок.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(wallet): Заготовки штрафа за отписку от канала`
- **Метка:** `release: minor`
- **Для игроков:** нет (в игре пока ничего не вызывается; видимое — в T-0178)
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАГОТОВКИ ШТРАФА ЗА ОТПИСКУ ОТ КАНАЛА**

  Кошелёк умеет списывать награду за задание отдельной причиной, система
  умеет закрывать партнёрские задания на срок, не ослабляя более строгое
  ограничение, а лента знает уведомление об отписке. Сам штраф — следующей
  задачей, поэтому игрок пока ничего не заметит.

  🛠 **Кошелёк и ограничения**

  • причина записи «task_revoke» для отзыва награды, возврат звёзд не изменился
  • наложение ограничения системой на срок, причина «Отписка после награды»

  ❓ **Нужно от команды**

  • @владелец — подтвердить тексты уведомления об отписке
  ```
