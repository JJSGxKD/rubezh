---
id: T-0148
title: Счётчик онлайна — клиент и панель: шапка, кнопка «Играть», разбивка
epic: E16
priority: P2
status: draft
owner:
author: claude-lead-1
size: M
depends_on: [T-0147, T-0176]
zones:
  - packages/app-shell/src/state/online.ts
  - packages/app-shell/src/app/AppHeader.tsx
  - packages/app-shell/src/screens/home.tsx
  - packages/adapter-telegram/src/ui-telegram.ts
  - apps/admin/src/screens/online.tsx
shared:
  - packages/app-shell/src/i18n/ru.json
  - docs/27-design-system-and-app-shell.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0148. Счётчик онлайна — клиент и панель: шапка, кнопка «Играть», разбивка

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0148.json)](README.md#значки-статуса) [![T-0147](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0147.json&label=T-0147)](archive/T-0147-online-counter-backend.md) [![T-0176](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0176.json&label=T-0176)](T-0176-live-feed-client.md)

## Зачем

Клиентская половина Р107 (`docs/35-stage4-plan.md`) поверх API T-0147.

## Решения

Из Р107 (15.10.2026):

- пинг — раз в `nextPingSec` из ответа, только пока приложение видимо;
  пропускается, если за промежуток был другой запрос в API; в забеге — всегда,
  с `inRun: true`;
- игроку — `online` в шапке по центру между кнопками площадки (полный экран
  Telegram, полоса кнопок поверх приложения), иначе — строкой под шапкой;
  `online: null` — «сегодня играли N»;
- `inRun` — подписью на кнопке «Играть», `null` — подписи нет;
- панель — разбивка по площадкам и рекорд, обновление раз в 15 с.

Решение claude-lead-1 от 19.10.2026: T-0148 зависит от T-0176: обе задачи правят `home.tsx`, и
место под кнопкой «Играть» сначала занимает лента событий.

## Открытые вопросы — до `ready`

1. **Макет** (`claude-design`, от нынешней шапки и главной). Плашка в полосе
   кнопок Telegram и строка под шапкой, подпись на «Играть», все ширины
   320–1440 и состояния: онлайн, «сегодня играли», нет чисел.
2. **Полоса кнопок площадки.** Сейчас адаптер складывает системную и
   контентную зоны в один отступ (`ui-telegram.ts:50–64`), и оболочка полосы
   не знает. Нужен порт: необязательный метод `PlatformUi`, отдающий отступ и
   высоту полосы кнопок поверх приложения, `null` у площадок без неё. Решить —
   в этой задаче или отдельной задачей порта до неё.
3. **Тексты** «N онлайн», «сегодня играли N», «N в забеге» — дословно, с
   формами числа и сокращением тысяч.
4. **Настройка игрока** (`docs/27` §7.1): прятать ли счётчик переключателем.
