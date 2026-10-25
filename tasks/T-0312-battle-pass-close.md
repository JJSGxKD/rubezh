---
id: T-0312
title: Батл-пасс — закрытие месяца: незабранное выдаётся само под локом, уведомление в игре и в боте; бусты-подарки тратятся при включении буста
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0311]
zones:
  - backend/api/src/modules/battle-pass/pass-close.service.ts
  - backend/api/src/modules/battle-pass/pass-close.job.ts
  - backend/api/test/battle-pass-close.integration.test.ts
  - backend/api/test/boost-credits.integration.test.ts
shared:
  - backend/api/src/modules/battle-pass/battle-pass.module.ts
  - backend/api/src/modules/boosts/boosts.service.ts
  - backend/api/src/modules/boosts/boosts.repository.ts
  - backend/api/src/modules/notifications/notification-kinds.ts
  - backend/api/src/modules/notifications-bot/bot-notify-texts.ts
  - backend/api/src/modules/vip/vip.repository.ts
  - docs/37-accounting.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 8
---

# T-0312. Батл-пасс — закрытие месяца: незабранное выдаётся само под локом, уведомление в игре и в боте; бусты-подарки тратятся при включении буста

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0312.json)](README.md#значки-статуса) [![T-0311](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0311.json&label=T-0311)](T-0311-battle-pass-server.md)

## Зачем

Игрок прошёл ступени, но не зашёл в последний день месяца — по решению
владельца награды не сгорают, а выдаются сами. После задачи:
- в первую минуту нового месяца по Москве задание закрывает прошлый месяц;
- каждому, кто набрал ступени, выдаётся всё незабранное по его лентам —
  один раз, даже если задание запустят две реплики;
- игрок получает уведомление «Пасс октября закрыт — награды на счету».

Ещё здесь тратятся бусты, выданные пассом: включение буста на забег
сначала берёт подарок, а уже потом списывает самоцветы.

## Решения

Решения владельца:
- Р46;
- 25.10.2026 — незабранное выдаётся само при закрытии.

Решения `claude-lead-1` от 25.10.2026:

- **Задание** — раз в минуту проверяет, есть ли незакрытый прошлый месяц.
  - Закрывает под локом Redis.
  - Идемпотентно по `pass_close (month_key, closed_at)` и по журналу
    `pass_claim`: строка уже есть — награда не выдаётся.
  - Образец — `seasons/seasons-close.service.ts`.
- **Кому что:**
  - бесплатная лента — всем с `points > 0`, по достигнутую ступень;
  - VIP-лента — тем, у кого VIP был активен **хоть в один день** этого месяца
    (`VipPeriod` пересекается с месяцем): за этот месяц игрок заплатил.
- **Выдача** — тем же путём, что ручной забор (T-0311): `pass_claim`, ключи
  кошелька, `boost_credit`.
  - Пачками по 500 аккаунтов.
  - Сбой пачки — повтор этой пачки, без двойных выдач.
- **Уведомление** — вид `pass_closed` в игре: «Пасс {месяц} закрыт: {n}
  наград зачислено». В боте — тем, кому можно писать (Р51), текст в
  `bot-notify-texts.ts`; кнопка — в игру.
- **Бусты-подарки** — включение буста на забег (`boosts.service.ts`):
  - есть `boost_credit` этого буста с `count > 0` — `count − 1`, самоцветы не
    списываются;
  - в журнале активации — `paid_with: "credit"`.

  Возврат забегу, который не начался (`boosts-refunder.ts`), возвращает
  подарок, а не самоцветы.
- **Лог** — `pass_closed { month, accounts, rewards }`.

## Как сейчас

- **Закрытие сезона рейтинга** — `seasons/seasons-close.service.ts`,
  `season-close.job.ts` (лок и идемпотентность).
- **Бусты** — `boosts/boosts.service.ts` (активация и цена),
  `boosts-refunder.ts`.
- **Уведомления** — `notifications/notification-kinds.ts`, бот —
  `notifications-bot/bot-notify-texts.ts`.
- **После T-0311** — `pass_progress`, `pass_claim`, `boost_credit`, выдача ступени.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`pass-close.service.ts`, `.job.ts`** — закрытие; таблица `pass_close`.
3. **Уведомления** — вид и тексты.
4. **Бусты-подарки** — трата и возврат.
5. **`docs/37`** — выдача пасса при закрытии, бусты-подарки.

## Чего не трогаем

- Ручной забор — T-0311.
- Ленты в панели — T-0313.

## Тесты

Первым коммитом.

- `battle-pass-close.integration.test.ts`:
  - игрок на 12-й ступени, забрал 1…5 бесплатной → закрытие выдало 6…12 бесплатной;
  - VIP был 3 дня в месяце → выдана и VIP-лента 1…12;
  - без VIP — VIP-ленты нет;
  - две реплики закрытия разом — одна выдача;
  - повтор закрытия — ничего;
  - уведомление — одно на игрока.
- `boost-credits.integration.test.ts`:
  - подарок есть — буст включён без списания самоцветов, подарок −1;
  - подарка нет — самоцветы, как раньше;
  - возврат несостоявшемуся забегу — подарок вернулся.

## Аналитика

`pass_reward_claimed` с `source: "close"` — при выдаче закрытием; словарь — `docs/22` (WP26).

## Настройки и окружение

Нет.

## Документы

По шагу 5.

## Критерии приёмки

- [ ] Новый месяц по Москве закрывает прошлый: незабранное выдаётся само, ровно один раз; VIP-лента — тем, у кого VIP был в этом месяце.
- [ ] Уведомление в игре и в боте.
- [ ] Бусты-подарки тратятся при включении буста и возвращаются несостоявшемуся забегу.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Закрытие месяца пасса и бусты-подарки`
- **Метка:** `release: minor`
- **Для игроков:** пусто — экран — T-0314.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАКРЫТИЕ ПАССА**

  В первую минуту месяца по Москве прошлый пасс закрывается сам: незабранные награды зачисляются, VIP-лента — тем, у кого VIP был в этом месяце. Бусты из пасса тратятся при включении буста вместо самоцветов.
  ```
