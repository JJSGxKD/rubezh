---
id: T-0043
title: Окно «Спасибо за тест» и знак «Тестер» в профиле, у друзей и в рейтинге
epic: E2
priority: P1
status: draft
owner:
size: M
depends_on: [T-0042]
zones:
  - packages/app-shell/src/screens/meta/tester-thanks.tsx
  - packages/app-shell/src/state/compensation.ts
  - packages/app-shell/src/i18n/ru-tester.json
  - packages/app-shell/src/state/analytics.ts
  - backend/api/src/modules/events/event-dictionary.ts
shared:
  - packages/shared-types/src/index.ts
  - docs/22-analytics-and-metrics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
---

# T-0043. Окно «Спасибо за тест» и знак «Тестер» в профиле, у друзей и в рейтинге

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0043.json)](README.md#значки-статуса) [![T-0042](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0042.json&label=T-0042)](T-0042-compensation-claim-and-tester-flag.md)

**Черновик.** Не хватает трёх вещей:

- макета `design/screens/tester-thanks.html` — его рисуют тимлиды в E9;
- текстов для игрока, согласованных с пользователем;
- точных путей экранов профиля, друзей и рейтинга, где встаёт знак.

После них задача переходит в `ready`, а зоны дополняются.

## Зачем

После вайпа тестер должен увидеть, что обещание выполнено:

- купленное за звёзды вернулось;
- за игру на тесте дали бонус и знак.

Без окна компенсация лежит на сервере, и о ней никто не знает (T-0042).

## Решения

Р87, решение пользователя от 07.10.2026:

- **Окно «Спасибо за тест» при первом входе после вайпа:**
  - что вернули и что дали сверху: купленное, самоцветы за второй шанс
    (`continueGems`), бонус за уровень;
  - кнопка «Забрать» начисляет один раз.
- **Знак «Тестер» виден в профиле, у друзей и в рейтинге.**

Что уже ясно тимлидам:

- **Окно показывается, пока `GET /api/v1/me/compensation` отдаёт не `null`.**
  Место — то же, что у предупреждения о тесте: отдельный экран в лобби после
  входа, не поверх забега (`docs/35-stage4-plan.md`, WP33, часть 1).
- **«Забрать» → `POST /api/v1/me/compensation/claim`:**
  - балансы из ответа — в шапку;
  - окно закрывается;
  - событие `compensation_claimed` с полями `tester`, `bonusGems`,
    `restoredGems`.
- **Нет сети или ошибка** — окно остаётся, кнопка повторяет запрос. Повтор
  безопасен: сервер не начислит дважды.
- **Признак `tester` в ответах необязательный**, нет поля — не тестер. В
  `packages/shared-types`:
  - у `LeaderboardEntry` — `tester?: true`;
  - у строк друзей и вида сессии — то же.

## Что осталось решить

- Тексты окна и подпись знака — тимлиды предлагают, пользователь утверждает.
- Вид знака рядом с именем — макет E9: чип в цвет акцента, место в строке
  рейтинга на 320 px.
- Пути компонентов профиля, списка друзей и строки рейтинга — разведка при
  переводе в `ready`.

## Аналитика

- Новое событие `compensation_claimed` — сначала в словарь
  `docs/22-analytics-and-metrics.md` §3.3 и в
  `backend/api/src/modules/events/event-dictionary.ts`, потом в клиент. Поля:
  - `tester: boolean`;
  - `bonusGems: count`;
  - `restoredGems: count`.

## Критерии приёмки

Будут уточнены при переводе в `ready`.

- [ ] Тестер после вайпа видит окно один раз. Нажатие «Забрать» начисляет
  компенсацию, балансы обновляются.
- [ ] Знак «Тестер» виден в профиле, у друзей и в рейтинге, только у тестеров.
- [ ] Снимки окна и строк со знаком — на 320, 390, 768 и 1440 px.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.
