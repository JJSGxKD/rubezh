---
id: T-0029
title: Досмотр рекламы через SDK засчитывается не раньше порога из панели
epic: E4
priority: P1
status: done
owner: claude-5 / sonnet-5.5
size: S
depends_on: []
zones:
  - backend/api/src/modules/ads/ads.service.ts
  - backend/api/src/modules/ads/ads.repository.ts
  - backend/api/test/ads.test.ts
  - backend/api/test/ads.integration.test.ts
shared:
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
---

# T-0029. Досмотр рекламы через SDK засчитывается не раньше порога из панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0029.json)](README.md#значки-статуса)

## Зачем

У сетей, чей ролик показывает SDK на клиенте, досмотр засчитывается по одному
ответу клиента «досмотрено». Ограничения по времени нет. Награды за рекламу
держатся только на паузе места и суточном потолке. Это пункт P2 аудита.

У креативов, которые рисуем мы сами (сеть с API), минимальное время уже
есть: поле сессии `view_sec`, досмотр раньше срока от выдачи не
засчитывается. Задача распространяет то же правило на показы через SDK.

## Решения

- **Порог — настройка панели, а не константа в коде.** Репозиторий публичный,
  а это порог против накрутки: опубликованный, он теряет смысл
  (`docs/12-ip-and-licensing.md` §4). В коде — только ключ и умолчание `0`
  («выключено»). Боевое значение задаёт команда в панели.
- **Правило то же, что у своих креативов:** досмотр засчитывается не раньше,
  чем через `view_sec` секунд после выдачи сессии. Для SDK `view_sec` берётся
  из настройки в момент выдачи и застывает в строке сессии. Смена настройки
  уже выданные сессии не меняет.
- **Только места с наградой** (`PLACE_RULES[place].rewarded`). Межстраничной
  награды нет, порог ей не нужен.
- **Слишком ранний досмотр** обрабатывается тем же путём, что закрытая
  сессия: `AdSessionClosedError` (`ad_session_closed`, 409). Награды нет.
  Клиент на это уже отвечает как на незасчитанный показ.

## Как сейчас

- `backend/api/src/modules/ads/ads.service.ts`, `offer` (строки 162–197):
  - SDK-путь — `if (!viaApi(block, place)) return await this.open(session, null);`;
  - путь API — `creative: { id, viewSec }` из `CREATIVE_VIEW_SEC`;
  - `newSession` (строки 199–202) собирает `NewAdSession` с `creative: null`.
- `backend/api/src/modules/ads/ads.repository.ts`:
  - `NewAdSession` (строки 50–66), поле `creative: { id; viewSec } | null`;
  - `createSession` (около строки 292) пишет
    `view_sec = ${session.creative?.viewSec ?? null}`;
  - `report` → `completed` (строки 384–391): `WHERE … AND (view_sec IS NULL OR created_at + make_interval(secs => view_sec) <= $3)`.
- `ads.service.ts`, `report` (строки 250–255): строка не обновилась (`null`)
  → `AdSessionClosedError`.
- Настройки: `backend/api/src/modules/settings/setting-catalog.ts`:
  - группа `ADS_GROUP`;
  - конструктор `integer(key, group, title, hint, range, fallback)`, образец —
    `interstitialEveryRuns`, около строки 228.

  Чтение — `this.settings.get(SETTINGS.<имя>)`, `SettingsReader` уже внедрён в
  `AdsService` (строка 154).

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **`setting-catalog.ts`**, в группе `ADS_GROUP`:

   ```ts
   adsSdkMinViewSec: integer(
     "ads.sdk-min-view-sec",
     ADS_GROUP,
     "Минимальный досмотр через SDK",
     "Досмотр рекламы за награду, показанной SDK сети, засчитывается не раньше стольких секунд после выдачи показа. 0 — без порога. Значение держим только здесь: в репозитории его нет",
     { min: 0, max: 60, unit: ["секунда", "секунды", "секунд"] },
     0,
   ),
   ```
3. **`ads.repository.ts`:**
   - в `NewAdSession` — поле с комментарием:

     ```ts
     /** Не раньше скольких секунд после выдачи засчитывается досмотр через SDK; нет или `null` — без порога. У креатива сети с API срок — в `creative.viewSec`. */
     minViewSec?: number | null;
     ```

     Поле необязательное: сессию задания ленты сети собирает
     `ad-task-feeds.ts:120-128`, и ему порог не нужен — файл не трогаем;
   - в `createSession`: `view_sec = ${session.creative?.viewSec ?? session.minViewSec ?? null}::smallint`.
4. **`ads.service.ts`, `newSession`** — `minViewSec`:
   - `null`, если у места нет награды (`!PLACE_RULES[place].rewarded`);
   - иначе `const sec = this.settings.get(SETTINGS.adsSdkMinViewSec)` и
     `sec > 0 ? sec : null`.

   Путь API значение не использует: у креатива свой `viewSec`, и он важнее
   (`creative?.viewSec ?? minViewSec`).
5. **Документы** — раздел «Документы».

## Чего не трогаем

- Сроки своих креативов `CREATIVE_VIEW_SEC`.
- Паузу места, кулдауны, суточный потолок наград и сессии пропуска (VIP).
- Клиент: отказ `ad_session_closed` он уже обрабатывает.

## Тесты

Первым коммитом.

- `backend/api/test/ads.integration.test.ts`, живой Postgres:
  - SDK-сессия места с наградой, настройка 10 → в строке `view_sec = 10`;
  - `completed` через 5 с после выдачи → `report` возвращает `null`, статус
    сессии не `completed`;
  - `completed` через 11 с → `completed`;
  - настройка 0 → `view_sec` пуст, `completed` сразу засчитывается;
  - межстраничная при настройке 10 → `view_sec` пуст.
- `backend/api/test/ads.test.ts`:
  - `offer` на SDK-блоке передаёт `minViewSec` из настройки;
  - на креативе сети с API — `creative.viewSec` как раньше;
  - `report(completed)` слишком рано → `AdSessionClosedError`.

## Аналитика

Нет новых событий. Ранний досмотр виден как отказ `ad_session_closed` у
клиента и отсутствием `ad_completed` в логе сервера.

## Настройки и окружение

- Новый ключ каталога настроек `ads.sdk-min-view-sec`, группа «Реклама»,
  умолчание 0. Боевое значение задаётся в панели и в репозиторий не пишется.

## Документы

- `docs/30-configuration-map.md`, строка «Реклама: …» (строка 54) — дописать:
  «; минимальный досмотр через SDK — панель, `ads.sdk-min-view-sec` (боевое
  значение — только в панели)».

## Критерии приёмки

- [ ] При пороге N > 0 досмотр через SDK раньше N секунд после выдачи не
  засчитывается, позже — засчитывается.
- [ ] При пороге 0 поведение прежнее.
- [ ] Креативы сети с API и межстраничная — без изменений.
- [ ] Боевого значения порога в репозитории нет — только умолчание 0.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(ads): Порог досмотра рекламы через SDK`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОРОГ ДОСМОТРА РЕКЛАМЫ**

  Досмотр рекламы за награду через SDK сети теперь можно засчитывать не раньше порога, как уже было у наших собственных креативов.

  📺 **Что изменилось**

  • новая настройка панели «Минимальный досмотр через SDK», группа «Реклама»; 0 — без порога
  • боевое значение задаётся только в панели и в репозиторий не попадает

  ❓ **Нужно от команды**

  • @участник1 — задать в панели порог «Минимальный досмотр через SDK»
  ```
