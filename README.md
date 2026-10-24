# Доска задач

Обновлено 24.10.2026 23:39 UTC. Страницу пересчитывает workflow `task-board.yml` после захвата, PR и мерджа — руками не править. Как брать задачу — [tasks/README.md](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/README.md#как-взять-задачу).

## Потоки сейчас

Какие потоки запускать в автопоток (`tasks/README.md`, «Автопоток»): доработка раньше новых задач, п.N — пачка выпуска. Строка `local` — задачи только для потоков на машине разработчика. То же даёт `pnpm task streams`.

### Запускать сейчас

| Поток | Свободно | Доработка | Ближайшие задачи |
|---|---|---|---|
| sonnet-5.5 / medium · local | 1 | 0 | [T-0210](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0210-notifications-read-by-action.md) (п.2) |
| sonnet-5.5 / high · local | 1 | 0 | [T-0064](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0064-fx-refresh-now-and-fallback-rates.md) (п.4) |
| sonnet-5.5 / extra · local | 2 | 0 | [T-0065](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0065-outbound-proxies.md) (п.4), [T-0070](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0070-postback-s2s-and-partner.md) (п.4) |

### На очереди

| Поток | Ждут | Ближайшая пачка |
|---|---|---|
| sonnet-5.5 / low · local | 1 | 3 |
| sonnet-5.5 / medium | 20 | 2 |
| sonnet-5.5 / medium · local | 8 | 2 |
| sonnet-5.5 / high | 24 | 2 |
| sonnet-5.5 / high · local | 30 | 2 |
| sonnet-5.5 / extra · local | 16 | 2 |
| haiku-5.5 / low | 1 | 2 |
| haiku-5.5 / medium | 3 | 2 |

## Доработка — 0

Пусто.

## Можно брать — 5

| Задача | Приоритет | Размер | Исполнитель | Эпик |
|---|---|---|---|---|
| [T-0210. Уведомления гаснут своим действием — друзья, подарки, предмет, журнал](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0210-notifications-read-by-action.md) | P1 | M | sonnet-5.5 · medium | E5 |
| [T-0233. Музыка — генератор с коммерческой лицензией и три трека по брифу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0233-music-tracks.md) | P2 | S | sonnet-5.5 · medium | E12 |
| [T-0064. Курсы руками — «Обновить сейчас» у источника и запасной ручной курс любой валюты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0064-fx-refresh-now-and-fallback-rates.md) | P2 | M | sonnet-5.5 · high | E13 |
| [T-0065. Прокси для исходящих запросов — список в панели, перебор после неудачи напрямую](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0065-outbound-proxies.md) | P2 | M | sonnet-5.5 · extra | E13 |
| [T-0070. Постбэки в s2s-сети и партнёру — шаблон адреса, click_id и sub1…sub5](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0070-postback-s2s-and-partner.md) | P2 | M | sonnet-5.5 · extra | E14 |

## В работе — 2

| Задача | Взял |
|---|---|
| [T-0112. Скрытое ограничение «Отдельная доска»: вид, право, панель](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0112-separate-board-restriction.md) | неизвестно |
| [T-0227. Имена всех кнопок, вкладок и переключателей оболочки — и `track` обязателен](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0227-ui-track-ids-all-screens.md) | claude-16 / haiku-5.5 / medium |

## На ревью — 3

| Задача | PR |
|---|---|
| [T-0116. Подбор «Заморозка»: враги на поле замирают на 10 секунд](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0116-freeze-pickup.md) | [#459](https://github.com/JJSGxKD/rubezh/pull/459) |
| [T-0205. Доска — кто кого ждёт, вид `owner` и счётчики сверху](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0205-board-who-waits-owner-runner.md) | [#467](https://github.com/JJSGxKD/rubezh/pull/467) |
| [T-0230. Черновой арт — тестерам флагом панели, с выключателем в «Графике»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0230-draft-art-testers-flag.md) | [#468](https://github.com/JJSGxKD/rubezh/pull/468) |

## Ждут — 103

| Задача | Чего ждёт |
|---|---|
| [T-0038. Кнопки «Выдать» и «Вернуть звёзды» у покупки в карточке игрока](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0038-support-purchase-actions-panel.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0172. Уход огонька и кастера — в бою нет врагов со снарядами](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0172-remove-shooting-enemies.md) | зоны пересекаются с T-0116 (на ревью) |
| [T-0190. Одна сложность у игрока — без выбора, первый забег обучающий](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0190-single-difficulty-shell.md) | ждёт T-0107; ждёт T-0111; ждёт T-0116; ждёт T-0125; ждёт T-0182; зоны пересекаются с T-0116 (на ревью) |
| [T-0191. Одна сложность на сервере — рейтинг с чистого листа](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0191-single-difficulty-server.md) | ждёт T-0107; ждёт T-0112; ждёт T-0113; ждёт T-0114; ждёт T-0125; зоны пересекаются с T-0112 (в работе) |
| [T-0192. Давление после 8-й минуты — единая сложность тяжелее «Сложной»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0192-pressure-after-minute-8.md) | ждёт T-0172; ждёт T-0116; зоны пересекаются с T-0116 (на ревью) |
| [T-0193. Прокачка до 15-й минуты — кривая опыта, уровни навыков, поздние сундуки, слоты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0193-longer-run-progression.md) | ждёт T-0116; ждёт T-0125; ждёт T-0172; ждёт T-0192; зоны пересекаются с T-0116 (на ревью) |
| [T-0194. «Предел» — бесконечные малые прибавки, когда прокачивать нечего](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0194-limit-break-offers.md) | ждёт T-0193; ждёт T-0116; ждёт T-0182; зоны пересекаются с T-0116 (на ревью) |
| [T-0195. Сила игрока и подстройка директора — движок и контент](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0195-player-power-pressure-engine.md) | ждёт T-0116; ждёт T-0125; ждёт T-0182; ждёт T-0190; ждёт T-0192; ждёт T-0193; ждёт T-0194; ждёт T-0197; зоны пересекаются с T-0116 (на ревью) |
| [T-0196. Подстройка под силу — калибровка, слабое устройство в оболочке, аналитика и приём на сервере](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0196-player-power-pressure-wiring.md) | ждёт T-0195; ждёт T-0190; ждёт T-0192; ждёт T-0193; ждёт T-0197; ждёт T-0125; ждёт T-0182 |
| [T-0197. Второй босс без снарядов — «Таран» вместо ушедшего Вещуна](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0197-second-boss-no-projectiles.md) | ждёт T-0172; ждёт T-0192; зоны пересекаются с T-0116 (на ревью) |
| [T-0105. Очки заданий: полоса дня и недели и награды за ступени очков](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0105-task-points-and-rewards.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0106. Достижения с престижем: сервер, 49 определений, редкость «есть у N%»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0106-achievements-prestige-server.md) | ждёт T-0105; ждёт T-0210; зоны пересекаются с T-0112 (в работе) |
| [T-0107. Витрина достижений: категории, редкость, любимые и престиж в профиле и рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0107-achievements-showcase-shell.md) | ждёт T-0106 |
| [T-0111. Недельный сезон — экран рейтинга: вкладки «Неделя», «Всё время», «Друзья», награды и таймер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0111-weekly-season-screen.md) | ждёт T-0107 |
| [T-0113. Доски рейтинга по зрителю: полная и общая, место и профиль по доске смотрящего](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0113-boards-by-viewer.md) | ждёт T-0112; зоны пересекаются с T-0112 (в работе) |
| [T-0114. Сезон и награды за места по доске зрителя, призы только внутриигровые](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0114-season-rewards-by-viewer-board.md) | ждёт T-0113 |
| [T-0125. Итог забега: счётчики боссов, элит, сундуков и кристаллов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0125-run-result-rank-chest-crystal-counters.md) | зоны пересекаются с T-0116 (на ревью) |
| [T-0126. Задания и достижения: боссы, элиты, сундуки, кристаллы, эволюции](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0126-tasks-kinds-bosses-elites-chests-evolutions.md) | ждёт T-0125; ждёт T-0106; зоны пересекаются с T-0112 (в работе) |
| [T-0144. Вход разработчика игроком без ролей — `dev-player-<id>`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0144-dev-login-as-player.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0145. Снимки экранов одной командой — `pnpm screens`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0145-screens-one-command.md) | ждёт T-0144 |
| [T-0211. Колокольчик обновляется сразу после экрана друзей, предмета и журнала](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0211-bell-refresh-after-actions.md) | ждёт T-0210 |
| [T-0052. Сводка панели — плитка и панель рекламы, вехи полосами, периоды — экран](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0052-overview-ads-and-periods-screen.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0182. Аналитика кольца — событие исхода (прорвался, выстоял, погиб)](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0182-cordon-ring-analytics.md) | зоны пересекаются с T-0116 (на ревью) |
| [T-0198. Уборка кода вражеских снарядов — снаряд врага уходит из пула, отрисовки и сигналов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0198-remove-enemy-projectile-code.md) | ждёт T-0172; ждёт T-0197; ждёт T-0116; ждёт T-0125; ждёт T-0182; ждёт T-0195; зоны пересекаются с T-0116 (на ревью) |
| [T-0206. Доска — в «В работе» и «На ревью» видно, кто, сколько висит и чего ждёт](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0206-board-work-review-columns.md) | ждёт T-0205; зоны пересекаются с T-0205 (на ревью) |
| [T-0208. «Вклад» на доске — задачи, доработки, ревью, спецификации и PR тимлидов по периодам](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0208-board-contribution-periods.md) | ждёт T-0209; зоны пересекаются с T-0205 (на ревью) |
| [T-0209. Готовые промты потоков с номером аккаунта — на доске и в `pnpm task streams`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0209-flow-prompts-per-account.md) | ждёт T-0206; зоны пересекаются с T-0205 (на ревью) |
| [T-0053. Воронка в панели — полосами, сравнение с прошлым периодом, подсветка источников](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0053-funnel-chart-screen.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0054. Карточка игрока вкладками — шапка с действиями, «Сводка» на один взгляд](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0054-player-card-tabs.md) | ждёт T-0038; зоны пересекаются с T-0112 (в работе) |
| [T-0089. Пропуск рекламы VIP — отдельной меткой «Пропуск VIP», не досмотр](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0089-vip-ad-pass-mark.md) | ждёт T-0052 |
| [T-0133. Панель — подпись «отдельной доски» в журнале и сверка списка оружия с контентом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0133-admin-audit-board-label-and-weapon-sync.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0151. Ник в панели — исходник, ручная смена с закреплением, длинные ники в списке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0151-admin-player-rename.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0167. Порядок заданий перетаскиванием — SortableList в панели и запрос порядка](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0167-admin-sortable-list-tasks-order.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0168. Порядок рекламных сетей в круге — перетаскиванием вместо числа](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0168-admin-ad-networks-order.md) | ждёт T-0167; зоны пересекаются с T-0112 (в работе) |
| [T-0169. Порядок заданий у игрока — по состоянию, внутри по порядку из панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0169-player-tasks-panel-order.md) | ждёт T-0167 |
| [T-0189. Порядок слайдов главной перетаскиванием в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0189-admin-home-slides-order.md) | ждёт T-0167; зоны пересекаются с T-0112 (в работе) |
| [T-0119. Модификаторы забега «Спешка» и «Инверсия»: данные и движок](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0119-run-modifiers-hurry-inverse.md) | ждёт T-0192; ждёт T-0193; ждёт T-0194; ждёт T-0195; ждёт T-0196; ждёт T-0198; зоны пересекаются с T-0116 (на ревью) |
| [T-0120. Рубеж — цель забега, движок: страж на отметке, победа в итоге забега](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0120-rubezh-guard-engine.md) | ждёт T-0190; ждёт T-0192; ждёт T-0193; ждёт T-0194; ждёт T-0195; ждёт T-0196; ждёт T-0197; зоны пересекаются с T-0116 (на ревью) |
| [T-0122. Модификаторы забега: проверка и награда ×1,25 на сервере, без рейтинга](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0122-run-modifiers-server.md) | ждёт T-0119; ждёт T-0113; ждёт T-0191; ждёт T-0193; ждёт T-0196; зоны пересекаются с T-0112 (в работе) |
| [T-0123. Модификаторы забега: выбор в листе «Перед забегом»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0123-run-modifiers-prerun-sheet.md) | ждёт T-0119; ждёт T-0122; ждёт T-0190; ждёт T-0193; ждёт T-0196; зоны пересекаются с T-0116 (на ревью); зоны пересекаются с T-0230 (на ревью) |
| [T-0129. Испытание дня: движок — фиксированный seed и набор на старте забега](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0129-daily-challenge-engine.md) | ждёт T-0119; ждёт T-0190; ждёт T-0193; ждёт T-0194; ждёт T-0195; ждёт T-0196; ждёт T-0198; зоны пересекаются с T-0116 (на ревью) |
| [T-0130. Испытание дня: сервер — расписание, выдача попыток, проверка, награда, таблица дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0130-daily-challenge-server.md) | ждёт T-0129; ждёт T-0122; ждёт T-0191; ждёт T-0193 |
| [T-0131. Испытание дня — вход с главной, лист испытания, таблица дня, расписание в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0131-daily-challenge-shell-and-panel.md) | ждёт T-0130; ждёт T-0190; ждёт T-0196 |
| [T-0199. Переброс карточек за рекламу — один раз за забег, когда заряды кончились](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0199-reroll-for-ad.md) | ждёт T-0089; ждёт T-0106; ждёт T-0107; ждёт T-0113; ждёт T-0116; ждёт T-0119; ждёт T-0120; ждёт T-0121; ждёт T-0122; ждёт T-0123; ждёт T-0124; ждёт T-0125; ждёт T-0127; ждёт T-0129; ждёт T-0130; ждёт T-0131; ждёт T-0168; ждёт T-0172; ждёт T-0175; ждёт T-0182; ждёт T-0190; ждёт T-0191; ждёт T-0193; ждёт T-0194; ждёт T-0195; ждёт T-0196; ждёт T-0198; зоны пересекаются с T-0116 (на ревью) |
| [T-0115. Метка «Отдельная доска» в сводке, воронке и разборе забегов в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0115-board-label-in-reports.md) | ждёт T-0112; зоны пересекаются с T-0112 (в работе) |
| [T-0121. Рубеж — цель забега, сервер: проверка победы, награда ×2, отметка в рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0121-rubezh-win-reward-server.md) | ждёт T-0120; ждёт T-0113; ждёт T-0191; ждёт T-0193; ждёт T-0196; зоны пересекаются с T-0112 (в работе); зоны пересекаются с T-0116 (на ревью) |
| [T-0124. Рубеж — цель забега, оболочка: баннеры, «до рубежа N с», отметка в рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0124-rubezh-banners-and-death-screen.md) | ждёт T-0121; ждёт T-0190; ждёт T-0193; ждёт T-0196; зоны пересекаются с T-0116 (на ревью); зоны пересекаются с T-0230 (на ревью) |
| [T-0127. Кодекс врагов: гайдбук как коллекция, «7/11» и награда за полный](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0127-enemy-codex.md) | ждёт T-0106; ждёт T-0125; ждёт T-0190; зоны пересекаются с T-0116 (на ревью) |
| [T-0128. Напоминания через бота: обогнали в сезоне, сезон закрывается, награда дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0128-bot-reminders.md) | ждёт T-0191 |
| [T-0241. Дневной кап роликов на все места — реклама не становится работой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0241-ads-daily-cap.md) | ждёт T-0199 |
| [T-0242. Награда дня ×2 за ролик — новое место рекламы daily_double, сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0242-daily-double-for-ad.md) | ждёт T-0241 |
| [T-0243. Самоцветы за ролик раз в день — новое место рекламы free_gems в магазине, сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0243-free-gems-for-ad.md) | ждёт T-0242 |
| [T-0244. Клиент наградной рекламы — «Удвоить за ролик» в награде дня, самоцветы за ролик в магазине, сообщение о капе](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0244-reward-ads-shell.md) | ждёт T-0243 |
| [T-0148. Счётчик онлайна — клиент и панель: шапка, кнопка «Играть», разбивка](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0148-online-counter-client.md) | ждёт T-0176 |
| [T-0174. Лента живых событий — сервер: запись настоящих событий за сутки, кэш, маршрут](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0174-live-feed-backend.md) | ждёт T-0112; ждёт T-0191 |
| [T-0175. Лента живых событий — убитый босс и редкий сундук: счётчик редких сундуков и события](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0175-live-feed-boss-and-rare-chest.md) | ждёт T-0125; ждёт T-0174; ждёт T-0193; ждёт T-0195; ждёт T-0198; зоны пересекаются с T-0116 (на ревью) |
| [T-0176. Лента живых событий — клиент: строка на главной под «Играть»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0176-live-feed-client.md) | ждёт T-0174 |
| [T-0212. Сцена эффекта по адресу — `?fx=<сцена>` на dev-сервере, шаг по тикам для снимков](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0212-fx-scene-by-url.md) | ждёт T-0145; зоны пересекаются с T-0116 (на ревью) |
| [T-0213. Раскадровка эффекта и замеры — `pnpm fx:frames <сцена>`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0213-fx-frames-and-metrics.md) | ждёт T-0212 |
| [T-0214. Рендер звуков в WAV и замеры — `pnpm fx:sound [звук…]`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0214-fx-sound-render-and-metrics.md) | ждёт T-0212 |
| [T-0215. Отчёт проверки звука и эффектов — `pnpm fx:check`, таблица в описание PR](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0215-fx-check-report.md) | ждёт T-0213; ждёт T-0214 |
| [T-0161. Знак «Поддержал проект» в ответах входа, рейтинга и сезонов — сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0161-supporter-badge-api.md) | ждёт T-0191; ждёт T-0193; зоны пересекаются с T-0116 (на ревью) |
| [T-0156. Панель — сводка заблокированных адресов клиента](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0156-csp-reports-panel.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0203. Сводка «чего достигли» в панели — итоги за всё время и рекорды DAU/WAU/MAU](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0203-admin-all-time-summary.md) | ждёт T-0052; ждёт T-0115 |
| [T-0216. Уровни ролей — администратор выдаёт роли ниже своей](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0216-role-levels.md) | ждёт T-0112; ждёт T-0144; зоны пересекаются с T-0112 (в работе) |
| [T-0231. Больше трёх вкладок — строкой с прокруткой и подчёркиванием, а не сеткой 2×2](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0231-tabs-row-over-three.md) | ждёт T-0227 |
| [T-0234. Музыка в игре — лобби, пульс забега, слой босса и регулятор громкости](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0234-music-playback.md) | ждёт T-0233 |
| [T-0177. Штраф за отписку — заготовки: списание награды, срочное закрытие, уведомление](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0177-unsubscribe-penalty-building-blocks.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0178. Отписка от канала после награды — перепроверка 7 суток, списание, закрытие заданий](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0178-channel-unsubscribe-recheck.md) | ждёт T-0177; ждёт T-0167; ждёт T-0169 |
| [T-0180. Панель «Ссылки» — автоисточники: пометка «авто», название, скрытие и сводка незнакомых меток](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0180-links-panel-auto-sources.md) | ждёт T-0167; зоны пересекаются с T-0112 (в работе) |
| [T-0181. Прямая ссылка на Mini App для рекламы AdsGram — метки сети в стартовом параметре и конверсия по запуску](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0181-direct-ad-link-network-label.md) | ждёт T-0180 |
| [T-0183. Подсказка о правиле подписки на карточке партнёрского задания](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0183-unsubscribe-rule-hint-on-task-card.md) | ждёт T-0178 |
| [T-0222. Заказчик партнёрского задания — модель оплаты CPA или RS, ставка и срок удержания](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0222-task-customer-and-pay-model.md) | ждёт T-0105; ждёт T-0106; ждёт T-0126; ждёт T-0167; ждёт T-0178 |
| [T-0223. Отметки удержания подписки на 1-й, 3-й и 7-й день — из перепроверки отписки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0223-subscription-retention-marks.md) | ждёт T-0178; ждёт T-0222 |
| [T-0224. Показы партнёрских заданий — событие `task_shown` при открытии экрана заданий](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0224-partner-task-impressions.md) | ждёт T-0105; ждёт T-0107 |
| [T-0225. Отчёт заказчику партнёрских заданий — по дням, без ID, экран и CSV](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0225-customer-report.md) | ждёт T-0222; ждёт T-0223; ждёт T-0224 |
| [T-0228. Отчёт «Нажатия» в панели — что нажимают на каждом экране](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0228-ui-clicks-report.md) | ждёт T-0227 |
| [T-0235. Знаки у имени — сервер: каталог, статусные и сезонные знаки, выбор знака](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0235-emblems-server.md) | ждёт T-0106; ждёт T-0107; ждёт T-0126 |
| [T-0236. Знаки у имени — клиент: все знаки в профиле, выбор знака, знак в рейтинге и у друзей](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0236-emblems-shell.md) | ждёт T-0235; ждёт T-0240; ждёт T-0107; ждёт T-0111 |
| [T-0237. Облики-архетипы — сервер: каталог, кто чем владеет, выбор облика и аватара, облик в списках](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0237-appearance-server.md) | ждёт T-0235; ждёт T-0240; ждёт T-0105; ждёт T-0126 |
| [T-0238. Облики — экран «Облик» из арсенала и профиля, портрет в арсенале, голова облика в аватаре](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0238-appearance-shell.md) | ждёт T-0237; ждёт T-0230; ждёт T-0236 |
| [T-0239. Облик в забеге — герой кадрами выбранного облика из атласа skins в режиме арта](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0239-appearance-in-run.md) | ждёт T-0238; ждёт T-0230 |
| [T-0240. Знак у имени в строках рейтинга, сезона и друзей — порт PublicIdentity](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0240-public-identity-in-lists.md) | ждёт T-0235; ждёт T-0161; ждёт T-0111 |
| [T-0247. Карточка игрока — сервер: публичный id, ответ карточки, заявка в друзья по публичному id](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0247-player-card-server.md) | ждёт T-0240; ждёт T-0237; ждёт T-0113 |
| [T-0248. Карточка игрока — клиент: лист по тапу в рейтинге, сезоне и у друзей, «Как меня видят» в профиле](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0248-player-card-shell.md) | ждёт T-0247; ждёт T-0238 |
| [T-0249. VIP в подарок другу — сервер: заказ за звёзды, срок подарка, уведомление, возврат](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0249-vip-gift-server.md) | ждёт T-0247 |
| [T-0250. VIP в подарок — клиент: «Подарить VIP» в карточке друга, уведомление получателю](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0250-vip-gift-shell.md) | ждёт T-0249; ждёт T-0248 |
| [T-0251. VIP глазами других — золотая галочка у аватара в списках и карточке, «Что увидят другие» на экране VIP](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0251-vip-seen-by-others.md) | ждёт T-0250 |
| [T-0252. Картинки бота — основа: шрифт Russo One, общая сцена с обликом, кэш file_id, публичный адрес картинки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0252-bot-cards-foundation.md) | ждёт T-0237 |
| [T-0253. Приглашение и итог забега картинкой — «Поделиться» несёт облик и рекорд](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0253-invite-and-run-share-cards.md) | ждёт T-0252 |
| [T-0255. Напоминания бота картинкой — «тебя обогнали», сезон закрывается, награда дня ждёт, колесо снова крутится](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0255-reminders-with-images.md) | ждёт T-0252; ждёт T-0128 |
| [T-0256. Итог сезона в боте картинкой — место и награды тем, кто играл](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0256-season-result-message.md) | ждёт T-0255 |
| [T-0232. Итоги забега — окно-реликвия, как сундук и уровень](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0232-run-results-relic.md) | ждёт T-0124 |
| [T-0093. Подписка Xray для прокси — хранение, обновление, контейнер Xray, раздел панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0093-xray-subscription-backend.md) | ждёт T-0065 |
| [T-0068. Воронка партнёра — по его ссылкам, кодам и площадкам](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0068-partner-funnel.md) | ждёт T-0053 |
| [T-0072. Метка партнёрки Telegram у игрока — слот источника занят, процент и срок программы в настройках](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0072-telegram-affiliate-mark.md) | ждёт T-0053; ждёт T-0054; ждёт T-0191; ждёт T-0199; зоны пересекаются с T-0112 (в работе) |
| [T-0217. Роль «партнёр» — аккаунт привязан к карточке, вход в свой кабинет, без самопривязки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0217-partner-role-and-account.md) | ждёт T-0216; ждёт T-0068; ждёт T-0070; ждёт T-0071; ждёт T-0181 |
| [T-0218. Кабинет партнёра в панели — свои ссылки и промокоды, доступ из карточки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0218-partner-cabinet-links-promo.md) | ждёт T-0217 |
| [T-0219. Кабинет партнёра — воронка по своим ссылкам и кодам, без ID и малых групп](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0219-partner-cabinet-funnel.md) | ждёт T-0218 |
| [T-0254. Карточка игрока картинкой — «Поделиться» из карточки и вход по ссылке прямо в карточку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0254-player-card-share.md) | ждёт T-0253; ждёт T-0251 |
| [T-0257. Сводка дня и тревоги в чате администраторов картинкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0257-admin-chat-images.md) | ждёт T-0252 |
| [T-0071. Постбэки — покупки и возврат на следующий день, выбор событий у назначения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0071-postback-events-and-selection.md) | ждёт T-0070 |
| [T-0221. Материалы для партнёров — баннеры, тексты постов и правила в кабинете](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0221-partner-materials.md) | ждёт T-0219 |

## Готово — 139

| Задача | Сделал | PR |
|---|---|---|
| [T-0229. Поле `size` у врага — радиус крупнее или мельче паттерна](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0229-enemy-size-field.md) | @Ferdinans228 · claude-13 / sonnet-5.5 / high | [#466](https://github.com/JJSGxKD/rubezh/pull/466) |
| [T-0226. Событие нажатий `ui_clicked` — разметка встроена в кнопки, вкладки и переключатели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0226-ui-clicked-event.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#458](https://github.com/JJSGxKD/rubezh/pull/458) |
| [T-0207. Строки «Поток» и «Запустил» в описании PR задачи — проверяет pr-check](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0207-pr-runner-and-launcher-lines.md) | @Ferdinans228 · claude-16 / haiku-5.5 / medium | [#465](https://github.com/JJSGxKD/rubezh/pull/465) |
| [T-0204. Архив задач — готовые и отменённые в `tasks/archive/`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0204-tasks-archive-folder.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#457](https://github.com/JJSGxKD/rubezh/pull/457) |
| [T-0202. Флак выгрузки — ENOENT во временном каталоге, потоки не закрываются при ошибке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0202-export-test-enoent-flake.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#423](https://github.com/JJSGxKD/rubezh/pull/423) |
| [T-0201. Фильтр ников — латинские имена не ловятся корнем после транслитерации](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0201-display-name-latin-names.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#425](https://github.com/JJSGxKD/rubezh/pull/425) |
| [T-0200. Панель за CDN Bunny — Caddy, тесты и документы; зона и DNS ставит тимлид](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0200-admin-behind-cdn.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#415](https://github.com/JJSGxKD/rubezh/pull/415) |
| [T-0188. «Что нового» скрыт у игроков до пересмотра журнала](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0188-hide-changelog-for-players.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#408](https://github.com/JJSGxKD/rubezh/pull/408) |
| [T-0187. Строки свойств предмета — значение не переносится, прибавка видна и при малом шаге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0187-item-stat-rows-narrow.md) | @Ferdinans228 · claude-16 / haiku-5.5 / medium | [#416](https://github.com/JJSGxKD/rubezh/pull/416) |
| [T-0186. Итоги забега — все кнопки видны без прокрутки, прокрутка одна](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0186-death-screen-pinned-actions.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#406](https://github.com/JJSGxKD/rubezh/pull/406) |
| [T-0185. Модалки и листы — поверх шапки и нижней панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0185-modal-layer-above-chrome.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#405](https://github.com/JJSGxKD/rubezh/pull/405) |
| [T-0184. Политика источников пускает сборки Яндекса и стили RichAds — вторая волна цепочек рекламы](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0184-csp-ad-chains-yandex-richads-styles.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#404](https://github.com/JJSGxKD/rubezh/pull/404) |
| [T-0179. Авторазбор стартовых параметров ключ-значение — автоисточники и сводка незнакомых ключей](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0179-start-param-pairs-auto-sources.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#432](https://github.com/JJSGxKD/rubezh/pull/432) |
| [T-0173. Положение радара в настройках игрока — справа сверху, слева сверху, выключен](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0173-radar-position-setting.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#409](https://github.com/JJSGxKD/rubezh/pull/409) |
| [T-0171. Страж кольца и кольца в таймлайне — контент, гайдбук, калибровка](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0171-cordon-guard-content.md) | @Ferdinans228 · claude-13 / sonnet-5.5 / high | [#445](https://github.com/JJSGxKD/rubezh/pull/445) |
| [T-0170. Кольцо стражей — движок: событие таймлайна, паттерн строя, непроходимое тело](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0170-cordon-ring-engine.md) | @Ferdinans228 · claude-13 / sonnet-5.5 / high | [#442](https://github.com/JJSGxKD/rubezh/pull/442) |
| [T-0166. Узкие экраны: время в плитке награды, имя в заявке в друзья, срез в витрине](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0166-narrow-screen-leftovers.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#407](https://github.com/JJSGxKD/rubezh/pull/407) |
| [T-0165. Гард панели экспортирует AdminModule, счётчик онлайна — один сервис](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0165-panel-guard-export-single-online-service.md) | @Kennix88 · claude-1 / sonnet-5.5 / high | [#411](https://github.com/JJSGxKD/rubezh/pull/411) |
| [T-0164. Тесты «61-й запрос — 429» не падают на смене минуты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0164-readiness-test-fixed-clock.md) | @Ferdinans228 · claude-15 / haiku-5.5 / low | [#403](https://github.com/JJSGxKD/rubezh/pull/403) |
| [T-0163. Забег, прерванный обновлением игры, засчитывается, а не пропадает](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0163-settle-run-interrupted-by-update.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#396](https://github.com/JJSGxKD/rubezh/pull/396) |
| [T-0162. Юзернейм бота в имени и bio — модуль на сервере: проверка, награда, серия, ночной проход](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0162-bot-mention-module.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#433](https://github.com/JJSGxKD/rubezh/pull/433) |
| [T-0160. Задания «юзернейм бота в имени и в bio» — блок на экране заданий и события](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0160-bot-mention-client.md) | @Ferdinans228 · claude-13 / sonnet-5.5 / high | [#443](https://github.com/JJSGxKD/rubezh/pull/443) |
| [T-0159. Юзернейм бота в имени и bio — порт площадки BotMentions и getChat у Telegram](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0159-bot-mention-server.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#400](https://github.com/JJSGxKD/rubezh/pull/400) |
| [T-0157. Донаты проекту — сервер: оплата любой суммой, выдача знака, ключи панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0157-donations-backend.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#430](https://github.com/JJSGxKD/rubezh/pull/430) |
| [T-0155. Отчёты политики источников — директива в политике и приём со сводкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0155-csp-reports-intake.md) | @Kennix88 · claude-1 / sonnet-5.5 / high | [#419](https://github.com/JJSGxKD/rubezh/pull/419) |
| [T-0154. Политика источников пускает цепочки SDK рекламы и Google Fonts](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0154-csp-ad-sdk-chains.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#393](https://github.com/JJSGxKD/rubezh/pull/393) |
| [T-0153. Ники без ссылок и упоминаний, словарь мата точнее](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0153-display-name-links-and-roots.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#399](https://github.com/JJSGxKD/rubezh/pull/399) |
| [T-0152. Бот калибровки с задержкой реакции и ограниченным вниманием](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0152-imperfect-balance-bot.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#382](https://github.com/JJSGxKD/rubezh/pull/382) |
| [T-0150. Ник чистится при входе — исходник для панели, закрепление, чистка старых](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0150-display-name-on-login.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#412](https://github.com/JJSGxKD/rubezh/pull/412) |
| [T-0149. Чистка ников — символы, длина, мат, замена пустого](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0149-display-name-cleaning.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#360](https://github.com/JJSGxKD/rubezh/pull/360) |
| [T-0147. Счётчик онлайна — бэкенд: активность, пинг, подсчёт, ключи настроек](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0147-online-counter-backend.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#375](https://github.com/JJSGxKD/rubezh/pull/375) |
| [T-0146. «pnpm task check» сверяет метку и заголовок из раздела «PR» с шапкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0146-task-check-pr-section.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#350](https://github.com/JJSGxKD/rubezh/pull/350) |
| [T-0143. Проверка PR — номер в сводке, путь задачи, сводка не в коде, трейлеры коммитов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0143-pr-check-summary-task-trailers.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#362](https://github.com/JJSGxKD/rubezh/pull/362) |
| [T-0142. Бюджет экранов — порог на самый большой экран, сумма — предупреждением](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0142-budget-largest-screen-chunk.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#361](https://github.com/JJSGxKD/rubezh/pull/361) |
| [T-0141. Хост Referer без порта — проверки доступности отсекаются и с портом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0141-referer-host-without-port.md) | @Kennix88 · claude-1 / haiku-5.5 / medium | [#422](https://github.com/JJSGxKD/rubezh/pull/422) |
| [T-0140. Две подписки VIP одновременно — продление остаётся у одной](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0140-vip-double-subscription-tie.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#417](https://github.com/JJSGxKD/rubezh/pull/417) |
| [T-0139. Полный прогон интеграционных тестов проходит и на Windows](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0139-integration-tests-on-windows.md) | @Kennix88 · claude-1 / sonnet-5.5 / medium | [#413](https://github.com/JJSGxKD/rubezh/pull/413) |
| [T-0138. Меню панели на телефоне открывается прокрученным к открытому разделу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0138-admin-menu-scroll-on-open.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#349](https://github.com/JJSGxKD/rubezh/pull/349) |
| [T-0137. Индекс досмотров по времени завершения — для ряда сводки панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0137-ad-session-completed-index.md) | @Kennix88 · claude-1 / sonnet-5.5 / medium | [#421](https://github.com/JJSGxKD/rubezh/pull/421) |
| [T-0136. Подсказки к параметрам снаряжения — что значит каждый](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0136-stat-hints.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#372](https://github.com/JJSGxKD/rubezh/pull/372) |
| [T-0135. Карточка предмета — «было → станет» перед улучшением](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0135-item-upgrade-preview.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#364](https://github.com/JJSGxKD/rubezh/pull/364) |
| [T-0134. Счёт за второй шанс проверяет ограничение «Покупки»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0134-continue-invoice-purchases-restriction.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#363](https://github.com/JJSGxKD/rubezh/pull/363) |
| [T-0132. Дата начала сезонов не в прошлом — проверка при сохранении и потолок догона](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0132-season-start-date-guard.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#358](https://github.com/JJSGxKD/rubezh/pull/358) |
| [T-0118. Седьмое оружие «Метеор» и его эволюция «Огненный ливень»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0118-seventh-weapon-meteor-and-evolution.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#444](https://github.com/JJSGxKD/rubezh/pull/444) |
| [T-0117. Враги в духе Vampire Survivors: два рядовых и элита](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0117-vampire-survivors-enemies.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#379](https://github.com/JJSGxKD/rubezh/pull/379) |
| [T-0110. Недельный сезон рейтинга — сервер: таблица недели, закрытие, награды, друзья](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0110-weekly-season-server.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#327](https://github.com/JJSGxKD/rubezh/pull/327) |
| [T-0109. Экран смерти — блок «Что дальше» с двумя-тремя ближайшими целями](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0109-death-whats-next.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#359](https://github.com/JJSGxKD/rubezh/pull/359) |
| [T-0108. Лестница открытий — оружие и навыки по уровням 2–14, а не все к шестому](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0108-unlock-ladder.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#348](https://github.com/JJSGxKD/rubezh/pull/348) |
| [T-0104. Задания: пул с ротацией по дням и недели и шесть новых видов цели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0104-tasks-pool-rotation-new-kinds.md) | @Kennix88 · claude-1 / sonnet-5.5 / high | [#325](https://github.com/JJSGxKD/rubezh/pull/325) |
| [T-0103. Рецепты эволюций в игре: подсказка на карточке, гайдбук, значок готовности](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0103-weapon-evolution-recipes-in-game.md) | @Ferdinans228 · claude-12 / sonnet-5.5 / medium | [#441](https://github.com/JJSGxKD/rubezh/pull/441) |
| [T-0102. Эволюции оружия: рецепты в контенте и выдача сундуком](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0102-weapon-evolutions-data-and-engine.md) | @Ferdinans228 · claude-13 / sonnet-5.5 / high | [#436](https://github.com/JJSGxKD/rubezh/pull/436) |
| [T-0101. Переброс, пропуск и изгнание карточек на выборе улучшения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0101-card-reroll-skip-banish.md) | @Kennix88 · claude-13 / sonnet-5.5 / high | [#397](https://github.com/JJSGxKD/rubezh/pull/397) |
| [T-0100. Сундук забега: окно открытия с «барабаном» и списком полученного](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0100-run-chest-window.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#378](https://github.com/JJSGxKD/rubezh/pull/378) |
| [T-0099. Сундук забега: падает с элиты и босса, открывает 1, 3 или 5 улучшений](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0099-run-chest-engine.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#366](https://github.com/JJSGxKD/rubezh/pull/366) |
| [T-0098. «Задания» открываются на вкладке, где ждёт награда](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0098-tasks-open-claimable-tab.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#371](https://github.com/JJSGxKD/rubezh/pull/371) |
| [T-0097. Радар забега — наверх, аптечки на нём зелёные](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0097-radar-top-green-medkit.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#351](https://github.com/JJSGxKD/rubezh/pull/351) |
| [T-0096. Убрать тень под врагами](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0096-enemy-no-shadow.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#316](https://github.com/JJSGxKD/rubezh/pull/316) |
| [T-0095. «Очаг» не звучит на каждый такт ауры](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0095-hearth-no-tick-sound.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#310](https://github.com/JJSGxKD/rubezh/pull/310) |
| [T-0094. Лист «Перед забегом»: отмеченная плитка справа не даёт боковой прокрутки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0094-prerun-no-sideways-scroll.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#315](https://github.com/JJSGxKD/rubezh/pull/315) |
| [T-0092. Пакет proxy-kit — разбор подписки Xray, конфиг спутника, пул узлов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0092-proxy-kit-package.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#370](https://github.com/JJSGxKD/rubezh/pull/370) |
| [T-0091. Ссылки Telegram собираются в одном месте — подготовка к смене домена](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0091-telegram-link-single-point.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#355](https://github.com/JJSGxKD/rubezh/pull/355) |
| [T-0090. QR входа на https, домен ссылок Telegram — настройкой в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0090-telegram-link-host-and-qr-https.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#373](https://github.com/JJSGxKD/rubezh/pull/373) |
| [T-0088. Внешняя проверка прода без ложных тревог и без записи развёртывания на каждый прогон](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0088-uptime-no-false-alarms-no-deployments.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#356](https://github.com/JJSGxKD/rubezh/pull/356) |
| [T-0087. Карточка разбора забега ведёт в панель, а комментарии о маршруте и боте говорят правду](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0087-stale-route-and-bot-texts.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#312](https://github.com/JJSGxKD/rubezh/pull/312) |
| [T-0086. Два теста охраны проверяют то, что обещают: публичность готовности и тревогу 5xx в полной сборке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0086-guard-tests-readiness-and-alarm.md) | @Kennix88 · claude-1 / haiku-5.5 / medium | [#326](https://github.com/JJSGxKD/rubezh/pull/326) |
| [T-0085. Первый выкат на чистый сервер проходит без --no-backup](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0085-first-deploy-clean-server.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#367](https://github.com/JJSGxKD/rubezh/pull/367) |
| [T-0084. Тесный `SegmentedControl`: подписи сжимаются на узком экране, без обёрток снаружи](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0084-segmented-small.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#352](https://github.com/JJSGxKD/rubezh/pull/352) |
| [T-0083. `Modal`: закреплённый подвал при прокручиваемом теле](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0083-modal-pinned-footer.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#388](https://github.com/JJSGxKD/rubezh/pull/388) |
| [T-0082. Список игроков — пустой «Статус» не остаётся подписью без значения в карточке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0082-players-list-empty-status.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#314](https://github.com/JJSGxKD/rubezh/pull/314) |
| [T-0081. Друзья — на узком экране кнопки заявки и «Подарить» значками, имя читается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0081-friends-narrow-peer-actions.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#354](https://github.com/JJSGxKD/rubezh/pull/354) |
| [T-0080. Колесо — на кнопке бесплатной крутки загрузка идёт до остановки колеса](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0080-wheel-free-button-loading-until-stop.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#313](https://github.com/JJSGxKD/rubezh/pull/313) |
| [T-0079. Второй шанс — ролик главной кнопкой, звёзды второй, как в макете](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0079-death-ad-primary-button.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#319](https://github.com/JJSGxKD/rubezh/pull/319) |
| [T-0078. Событие continue_offered уходит после ответа проверок, а не при открытии шага](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0078-continue-offered-after-answers.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#296](https://github.com/JJSGxKD/rubezh/pull/296) |
| [T-0077. «Повторить» на плашке связи отвечает, даже если код проверки не загрузился](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0077-connection-retry-chunk-failure.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#298](https://github.com/JJSGxKD/rubezh/pull/298) |
| [T-0076. «Друзья»: крупное приглашение не мелькает, пока экран грузится](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0076-friends-no-invite-flash.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#318](https://github.com/JJSGxKD/rubezh/pull/318) |
| [T-0075. Награда дня сама обновляется на смене суток по Москве](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0075-daily-reload-on-midnight.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#317](https://github.com/JJSGxKD/rubezh/pull/317) |
| [T-0074. Тест лимита приёмника событий не зависит от границы минуты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0074-events-limit-test-clock.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#311](https://github.com/JJSGxKD/rubezh/pull/311) |
| [T-0073. Проверки доступности не считаются кликами; клики без класса устройства — отдельной строкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0073-availability-checks-not-clicks.md) | @Kennix88 · claude-1 / sonnet-5.5 / high | [#328](https://github.com/JJSGxKD/rubezh/pull/328) |
| [T-0069. Постбэки — слой «событие → назначение», AdsGram первым назначением](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0069-postback-destinations-layer.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#439](https://github.com/JJSGxKD/rubezh/pull/439) |
| [T-0067. Ссылки партнёра — ссылка кампании с владельцем-партнёром, привязка игрока по первому входу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0067-partner-links-and-binding.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#429](https://github.com/JJSGxKD/rubezh/pull/429) |
| [T-0066. Карточка партнёра — TG id, статус, страна, валюта и способ выплаты, процент](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0066-partner-card-fields-and-status.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#299](https://github.com/JJSGxKD/rubezh/pull/299) |
| [T-0063. CoinMarketCap — новый источник курсов; необязательные ключи tonapi и erapi](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0063-coinmarketcap-and-optional-keys.md) | @Ferdinans228 · claude-13 / sonnet-5.5 / high | [#437](https://github.com/JJSGxKD/rubezh/pull/437) |
| [T-0062. Лимиты источников курсов в панели — сколько осталось, правка лимита и счётчика, предупреждения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0062-fx-source-limits-panel.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#428](https://github.com/JJSGxKD/rubezh/pull/428) |
| [T-0061. Раздел «Запросы» в панели — исходящие вызовы и сводка входящих](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0061-requests-panel-section.md) | @Ferdinans228 · claude-13 / sonnet-5.5 / high | [#427](https://github.com/JJSGxKD/rubezh/pull/427) |
| [T-0060. Журнал запросов — исходящие по вызову, входящие сводкой по маршрутам, 7 дней](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0060-request-journal-storage.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#424](https://github.com/JJSGxKD/rubezh/pull/424) |
| [T-0059. Один клиент исходящих запросов — все вызовы внешних API через него](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0059-outbound-http-client.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#374](https://github.com/JJSGxKD/rubezh/pull/374) |
| [T-0058. Переходник ссылок открывает Telegram диплинком — с запасным t.me](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0058-redirect-deeplink-page.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#369](https://github.com/JJSGxKD/rubezh/pull/369) |
| [T-0057. Цель ссылки и прямые ссылки — Mini App, бот или лендинг, с переходником и без](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0057-link-target-and-direct-links.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#288](https://github.com/JJSGxKD/rubezh/pull/288) |
| [T-0056. Вход в панель по QR и диплинку — запрос со страницей, без лишнего перехода](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0056-panel-login-qr-deeplink.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#285](https://github.com/JJSGxKD/rubezh/pull/285) |
| [T-0055. Выключатели внешних скриптов клиента в панели — Graspil, учёт аудитории, всё сразу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0055-external-scripts-switches.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#297](https://github.com/JJSGxKD/rubezh/pull/297) |
| [T-0051. Сводка панели — реклама, периоды 7 и 30 дней, покупки в ряду — сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0051-overview-ads-and-periods-api.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#284](https://github.com/JJSGxKD/rubezh/pull/284) |
| [T-0050. Подтверждения в панели по цене ошибки — окно действия и «Отменить»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0050-admin-confirm-and-undo.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#365](https://github.com/JJSGxKD/rubezh/pull/365) |
| [T-0049. Каркас панели — меню со значками и поиском, телефон, таблицы карточками](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0049-admin-shell-responsive.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#286](https://github.com/JJSGxKD/rubezh/pull/286) |
| [T-0048. Экран друзей — список первым, полоса бонуса и «Подарить всем»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0048-friends-screen-layout.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#268](https://github.com/JJSGxKD/rubezh/pull/268) |
| [T-0047. «Подарить всем» — подарок каждому другу одним запросом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0047-gift-all-friends-api.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#255](https://github.com/JJSGxKD/rubezh/pull/255) |
| [T-0046. Магазин в облике «Сумеречный рубеж» — по макету](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0046-shop-twilight-look.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#389](https://github.com/JJSGxKD/rubezh/pull/389) |
| [T-0045. Экран смерти в два шага — сначала второй шанс, потом итоги](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0045-death-screen-two-steps.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#254](https://github.com/JJSGxKD/rubezh/pull/254) |
| [T-0044. «Перед забегом» одним листом — два касания до боя вместо четырёх](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0044-pre-run-sheet.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#253](https://github.com/JJSGxKD/rubezh/pull/253) |
| [T-0043. Окно «Спасибо за тест» и знак «Тестер» в профиле, у друзей и в рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0043-thanks-for-testing-window.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#368](https://github.com/JJSGxKD/rubezh/pull/368) |
| [T-0042. Компенсация после вайпа — выдача по кнопке и признак «Тестер» в ответах](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0042-compensation-claim-and-tester-flag.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#308](https://github.com/JJSGxKD/rubezh/pull/308) |
| [T-0041. Команда вайпа — подсчёт, снимок и стирание одной транзакцией](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0041-wipe-command.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#273](https://github.com/JJSGxKD/rubezh/pull/273) |
| [T-0040. Снимок перед вайпом — что вернуть тестеру и какой бонус дать](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0040-tester-compensation-snapshot.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#270](https://github.com/JJSGxKD/rubezh/pull/270) |
| [T-0039. План вайпа — у каждой таблицы решение «стираем» или «оставляем»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0039-wipe-plan.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#244](https://github.com/JJSGxKD/rubezh/pull/244) |
| [T-0037. Поддержка возвращает звёзды и повторяет выдачу покупки — сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0037-support-refund-and-refulfill-api.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#301](https://github.com/JJSGxKD/rubezh/pull/301) |
| [T-0036. Свежий бэкап базы перед каждым выкатом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0036-backup-before-deploy.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#247](https://github.com/JJSGxKD/rubezh/pull/247) |
| [T-0035. Тревога в чат команды о всплеске ошибок 5xx](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0035-server-error-alarm.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#260](https://github.com/JJSGxKD/rubezh/pull/260) |
| [T-0034. Внешняя проверка прода раз в 5 минут и тревога в чат команды](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0034-uptime-check.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#259](https://github.com/JJSGxKD/rubezh/pull/259) |
| [T-0033. Проверка готовности API — /health/ready смотрит базу и Redis](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0033-health-ready.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#238](https://github.com/JJSGxKD/rubezh/pull/238) |
| [T-0032. Роли владельца и администратора выдаются только с подтверждением в Telegram](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0032-confirm-privileged-roles-in-telegram.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#265](https://github.com/JJSGxKD/rubezh/pull/265) |
| [T-0031. API панели отвечает только на домене панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0031-admin-api-only-on-admin-domain.md) | @Kennix88 · claude-4 / sonnet-5.5 | [#239](https://github.com/JJSGxKD/rubezh/pull/239) |
| [T-0030. Отзыв без подписи запуска — строже лимит и потолок карточек в чат](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0030-unsigned-feedback-limits.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#241](https://github.com/JJSGxKD/rubezh/pull/241) |
| [T-0029. Досмотр рекламы через SDK засчитывается не раньше порога из панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0029-ad-min-view-time.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#252](https://github.com/JJSGxKD/rubezh/pull/252) |
| [T-0028. Награда за друга не теряется, если начисление упало](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0028-referral-reward-not-lost.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#251](https://github.com/JJSGxKD/rubezh/pull/251) |
| [T-0027. Обновления бота не теряются при перезапуске — сначала очередь, потом ответ](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0027-bot-updates-via-queue.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#261](https://github.com/JJSGxKD/rubezh/pull/261) |
| [T-0025. Вторая подписка VIP не оплачивается и не продлевается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0025-vip-no-double-subscription.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#258](https://github.com/JJSGxKD/rubezh/pull/258) |
| [T-0024. После возврата звёзд покупки аккаунту закрыты, команда получает карточку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0024-refund-closes-purchases.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#275](https://github.com/JJSGxKD/rubezh/pull/275) |
| [T-0023. Возврат звёзд забирает то, что осталось от покупки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0023-refund-revokes-remainder.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#269](https://github.com/JJSGxKD/rubezh/pull/269) |
| [T-0022. Лимиты частоты на маршрутах игрока, где их не было](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0022-rate-limits-on-open-routes.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#263](https://github.com/JJSGxKD/rubezh/pull/263) |
| [T-0021. Маршруты с правами — только в панели, дубли под токеном игры убраны](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0021-remove-duplicate-privileged-routes.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#240](https://github.com/JJSGxKD/rubezh/pull/240) |
| [T-0020. Бот говорит «идёт тест» и отвечает на обычное сообщение](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0020-bot-texts-and-reply.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#248](https://github.com/JJSGxKD/rubezh/pull/248) |
| [T-0019. Бот больше не пишет о каждой новой версии](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0019-no-bot-version-message.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#242](https://github.com/JJSGxKD/rubezh/pull/242) |
| [T-0018. Статусы задач в эпиках, страница доски и вклад по аккаунтам GitHub](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0018-board-page-and-epic-badges.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#217](https://github.com/JJSGxKD/rubezh/pull/217) |
| [T-0017. Подписи у всех вкладок нижней панели, если помещаются](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0017-tab-labels-when-fit.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#246](https://github.com/JJSGxKD/rubezh/pull/246) |
| [T-0016. Пересчёт значков не отменяется пустыми прогонами](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0016-task-board-concurrency.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#216](https://github.com/JJSGxKD/rubezh/pull/216) |
| [T-0015. Общая плашка «Нет связи с сервером»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0015-connection-banner.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#267](https://github.com/JJSGxKD/rubezh/pull/267) |
| [T-0014. Вид боя — красная гамма по угрозе, тени и новые цвета мира](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0014-battle-look-threat-colors.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#224](https://github.com/JJSGxKD/rubezh/pull/224) |
| [T-0013. Срезанный угол с рамкой по срезу у главного на экране](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0013-cut-corners.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#385](https://github.com/JJSGxKD/rubezh/pull/385) |
| [T-0012. Палитра, шрифты и скругления направления «Сумеречный рубеж»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0012-twilight-tokens-and-fonts.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#218](https://github.com/JJSGxKD/rubezh/pull/218) |
| [T-0011. Живые значки статуса задач и проверка захвата в CI](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0011-task-board-badges.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#213](https://github.com/JJSGxKD/rubezh/pull/213) |
| [T-0010. Разрешение боту писать — после первого забега и в настройках](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0010-bot-write-access.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#353](https://github.com/JJSGxKD/rubezh/pull/353) |
| [T-0009. Выход везде и блокировка сразу закрывают выданные токены доступа](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0009-revoke-access-tokens.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#249](https://github.com/JJSGxKD/rubezh/pull/249) |
| [T-0008. Свечение кнопок и значков — позади, а не поверх](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0008-glow-behind-not-over.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#295](https://github.com/JJSGxKD/rubezh/pull/295) |
| [T-0007. Точные и тикающие отсчёты «через сколько» на главной и в награде дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0007-countdown-precision.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#245](https://github.com/JJSGxKD/rubezh/pull/245) |
| [T-0006. Кнопка бесплатной крутки не оживает во время крутки за рекламу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0006-wheel-free-button-during-ad.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#243](https://github.com/JJSGxKD/rubezh/pull/243) |
| [T-0005. Обереги и снаряды рисуются так, как бьёт симуляция](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0005-orbiters-and-projectiles-render.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#222](https://github.com/JJSGxKD/rubezh/pull/222) |
| [T-0004. Внешние возвраты через очередь и сигнал о брошенном задании](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0004-payments-refunds-via-queue.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#250](https://github.com/JJSGxKD/rubezh/pull/250) |
| [T-0003. Оплаченное всегда выдаётся или возвращается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0003-payments-fulfillment-sweeper.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#228](https://github.com/JJSGxKD/rubezh/pull/228) |
| [T-0002. Команда pnpm task — доска, захват и проверка зон](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0002-task-cli.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#211](https://github.com/JJSGxKD/rubezh/pull/211) |
| [T-0001. Наборы магазина только из самоцветов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0001-shop-gems-only-bundles.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#205](https://github.com/JJSGxKD/rubezh/pull/205) |

## Вклад

Очки — сумма размеров сделанных задач: S — 1, M — 2. Это наглядность, а не формула выплат: доли участников — `docs/11-revenue-split.md`.

| GitHub | Задач | Очков | Последний мердж |
|---|---|---|---|
| [@Kennix88](https://github.com/Kennix88) | 116 | 172 | 21.10.2026 |
| [@Ferdinans228](https://github.com/Ferdinans228) | 23 | 32 | 24.10.2026 |

| GitHub | Исполнитель | Задач | Очков |
|---|---|---|---|
| @Kennix88 | claude-5 / sonnet-5.5 / high | 20 | 37 |
| @Kennix88 | claude-3 / sonnet-5.5 / medium | 20 | 23 |
| @Kennix88 | claude-5 / sonnet-5.5 | 13 | 19 |
| @Kennix88 | claude-1 / sonnet-5.5 / extra | 10 | 19 |
| @Kennix88 | claude-2 / sonnet-5.5 | 9 | 15 |
| @Kennix88 | claude-6 / sonnet-5.5 | 6 | 11 |
| @Kennix88 | claude-3 / sonnet-5.5 | 9 | 10 |
| @Kennix88 | claude-6 / sonnet-5.5 / extra | 5 | 10 |
| @Kennix88 | claude-7 / haiku-5.5 / medium | 8 | 8 |
| @Kennix88 | claude-1 / sonnet-5.5 / high | 4 | 7 |
| @Kennix88 | claude-9 / haiku-5.5 / low | 6 | 6 |
| @Kennix88 | claude-1 / haiku-5.5 / medium | 2 | 2 |
| @Kennix88 | claude-1 / sonnet-5.5 / medium | 2 | 2 |
| @Kennix88 | claude-13 / sonnet-5.5 / high | 1 | 2 |
| @Kennix88 | claude-4 / sonnet-5.5 | 1 | 1 |
| @Ferdinans228 | claude-12 / sonnet-5.5 / medium | 13 | 16 |
| @Ferdinans228 | claude-13 / sonnet-5.5 / high | 7 | 13 |
| @Ferdinans228 | claude-16 / haiku-5.5 / medium | 2 | 2 |
| @Ferdinans228 | claude-15 / haiku-5.5 / low | 1 | 1 |
