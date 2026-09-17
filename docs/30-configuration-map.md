# Карта конфигурации: что где настраивается

Документ отвечает на один вопрос: **«я хочу поменять вот это — куда идти?»**
Не объясняет, почему устроено так, — для этого есть смежные документы, ссылки
на них стоят в каждой таблице.

Порядок такой же, как в голове у человека, который что-то меняет: сначала
игра, потом интерфейс, потом сборка и окружение, в конце — то, что данными не
настраивается вовсе.

## Правило поддержки

**Карта, отставшая от кода, хуже отсутствующей** — по ней ищут, а она врёт.
Появился новый файл настроек, ключ хранилища, переменная окружения или порог
проверки — строка добавляется сюда **в том же PR**. Проверка входит в скилл
`pre-pr`; то же правило действует для схем в `21-diagrams.md`.

Здесь перечислено то, что меняют осмысленно. Внутренние константы вроде
ёмкости кольцевого буфера событий в карту не попадают: их правят вместе с
кодом, который их читает.

## Кто владелец

| Владелец | Что за ним |
|---|---|
| **Геймдизайнер** | числа игры: враги, таймлайн, оружие, прокачка, карта, коридоры баланса |
| **Участник 1** | движок, оболочка, сборка, окружение, проверки |
| **Напарник** | визуальный стиль: токены, шрифты, иконки, ассеты |

Границы зон — `06-team-and-workflow.md` §2 и `CLAUDE.md`, раздел «Структура и
зоны ответственности». Правка в чужой зоне не запрещена, но согласуется с
владельцем: иначе двое в один вечер крутят одно и то же число в разные стороны.

---

## 1. Игровой баланс и контент

Всё это — **данные**, а не код. Правятся напрямую, кодом трогать не нужно.

| Что меняю | Где | Ломает |
|---|---|---|
| Враги: здоровье, скорость, урон, опыт, стоимость угрозы, ранг элиты | `packages/core-game/src/content/enemies.ts` → `ENEMIES` | golden-прогон, отпечаток контента |
| Первые минуты забега: состав, темп, выбросы, события отрезка | `content/waves.ts` → `TIMELINE` | golden-прогон, свойства баланса |
| Бесконечный режим: бюджет угрозы, рост, потолок живых, пул типов, события | `content/waves.ts` → `ENDLESS_CURVE` | свойства баланса |
| Оружие: поведение, числа по уровням, что даётся на старте | `content/weapons.ts` → `WEAPONS` | golden-прогон |
| Ступени врагов: когда открываются, вес в потоке, множители | `content/stages.ts` → `ENEMY_STAGES` | golden-прогон |
| Пассивки и их категории, слоты оружия и каждой категории пассивок, кривая опыта | `content/upgrades.ts` → `PASSIVES` (`category`), `LOADOUT_LIMITS`, `LEVEL_CURVE` | golden-прогон |
| Уровни сложности: множители здоровья и урона врагов, темпа спавна и потолка живых; какой открыт по умолчанию | `content/difficulty.ts` → `DIFFICULTIES`, `DEFAULT_DIFFICULTY_ID` | отпечаток контента; эталоны — нет: они идут на «Лёгкой» |
| Что падает с врагов: на сколько кристаллов делится опыт; шансы аптечки, магнита и динамита с рядового и с элиты, сколько лежит на поле; сколько лечит аптечка; радиус взрыва динамита и какую долю здоровья он снимает с элиты | `content/drops.ts` → `DROPS` | golden-прогон, контрольная сумма |
| Карта: границы мира, видимая область, поведение камеры | `content/maps.ts` → `MAPS` | радиус кольца спавна, а с ним весь баланс |
| Целевые коридоры калибровки | `content/balance-targets.ts` → `BALANCE_TARGETS` | тест свойств баланса |

Как добавлять врага, отрезок таймлайна, оружие и границы карты — `CLAUDE.md`,
соответствующие разделы. Проверить правку: `pnpm test` (тесты контента
называют врага и поле), распределение по десяткам seed — `pnpm balance:sim`,
таблица ложится в `var/balance/`.

**Отпечаток контента** (`content/hash.ts` → `CONTENT_HASH`) не настраивается:
он считается по всем таблицам разом и уезжает в итог забега, чтобы эффект
правки баланса был отделим от сезонности (`22-analytics-and-metrics.md` §5.3).

---

## 2. Ощущение забега: константы движка

Это уже код, зона участника 1. Числа влияют на то, как игра **ощущается**, а
не на то, насколько она сложная, — сложность живёт в контенте выше.

| Что меняю | Где |
|---|---|
| Частота симуляции, минимальная доля проходящего урона | `game/sim/world.ts` → `TICK_HZ`, `MIN_DAMAGE_RATIO` |
| Запас кольца спавна, радиус удержания, минимальный размер карты | `game/sim/map-types.ts` → `SPAWN_MARGIN_UNITS`, `RETENTION_RATIO`, `MIN_HALF_EXTENT_RATIO` |
| Разброс кольца спавна, дуга переноса отставших, отступ от стены | `game/sim/spawner.ts` → `SPAWN_JITTER_UNITS`, `FORWARD_ARC_SIN`, `BOUNDS_MARGIN_UNITS` |
| Ширина дуги роя с одной стороны | `game/sim/director.ts` → `FLANK_ARC_SIN` |
| Интервал контактной атаки | `game/sim/step.ts` → `MELEE_INTERVAL_SEC` |
| Скорость притяжения кристаллов и запас подбора | `game/sim/gems.ts` → `GEM_SPEED`, `PICKUP_SLACK` |
| Как быстро подборы подползают к игроку в радиусе сбора | `game/sim/pickups.ts` → `PULL_AT_EDGE`, `PULL_AT_PLAYER` |
| Кольца здоровья и опыта вокруг персонажа: радиусы, толщина, пороги цвета | `game/render/player-rings.ts` |
| Полёт кристалла от места смерти: длительность, разлёт, потолок горсти | `game/sim/gems.ts` → `GEM_LAND_TICKS`, `SCATTER_MIN`, `SCATTER_MAX`, `MAX_GEMS_PER_KILL` |
| Формы и цвета мира: враги по паттернам, кристаллы, подборы, снаряды | `game/render/looks.ts` → `ENEMY_LOOKS`, `GEM_TIERS`, `PICKUP_LOOKS`, `WORLD_COLORS`; рисование фигур — `render/shapes.ts` |
| Ступени ценности кристаллов: пороги, цвета, размеры; подскок и мерцание | `game/render/looks.ts` → `GEM_TIERS`; `render/pickups.ts` → `GEM_HOP_UNITS`, `SHIMMER_*` |
| Подборы (аптечка, магнит, динамит): радиус касания, полёт, потолок пула и потолок вида; вид на земле, пульсация, кольца лечения и магнита | `game/sim/pickups.ts` → `PICKUP_RADIUS_UNITS`, `PICKUP_LAND_TICKS`, `MAX_PICKUPS`, `MAX_PICKUPS_OF_KIND`; `render/looks.ts` → `PICKUP_LOOKS`; `render/pickups.ts` → `PICKUP_*`; `WorldRenderer.ts` → `HEAL_RING_UNITS`, `MAGNET_RING_UNITS` |
| Числа урона: сколько на экране, сколько новых за кадр, жизнь, подъём, размер; вспышка гибели | `game/render/combat-feedback.ts` → `MAX_NUMBERS`, `MAX_NEW_NUMBERS_PER_FRAME`, `NUMBER_*`, `BURST_*` |
| Телеграфы: кольцо взрыва, полоса рывка | `game/render/telegraphs.ts` |
| Радар: сколько точек, радиус; размер и вид в HUD | `game/radar.ts` → `MAX_BLIPS`; `app-shell/src/screens/run/Radar.tsx` → `SIZE_PX`, `*_PX` |
| Размер клетки сетки коллизий | `game/sim/grid.ts` → `gridCellSize` |
| Хитбоксы и умолчания паттернов, множители элиты и босса | `game/patterns/enemy-types.ts` → `PATTERN_TRAITS`, `PATTERN_DEFAULTS`, `ELITE_RADIUS_MUL`, `BOSS_RADIUS_MUL` |
| Фазы боя с боссом: сколько их и по каким долям здоровья | `game/run/boss.ts` → `BOSS_PHASES`, `bossPhase` |
| Опрос обратной связи: вопросы и варианты | `shared-types` → `FEEDBACK_QUESTIONS`; тексты — ключи `feedback.q.*` в `i18n/ru.json` |
| Когда звать за отзывом, потолок текста | `app-shell/src/state/feedback.ts` → `ASK_AGAIN_AFTER_RUNS`; `shared-types` → `FEEDBACK_TEXT_MAX` |
| Лимиты приёма отзывов, размер тела | `modules/ingest/ingest-limits.ts` → `INGEST_LIMITS.feedback` |
| Сколько отзывов уходит в выгрузку `/feedback` | `modules/feedback/feedback-bot.command.ts` → `EXPORT_LIMIT` |
| Насколько кастер ускоряется за фазу, время жизни его снарядов, разброс веера | `game/patterns/caster.ts` → `PHASE_SPEEDUP`, `PROJECTILE_TTL_SEC`, `SPREAD_STEP`, `WALL_SPEED_RATIO` |
| Умолчания поведений оружия, потолок снарядов за выстрел | `game/weapons/weapon-types.ts` → `BEHAVIOR_DEFAULTS`, `MAX_PROJECTILES_PER_SHOT` |
| Разброс веера снарядов | `game/weapons/shooting.ts` → `SPREAD_STEP` |
| Радиус оберега и потолок оберегов | `game/weapons/orbit.ts` → `ORBITER_RADIUS`, `MAX_ORBITERS` |
| Сколько вариантов при наборе уровня, сила запасного лечения | `game/progression/levels.ts` → `OFFERS_PER_LEVEL`, `HEAL_RATIO` |
| Джойстик: размер кольца, мёртвая зона | `game/joystick.ts` → `RING_UNITS`, `DEAD_ZONE_UNITS` |
| Порог «игрок стоит» для камеры | `game/render/run-camera.ts` → `IDLE_SPEED_RATIO` |
| Формы и цвета врагов, кристаллов, подборов, персонажа и эффектов — на канве и в гайдбуке сразу | `game/render/looks.ts` → `ENEMY_LOOKS`, `GEM_TIERS`, `PICKUP_LOOKS`, `STAGE_LOOKS`, `WORLD_COLORS` |
| Вспышка попадания, взрывы, плитка фона | `game/render/WorldRenderer.ts` → `HIT_FLASH_TICKS`, `BLAST_*`, `GROUND_TILE_UNITS` |
| Телеграфы угроз: за сколько до выстрела виден прицел стрелка, толщина полос | `game/render/telegraphs.ts` → `AIM_TELEGRAPH_SEC`, `LANE_WIDTH_UNITS`, `AIM_WIDTH_UNITS`; отсчёт взрыва и рывка берётся из `fuseSec` и `telegraphSec` врага |
| Граница «Очага» и молния «Грозы»: вспышка, высота и изгиб молнии | `game/render/weapon-effects.ts` → `AURA_FLASH_TICKS`, `BOLT_LIFETIME_TICKS`, `BOLT_HEIGHT_UNITS`, `BOLT_JITTER_UNITS` |
| Потолок шагов симуляции за кадр, частота снимков HUD | `game/MainScene.ts` → `MAX_STEPS_PER_FRAME`, `HUD_INTERVAL_MS` |
| Бот калибровки: дистанции страха и сближения, стратегия выбора | `game/balance/bot.ts` |

Почти любая правка отсюда роняет golden-прогон и эталонную контрольную сумму
(`17-testing-strategy.md` §3.0, §3.2) — это ожидаемо: эталон затем и нужен,
чтобы правка была видна в диффе.

**Палитра мира забега живёт здесь, а не в токенах оболочки.** Движок не
импортирует `app-shell` — направление зависимостей запрещает
(`27-design-system-and-app-shell.md` §2). Сведение палитр — вместе с ассетами.

---

## 3. Интерфейс

| Что меняю | Где | Владелец |
|---|---|---|
| Цвета, типографика, радиусы, тени, слои, длительности, кривые и анимации | `packages/app-shell/src/design-system/tokens.css` → `@theme`, `:root` | напарник |
| Составные поверхности: фон приложения, карточки, панели, кнопки, заливки полос, ореолы | `tokens.css` → блоки `@utility` | напарник |
| Те же значения числами для канвы и цветов площадки, имена гарнитур | `design-system/tokens.ts` → `COLORS`, `PLATFORM_COLORS`, `DURATION`, `FONT_FAMILY` | напарник |
| Файлы шрифтов и подмножества алфавитов | `design-system/fonts.css`; новый алфавит — ещё и бюджет шрифтов ниже, §7 | напарник |
| Заставка до загрузки JS: знак, цвета, полоса | `apps/web-*/index.html`, во всех трёх одинаково; цвета — копия токенов числами | напарник |
| Знак игры | `design-system/components/Brand.tsx` → `Emblem` и та же фигура в `index.html` | напарник |
| Значки оружия и пассивок | `app-shell/src/screens/item-icons.tsx` → `WEAPON_ICONS`, `PASSIVE_ICONS`; нет значка — общий | участник 1 |
| Любой текст интерфейса, включая имена оружия и пассивок | `app-shell/src/i18n/ru.json` | участник 1 |
| Подсказки на экране загрузки забега | `ru.json` → `run.tip.1`…`run.tip.N` и число `TIP_COUNT` в `screens/run/RunLoading.tsx` | участник 1 |
| Примеры в заглушках меты: награды семи дней, сектора и шансы колеса, задания, достижения | `app-shell/src/screens/meta/stub-content.ts`. Это не баланс: настоящие числа будут на сервере (`07-monetization-and-ads.md` §7) | геймдизайнер |
| Приглашение друга: текст и параметр запуска в ссылке | `ru.json` → `friends.invite.text`; `screens/meta/friends.tsx` → `INVITE_START_PARAM`; адрес бота — `VITE_TELEGRAM_BOT_USERNAME` | участник 1 |
| Гайдбук: тексты поведения и советы, имена врагов; пороги «медленный / быстрый»; мини-сцены | `ru.json` → `guide.*`, `enemy.<id>.name`; `screens/guide/guide-data.ts` → `speedClass`; `screens/guide/scenes.tsx`, анимации — `tokens.css` → `guide-*`. Числа врагов, оружия и пассивок — из контента, в гайдбуке их не правят | участник 1 |
| Пример снаряжения в заглушке арсенала: слоты, редкости, предметы | `app-shell/src/screens/meta/arsenal.tsx` → `EQUIPPED`, `INVENTORY`, `RARITY_TONE` | геймдизайнер, напарник |
| Граница суток и недели для заданий и награды дня | `screens/meta/schedule.ts` → `MOSCOW_OFFSET_MS`, `MONDAY` | участник 1 |
| Колесо удачи: сколько оборотов за крутку; длительность и кривая вращения | `screens/meta/wheel.tsx` → `SPIN_TURNS`; `tokens.css` → `--duration-spin`, `--ease-spin` | участник 1, напарник |
| Цена «Второго шанса» в заглушке экрана смерти | `screens/run/SecondChance.tsx` → `PREMIUM_PRICE` | геймдизайнер |
| Подсказки первого забега: порядок, когда гаснут | `app-shell/src/state/hints.ts` → `HINT_ORDER`, `MOVE_DONE_UNITS`, `DODGE_SHOW_SEC`; тексты — `ru.json` → `run.hint.*`, значки — `screens/run/HintBanner.tsx` | участник 1 |
| Сколько запуск ждёт свои шрифты | `app-shell/src/index.tsx` → `FONT_WAIT_MS` | участник 1 |
| Через сколько лобби предзагружает движок | `app-shell/src/screens/home.tsx` → `PRELOAD_DELAY_MS` | участник 1 |
| Разделы нижней панели и какие экраны считаются заглушками | `app-shell/src/state/navigation.ts` → `TAB_ROOTS`, `STUB_SCREENS` | участник 1 |
| Порядок вкладок, их значки и точки | `app-shell/src/app/App.tsx` → `TABS`; нагрудник арсенала — `design-system/components/icons.tsx` | участник 1 |
| Шапка разделов и её меню: что показывается, куда ведёт | `app-shell/src/app/AppHeader.tsx`, `app/MainMenu.tsx` | участник 1 |
| Как часто забег сохраняется сам | `app-shell/src/state/run.ts` → `AUTOSAVE_SEC` | участник 1 |
| Плейтест на клиенте: таймаут запроса, сколько неотправленных забегов хранить | `app-shell/src/state/playtest-api.ts` → `PLAYTEST_TIMEOUT_MS`; `state/playtest.ts` → `QUEUE_LIMIT` | участник 1 |
| Сводка плейтеста: корзины длины забега, сколько строк в топах, цвета и раскладка картинки | `backend/api/src/modules/playtest/playtest-stats.store.ts` → `DURATION_BUCKETS_MIN`; `playtest-stats.summary.ts` → `TOP_LIMIT`; `playtest-stats.image.ts`; цвета карточек бота — `backend/api/src/common/card/svg.ts` → `PALETTE`, `SERIES` (повторяют `tokens.css`), подписи устройств и исходов — `common/card/labels.ts` | участник 1 |
| Бот: long polling, лок читателя, паузы при конфликте и сбое | `backend/api/src/modules/bot/bot-poller.ts` → `POLL_TIMEOUT_SEC`, `POLLER_LOCK_TTL_MS`, `STANDBY_MS`, `RETRY_MS` | участник 1 |
| Приветствие по `/start`: тексты на двух языках, какие языки читают по-русски | `backend/api/src/modules/welcome/welcome-texts.ts` → `WELCOME_TEXTS`, `RUSSIAN_READERS` | участник 1 |
| Карточка приветствия: раскладка, длина имени, версия шаблона для кэша | `backend/api/src/modules/welcome/welcome-card.ts` → `CARD_VERSION` (поднять при любой правке вида), `NAME_MAX` | участник 1 |
| Приветствие: сколько хранить `file_id` карточки, окно двойного нажатия, ожидание прогресса | `backend/api/src/modules/welcome/welcome.command.ts` → `CARD_CACHE_TTL_SEC`, `START_WINDOW_SEC`, `PROGRESS_TIMEOUT_MS` | участник 1 |
| Выгрузка: размер частей, страницы чтения и пауза между ними, колонки таблицы забегов, формат архива | `backend/api/src/modules/export/export.service.ts` → `EXPORT_PART_BYTES`, `EVENTS_PAGE`, `REPORTS_PAGE`, `PAGE_PAUSE_MS`, `RUN_COLUMNS`, `EXPORT_FORMAT` | участник 1 |
| Выгрузка через бота: сколько держится лок администратора, пауза между выгрузками, подписи периодов | `backend/api/src/modules/export/export-bot.command.ts` → `LOCK_TTL_SEC`, `COOLDOWN_SEC`, `PERIOD_LABELS` | участник 1 |
| Очистка старых данных: как часто и какими пачками | `backend/api/src/modules/export/retention.job.ts` → `EVERY_MS`, `BATCH`, `BATCH_PAUSE_MS` | участник 1 |
| Уведомления об отчётах: темп отправки в чат, повторы, карточка стресс-теста — раскладка, порог плавности на графике | `backend/api/src/modules/admin-notify/report-notifier.ts` → `MESSAGES_PER_MINUTE`, параметры `queue.add`; `stress-card.ts` → `SMOOTH_FPS` | участник 1 |
| Бот: сколько помнить обработанные обновления вебхука, какие обновления читать | `backend/api/src/modules/bot/bot-webhook.controller.ts` → `DEDUPE_TTL_SEC`; `modules/telegram/telegram-bot-api.ts` → `ALLOWED_UPDATES` | участник 1 |
| Сводка плейтеста в Telegram: частота команды, возраст команды из очереди | `backend/api/src/modules/playtest/playtest-stats.reporter.ts` → `COMMAND_WINDOW_SEC`, `STALE_COMMAND_SEC` | участник 1 |
| Плейтест на сервере: строк в лидерборде, последних забегов в профиле, сколько забегов хранится | `backend/api/src/modules/playtest/playtest.service.ts` → `LEADERBOARD_LIMIT`, `RECENT_RUNS_SHOWN`; `redis-playtest.store.ts` → `RECENT_RUNS_KEPT`; границы правдоподобия итога — `dto/run-submission.dto.ts` | участник 1 |
| С какой высоты экрана модалки забега уплотняются | `tokens.css` → `@custom-variant short` (`27-design-system-and-app-shell.md` §5.3) | напарник |
| Задержка от случайного тапа на оверлеях забега | `app-shell/src/screens/run/overlays.tsx` → `GUARD_MS` | участник 1 |
| Порог «мало здоровья» в HUD | `app-shell/src/screens/run/RunHud.tsx` → `LOW_HP_RATIO` | участник 1 |

Два правила, которые проверяются тестами: **значения — только из токенов**
(цвет или отступ числом в компоненте — замечание на ревью), и **`tokens.css`
и `tokens.ts` обязаны совпадать** — расхождение ловит `app-shell/test/tokens.test.ts`.

Тексты — только ключами. Новый ключ добавляется в `ru.json`; неизвестный ключ
показывается как есть, чтобы пропажа бросалась в глаза.

---

## 4. Хранение на устройстве

Ключи версионированы именем: сменился формат — сменился ключ, старое значение
просто перестаёт читаться (`27-design-system-and-app-shell.md` §7).

| Ключ | Что лежит | Где объявлен |
|---|---|---|
| `bh.settings.v1` | режим экрана, звук, музыка, вибрация | `app-shell/src/state/settings.ts` |
| `bh.diagnostics.v1` | режим диагностики, запись забегов, оверлей FPS | `state/diagnostics.ts` |
| `bh.meta.v1.profile` | число забегов, последнее стартовое оружие и сложность | `state/meta.ts` |
| `bh.meta.v1.bestSurvivalSec.<сложность>` | локальный рекорд на каждой сложности; старый ключ без сложности переезжает на `easy` | `core-game/src/game/run/records.ts` |
| `bh.install.v1.id` | `installId` устройства | `state/install.ts` |
| `bh.install.v1.accepted` | предупреждение закрытого теста принято | `state/install.ts` |
| `bh.hints.v1` | какие подсказки первого забега игрок уже усвоил | `state/hints.ts` |
| `bh.run.v1.save` | снимок прерванного забега; формат мира — `RUN_SNAPSHOT_FORMAT` в `core-game/src/run-api.ts` | `state/run-save.ts` |
| `bh.playtest.v1.pending` | итоги забегов, ещё не дошедшие до сервера плейтеста | `state/playtest.ts` |
| `bh.telemetry.v1.queue` | события, ещё не дошедшие до приёмника; до 500 штук, старые вытесняются | `state/telemetry.ts` |
| `bh.reports.v1.queue` | записи забегов, ещё не дошедшие до приёмника диагностики; до 10 штук и 1 МБ, старые вытесняются | `state/report-keys.ts`, очередь — `state/report-queue.ts` |
| `bh.reports.v1.sent` | десять последних отправленных отчётов для экрана «Последние отчёты» | `state/report-queue.ts` |
| `bh.reports.v1.evicted` | сколько отчётов вытеснено и ещё не сообщено серверу | `state/report-queue.ts` |

Само хранилище приходит от адаптера площадки портом `KeyValueStorage`, а не
берётся из `localStorage` напрямую: переезд на `DeviceStorage` Telegram не
должен трогать оболочку.

---

## 5. Аналитика

| Что меняю | Где |
|---|---|
| Словарь имён событий | `docs/22-analytics-and-metrics.md` §3.3 — **сначала сюда**, потом в код |
| Имена событий в коде оболочки | `app-shell/src/state/analytics.ts` → `ANALYTICS_EVENTS`; схемы `payload` на сервере — `backend/api/src/modules/events/event-dictionary.ts` |
| Отправка на сервер: адрес, размер пачки, таймер, потолок очереди, пауза после сбоя, тело keepalive | `capabilities.telemetry` в `apps/web-telegram/src/main.tsx`; `app-shell/src/state/telemetry.ts` → `TELEMETRY_BATCH_SIZE`, `FLUSH_AT`, `FLUSH_INTERVAL_MS`, `TELEMETRY_MAX_QUEUED`, `MAX_BACKOFF_MS`, `KEEPALIVE_MAX_BYTES` |
| Сколько `client_error` уходит: повтор одной ошибки, потолок на запуск | `app-shell/src/state/shell.ts` → `ERROR_REPEAT_MS`, `ERRORS_PER_LAUNCH` |
| Консоль событий на устройстве разработчика | `apps/web-*/src/main.tsx`, функция `createAnalytics` |

Порядок обязателен: имя сначала в словарь, потом в код. Иначе в базе заводятся
`run_end`, `runFinished` и `end_run` одновременно, и ни один отчёт не сходится.

---

## 6. Сборка, окружение, порты

| Что меняю | Где |
|---|---|
| Любая переменная окружения | `.env` локально, шаблон — `.env.example`, описание — `20-env-and-ports.md` |
| Порт сервиса | **только** карта портов `20-env-and-ports.md` §2, дальше переменная |
| Конфигурация бэкенда и её проверка | `backend/api/src/config/app-config.ts` — единственное место, где читается `process.env` |
| HTTP-приложение бэкенда: лимит тела запроса, префикс API, CORS, фильтр ошибок | `backend/api/src/http-app.ts` → `BODY_LIMIT_BYTES`, `createHttpApp` |
| Приёмники событий и отчётов: лимиты частоты по IP, установке и Telegram ID, потолок тела | `backend/api/src/modules/ingest/ingest-limits.ts` → `INGEST_LIMITS` |
| Словарь событий сервера: имена, версии и схемы `payload`, потолок полей | `backend/api/src/modules/events/event-dictionary.ts` → `EVENT_DICTIONARY`, `MAX_PAYLOAD_KEYS`; размер пачки — `dto/event-batch.dto.ts` → `MAX_EVENTS_PER_BATCH` |
| Очередь событий: ожидание постановки, параллельность воркера, повторы | `backend/api/src/modules/events/events.sink.ts` → `ENQUEUE_TIMEOUT_MS`, `WORKER_CONCURRENCY`, параметры `queue.add` |
| Postgres: схема, миграции, таймауты соединения и запроса, размер пула | `backend/api/prisma/schema.prisma`, `prisma/migrations/`; `src/infra/database.ts` → `CONNECT_TIMEOUT_MS`, `STATEMENT_TIMEOUT_MS`, `POOL_SIZE` |
| Интеграционные тесты в CI: версии Postgres и Redis, адреса баз | `.github/workflows/ci.yml` → `services`, `env` |
| Сборка клиента: плагины, туннель, режимы | `apps/web-*/vite.config.ts` |
| Поведение dev-сервера при обрыве связи: плашка вместо перезагрузки | `scripts/vite/stable-dev-session.ts` (`20-env-and-ports.md` §4) |
| Режим сборки клиента: всегда production, `NODE_ENV` из `.env` не берётся | `scripts/vite/production-node-env.ts` |
| Раскладка чанков клиента: без слияния общих чанков Rolldown | `scripts/vite/chunking.ts` → `clientRolldownOptions` (`27-design-system-and-app-shell.md` §3.4) |
| Какие экраны грузятся по требованию | `packages/app-shell/src/app/lazy-screens.tsx` → `loaders` |
| Версия Node | `.nvmrc` |
| Правила TypeScript | `tsconfig.base.json`, проекты — `tsconfig.json` пакетов, тесты — `tsconfig.tests.json` |
| Правила линта | `eslint.config.js` |
| Что и как запускается | `package.json` в корне, раздел `scripts` |
| Локальные Postgres и Redis | `docker-compose.yml` |
| Туннель для открытия Mini App с телефона | `infra/frpc/frpc.local.toml` (не коммитится: в нём токен) |

Три правила, которые нарушают чаще всего: порт **не выбирается на месте**;
`process.env` за пределами модуля конфигурации запрещён; **у секретов не бывает
значений по умолчанию** — приложение падает при старте, и это осознанно.

Переменные, которые чаще всего трогают на этапе закрытого теста:

| Переменная | Что делает |
|---|---|
| `VITE_DIAGNOSTICS_DEFAULT` | включает режим диагностики по умолчанию; переключатель остаётся |
| `DEV_TUNNEL_TELEGRAM_HOST` | домен туннеля, чтобы Vite пустил запрос с телефона |
| `PLAYTEST_ENABLED`, `TELEGRAM_BOT_TOKEN` | сохранения и лидерборд плейтеста на бэкенде; без токена бэкенд с включённым плейтестом не стартует |
| `PLAYTEST_DATA_TTL_DAYS`, `PLAYTEST_INIT_DATA_MAX_AGE_SEC` | сколько живут данные плейтеста в Redis и подпись запуска Telegram |
| `PLAYTEST_DEV_AUTH`, `VITE_PLAYTEST_DEV_USER` | вход в плейтест без Telegram на машине разработчика; только `NODE_ENV=development` |
| `EVENTS_INGEST_ENABLED`, `DIAGNOSTICS_INGEST_ENABLED` | приёмники событий и отчётов; без `DATABASE_URL` бэкенд не стартует |
| `TRUST_PROXY_HOPS` | сколько прокси перед API; за Caddy — `1`, иначе лимит по IP посчитает всех тестеров одним адресом |
| `TELEGRAM_BOT_UPDATES` | откуда бот берёт обновления: `off` — молчит, `polling` — читает сам, `webhook` — Telegram шлёт их на `PUBLIC_API_URL`; регистрация — `pnpm --filter backend-api bot:webhook` |
| `TELEGRAM_WEBHOOK_SECRET` | секретный токен вебхука; без него режим `webhook` не стартует |
| `PUBLIC_WEB_URL` | адрес Mini App; HTTPS — кнопка «Играть» под приветствием бота |
| `EXPORT_PSEUDONYM_KEY` | ключ псевдонимов Telegram ID в выгрузках; без него выгрузка невозможна, смена меняет все псевдонимы |
| `DATA_EXPORT_BOT_ENABLED` | выгрузка через бота; без ключа, базы и чтения обновлений бэкенд не стартует |
| `DIAGNOSTICS_RETENTION_DAYS` | сколько дней хранить сырые события и отчёты |
| `ADMIN_NOTIFY_REPORTS` | карточка в чат администраторов на каждый новый стресс-тест; нужны `ADMIN_CHAT_ID` и включённый приёмник отчётов |
| `ADMIN_CHAT_ID` | групповой чат администраторов: сводка и уведомления. Прежнее имя `PLAYTEST_STATS_CHAT_ID` — бэкенд не стартует и называет новое |
| `PLAYTEST_STATS_ENABLED` | сводка статистики плейтеста в чат администраторов по `/stats`; без чата или чтения обновлений бота бэкенд не стартует |
| `PLAYTEST_STATS_DAILY_AT`, `PLAYTEST_STATS_UTC_OFFSET_MIN` | когда бот присылает сводку сам и в каком поясе считаются «сутки»; пусто в `DAILY_AT` — только по команде |
| `ADMIN_TELEGRAM_IDS` | администраторы: режим разработчика в клиенте и забеги с читами в рейтинге. Стресс-тест открыт всем, пока `PLAYTEST_ENABLED=true`; в dev-сервере инструменты открыты без сервера (`capabilities.devTools`). Правила — `backend/api/src/modules/playtest/playtest-access.ts` |

Прокси dev-сервера на бэкенд плейтеста — `apps/web-telegram/vite.config.ts` →
`apiProxy`: проксируется только `/api/v1/playtest` (`20-env-and-ports.md` §4).

---

## 7. Проверки: тесты, гейт, бюджеты

| Что меняю | Где |
|---|---|
| Что и где ищет тестовый раннер | `vitest.config.ts` |
| Проверка ссылок в документации: какие файлы и какие пути проверяются | `scripts/docs-check.mjs` → `CODE_ROOTS`, `documentationFiles`; запуск — `pnpm docs:check`, в гейте — `scripts/test/docs-check.test.ts` |
| Свод калибровки баланса отдельной командой | `vitest.balance.config.ts`, прогон — `scripts/balance/balance-sim.ts` |
| Бюджеты размера бандла: первая загрузка, CSS, ленивые чанки, шрифты | `scripts/bundle-budget.mjs` → `BUDGETS` |
| Порог теста производительности симуляции | `packages/core-game/test/perf-budget.test.ts` |
| Эталон забега и контрольная сумма | `test/run-summary.test.ts`, `test/determinism.test.ts` |
| Правила границ слоёв | `scripts/test/layer-boundaries.test.ts` → `RULES` |
| Шаги гейта в CI | `.github/workflows/ci.yml` |

Гейт целиком:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm budget
```

Пороги здесь двигают **осознанно и с объяснением в PR**, а не потому что
покраснело. Эталон забега — исключение наоборот: он обязан меняться вместе с
контентом, иначе не видно, как правка повлияла на игру.

---

## 8. Стресс-тест, звук, вибрация и режим разработчика

| Что меняю | Где |
|---|---|
| Стресс-тест: темп роста нагрузки, потолок, пулы, аварийный таймер | `core-game/src/game/bench/profiles.ts` → `BENCH_STRESS`, `BENCH_RAMP_START` |
| Нагрузка позднего забега для стресс-теста в оболочке: доли паттернов, частота и размер волны элит | `bench/full-load.ts` → `BENCH_FULL_LOAD` |
| Как часто стресс-тест сообщает прогресс оболочке | `game/BenchScene.ts` → `PROGRESS_INTERVAL_MS` |
| Звуки: слои синтеза, шина, громкость, голоса, интервал, реверберация | `app-shell/src/audio/recipes.ts` → `SOUND_RECIPES`; правка на устройстве — звуковая лаборатория (`docs/31-audio-and-haptics.md` §6) |
| Звук: уровни и приоритеты шин, бюджет запусков, потолок голосов, плотность, глубина приглушения | `audio/recipes.ts` → `BUSES`, `MIX_RULES` |
| Звук: какие звуки на сигналы забега, напряжение музыки, сердцебиение, серия кристаллов | `audio/sound-director.ts` → `planCueSounds`, `FULL_INTENSITY_ENEMIES`, `HEARTBEAT_*`, `GEM_STREAK_*` |
| Музыка: лад, аккорды, темп сцен, мотивы, пороги слоёв | `audio/music.ts` → `SCALE`, `CHORDS`, `CONTEXTS`, `MOTIFS`, `LAYER_THRESHOLDS` |
| Громкость по умолчанию и шкала регулятора | `audio/index.ts` → `DEFAULT_VOLUMES` (музыка выключена, интерфейс громче боя); `audio/audio-engine.ts` → `volumeCurve` |
| Правила грани звука: включены ли по умолчанию, бюджеты шин, потолок голосов | `audio/audio-engine.ts` → `rulesEnabled`; `audio/recipes.ts` → `MIX_RULES` |
| Настройки графики игрока: что можно отключить и что включено по умолчанию | `app-shell/src/state/graphics.ts` → `DEFAULT_GRAPHICS`; применяет `core-game/src/game/render/WorldRenderer.ts` |
| Звук интерфейса и вибрация на нажатия | `app-shell/src/state/ui-feedback.ts` → `FEEDBACK` |
| Бюджет звукового чанка | `scripts/bundle-budget.mjs` → строка «Звук» |
| Вибрация: вид и минимальный интервал каждого события, интервал между любыми двумя | `app-shell/src/state/haptics.ts` → `HAPTIC_RULES`, `GLOBAL_MIN_INTERVAL_MS` |
| Вибрация вне Telegram: шаблоны `navigator.vibrate` | `adapter-telegram/src/index.ts` → `VIBRATE_PATTERNS` |
| Сигналы забега для вибрации и звука: частота, что считать взрывом рядом | `core-game/src/game/MainScene.ts` → `CUE_INTERVAL_MS`; `game/run/cues.ts` → `NEAR_MARGIN_UNITS` |
| Режим разработчика: цвета отладочной отрисовки | `core-game/src/game/render/looks.ts` → `DEBUG_COLORS` |
| Режим разработчика: где появляется заспавненное, потолки количества и перемотки | `core-game/src/game/run/dev-commands.ts` → `SPAWN_DISTANCE_UNITS`, `PICKUP_DISTANCE_UNITS`, `MAX_SPAWN_COUNT`, `MAX_JUMP_MINUTE` |
| Режим разработчика: окно технической сводки, потолок шагов на паузе | `core-game/src/game/MainScene.ts` → `DEV_INFO_INTERVAL_MS`, `MAX_DEV_STEP_TICKS` |
| Режим разработчика: наборы, скорости времени, множители урона и бега, умолчания | `app-shell/src/state/dev-mode.ts` → `DEV_PRESETS`, `TIME_SCALES`, `DAMAGE_MULS`, `MOVE_SPEED_MULS`, `DEFAULT_DEV_SETTINGS` |
| Что попадает в отчёт и версия его схемы | `bench/metrics.ts` → `BENCH_REPORT_SCHEMA` |
| Сводка производительности забега: шаг гистограммы, прогрев, порог рывка | `core-game/src/game/diagnostics/run-perf.ts` → `BIN_MS`, `BINS`, `WARMUP_MS`; `frame-stats.ts` → `JANK_FRAME_MS` |
| Очередь отчётов на устройстве: потолки, паузы повтора, длина истории | `app-shell/src/state/report-queue.ts` → `REPORT_QUEUE_MAX_ITEMS`, `REPORT_QUEUE_MAX_BYTES`, `BASE_BACKOFF_MS`, `MAX_BACKOFF_MS`, `SENT_HISTORY_SIZE` |
| Запись забега: корзина таймлайна и её потолок, свёртки мира, потолок событий, формат | `game/diagnostics/run-timeline.ts` → `TIMELINE_BUCKET_SEC`, `TIMELINE_MAX_BUCKETS`; `run-recorder.ts` → `CHECKPOINT_TICKS`, `MAX_RECORDED_EVENTS`; `run-api.ts` → `RUN_RECORDING_SCHEMA` |
| Лог ввода: потолок и кодировка; квантование направления и гистерезис | `game/diagnostics/input-log.ts` → `INPUT_LOG_MAX_BYTES`, `INPUT_LOG_ENCODING`; `game/sim/input-code.ts` → `DIRECTION_CODES`, `HYSTERESIS` |
| Критерии вердикта «тянет / не тянет» | `bench/verdict.ts` |
| Определение просадки, на которой стресс-тест останавливается | `bench/degradation-detector.ts` → `DEFAULT_DEGRADATION` |
| Скрипт движения автопилота | `bench/autopilot.ts` |
| Приёмник отчётов диагностики: конверт, схемы стресс-теста и записи забега, итог для выборок, кому открыт стресс-тест | `backend/api/src/modules/diagnostics/dto/report-envelope.dto.ts`, `dto/bench-report.dto.ts`, `dto/run-report.dto.ts`; `diagnostics-summary.ts` → `benchSummaryOf`, `runSummaryOf`; `diagnostics.service.ts` → `stressTestOpen` |
| Какой забег проблемный: минимум кадров, доля рывков, p95 кадра, доля догоняния, потолок шагов | `backend/api/src/modules/diagnostics/diagnostics-summary.ts` → `RUN_PROBLEM_THRESHOLDS` |
| Карточка проблемного забега в чате администраторов: вид, подпись, названия причин | `backend/api/src/modules/admin-notify/run-card.ts`; `common/card/labels.ts` → `runProblemLabel` |
| Записи забегов в ежедневной сводке плейтеста | `backend/api/src/modules/playtest/playtest-stress.listener.ts`; `redis-playtest-stats.store.ts` → ключи `pt:st:rec*` |
| Итог стресс-теста в сводке плейтеста | `backend/api/src/modules/playtest/playtest-stress.listener.ts` |
| Кому открыты инструменты команды: режим разработчика, стресс-тест, витрина компонентов, звуковая лаборатория | сервер — `backend/api/src/modules/playtest/playtest-access.ts` по `ADMIN_TELEGRAM_IDS`; на dev-сервере — `VITE_DEV_TOOLS=1` |
| Команды бота: что видно всем и что администраторам, текст `/help` | `backend/api/src/modules/bot/bot-commands.ts`; сами команды — рядом с обработчиками (`welcome.command.ts`, `playtest-stats.reporter.ts`, `export-bot.command.ts`) |
| Куда бот пишет: общий чат и адреса потоков, разбор `чат:тема` | `.env` → `ADMIN_CHAT_ID`, `ADMIN_CHAT_STATS`, `ADMIN_CHAT_STRESS`, `ADMIN_CHAT_RUNS`; разбор — `backend/api/src/modules/telegram/chat-target.ts` |

Протокол замера выверен на FPS-испытаниях этапа 1 — `25-week1-fps-trials.md`.

---

## 9. Что настройкой не меняется

Сюда попадает то, за чем идут в карту и не находят. Это не недоработка — это
граница между данными и кодом (`01-tech-stack.md` §9).

| Хочу | Почему данными нельзя | Что делать |
|---|---|---|
| Новый паттерн поведения врага | поведение — это код в `game/patterns/` | задача участнику 1 |
| Новый способ атаки оружия | то же, `game/weapons/` | задача участнику 1 |
| Пассивка на характеристику, которой нет | характеристики перечислены типом `PlayerStat` | задача участнику 1 |
| Размер хитбокса конкретному врагу | радиус — свойство поведения, а не число в контенте; ранг элиты умножает его | обсудить с участником 1 |
| Светлая тема | на MVP тема одна, тёмная (`27-design-system-and-app-shell.md` §4.1) | решение команды, потом код |
| Вторая карта | решение Р8 этапа 2: карта одна | решение команды |

---

## 10. Куда смотреть дальше

| Вопрос | Документ |
|---|---|
| Почему устроено именно так | `01-tech-stack.md`, `16-tech-stack-decisions.md` |
| Границы слоёв и стиль кода | `15-engineering-standards.md`, `CLAUDE.md` |
| Интерфейс, токены, экраны | `27-design-system-and-app-shell.md` |
| Переменные окружения и порты подробно | `20-env-and-ports.md` |
| Тесты и что они защищают | `17-testing-strategy.md` |
| События аналитики | `22-analytics-and-metrics.md` |
| Редактор баланса для геймдизайнера | `19-content-admin.md` |
