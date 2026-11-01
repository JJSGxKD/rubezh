---
id: T-0360
title: Панель — строка «пульса» в шапке: онлайн сейчас, ход рассылки, новые блокировки клиента за час
epic: E7
priority: P3
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0359, T-0148]
zones:
  - apps/admin/src/api/pulse.ts
  - apps/admin/test/pulse.test.ts
  - backend/api/src/modules/admin/admin-pulse.service.ts
  - backend/api/src/modules/admin/admin-pulse.controller.ts
  - backend/api/test/admin-pulse.test.ts
shared:
  - apps/admin/src/screens/Shell.tsx
  - apps/admin/src/state/use-attention.ts
  - backend/api/src/modules/admin/admin.module.ts
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: design/art/direction-v2.md
batch: 4
---

# T-0360. Панель — строка «пульса» в шапке: онлайн сейчас, ход рассылки, новые блокировки клиента за час

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0360.json)](README.md#значки-статуса) [![T-0359](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0359.json&label=T-0359)](T-0359-admin-attention-menu-badge.md) [![T-0148](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0148.json&label=T-0148)](T-0148-online-counter-client.md)

## Зачем

Дежурный открыл панель, чтобы найти игрока, и не видит, что происходит с
игрой прямо сейчас: сколько людей играет, дошла ли рассылка, не посыпались
ли блокировки клиента после выката. После задачи в шапке панели на любом
экране — тонкая строка вида «● 128 онлайн · рассылка 40% · CSP 3 за час».
Каждая часть — ссылка в свой раздел.

## Решения

Находка AD-11 аудита дизайнера (`design/art/direction-v2.md` §4.6).
Решения `claude-lead-1` от 01.11.2026:

- **Запрос** `GET /admin/pulse` → `{ data: { online, broadcast, csp } }`.
  Каждая часть — `null`, если у человека нет на неё права или источник не
  ответил:
  - `online: { total: number } | null` — право `analytics.gameplay.view`;
    из `OnlineService`, тот же снимок, что `GET /admin/online`;
  - `broadcast: { id: string; percent: number } | null` — право
    `broadcast.edit`; рассылка в статусе `sending`. Если таких несколько —
    начатая раньше. Процент — как `sentPercent` в
    `apps/admin/src/api/broadcasts.ts:207`;
  - `csp: { hosts: number } | null` — право `diagnostics.view`; сколько
    пар «директива · адрес» получили отчёт за последний час (`lastAt` не
    старше часа). Число отчётов сервер по часам не хранит, поэтому
    считаются адреса: «CSP 3 за час» — три адреса.
- **Таймауты** — у каждого источника свой, как в сводке (`withTimeout`,
  `READ_TIMEOUT_MS`): один упавший источник не роняет строку.
- **Опрос** — вместе с «Ждёт вас» (T-0359), тем же циклом
  `use-attention.ts`, но раз в 30 с. Пока вкладка скрыта — не опрашиваем.
- **Вид** — в шапке ПК, слева от меню аккаунта, `text-xs text-text-muted`,
  части через « · ». Пустая часть не показывается, все пустые — строки нет.
  - Онлайн: точка цвета `success` и «128 онлайн» → раздел «Онлайн» (T-0148).
  - Рассылка: «рассылка 40%» → карточка рассылки.
  - CSP: «CSP 3 за час» → раздел «Блокировки клиента»; ноль — части нет:
    тихо, значит хорошо.
- **Телефон** — строки нет: шапка там занята заголовком раздела, а пульс
  на телефоне — экран «Онлайн».

## Как сейчас

- `backend/api/src/modules/online/online.controller.ts:44` — `GET
  /admin/online`, `OnlineService`.
- `backend/api/src/modules/csp-reports/csp-reports.controller.ts:41` — сводка
  отчётов, записи с `lastAt`.
- Рассылки — `backend/api/src/modules/broadcasts/`, список с `stats`.
- `apps/admin/src/screens/Shell.tsx:125–139` — шапка ПК.
- После T-0359 — `apps/admin/src/state/use-attention.ts` с опросом.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Сервер:**
   - `AdminPulseService` — три источника с правами и таймаутами;
   - `AdminPulseController`, `GET /admin/pulse` под `AdminSessionGuard`;
   - модуль подключает сервисы онлайна, рассылок и CSP через их модули.
     Чужие репозитории напрямую не трогать.
3. **Панель:**
   - `api/pulse.ts` — схема и чистая функция `pulseParts(pulse)` → части
     строки с текстом и адресом;
   - опрос в `use-attention.ts`;
   - строка в шапке.

## Чего не трогаем

- Раздел «Онлайн» — T-0148.
- Хранение отчётов CSP по часам: адресов за час хватает, отчёты по часам —
  отдельное решение, если понадобятся.

## Сценарий и интерфейс

- **Идёт рассылка, 128 онлайн, блокировок нет** — «● 128 онлайн ·
  рассылка 40%».
- **После выката посыпались блокировки** — «● 96 онлайн · CSP 5 за час»;
  щелчок ведёт в «Блокировки клиента».
- **Модератор без аналитики и рассылок** — только «CSP …», если есть
  `diagnostics.view`, иначе строки нет.

## Тесты

Первым коммитом:

- `backend/api/test/admin-pulse.test.ts`:
  - без прав все части `null`;
  - рассылка `sending` 40 из 100 → `percent: 40`;
  - две `sending` → берётся начатая раньше;
  - CSP: из записей с `lastAt` 10 мин, 50 мин и 2 ч назад → `hosts: 2`;
  - упавший онлайн → `online: null`, остальное есть.
- `apps/admin/test/pulse.test.ts`:
  - `pulseParts` со всеми `null` → `[]`;
  - CSP `hosts: 0` части не даёт;
  - тексты и адреса частей.

## Аналитика

Нет: служебный опрос панели, в Prometheus — ничего с высокой
кардинальностью.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` — строка пульса в шапке и маршрут `/admin/pulse`.
- `docs/21-diagrams.md` — если в схеме модулей бэкенда есть модуль панели,
  связь панели с онлайном, рассылками и CSP.
- `design/art/direction-v2.md` §4.6, строка AD-11: статус «сделано, T-0360».

## Критерии приёмки

- [ ] В шапке ПК — онлайн, ход рассылки и CSP за час по правам; каждая часть
      ведёт в свой раздел.
- [ ] Упавший источник не роняет строку.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Строка пульса в шапке панели`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПУЛЬС В ШАПКЕ ПАНЕЛИ**

  В шапке панели на ПК — онлайн сейчас, ход рассылки и новые блокировки клиента за час. Каждая часть ведёт в свой раздел.
  ```
