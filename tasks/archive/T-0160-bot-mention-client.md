---
id: T-0160
title: Задания «юзернейм бота в имени и в bio» — блок на экране заданий и события
epic: E16
priority: P2
status: done
owner: claude-13 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0162]
zones:
  - packages/app-shell/src/state/bot-mention-api.ts
  - packages/app-shell/src/screens/meta/bot-mention-rules.ts
  - packages/app-shell/src/screens/meta/bot-mention-rows.tsx
  - packages/app-shell/src/screens/meta/tasks.tsx
  - packages/app-shell/src/i18n/ru-tasks.json
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/test/bot-mention-api.test.ts
  - packages/app-shell/test/bot-mention-rules.test.ts
  - packages/app-shell/test/bot-mention-rows.test.ts
  - apps/web-telegram/vite.config.ts
shared:
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0160. Задания «юзернейм бота в имени и в bio» — блок на экране заданий и события

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0160.json)](../README.md#значки-статуса) [![T-0162](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0162.json&label=T-0162)](T-0162-bot-mention-module.md)

## Зачем

T-0162 даёт серверу проверку и ежедневную награду (Р110) поверх порта T-0159, но игроку нужно
место, где он узнаёт, что вписать, начинает задание, видит серию и нажимает
«Проверить». Экран заданий сам новый вид не покажет: его строки строятся из
каталога `task_def`, а наши задания в каталоге не живут.

## Решения

- Решение claude-lead-1 от 19.10.2026: **блок стоит внизу вкладки
  «Ежедневные»** экрана заданий, отдельной группой под заголовком «Юзернейм
  бота»: награда приходит каждые игровые сутки, как у ежедневных. Партнёрской
  вкладке такие задания не подходят: она закрывается ограничением
  `partner_tasks`, а это наши задания, не партнёрские.
- Решение claude-lead-1 от 19.10.2026: серия — число игровых суток подряд с
  наградой; пропуск обнуляет серию без штрафа; награда за сутки одинаковая,
  надбавки за длину серии нет. Клиент серию показывает, но не считает.
- Решение claude-lead-1 от 19.10.2026: кнопка «Проверить» у игрока есть — одна
  ручная проверка на вид в игровые сутки с лимитом частоты (серверный
  `done_today` и `retry`, T-0162).
- Решение claude-lead-1 от 19.10.2026: пустое и закрытое bio неразличимы — один
  исход `hidden` и одна фраза для игрока (`botMention.status.hidden`).
- **Макета нет** (`design: null`). Блок собирается из готовых компонентов
  дизайн-системы (`Card`, `Badge`, `Button`, `RewardChips`) по образцу
  `task-row.tsx`, без новых токенов и без анимаций; вид принимается по
  снимкам.

- **Р110** (`docs/35-stage4-plan.md`): два задания — в имени и в bio; награда за
  каждые игровые сутки, пока юзернейм стоит, серия растёт; убрал — награды за
  сутки нет, штрафа нет; bio скрыто приватностью — задание говорит, что
  проверить нельзя; у площадок без возможности проверки заданий нет.
- Что и как делает сервер, какие поля в ответах — `tasks/T-0162-bot-mention-module.md`
  (`BotMentionView`, `BotMentionCheck`). Клиент ничего не считает: ни награду,
  ни серию, ни «стоит или нет» — только показывает ответ. Решение о награде за
  сутки у сервера, клиент присылает один вид задания.
- **Настройки не отстают от игры** (`CLAUDE.md`): блок не вводит анимаций и
  звуков, поэтому нового переключателя не требует — проверено при написании
  спецификации. Появится анимация — решение принимается в этом же PR.
- **События** (`docs/22-analytics-and-metrics.md` §3.3): имя события берётся из
  словаря, новое сначала в словарь и Zod-схему, потом в код.
- Тексты ниже даны дословно; отличаться от них исполнитель не вправе.

## Как сейчас

- `packages/app-shell/src/screens/meta/tasks.tsx:1–218` — экран заданий: вкладки
  `partner / daily / weekly / achievements` (строки 126–166), загрузка
  `api.view()` (65–88), группа строк вкладки (184–190). Дополнительные группы
  рисуются отдельным компонентом со своими данными, как `NetworkTasks`
  (`network-tasks.tsx`, строка 187).
- `packages/app-shell/src/screens/meta/task-row.tsx:36–173` — образец карточки
  задания: иконка, заголовок, `Badge`, `RewardChips`, кнопка `Button block`.
  Награда — `screens/meta/task-reward.tsx:11–47` (`RewardChips`, `rewardText`).
- `packages/app-shell/src/state/tasks-api.ts:262–272` — `createTasksApi(request)`:
  запрос через `apiRequest`, ответы разбираются схемами `zod/mini`; незнакомые
  значения — строкой, чтобы сервер новее клиента не ронял экран
  (`tasks-api.ts:15–18`). `tasksAvailable()` (строка 276) — задания только с
  входом.
- `packages/app-shell/src/i18n/ru-tasks.json` и `i18n/tasks.ts` — ленивый словарь
  экрана заданий; формы числа — `{n, plural, one {…} few {…} many {…} other {…}}`
  (`ru-tasks.json:63–65`).
- `packages/app-shell/src/state/analytics.ts` — `ANALYTICS_EVENTS`, список
  событий клиента; тест `scripts/test/event-dictionary.test.ts` требует, чтобы он
  совпадал со словарём сервера и чтобы каждое событие было в
  `docs/22-analytics-and-metrics.md`.
- `backend/api/src/modules/events/event-dictionary.ts:214–215` — образец записи
  события `task_completed`.
- Тесты вёрстки без браузера — `renderToStaticMarkup` в `packages/app-shell/test/`
  (образец — `modal-label.test.ts`).
- Гайдбук про задания не рассказывает (в `i18n/ru-guide.json` слова «задани…» нет) —
  обновлять нечего.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Словарь событий — до кода** (`event-dictionary.ts`, `state/analytics.ts`,
   `docs/22` — в абзаце «Удержание» §3.3 и таблице описаний, рядом с
   `task_link_opened`):
   - `bot_mention_started` — `payload({ kind: z.enum(["name", "bio"]) })`. Игрок
     нажал «Начать» и сервер принял. Зачем: сколько игроков берутся за задание
     и сколько видов выбирают;
   - `bot_mention_checked` — `payload({ kind: z.enum(["name", "bio"]), outcome:
     z.enum(["present", "absent", "hidden", "unavailable", "retry", "done_today"]) })`.
     Игрок нажал «Проверить»/«Начать» и получил ответ. Зачем: доля нашедших
     с первой попытки, доля `hidden` у bio (насколько приватность мешает
     заданию). Ночные проверки сервера клиент не видит — их факты в таблице
     `bot_mention_task` и журнале кошелька (T-0162, «Аналитика»);
   - версии `version: 1`; в описании — «событие шлёт клиент после ответа сервера».
3. **`state/bot-mention-api.ts`** — по образцу `tasks-api.ts`:

   ```ts
   const rewardSchema = z.object({ coins: z.number(), gems: z.number(), shards: z.number() });
   const taskSchema = z.object({
     kind: z.string(),                       // "name" | "bio", незнакомый вид — строкой
     reward: rewardSchema,
     started: z.boolean(),
     streak: z.number(),
     bestStreak: z.number(),
     rewardedToday: z.boolean(),
     lastResult: z.nullable(z.string()),
     checkedAt: z.nullable(z.string()),
   });
   const viewSchema = z.object({ botUsername: z.nullable(z.string()), tasks: z.array(taskSchema) });
   const checkSchema = z.object({ outcome: z.string(), credited: rewardSchema, view: viewSchema });

   export interface BotMentionApi {
     view(): Promise<ApiResult<BotMentionView>>;                    // GET /api/v1/bot-mention
     check(kind: string): Promise<ApiResult<BotMentionCheck>>;      // POST /api/v1/bot-mention/<kind>/check, без тела
   }
   export function createBotMentionApi(request: ApiRequest = apiRequest): BotMentionApi;
   ```

   `kind` в пути — через `encodeURIComponent`. Вид показывается, только если он
   `name` или `bio`: незнакомый вид сервера новее клиента молча пропускается.
4. **`screens/meta/bot-mention-rules.ts`** — чистые функции без React:
   - `visibleTasks(view)` — виды `name` и `bio` в таком порядке, только при
     `botUsername !== null`; иначе пусто (блока нет);
   - `statusKey(task)` → ключ строки состояния под описанием:
     - `lastResult === "present"` и `rewardedToday` → `botMention.status.rewarded`;
     - `lastResult === "absent"` → `botMention.status.absent.<вид>`;
     - `lastResult === "hidden"` → `botMention.status.hidden`;
     - `lastResult === "unavailable"` → `botMention.status.unavailable`;
     - не начато или нет проверок → `null`;
   - `buttonKey(task)` — `botMention.start`, пока `!started`; иначе
     `botMention.check`; `null`, когда `rewardedToday` (кнопки нет);
   - `outcomeKey(outcome)` — ключ сообщения под кнопкой после ответа (все шесть
     исходов + незнакомая строка → `botMention.outcome.failed`).
5. **`screens/meta/bot-mention-rows.tsx`** — компонент `BotMentionRows` с
   состоянием и презентационный `BotMentionCard(props)` без состояния (его
   рендерят тесты). Блок:
   - сам грузит `api.view()` при монтировании и при возврате на вкладку; пока
     грузит, **ничего не рисует** (дополнение к списку: пустое место не мерцает);
     ответ с ошибкой или пустой список — блок не показывается, экран заданий не
     страдает (как `NetworkTasks`, `network-tasks.tsx`). Гость
     (`tasksAvailable() === false`) — блок не рисуется;
   - заголовок группы `botMention.title`; в каждой карточке — иконка (`Bot` из
     `lucide-react`, как у `bot` в `task-row.tsx`), заголовок, строка описания
     с юзернеймом бота `@{botUsername}` (моноширинным, чтобы его можно было
     выделить и скопировать системным способом), `RewardChips`, строка серии
     `botMention.streak` при `streak > 0` и `botMention.best` при `bestStreak >
     streak`, строка состояния по `statusKey`, под ними — `Button block`;
   - нажатие: `api.check(kind)` → кнопка в состоянии `loading`, повторное нажатие
     игнорируется; в ответе `view` заменяет данные блока, под кнопкой — текст
     `outcomeKey`, при `credited` с ненулевой суммой — `botMention.outcome.present`
     с `rewardText(credited)`; после ответа — `loadWallet()` (баланс обновился) и
     `loadBadges()`; события шага 2 — `track(...)` после ответа сервера:
     `bot_mention_started` при первом нажатии (`started` был `false`) и успехе,
     `bot_mention_checked` при любом ответе `ok`;
   - ответ с ошибкой (`!response.ok`, в том числе 429 и нет сети) — под
     кнопкой `botMention.outcome.failed`, данные не меняются;
   - отступы и цвета — только токены, анимаций нет, `--app-inset-*` не нужны
     (блок внутри колонки экрана).
6. **`tasks.tsx`**: во вкладке «Ежедневные» после группы строк добавить `<BotMentionRows />`
   (одна строка импорта, одна в разметке). Остальное в файле не менять.
7. **Тексты** — в `i18n/ru-tasks.json`, ключи и значения дословно:

   | Ключ | Текст |
   |---|---|
   | `botMention.title` | Юзернейм бота |
   | `botMention.name.title` | Юзернейм бота в имени |
   | `botMention.name.hint` | Впишите {bot} в имя своего профиля. Награда — за каждые игровые сутки, пока он там стоит. |
   | `botMention.bio.title` | Юзернейм бота в bio |
   | `botMention.bio.hint` | Впишите {bot} в раздел «О себе» своего профиля. Награда — за каждые игровые сутки, пока он там стоит. |
   | `botMention.auto` | Мы сами проверяем раз в игровые сутки — награда придёт без вашего участия. |
   | `botMention.start` | Начать |
   | `botMention.check` | Проверить |
   | `botMention.streak` | Серия: {n} {n, plural, one {день} few {дня} many {дней} other {дня}} |
   | `botMention.best` | Лучшая серия: {n} |
   | `botMention.status.rewarded` | Награда за сегодня получена. Завтра проверим снова. |
   | `botMention.status.absent.name` | В имени юзернейм не нашли. Впишите его и нажмите «Проверить». |
   | `botMention.status.absent.bio` | В bio юзернейм не нашли. Впишите его и нажмите «Проверить». |
   | `botMention.status.hidden` | Не видим ваше bio: оно пустое или закрыто настройками приватности. |
   | `botMention.status.unavailable` | Сейчас проверить не получается. Откройте чат с ботом и попробуйте ещё раз. |
   | `botMention.outcome.present` | Нашли! Получено: {what} |
   | `botMention.outcome.absent` | Юзернейм не нашли. |
   | `botMention.outcome.hidden` | Не видим ваше bio: оно пустое или закрыто настройками приватности. |
   | `botMention.outcome.unavailable` | Сейчас проверить не получается. Откройте чат с ботом и попробуйте ещё раз. |
   | `botMention.outcome.retry` | Площадка не ответила. Попробуйте чуть позже. |
   | `botMention.outcome.done_today` | Награда за сегодня уже получена. Завтра проверим снова. |
   | `botMention.outcome.failed` | Не получилось проверить. Попробуйте ещё раз. |

   Тексты про `hidden` и серию отвечают решениям claude-lead-1 от 19.10.2026
   (см. «Решения»): если решения изменятся, правятся только они.
8. **Документы:** `docs/22` (шаг 2) — единственный.

## Чего не трогаем

- Сервер: порт площадки (T-0159), проверку, ключи настроек и награду (T-0162). Если ответ сервера
  не похож на описанный там — вопрос, а не подгонка.
- Каталог заданий, `TasksService`, `task-row.tsx`, `network-tasks.tsx`,
  `tasks-rules.ts` и `tasks-api.ts`: наши задания не строки каталога и не вид цели.
- Знак на кнопке меню «Задания» (`state/badges*.ts`): награда приходит сама, а не
  ждёт «Забрать».
- Предпросмотр панели (`preview/registry.tsx`): блока в черновиках каталога нет.
- Гайдбук, звук, вибрация, переключатели настроек игрока.
- Панель администратора: ключи правятся в общем разделе настроек (T-0162).

## Сценарий и интерфейс

Игрок открывает «Задания» → «Ежедневные», внизу — группа «Юзернейм бота» из двух
карточек. Состояния карточки:

- **Не начато.** Название, описание с `@юзернейм`, награда, кнопка «Начать».
  Под ней строка `botMention.auto`.
- **Загрузка нажатия.** Кнопка с индикатором, повторное нажатие не действует.
- **Нашли, награда получена.** Строка `botMention.status.rewarded`, серия, лучшая
  серия при `bestStreak > streak`, под кнопкой `botMention.outcome.present`.
  Кнопки «Проверить» после награды нет до смены суток.
- **Не нашли.** Строка `botMention.status.absent.*`, кнопка «Проверить».
- **Bio скрыто.** `botMention.status.hidden`, кнопка «Проверить» остаётся: игрок
  мог открыть bio.
- **Проверить нельзя / площадка не ответила / нет сети / лимит частоты.** Текст
  `unavailable` / `retry` / `failed`, данные карточки прежние.
- **Блока нет.** Гость без входа, площадка без заданий (`botUsername === null`),
  функция выключена или награда вида 0 (сервер не вернул вид), ошибка загрузки.
  Пустой заголовок без карточек не рисуется.

Макета нет (`design: null`); принимается по снимкам на **320, 390, 768 и 1440 px**
для состояний: не начато, нашли с серией, не нашли, bio скрыто, ответ с ошибкой.
Снимки — `pnpm screens` (T-0145), если она уже влита, иначе вручную в браузере по
`docs/27-design-system-and-app-shell.md`. Два вида в карточках одной группы на 320 px
не вылезают за край, длинный юзернейм бота переносится.

## Тесты

Пишутся первым коммитом.

- `bot-mention-api.test.ts` (подмена `request`, образец — `tasks-api.test.ts`):
  - `view()` — `GET /api/v1/bot-mention`; ответ с незнакомым `kind` и лишним
    полем разбирается, не падая;
  - `check("name")` — `POST /api/v1/bot-mention/name/check` без тела;
    `check("a/b")` — слэш закодирован в пути;
  - `outcome` незнакомой строкой разбирается.
- `bot-mention-rules.test.ts`:
  - `visibleTasks`: `botUsername: null` → пусто; виды `bio`, `name`, `other` →
    `[name, bio]`; пустой `tasks` → пусто;
  - `statusKey`: не начато → `null`; `absent` у `name` и `bio` → разные ключи;
    `hidden` → общий ключ; `present` + `rewardedToday` → `rewarded`;
  - `buttonKey`: не начато → `botMention.start`; начато → `botMention.check`;
    `rewardedToday` → `null`;
  - `outcomeKey`: каждый из шести исходов → свой ключ; `"weird"` →
    `botMention.outcome.failed`;
  - каждый ключ из правил существует в `ru-tasks.json` (тест читает словарь).
- `bot-mention-rows.test.ts` (`renderToStaticMarkup` презентационной карточки):
  - не начато: в разметке `@game_bot`, кнопка «Начать», строка `auto`, награда;
  - серия 3, лучшая 5: «Серия: 3 дня», «Лучшая серия: 5»; серия 1 — «1 день»,
    серия 5 — «5 дней»; лучшая равна текущей — строки «Лучшая серия» нет;
  - `rewardedToday`: кнопки нет, строка «Награда за сегодня получена…»;
  - `hidden`: текст про приватность, кнопка «Проверить» есть;
  - `loading` — у кнопки признак занятости;
  - юзернейм стоит в элементе, который можно выделить (`select-text` или
    эквивалент), и не обрезается (`break-all`/перенос).
- Словарь: `pnpm test` из корня — `scripts/test/event-dictionary.test.ts` зелёный
  (клиент, сервер и `docs/22` согласованы).

## Аналитика

Два события из шага 2: `bot_mention_started {kind}`, `bot_mention_checked {kind,
outcome}`. Шлёт клиент после ответа сервера, через `track(...)`. Метрик
Prometheus и `user_id` в метках нет. Раздел `docs/22` обновляется в этом же PR.

## Настройки и окружение

Нет: клиент ничего не настраивает; ключи и переключатель — на сервере (T-0162).

## Документы

`docs/22-analytics-and-metrics.md` — два события (шаг 2). Остальное не
затрагивается: гайдбука про задания нет.

## Критерии приёмки

- [x] Блок показывается в «Ежедневных» только при входе, `botUsername` и хотя бы
  одном показываемом виде; иначе экран заданий выглядит как прежде.
- [x] Клиент ничего не считает сам: награда, серия, исход — из ответа сервера.
- [x] Нажатие шлёт один запрос с видом в пути; повторные нажатия, пока он идёт,
  игнорируются.
- [x] Закрытое bio объясняется текстом, а не «не нашли».
- [x] Ошибка запроса не меняет данные карточки и не роняет экран.
- [x] Юзернейм бота можно выделить; на 320 px карточки без горизонтальной прокрутки.
- [x] Нет анимаций, цвета и отступы — токены.
- [x] События в словаре сервера, `ANALYTICS_EVENTS` и `docs/22`; тест словаря
  зелёный.
- [x] Гейт (`CLAUDE.md`), `pnpm budget` и `pnpm docs:check` зелёные; блок не
  утяжеляет первую загрузку: код живёт в ленивом чанке экрана заданий.

## PR

- **Заголовок:** `feat(app-shell): Задания с юзернеймом бота на экране заданий`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: в «Заданиях» — награда за юзернейм бота в имени и в bio профиля: проверяем раз в игровые сутки, серия растёт`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАДАНИЯ С ЮЗЕРНЕЙМОМ БОТА НА ЭКРАНЕ**

  Во вкладке «Ежедневные» появилась группа «Юзернейм бота»: игрок видит, что вписать в имя и в bio, начинает задание, нажимает «Проверить» и видит серию. Награду и проверку ведёт сервер (T-0162).

  🛠 **Аналитика**

  • Новые события bot_mention_started и bot_mention_checked

  ❓ **Нужно от команды**

  • @участник1 — награда включается в панели после решения геймдизайнера
  ```
