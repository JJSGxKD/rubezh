---
id: T-0199
title: Переброс карточек за рекламу — один раз за забег, когда заряды кончились
epic: E10
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0101, T-0089, T-0102, T-0103, T-0106, T-0107, T-0113, T-0116, T-0118, T-0119, T-0120, T-0121, T-0122, T-0123, T-0124, T-0125, T-0127, T-0129, T-0130, T-0131, T-0168, T-0170, T-0171, T-0172, T-0175, T-0182, T-0190, T-0191, T-0193, T-0194, T-0195, T-0196, T-0198]
zones:
  - packages/core-game/src/game/progression/card-tools.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/run-api.ts
  - packages/core-game/test/ad-reroll.test.ts
  - backend/api/src/modules/ads/ads-rules.ts
  - backend/api/src/modules/ads/ad-networks.ts
  - backend/api/src/modules/ads/ads.service.ts
  - backend/api/src/modules/runs/run-ad-reroll.service.ts
  - backend/api/src/modules/runs/run-ad-reroll.controller.ts
  - backend/api/src/modules/runs/run-ad-rerolls.repository.ts
  - backend/api/src/modules/runs/run-reroll-errors.ts
  - backend/api/src/modules/runs/runs.module.ts
  - backend/api/src/modules/runs/runs-limits.ts
  - backend/api/src/modules/runs/run-verdict.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - backend/api/test/run-ad-reroll.test.ts
  - backend/api/test/run-ad-reroll.integration.test.ts
  - backend/api/test/run-verdict.test.ts
  - backend/api/test/ads.test.ts
  - backend/api/test/ads-catalog.test.ts
  - apps/admin/src/api/ads.ts
  - apps/admin/test/ads.test.ts
  - packages/app-shell/src/state/ads-api.ts
  - packages/app-shell/src/state/ad-reroll.ts
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/state/runs.ts
  - packages/app-shell/src/screens/run/CardTools.tsx
  - packages/app-shell/src/screens/run/card-tools-rules.ts
  - packages/app-shell/src/screens/run/overlays.tsx
  - packages/app-shell/src/screens/run/RunScreen.tsx
  - packages/app-shell/src/i18n/ru-run.json
  - packages/app-shell/src/i18n/ru-guide.json
  - packages/app-shell/test/ad-reroll.test.ts
  - packages/app-shell/test/card-tools-rules.test.ts
shared:
  - packages/shared-types/src/index.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/src/state/analytics.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/wipe/wipe-plan.ts
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0199. Переброс карточек за рекламу — один раз за забег, когда заряды кончились

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0199.json)](README.md#значки-статуса) [![T-0101](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0101.json&label=T-0101)](archive/T-0101-card-reroll-skip-banish.md) [![T-0089](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0089.json&label=T-0089)](archive/T-0089-vip-ad-pass-mark.md) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](archive/T-0102-weapon-evolutions-data-and-engine.md) [![T-0103](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0103.json&label=T-0103)](archive/T-0103-weapon-evolution-recipes-in-game.md) [![T-0106](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0106.json&label=T-0106)](T-0106-achievements-prestige-server.md) [![T-0107](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0107.json&label=T-0107)](T-0107-achievements-showcase-shell.md) [![T-0113](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0113.json&label=T-0113)](T-0113-boards-by-viewer.md) [![T-0116](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0116.json&label=T-0116)](archive/T-0116-freeze-pickup.md) [![T-0118](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0118.json&label=T-0118)](archive/T-0118-seventh-weapon-meteor-and-evolution.md) [![T-0119](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0119.json&label=T-0119)](T-0119-run-modifiers-hurry-inverse.md) [![T-0120](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0120.json&label=T-0120)](T-0120-rubezh-guard-engine.md) [![T-0121](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0121.json&label=T-0121)](T-0121-rubezh-win-reward-server.md) [![T-0122](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0122.json&label=T-0122)](T-0122-run-modifiers-server.md) [![T-0123](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0123.json&label=T-0123)](T-0123-run-modifiers-prerun-sheet.md) [![T-0124](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0124.json&label=T-0124)](T-0124-rubezh-banners-and-death-screen.md) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](archive/T-0125-run-result-rank-chest-crystal-counters.md) [![T-0127](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0127.json&label=T-0127)](T-0127-enemy-codex.md) [![T-0129](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0129.json&label=T-0129)](T-0129-daily-challenge-engine.md) [![T-0130](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0130.json&label=T-0130)](T-0130-daily-challenge-server.md) [![T-0131](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0131.json&label=T-0131)](T-0131-daily-challenge-shell-and-panel.md) [![T-0168](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0168.json&label=T-0168)](T-0168-admin-ad-networks-order.md) [![T-0170](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0170.json&label=T-0170)](archive/T-0170-cordon-ring-engine.md) [![T-0171](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0171.json&label=T-0171)](archive/T-0171-cordon-guard-content.md) [![T-0172](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0172.json&label=T-0172)](archive/T-0172-remove-shooting-enemies.md) [![T-0175](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0175.json&label=T-0175)](T-0175-live-feed-boss-and-rare-chest.md) [![T-0182](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0182.json&label=T-0182)](archive/T-0182-cordon-ring-analytics.md) [![T-0190](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0190.json&label=T-0190)](T-0190-single-difficulty-shell.md) [![T-0191](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0191.json&label=T-0191)](T-0191-single-difficulty-server.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md) [![T-0194](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0194.json&label=T-0194)](T-0194-limit-break-offers.md) [![T-0195](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0195.json&label=T-0195)](T-0195-player-power-pressure-engine.md) [![T-0196](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0196.json&label=T-0196)](T-0196-player-power-pressure-wiring.md) [![T-0198](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0198.json&label=T-0198)](T-0198-remove-enemy-projectile-code.md)

## Зачем

Заряды переброса (T-0101) кончаются, а «выпало не то» остаётся. Игрок, у которого
зарядов нет — ещё не набрал уровень аккаунта или всё потратил, — может один раз за
забег посмотреть ролик и получить ещё один переброс. Игрок получает контроль над
выбором, мы — показ рекламы в месте, где человек сам хочет её посмотреть.

## Решения

Р133 (`docs/35-stage4-plan.md`, 21.10.2026) и Р102. Исполнитель их не пересматривает.

- **Что продаётся.** Только переброс. Пропуск и изгнание за рекламу не продаются:
  они остаются наградой уровня аккаунта и буста «Контроль».
- **Сколько.** Один переброс за ролик и **один раз за забег** — не за уровень и не за
  сутки. Суточного потолка нет: награда не валюта, а ограничение «раз за забег» держат
  и движок, и сервер.
- **Когда видна кнопка.** Только на выборе улучшения и только если одновременно:
  зарядов переброса нет (`left.reroll == 0`, в том числе у игрока, у которого их не было
  вовсе); переброс сработает (на карточках не одно лечение, есть что показать нового);
  за рекламу в этом забеге ещё не перебрасывали; площадка умеет показывать ролик, а сервер
  говорит, что реклама для этого места есть. Нет рекламы у сети — кнопки нет, объяснений
  не показывается.
- **Новое место показа `card_reroll`** («Переброс карточек»), формат `rewarded`, по
  образцу `second_chance` и `run_double`: награда — переброс, выдаёт его хозяин места
  (модуль забегов), модуль рекламы лишь ручается, что показ был. Блоки места в панели
  заводит команда, как для других мест; пока блоков нет, реклама для места недоступна и
  кнопки нет.
- **VIP — без ролика** (`pass: true`, `docs/35-stage4-plan.md` §3.6): тот же переброс, один
  раз за забег, кнопка с другой подписью.
- **Тот же механизм, что у T-0101.** Новые карточки берутся из `world.cardRng`, кандидаты
  и число карточек те же. Отличие одно: переброс за рекламу списывает не заряд, а право
  «раз за забег». Новой случайности нет, `world.rng` не трогается, забег без рекламного
  переброса не меняется ни на бит, golden остаются прежними.
- **Проверка на сервере — книга показов, как у второго шанса.** Сервер забеги заново не
  проигрывает (серверный повтор — этап 4+, `docs/34-stage3-plan.md` Р6), поэтому
  рекламный переброс засчитывается так же, как продолжение: клиент перед перебросом
  забирает у сервера досмотренную сессию показа, сервер пишет её в таблицу рядом с
  забегом, а при приёме итога сверяет заявленное число с таблицей. Заявлен рекламный
  переброс без записи — забег отклоняется с нейтральной причиной «рекламный переброс не
  подтверждён» (как «неоплаченное продолжение»). Когда появится серверный повтор забега,
  он сверит число команд `~adreroll` в записи с той же таблицей.
- **Условная команда в логе выбора** — `~adreroll` (рядом с `~reroll`, `~skip`,
  `~banish:` из T-0101). Движок принимает её, только если зарядов переброса нет и
  рекламный переброс в забеге ещё не использован; иначе запись «не ложится на забег».
- **Принято:** если связь оборвалась после того, как сервер записал показ, а до переброса
  в движке, переброс пропадает (сервер скажет «уже использован»). Награда копеечная,
  защита от повторов важнее.
- Тексты для игрока — «Шаги», п. 9. Исполнитель их не меняет.

## Как сейчас

Опираемся на T-0101 (в `dev` её файлов может ещё не быть — задача зависит от неё; ниже
имена из ветки `task/T-0101`, сверь с влитым).

- `game/progression/card-tools.ts` (T-0101): `REROLL_COMMAND`, `canReroll(world)`,
  `applyCardTool(world, command)`; внутренний `reroll(world)` берёт `candidatesOutside`,
  добирает `pickWeighted(world.cardRng, …)` и списывает `progression.tools.reroll`.
  `CardToolOutcome = { kind, left, item }`.
- `game/MainScene.ts` (T-0101): `applyCardToolCommand(command)` — только в фазе
  `choosing`, пишет `probe.choice(world, command)`, шлёт `cardTool`, затем
  `emitLevelUp(true)`. `emitLevelUp` отдаёт `tools`, `toolsTotal`, `canReroll`, `refreshed`.
- `game/diagnostics/replay.ts` (T-0101): выбор с `~` идёт в `applyCardTool`
  (`isCardToolCommand`), поэтому новая команда в повторе заработает без правок файла.
- `run-api.ts`: `RunEvents.levelUp`, `RunEvents.cardTool`, `RunSession.rerollOffers()`.
- `game/run/run-result.ts:59` — итог забега, поле `boosts` необязательное; образец для
  `adRerolls`. `shared-types/src/index.ts` — `RunResult` (~1259) и `RunFinish` (~1313).
- **Реклама.** `backend/api/src/modules/ads/`: `ads-rules.ts` — `AD_PLACES` (15),
  `PLACE_RULES` (54); `ad-networks.ts` — `PLACE_FORMAT` (37), `PLACE_TITLES` (59);
  `ads.service.ts` — `RESTRICTED_BY` (~139), `readiness(player, place, at)` и
  `claim(accountId, sessionId, place, at)`. `interstitial-gate.ts:38` —
  `REWARDED_VIDEO_PLACES` собирается из мест формата `rewarded`: новое место попадает
  туда само, и ролик за переброс, как любой другой ролик за награду, отодвигает
  межстраничную (так задумано).
- **Образец хозяина места — второй шанс:** `runs/run-ad-continue.service.ts`
  (`view`, `claim`, порядок «проверка → забор сессии → запись», повтор той же сессии
  отдаёт тот же ответ), `run-ad-continue.controller.ts`, `run-ad-continues.repository.ts`
  (`ON CONFLICT DO NOTHING`, исходы `granted | repeat | taken`), `run-continue-errors.ts`,
  таблица `run_ad_continue` (миграция `20261002140000_run_ad_continue`, модель
  `RunAdContinue` в `schema.prisma`), запись в `wipe/wipe-plan.ts` (101, 123) и
  `wipe/wipe-runner.ts` (133, 178), лимит `RUNS_LIMITS.adContinue` в `runs-limits.ts`.
  Сверка итога: `runs.service.ts` `finish()` (~83–110) и `run-verdict.ts`
  (`unpaid_continue` в `REJECTING`, `judgeRun`).
- **Оболочка.** `state/ad-continue.ts` — образец: схемы `zod/mini`, стадии `idle | checking |
  ready | watching | unavailable`, `watched` (досмотренная, но не забранная сессия — повтор
  без второго ролика), одна пауза и повтор при `run_unverified`. `state/ad-watch.ts` —
  `watchAd(place)`, `trackAdReward`, `adsPlayable()`. `state/ads-api.ts:15` —
  `AD_PLACES` клиента. `state/runs.ts` — очередь итогов: схема сохранённого итога (~55–70)
  и сборка тела отправки (~270–290, образец — `continues`, `boosts`).
- **Панель:** `apps/admin/src/api/ads.ts:17` — свой список мест и названия (29–32).
  Тесты, перечисляющие места: `backend/api/test/ads.test.ts:682`
  (`REWARDED_VIDEO_PLACES`), `ads-catalog.test.ts:253`, `apps/admin/test/ads.test.ts:104,145`.

## Шаги по порядку

Пункт — коммит; тесты (1) — первым.

1. **Тесты** (раздел «Тесты») — первым коммитом, падают до кода.
2. **Типы и контракт.** `shared-types`: `RunResult.adRerolls?: number` (комментарий: сколько
   раз за забег переброс взят за рекламу; нет поля — не брали, в том числе итог прошлой
   сборки) и то же поле в `RunFinish`.
3. **Движок.**
   - `world.ts`: `progression.adRerolls: number` (0 при создании). `snapshot.ts`: поле в
     снимке `progression` с проверкой типа (целое, 0..`MAX_AD_REROLLS`), версия
     `WORLD_SNAPSHOT_VERSION` + 1 от значения в `dev` на момент PR.
   - `card-tools.ts`: `AD_REROLL_COMMAND = "~adreroll"`, `MAX_AD_REROLLS = 1`;
     `canAdReroll(world)`: ждёт выбора, `tools.reroll === 0`, `adRerolls < MAX_AD_REROLLS`, на
     карточках есть не-лечение, есть кандидат вне показанных. Внутренний `reroll` делится
     на «заменить карточки» (`replaceOffers(world)`, общий) и «списать заряд»; этот
     рефакторинг — **отдельным коммитом** без изменения поведения, T-0101 и golden не
     меняются. `applyCardTool(world, "~adreroll")` → `canAdReroll`, `replaceOffers`,
     `adRerolls++`; итог `{ kind: "reroll", left: 0, item: null, viaAd: true }` (в
     `CardToolOutcome` необязательное `viaAd?: true`).
   - `run-result.ts`: `...(world.progression.adRerolls === 0 ? {} : { adRerolls: world.progression.adRerolls })`.
   - `run-api.ts`: в `RunEvents.levelUp` — `canAdReroll: boolean`; в `cardTool` —
     необязательное `viaAd?: true`; в `RunSession` — `rerollOffersViaAd(): void` («переброс
     за рекламу: оболочка зовёт его только после того, как сервер записал показ»).
     `MainScene.ts`: `rerollOffersViaAd()` → `applyCardToolCommand(AD_REROLL_COMMAND)`;
     `emitLevelUp` отдаёт `canAdReroll(world)`; `cardTool` несёт `viaAd`.
     `replay.ts` не правится: команда с `~` уже идёт в `applyCardTool`.
4. **Место показа на сервере.**
   - `schema.prisma`: значение `card_reroll` в `enum AdPlace`; модель `RunAdReroll`
     (`run_ad_reroll`) блоком в конце файла по образцу `RunAdContinue`: `runId` — первичный
     ключ (рекламный переброс один на забег), `accountId`, `sessionId` (уникален),
     `networkKey`, `grantedAt`; связи с `Run` и `Account` с `onDelete: Cascade`, строка
     связи в `model Account` и `model Run` — по одной.
   - Миграция — один раз, командой `prisma migrate dev --create-only` на отдельной базе,
     **после** перебазирования на свежий `dev`; проверить, что папка одна
     (`ls backend/api/prisma/migrations | tail`). В SQL: `ALTER TYPE "AdPlace" ADD VALUE
     'card_reroll'` и создание таблицы с внешними ключами, как в миграции второго шанса.
   - `ads-rules.ts`: `"card_reroll"` в `AD_PLACES` (после `run_double`, до `task`),
     `PLACE_RULES.card_reroll = { rewarded: true, pass: true, cooldown: null }` (ограничение
     «раз за забег» у хозяина места, как у второго шанса). `ad-networks.ts`:
     `PLACE_FORMAT.card_reroll = "rewarded"`, `PLACE_TITLES.card_reroll = "Переброс карточек"`.
     `ads.service.ts`: `RESTRICTED_BY.card_reroll = "ad_rewards"`. Остальные
     `Record<AdPlace, …>` покажет `pnpm typecheck` — в каждый дописывается своя строка.
   - `apps/admin/src/api/ads.ts`: то же место и название в списках панели.
5. **Хозяин места — модуль забегов.**
   - `run-ad-rerolls.repository.ts`: токен `RUN_AD_REROLLS_REPOSITORY`, интерфейс
     `grant({ runId, accountId, sessionId, networkKey, grantedAt }) → "granted" | "repeat" |
     "taken"` (`INSERT … ON CONFLICT DO NOTHING`, затем разбор, чем занят ключ),
     `bySession(sessionId)`, `count(runId): Promise<number>`; реализация на Prisma.
   - `run-reroll-errors.ts`: коды `reroll_unavailable` (забег закончен или рекламный
     переброс уже взят, 409) и `reroll_taken` (сессия потрачена на другой забег, 409);
     «сервер не знает забег» — тот же `ContinueRunUnverifiedError` (`run_unverified`),
     клиент уже умеет его ждать.
   - `run-ad-reroll.service.ts` (`RunAdRerollService`): `view(player, runId)` →
     `{ status: "available", pass: string | null } | { status: "unavailable", reason: "unverified" | "finished" | "used_up" | "no_ads" }`;
     `claim(player, runId, sessionId, at)` — порядок как у `RunAdContinueService.claim`:
     сессия уже потрачена на этот забег — тот же ответ; чужой и незнакомый забег —
     одинаково `run_unverified`; закончен или рекламный переброс уже есть —
     `reroll_unavailable`; затем `ads.claim(accountId, sessionId, "card_reroll", at)`, затем
     `grant`; лог `run_ad_rerolled` (модуль, аккаунт, забег, сеть); `paid(runId, claimed)` →
     сколько показов подтверждено (для сверки итога). Все обращения к базе — с
     `withTimeout`.
   - `run-ad-reroll.controller.ts`: `GET` и `POST /api/v1/runs/:runId/rerolls/ad`, тело POST
     `{ sessionId }` (`z.object({ sessionId: regex 16 знаков }).strict()`, как у второго шанса),
     ответ POST `{ data: { granted: true } }`, `AuthGuard`, лимит `RUNS_LIMITS.adReroll`
     (`runs:reroll-ad`, 120 в час) в `runs-limits.ts`. Подключить в `runs.module.ts`
     (контроллер, сервис, репозиторий; сервис с `exports` — он нужен `RunsService`).
   - `wipe-plan.ts` и `wipe-runner.ts`: модель `RunAdReroll` («рекламный переброс — часть
     забега»), таблица `run_ad_reroll`, ветка в `switch` — по образцу `RunAdContinue`.
6. **Приём итога.** `dto/runs.dto.ts`: `adRerolls: z.number().int().min(0).max(1).default(0)`.
   `runs.service.ts` `finish()`: рядом с `continues.check` — `adRerolls.paid(run.runId,
   run.adRerolls)` (при нуле в базу не ходить); в `judgeRun` — `adRerolls` и
   `paidAdRerolls`. `run-verdict.ts`: причина `unpaid_ad_reroll` («рекламный переброс не
   подтверждён показом») в `REJECTING`, условие `!cheats && adRerolls > paidAdRerolls`
   (забег с читами разработчика исключён, как у продолжений). Описание в шапке файла —
   нейтральное, без подсказок, как обойти.
7. **Оболочка: состояние.**
   - `state/ads-api.ts`: `"card_reroll"` в `AD_PLACES`.
   - `state/ad-reroll.ts` (новый, по образцу `ad-continue.ts`, не копией): `createAdRerollApi`
     (`view(runId)`, `claim(runId, sessionId)`, схемы `zod/mini`), стор `useAdReroll` со
     стадиями `idle | checking | ready { pass } | watching | gone`, заметкой
     `notice: "closed" | "failed" | "claim_failed" | "restricted" | null` и `watched`
     (досмотренная, но не забранная сессия). `prepare(runId)` зовётся один раз на забег,
     когда движок прислал `levelUp` с `canAdReroll`, `left.reroll == 0` и `adsPlayable()`:
     перед вопросом `useRuns.getState().flush("continue")` (старт забега мог лежать в
     очереди), `run_unverified` — одна пауза 1,5 с и второй вопрос; ответ `unavailable` с
     любой причиной закрывает стадию (`gone`) до конца забега; смена `runId` сбрасывает стор.
     `watch()`: `watchAd("card_reroll")` → `watched` → `claim` → успех: `trackAdReward("card_reroll",
     source)` и `useRun.getState().rerollViaAd()`; `closed` — заметка «ролик закрыт», кнопка
     остаётся; `no_ads` и `cooldown` — `gone`; `restricted` — заметка и `gone`; `failed` —
     заметка «не загрузилась»; claim не ответил — `claim_failed`, повтор забирает ту же
     сессию без нового ролика; ответы `reroll_unavailable`, `reroll_taken`, `run_unverified`
     после повтора — `gone`.
   - `state/run.ts`: поле `canAdReroll` из `levelUp`; `runId` забега в сторе (из `started` и
     из восстановленного сохранения — `state/run-save.ts:28`), если поля ещё нет;
     действие `rerollViaAd()` — только в фазе `levelUp`, `audio.runEvent("choose")`,
     `session?.rerollOffersViaAd()`; обработчик `cardTool` шлёт `card_rerolled` с `via: "ad"`
     при `viaAd`. `state/runs.ts`: `adRerolls` — необязательное поле схемы сохранённого
     итога и тела отправки (только если больше нуля), как `boosts`.
   - `card-tools-rules.ts`: чистая функция `adRerollButton({ left, canAdReroll, stage,
     banishing })` → `{ kind: "hidden" } | { kind: "ready"; pass: boolean } | { kind: "busy" }`;
     видна только при `left.reroll == 0`, `canAdReroll`, стадии `ready` или `watching`, вне
     режима изгнания.
8. **Оболочка: экран.**
   - `CardTools.tsx`, `overlays.tsx`, `RunScreen.tsx`: под рядом T-0101 — кнопка
     `btn-secondary` на всю ширину, высота от 44 px, значок `Tv` (`lucide-react`), подпись
     из словаря; пока идёт ролик — отключена, `aria-busy`. Серая «Переброс ×0» ряда T-0101
     остаётся (ряд не прыгает). Если ряда нет (зарядов не было вовсе) — кнопка одна, под
     карточками. На невысоком экране (`short:`) кнопка встаёт в ряд **вместо** серой
     «Переброс», с короткой подписью, а подпись «Один раз за забег» уходит: окно не должно
     уходить в прокрутку на 667×375 (так принят T-0101). Заметка стадии — строка
     `text-warning` под кнопкой, `role="status"`. В режиме изгнания кнопки нет.
   - Анимации — только `transform` и `opacity`; цвета и отступы — из токенов; отдельного
     переключателя настроек нет (обычная кнопка, как другие кнопки окна).
   - В момент появления кнопки (стадия стала `ready` на экране нового выбора, не при
     `refreshed`) — событие `card_reroll_ad_offered` (см. «Аналитика»).
9. **Тексты дословно** (`ru-run.json`, рядом с `run.tools.*`):

   | Ключ | Текст |
   |---|---|
   | `run.tools.rerollAd` | Перебросить за рекламу |
   | `run.tools.rerollAd.short` | За рекламу |
   | `run.tools.rerollAd.pass` | Перебросить — VIP, без рекламы |
   | `run.tools.rerollAd.pass.short` | VIP, без рекламы |
   | `run.tools.rerollAd.once` | Один раз за забег |
   | `run.tools.rerollAd.notice.closed` | Ролик закрыт раньше конца — переброса нет |
   | `run.tools.rerollAd.notice.failed` | Реклама не загрузилась — попробуйте ещё раз |
   | `run.tools.rerollAd.notice.claim_failed` | Ролик засчитан, но сервер не ответил — нажмите ещё раз, смотреть заново не придётся |
   | `run.tools.rerollAd.notice.restricted` | Награды за рекламу закрыты — подробности в профиле |

   `aria-label` кнопки — подпись и « — один раз за забег». Гайдбук (`ru-guide.json`): в
   абзац про переброс, пропуск и изгнание (T-0101) добавить предложение: «Когда
   переброски кончились, один раз за забег их можно получить за просмотр рекламы;
   пропуск и изгнание за рекламу не даются». Абзац найти по `grep "изгнан" ru-guide.json`;
   ключ не новый, а тот же.
10. **Аналитика и документы** — по разделам ниже; документы — коммитом той части, что
    они описывают.

## Чего не трогаем

- Пропуск и изгнание: за рекламу их нет и не будет в этой задаче.
- Заряды, `CARD_TOOL_UNLOCKS`, буст «Контроль», числа T-0101.
- Поток `world.cardRng`, `world.rng`, `STREAM_SALT`, golden-эталоны — без правок.
- Второй шанс (`run-ad-continue.*`, `ad-continue.ts`) и удвоение награды: только
  читаем как образец.
- Выдача сессий показа и сети (`ads.service.ts` — только строка `RESTRICTED_BY`),
  адаптеры сетей, CSP: у нового места формат тот же `rewarded`, сети те же.
- Межстраничная и её политика: ролик за переброс отодвигает её так же, как другие
  ролики за награду.
- Серверный повтор забега: его нет (`docs/34-stage3-plan.md` Р6), здесь не заводится.
- Блоки места в панели и кабинетах сетей: заводит команда после выката (раздел «Нужно от
  команды»), исполнитель кабинеты не трогает.

## Сценарий и интерфейс

Макета нет (`design: null`): ориентир — `LevelUpOverlay` и ряд `CardToolsBar` из T-0101.
Снимки на 320, 390, 768, 1440 px и ландшафт 667×375; окно не уходит в прокрутку на
высоте 360 px.

- **Зарядов нет, реклама есть:** под карточками (и под рядом, если он есть) кнопка
  «Перебросить за рекламу», под ней «Один раз за забег». У VIP — «Перебросить — VIP,
  без рекламы».
- **Нажатие:** игра на паузе, звук приглушён (как у любого ролика), кнопка отключена
  до конца показа. Досмотрел — карточки сменились (появление проигрывается заново),
  кнопка исчезла до конца забега.
- **Закрыл ролик раньше конца или реклама не загрузилась:** строка под кнопкой, кнопка
  остаётся, можно нажать ещё раз. Досмотрел, а сервер не ответил: «Ролик засчитан…» —
  повтор без нового ролика.
- **Загрузка:** пока сервер отвечает на вопрос «можно ли», кнопки нет (не мигает).
- **Пусто, нет сети, реклама недоступна, ограничение аккаунта:** кнопки нет; если
  ограничение закрыло награды уже после нажатия — строка про закрытые награды.
- **Режим изгнания и карточки одного лечения:** кнопки нет.
- Площадка без показа рекламы (`adsPlayable()` ложно): кнопки нет.

## Тесты

Пишутся первым коммитом.

`packages/core-game/test/ad-reroll.test.ts` (мир на фикстурах, как в `card-tools.test.ts`):

- `~adreroll` без зарядов: карточки заменены, ни одна не совпадает с прежними по `id`,
  число то же (+1 с `extraOffers`), `world.rng.getState()` не изменилось, `adRerolls == 1`,
  итог `viaAd: true`, `tools.reroll` по-прежнему 0;
- второй `~adreroll` в том же забеге → `null`, карточки целы; при `tools.reroll == 1` →
  `null`, заряд цел; на одном лечении и без кандидатов → `null`; вне выбора → `null`;
- обычный `~reroll` и `~adreroll` из одного состояния дают **те же** новые карточки
  (один поток случайности);
- снимок: после `~adreroll` снимок возвращает `adRerolls` и `cardRng`, повторный
  рекламный переброс невозможен, следующие карточки совпадают с прогоном без перерыва;
  прежняя версия снимка → `SnapshotError`;
- запись: забег с `~adreroll` через `replayRecording` «сошёлся»; вторая команда или
  команда при ненулевых зарядах → «не ложится на забег»; `buildRunResult` несёт
  `adRerolls: 1`, без рекламного переброса поля нет;
- **все существующие golden-тесты проходят без правки эталонов.**

`backend/api/test/run-ad-reroll.test.ts` (память вместо базы, по образцу
`run-ad-continue.test.ts`, `MemoryAds` и `MemoryRunsRepository` из `test/helpers`):

- `view`: незнакомый и чужой забег — одинаково `unverified`; записанный как законченный —
  `finished`; свежий забег с блоком места — `available`; без блоков для места — `no_ads`;
  VIP — `available` с пропуском; после `grant` — `used_up`; ограничение `ad_rewards` — `no_ads`;
- `claim`: досмотренная сессия записывает показ; повтор той же сессии на тот же забег —
  тот же ответ, строка одна; та же сессия на другой забег — `reroll_taken`; вторая сессия на
  тот же забег — `reroll_unavailable`, **вторая сессия не потрачена** (её ещё можно забрать
  на другом забеге); недосмотренная сессия — отказ и записи нет; сессия другого места
  (`wheel_spin`) и чужого игрока — отказ; пропуск VIP забирается так же;
- `paid(runId, 1)` после `claim` — 1; без `claim` — 0;
- HTTP: без токена 401; кривая сессия 400; успех 200 `{ granted: true }`; отказы 409 с кодами
  `reroll_unavailable`, `reroll_taken`, `run_unverified`; сверх лимита частоты — 429.

`backend/api/test/run-verdict.test.ts`: `adRerolls: 1, paidAdRerolls: 0` → `rejected` с
`unpaid_ad_reroll`; `1/1` → `ok`; `0/0` → `ok`; с `cheats: true` и `1/0` — без этой причины.
Приём итога (`runs.test.ts` или интеграционный): забег с `adRerolls: 1` без записи отклонён,
с записью принят; итог без поля — как `0`.

`backend/api/test/run-ad-reroll.integration.test.ts` (живые Postgres и Redis): уникальность
`run_id` и `session_id` — одновременные `grant` двух сессий на один забег дают ровно один
`granted`; удаление забега каскадом убирает строку; вайп (`wipe-plan.test.ts`,
`wipe-runner.integration.test.ts`) знает новую модель — если эти тесты красные, правится
запись в плане, а не тест.

`backend/api/test/ads.test.ts` (`REWARDED_VIDEO_PLACES` включает `card_reroll`),
`ads-catalog.test.ts` (список мест, формат места — `rewarded`), `apps/admin/test/ads.test.ts`
(места и подписи): ожидания обновлены.

`packages/app-shell/test/ad-reroll.test.ts` (по образцу `ad-continue.test.ts`, подмена
зависимостей `setAdRerollDepsForTests`): `prepare` не зовёт сервер, если заряды ещё есть,
нет `canAdReroll` или `adsPlayable()` ложно; `available` → `ready`; `unavailable` (любая
причина) → `gone`, повторного вопроса в этом забеге нет; `run_unverified` → пауза и второй
вопрос; смена `runId` сбрасывает стадию; `watch`: `watched` → `claim` → `rerollViaAd` один
раз и `ad_reward_claimed` с `place: "card_reroll"`; `closed` → заметка, стадия `ready`;
`failed` → заметка; `claim` не ответил → `claim_failed`, повтор забирает **ту же** сессию
без второго `watchAd`; `reroll_taken` → `gone`; VIP (`pass`) — без ролика.
`packages/app-shell/test/card-tools-rules.test.ts`: `adRerollButton` — `hidden` при
зарядах, без `canAdReroll`, в режиме изгнания, в стадиях `gone` и `idle`; `ready` с `pass`;
`busy`. Ключи `run.tools.rerollAd*` есть в словаре. Снимки экрана — по списку «Сценарий».

## Аналитика

Сначала словарь (`docs/22` §3.3), потом Zod (`event-dictionary.ts`) и список клиента
(`state/analytics.ts`), потом код. Версия 1.

| Событие | Что |
|---|---|
| `card_rerolled` (T-0101) | Необязательное поле `via` (`id`): `"ad"` у переброса за рекламу, у обычного нет. Шлёт оболочка по `cardTool` с `viaAd` |
| `card_reroll_ad_offered` (новое) | Кнопка «Перебросить за рекламу» показана игроку. Поля: `level` (уровень выбора), `pass` (`z.boolean()`, VIP без ролика). Раз на экран нового выбора, при `refreshed` не шлётся. Знаменатель для `card_rerolled` с `via: ad`: без него не посчитать, какая доля увидевших кнопку досматривает ролик |
| `ad_shown`, `ad_failed`, `ad_reward_claimed` | Существующие, место `card_reroll` — через общие `watchAd` и `trackAdReward`; новых полей нет |

В `docs/22` описание `ad_reward_claimed` («колесо, удвоение за забег») дополняется местом
«переброс карточек»; в группу «Забеги» — `card_reroll_ad_offered`.

## Настройки и окружение

Нет новых ключей и переменных. `MAX_AD_REROLLS = 1` — константа движка (правило, а не
баланс); лимит частоты `RUNS_LIMITS.adReroll` — рядом с остальными лимитами забегов. Какая
сеть показывает ролик в месте — блоки в панели, не код.

## Документы

- `docs/22-analytics-and-metrics.md` — событие, поле `via`, место в `ad_reward_claimed`.
- `docs/21-diagrams.md` — ER: сущность `RUN_AD_REROLL` и связи с `RUN` и `ACCOUNT` (рядом с
  `RUN_AD_CONTINUE`, строки 104 и 779), перечень значений `AD_BLOCK.place` (748), абзац
  про `RUN_AD_REROLL` рядом с абзацем про `RUN_AD_CONTINUE` (1128).
- `docs/30-configuration-map.md` — строка «Рекламный переброс: лимит `RUNS_LIMITS.adReroll`,
  правило `MAX_AD_REROLLS`, блоки места `card_reroll` — в панели».
- `docs/35-stage4-plan.md` §3.7, абзац «Места показа» (~586): добавить «переброс
  карточек»; запись Р133 дополнить «сделано в T-0199».
- `docs/07-monetization-and-ads.md` — место показа в перечне рекламных мест, если он там
  есть; `docs/39-retention-mechanics.md` Б3 — одна строка про рекламный переброс;
  `docs/32-balance.md` — в абзаце про заряды (T-0101) фраза: рекламный переброс вне golden
  и коридоров, бот его не использует; `docs/27-design-system-and-app-shell.md` — строка про
  кнопку под рядом действий, если окно выбора там описано.
- Гайдбук — шаг 9.

## Нужно от команды (после выката, не исполнителю)

Блоки для места «Переброс карточек» (`card_reroll`) заводит команда в панели (раздел
«Реклама») и, где сеть требует, в кабинете сети — по тем же правилам, что для «Второго
шанса». Пока блоков нет, кнопки у игроков нет — это штатное поведение, не сбой.

## Вопросы к тимлиду

- Размер на верхней границе M. Не вмещается — отрезать оболочку (шаги 7–8) в отдельную
  задачу; движок и сервер без неё безопасны (кнопки просто нет).
- Принято при записи спецификации из Р133 (подтвердить): суточного потолка рекламных
  переборов нет; игрок, у которого зарядов не было вовсе, кнопку видит; обрыв между
  забором показа и перебросом переброс теряет.

## Критерии приёмки

- [ ] При нуле зарядов, живой рекламе и неиспользованном праве на экране выбора есть кнопка;
  по досмотру карточки заменяются, кнопка до конца забега исчезает. Заряды есть, нет
  рекламы, площадка без показа, режим изгнания — кнопки нет.
- [ ] Рекламный переброс один за забег — и в движке (`adRerolls`, снимок), и на сервере
  (`run_id` уникален в таблице).
- [ ] Нового потока случайности нет: `~adreroll` и `~reroll` из одного состояния дают
  одинаковые карточки; `world.rng` не двигается; **golden без правки**.
- [ ] Итог с `adRerolls: 1` без записанного показа отклоняется причиной «рекламный
  переброс не подтверждён»; с записью принимается; итог без поля принимается.
- [ ] Пропуск и изгнание за рекламу недоступны ни в оболочке, ни в движке.
- [ ] Место `card_reroll` — в enum базы, правилах, названиях, панели и тестах списков;
  модель и таблица внесены в вайп.
- [ ] События в словаре, схеме, клиенте и `docs/22`; ER и карта конфигурации обновлены.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и `pnpm docs:check`
  зелёные.

## PR

- **Заголовок:** `feat(core-game): Добавить переброс карточек за рекламу`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: когда переброски карточек кончились, один раз за забег их можно получить за просмотр рекламы`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПЕРЕБРОС КАРТОЧЕК ЗА РЕКЛАМУ**

  На выборе улучшения, когда зарядов переброса нет, появилась кнопка «Перебросить за рекламу»: ролик даёт один переброс, один раз за забег. Пропуск и изгнание за рекламу не продаются. Забег без рекламного переброса и golden не изменились.

  🛠 **Реклама и забеги**

  • новое место показа «Переброс карточек» (`card_reroll`), хозяин — модуль забегов; показ записывается рядом с забегом, а итог без подтверждённого показа отклоняется
  • VIP получает переброс без ролика
  • версия снимка забега выросла, сохранённые незавершённые забеги тестеров при выкате пропадут

  ❓ **Нужно от команды**

  • @владелец — после выката завести блоки места «Переброс карточек» в панели (раздел «Реклама») и в кабинетах сетей; без блоков кнопки у игроков нет
  ```
