# Доска задач

Обновлено 17.10.2026 13:44 UTC. Страницу пересчитывает workflow `task-board.yml` после захвата, PR и мерджа — руками не править. Как брать задачу — [tasks/README.md](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/README.md#как-взять-задачу).

## Потоки сейчас

Какие потоки запускать в автопоток (`tasks/README.md`, «Автопоток»): доработка раньше новых задач, п.N — пачка выпуска. Строка `local` — задачи только для потоков на машине разработчика. То же даёт `pnpm task streams`.

### Запускать сейчас

| Поток | Свободно | Доработка | Ближайшие задачи |
|---|---|---|---|
| sonnet-5.5 / medium | 0 | 2 | [T-0097](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0097-radar-top-green-medkit.md) (п.1), [T-0132](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0132-season-start-date-guard.md) (п.2) |
| sonnet-5.5 / medium · local | 2 | 0 | [T-0139](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0139-integration-tests-on-windows.md) (п.2), [T-0137](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0137-ad-session-completed-index.md) (п.2) |
| sonnet-5.5 / high | 0 | 3 | [T-0099](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0099-run-chest-engine.md) (п.1), [T-0109](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0109-death-whats-next.md) (п.1), [T-0043](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0043-thanks-for-testing-window.md) (п.3) |
| sonnet-5.5 / extra · local | 3 | 0 | [T-0150](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0150-display-name-on-login.md) (п.2), [T-0140](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0140-vip-double-subscription-tie.md) (п.2), [T-0067](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0067-partner-links-and-binding.md) (п.3) |
| haiku-5.5 / medium | 0 | 1 | [T-0146](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0146-task-check-pr-section.md) (п.2) |
| haiku-5.5 / medium · local | 1 | 0 | [T-0141](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0141-referer-host-without-port.md) (п.2) |

### На очереди

| Поток | Ждут | Ближайшая пачка |
|---|---|---|
| sonnet-5.5 / medium | 8 | 2 |
| sonnet-5.5 / medium · local | 1 | 2 |
| sonnet-5.5 / high | 18 | 1 |
| sonnet-5.5 / high · local | 11 | 1 |
| sonnet-5.5 / extra · local | 12 | 1 |
| haiku-5.5 / low | 1 | 2 |

## Доработка — 6

| Задача | Исполнитель | PR | Вёл |
|---|---|---|---|
| [T-0099. Сундук забега: падает с элиты и босса, открывает 1, 3 или 5 улучшений](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0099-run-chest-engine.md) | sonnet-5.5 · high | [#366](https://github.com/JJSGxKD/rubezh/pull/366) | claude-5 / sonnet-5.5 / high |
| [T-0109. Экран смерти — блок «Что дальше» с двумя-тремя ближайшими целями](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0109-death-whats-next.md) | sonnet-5.5 · high | [#359](https://github.com/JJSGxKD/rubezh/pull/359) | claude-5 / sonnet-5.5 / high |
| [T-0097. Радар забега — наверх, аптечки на нём зелёные](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0097-radar-top-green-medkit.md) | sonnet-5.5 · medium | [#351](https://github.com/JJSGxKD/rubezh/pull/351) | claude-3 / sonnet-5.5 / medium |
| [T-0132. Дата начала сезонов не в прошлом — проверка при сохранении и потолок догона](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0132-season-start-date-guard.md) | sonnet-5.5 · medium | [#358](https://github.com/JJSGxKD/rubezh/pull/358) | claude-3 / sonnet-5.5 / medium |
| [T-0146. «pnpm task check» сверяет метку и заголовок из раздела «PR» с шапкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0146-task-check-pr-section.md) | haiku-5.5 · medium | [#350](https://github.com/JJSGxKD/rubezh/pull/350) | claude-7 / haiku-5.5 / medium |
| [T-0043. Окно «Спасибо за тест» и знак «Тестер» в профиле, у друзей и в рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0043-thanks-for-testing-window.md) | sonnet-5.5 · high | [#368](https://github.com/JJSGxKD/rubezh/pull/368) | claude-5 / sonnet-5.5 / high |

## Можно брать — 6

| Задача | Приоритет | Размер | Исполнитель | Эпик |
|---|---|---|---|---|
| [T-0150. Ник чистится при входе — исходник для панели, закрепление, чистка старых](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0150-display-name-on-login.md) | P1 | M | sonnet-5.5 · extra | E4 |
| [T-0139. Полный прогон интеграционных тестов проходит и на Windows](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0139-integration-tests-on-windows.md) | P2 | S | sonnet-5.5 · medium | E0 |
| [T-0140. Две подписки VIP одновременно — продление остаётся у одной](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0140-vip-double-subscription-tie.md) | P2 | S | sonnet-5.5 · extra | E1 |
| [T-0137. Индекс досмотров по времени завершения — для ряда сводки панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0137-ad-session-completed-index.md) | P3 | S | sonnet-5.5 · medium | E4 |
| [T-0141. Хост Referer без порта — проверки доступности отсекаются и с портом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0141-referer-host-without-port.md) | P3 | S | haiku-5.5 · medium | E14 |
| [T-0067. Ссылки партнёра — ссылка кампании с владельцем-партнёром, привязка игрока по первому входу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0067-partner-links-and-binding.md) | P1 | M | sonnet-5.5 · extra | E14 |

## В работе — 6

| Задача | Взял |
|---|---|
| [T-0010. Разрешение боту писать — после первого забега и в настройках](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0010-bot-write-access.md) | claude-5 / sonnet-5.5 / high |
| [T-0090. QR входа на https, домен ссылок Telegram — настройкой в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0090-telegram-link-host-and-qr-https.md) | claude-5 / sonnet-5.5 / high |
| [T-0112. Скрытое ограничение «Отдельная доска»: вид, право, панель](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0112-separate-board-restriction.md) | неизвестно |
| [T-0059. Один клиент исходящих запросов — все вызовы внешних API через него](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0059-outbound-http-client.md) | claude-5 / sonnet-5.5 / high |
| [T-0134. Счёт за второй шанс проверяет ограничение «Покупки»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0134-continue-invoice-purchases-restriction.md) | claude-3 / sonnet-5.5 / medium |
| [T-0147. Счётчик онлайна — бэкенд: активность, пинг, подсчёт, ключи настроек](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0147-online-counter-backend.md) | claude-5 / sonnet-5.5 / high |

## На ревью — 0

Пусто.

## Ждут — 51

| Задача | Чего ждёт |
|---|---|
| [T-0100. Сундук забега: окно открытия с «барабаном» и списком полученного](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0100-run-chest-window.md) | ждёт T-0099; ждёт T-0097; зоны пересекаются с T-0097 (на доработке); зоны пересекаются с T-0099 (на доработке) |
| [T-0105. Очки заданий: полоса дня и недели и награды за ступени очков](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0105-task-points-and-rewards.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0106. Достижения с престижем: сервер, 49 определений, редкость «есть у N%»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0106-achievements-prestige-server.md) | ждёт T-0105; зоны пересекаются с T-0112 (в работе) |
| [T-0107. Витрина достижений: категории, редкость, любимые и престиж в профиле и рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0107-achievements-showcase-shell.md) | ждёт T-0106; зоны пересекаются с T-0043 (на доработке) |
| [T-0038. Кнопки «Выдать» и «Вернуть звёзды» у покупки в карточке игрока](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0038-support-purchase-actions-panel.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0101. Переброс, пропуск и изгнание карточек на выборе улучшения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0101-card-reroll-skip-banish.md) | ждёт T-0099; зоны пересекаются с T-0099 (на доработке) |
| [T-0102. Эволюции оружия: рецепты в контенте и выдача сундуком](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0102-weapon-evolutions-data-and-engine.md) | ждёт T-0099; ждёт T-0101; зоны пересекаются с T-0010 (в работе); зоны пересекаются с T-0134 (в работе); зоны пересекаются с T-0043 (на доработке); зоны пересекаются с T-0097 (на доработке); зоны пересекаются с T-0099 (на доработке); зоны пересекаются с T-0109 (на доработке) |
| [T-0103. Рецепты эволюций в игре: подсказка на карточке, гайдбук, значок готовности](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0103-weapon-evolution-recipes-in-game.md) | ждёт T-0102; ждёт T-0100; зоны пересекаются с T-0010 (в работе); зоны пересекаются с T-0134 (в работе); зоны пересекаются с T-0043 (на доработке); зоны пересекаются с T-0097 (на доработке); зоны пересекаются с T-0109 (на доработке) |
| [T-0116. Подбор «Заморозка»: враги на поле замирают на 10 секунд](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0116-freeze-pickup.md) | ждёт T-0099; зоны пересекаются с T-0097 (на доработке); зоны пересекаются с T-0099 (на доработке) |
| [T-0117. Враги в духе Vampire Survivors: без стрелка, два рядовых и элита](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0117-vampire-survivors-enemies.md) | ждёт T-0099; зоны пересекаются с T-0099 (на доработке) |
| [T-0118. Седьмое оружие «Метеор» и его эволюция «Огненный ливень»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0118-seventh-weapon-meteor-and-evolution.md) | ждёт T-0102; зоны пересекаются с T-0099 (на доработке) |
| [T-0111. Недельный сезон — экран рейтинга: вкладки «Неделя», «Всё время», «Друзья», награды и таймер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0111-weekly-season-screen.md) | ждёт T-0107; зоны пересекаются с T-0043 (на доработке) |
| [T-0113. Доски рейтинга по зрителю: полная и общая, место и профиль по доске смотрящего](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0113-boards-by-viewer.md) | ждёт T-0112; зоны пересекаются с T-0112 (в работе) |
| [T-0114. Сезон и награды за места по доске зрителя, призы только внутриигровые](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0114-season-rewards-by-viewer-board.md) | ждёт T-0113; зоны пересекаются с T-0132 (на доработке) |
| [T-0125. Итог забега: счётчики боссов, элит, сундуков и кристаллов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0125-run-result-rank-chest-crystal-counters.md) | ждёт T-0099; зоны пересекаются с T-0099 (на доработке) |
| [T-0126. Задания и достижения: боссы, элиты, сундуки, кристаллы, эволюции](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0126-tasks-kinds-bosses-elites-chests-evolutions.md) | ждёт T-0125; ждёт T-0106; ждёт T-0102; зоны пересекаются с T-0112 (в работе) |
| [T-0052. Сводка панели — плитка и панель рекламы, вехи полосами, периоды — экран](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0052-overview-ads-and-periods-screen.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0145. Снимки экранов одной командой — `pnpm screens`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0145-screens-one-command.md) | ждёт T-0144; зоны пересекаются с T-0043 (на доработке) |
| [T-0083. `Modal`: закреплённый подвал при прокручиваемом теле](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0083-modal-pinned-footer.md) | ждёт T-0013 |
| [T-0053. Воронка в панели — полосами, сравнение с прошлым периодом, подсветка источников](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0053-funnel-chart-screen.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0054. Карточка игрока вкладками — шапка с действиями, «Сводка» на один взгляд](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0054-player-card-tabs.md) | ждёт T-0038; зоны пересекаются с T-0112 (в работе) |
| [T-0089. Пропуск рекламы VIP — отдельной меткой «Пропуск VIP», не досмотр](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0089-vip-ad-pass-mark.md) | ждёт T-0052 |
| [T-0133. Панель — подпись «отдельной доски» в журнале и сверка списка оружия с контентом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0133-admin-audit-board-label-and-weapon-sync.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0151. Ник в панели — исходник, ручная смена с закреплением, длинные ники в списке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0151-admin-player-rename.md) | ждёт T-0150; зоны пересекаются с T-0112 (в работе) |
| [T-0013. Срезанный угол с рамкой по срезу у главного на экране](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0013-cut-corners.md) | ждёт T-0010; зоны пересекаются с T-0010 (в работе); зоны пересекаются с T-0109 (на доработке) |
| [T-0046. Магазин в облике «Сумеречный рубеж» — по макету](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0046-shop-twilight-look.md) | ждёт T-0013 |
| [T-0144. Вход разработчика игроком без ролей — `dev-player-<id>`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0144-dev-login-as-player.md) | зоны пересекаются с T-0112 (в работе) |
| [T-0119. Модификаторы забега «Спешка» и «Инверсия»: данные и движок](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0119-run-modifiers-hurry-inverse.md) | зоны пересекаются с T-0099 (на доработке) |
| [T-0120. Рубеж — цель забега, движок: страж на отметке, победа в итоге забега](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0120-rubezh-guard-engine.md) | ждёт T-0099; ждёт T-0102; зоны пересекаются с T-0099 (на доработке) |
| [T-0122. Модификаторы забега: проверка и награда ×1,25 на сервере, без рейтинга](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0122-run-modifiers-server.md) | ждёт T-0119; ждёт T-0113; зоны пересекаются с T-0010 (в работе); зоны пересекаются с T-0059 (в работе); зоны пересекаются с T-0090 (в работе); зоны пересекаются с T-0112 (в работе); зоны пересекаются с T-0134 (в работе); зоны пересекаются с T-0147 (в работе); зоны пересекаются с T-0132 (на доработке) |
| [T-0123. Модификаторы забега: выбор в листе «Перед забегом»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0123-run-modifiers-prerun-sheet.md) | ждёт T-0119; ждёт T-0122; зоны пересекаются с T-0010 (в работе); зоны пересекаются с T-0134 (в работе); зоны пересекаются с T-0043 (на доработке); зоны пересекаются с T-0097 (на доработке); зоны пересекаются с T-0099 (на доработке); зоны пересекаются с T-0109 (на доработке) |
| [T-0129. Испытание дня: движок — фиксированный seed и набор на старте забега](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0129-daily-challenge-engine.md) | ждёт T-0119; зоны пересекаются с T-0099 (на доработке) |
| [T-0130. Испытание дня: сервер — расписание, выдача попыток, проверка, награда, таблица дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0130-daily-challenge-server.md) | ждёт T-0129; ждёт T-0122 |
| [T-0131. Испытание дня — вход с главной, лист испытания, таблица дня, расписание в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0131-daily-challenge-shell-and-panel.md) | ждёт T-0130; зоны пересекаются с T-0099 (на доработке) |
| [T-0115. Метка «Отдельная доска» в сводке, воронке и разборе забегов в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0115-board-label-in-reports.md) | ждёт T-0112; зоны пересекаются с T-0112 (в работе) |
| [T-0121. Рубеж — цель забега, сервер: проверка победы, награда ×2, отметка в рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0121-rubezh-win-reward-server.md) | ждёт T-0120; ждёт T-0113; зоны пересекаются с T-0010 (в работе); зоны пересекаются с T-0059 (в работе); зоны пересекаются с T-0090 (в работе); зоны пересекаются с T-0112 (в работе); зоны пересекаются с T-0134 (в работе); зоны пересекаются с T-0147 (в работе); зоны пересекаются с T-0132 (на доработке) |
| [T-0124. Рубеж — цель забега, оболочка: баннеры, «до рубежа N с», отметка в рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0124-rubezh-banners-and-death-screen.md) | ждёт T-0121; ждёт T-0109; зоны пересекаются с T-0010 (в работе); зоны пересекаются с T-0134 (в работе); зоны пересекаются с T-0043 (на доработке); зоны пересекаются с T-0097 (на доработке); зоны пересекаются с T-0099 (на доработке); зоны пересекаются с T-0109 (на доработке) |
| [T-0127. Кодекс врагов: гайдбук как коллекция, «7/11» и награда за полный](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0127-enemy-codex.md) | ждёт T-0106; ждёт T-0125 |
| [T-0128. Напоминания через бота: обогнали в сезоне, сезон закрывается, награда дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0128-bot-reminders.md) | ждёт T-0010; зоны пересекаются с T-0010 (в работе) |
| [T-0060. Журнал запросов — исходящие по вызову, входящие сводкой по маршрутам, 7 дней](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0060-request-journal-storage.md) | ждёт T-0059; зоны пересекаются с T-0059 (в работе) |
| [T-0061. Раздел «Запросы» в панели — исходящие вызовы и сводка входящих](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0061-requests-panel-section.md) | ждёт T-0060 |
| [T-0062. Лимиты источников курсов в панели — сколько осталось, правка лимита и счётчика, предупреждения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0062-fx-source-limits-panel.md) | ждёт T-0059; зоны пересекаются с T-0059 (в работе) |
| [T-0069. Постбэки — слой «событие → назначение», AdsGram первым назначением](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0069-postback-destinations-layer.md) | ждёт T-0059; зоны пересекаются с T-0059 (в работе) |
| [T-0063. CoinMarketCap — новый источник курсов; необязательные ключи tonapi и erapi](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0063-coinmarketcap-and-optional-keys.md) | ждёт T-0062; зоны пересекаются с T-0059 (в работе) |
| [T-0064. Курсы руками — «Обновить сейчас» у источника и запасной ручной курс любой валюты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0064-fx-refresh-now-and-fallback-rates.md) | ждёт T-0063; зоны пересекаются с T-0059 (в работе) |
| [T-0065. Прокси для исходящих запросов — список в панели, перебор после неудачи напрямую](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0065-outbound-proxies.md) | ждёт T-0060; ждёт T-0061 |
| [T-0093. Подписка Xray для прокси — хранение, обновление, контейнер Xray, раздел панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0093-xray-subscription-backend.md) | ждёт T-0065 |
| [T-0068. Воронка партнёра — по его ссылкам, кодам и площадкам](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0068-partner-funnel.md) | ждёт T-0067; ждёт T-0053 |
| [T-0070. Постбэки в s2s-сети и партнёру — шаблон адреса, click_id и sub1…sub5](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0070-postback-s2s-and-partner.md) | ждёт T-0069; ждёт T-0067; зоны пересекаются с T-0059 (в работе) |
| [T-0072. Метка партнёрки Telegram у игрока — слот источника занят, процент и срок программы в настройках](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0072-telegram-affiliate-mark.md) | ждёт T-0053; ждёт T-0054; зоны пересекаются с T-0112 (в работе); зоны пересекаются с T-0132 (на доработке) |
| [T-0071. Постбэки — покупки и возврат на следующий день, выбор событий у назначения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0071-postback-events-and-selection.md) | ждёт T-0069; ждёт T-0070; зоны пересекаются с T-0059 (в работе) |

## Готово — 80

| Задача | Сделал | PR |
|---|---|---|
| [T-0149. Чистка ников — символы, длина, мат, замена пустого](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0149-display-name-cleaning.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#360](https://github.com/JJSGxKD/rubezh/pull/360) |
| [T-0143. Проверка PR — номер в сводке, путь задачи, сводка не в коде, трейлеры коммитов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0143-pr-check-summary-task-trailers.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#362](https://github.com/JJSGxKD/rubezh/pull/362) |
| [T-0142. Бюджет экранов — порог на самый большой экран, сумма — предупреждением](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0142-budget-largest-screen-chunk.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#361](https://github.com/JJSGxKD/rubezh/pull/361) |
| [T-0138. Меню панели на телефоне открывается прокрученным к открытому разделу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0138-admin-menu-scroll-on-open.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#349](https://github.com/JJSGxKD/rubezh/pull/349) |
| [T-0136. Подсказки к параметрам снаряжения — что значит каждый](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0136-stat-hints.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#372](https://github.com/JJSGxKD/rubezh/pull/372) |
| [T-0135. Карточка предмета — «было → станет» перед улучшением](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0135-item-upgrade-preview.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#364](https://github.com/JJSGxKD/rubezh/pull/364) |
| [T-0110. Недельный сезон рейтинга — сервер: таблица недели, закрытие, награды, друзья](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0110-weekly-season-server.md) | @Kennix88 · claude-1 / sonnet-5.5 / extra | [#327](https://github.com/JJSGxKD/rubezh/pull/327) |
| [T-0108. Лестница открытий — оружие и навыки по уровням 2–14, а не все к шестому](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0108-unlock-ladder.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#348](https://github.com/JJSGxKD/rubezh/pull/348) |
| [T-0104. Задания: пул с ротацией по дням и недели и шесть новых видов цели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0104-tasks-pool-rotation-new-kinds.md) | @Kennix88 · claude-1 / sonnet-5.5 / high | [#325](https://github.com/JJSGxKD/rubezh/pull/325) |
| [T-0098. «Задания» открываются на вкладке, где ждёт награда](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0098-tasks-open-claimable-tab.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#371](https://github.com/JJSGxKD/rubezh/pull/371) |
| [T-0096. Убрать тень под врагами](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0096-enemy-no-shadow.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#316](https://github.com/JJSGxKD/rubezh/pull/316) |
| [T-0095. «Очаг» не звучит на каждый такт ауры](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0095-hearth-no-tick-sound.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#310](https://github.com/JJSGxKD/rubezh/pull/310) |
| [T-0094. Лист «Перед забегом»: отмеченная плитка справа не даёт боковой прокрутки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0094-prerun-no-sideways-scroll.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#315](https://github.com/JJSGxKD/rubezh/pull/315) |
| [T-0092. Пакет proxy-kit — разбор подписки Xray, конфиг спутника, пул узлов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0092-proxy-kit-package.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#370](https://github.com/JJSGxKD/rubezh/pull/370) |
| [T-0091. Ссылки Telegram собираются в одном месте — подготовка к смене домена](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0091-telegram-link-single-point.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#355](https://github.com/JJSGxKD/rubezh/pull/355) |
| [T-0088. Внешняя проверка прода без ложных тревог и без записи развёртывания на каждый прогон](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0088-uptime-no-false-alarms-no-deployments.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#356](https://github.com/JJSGxKD/rubezh/pull/356) |
| [T-0087. Карточка разбора забега ведёт в панель, а комментарии о маршруте и боте говорят правду](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0087-stale-route-and-bot-texts.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#312](https://github.com/JJSGxKD/rubezh/pull/312) |
| [T-0086. Два теста охраны проверяют то, что обещают: публичность готовности и тревогу 5xx в полной сборке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0086-guard-tests-readiness-and-alarm.md) | @Kennix88 · claude-1 / haiku-5.5 / medium | [#326](https://github.com/JJSGxKD/rubezh/pull/326) |
| [T-0085. Первый выкат на чистый сервер проходит без --no-backup](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0085-first-deploy-clean-server.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#367](https://github.com/JJSGxKD/rubezh/pull/367) |
| [T-0084. Тесный `SegmentedControl`: подписи сжимаются на узком экране, без обёрток снаружи](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0084-segmented-small.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#352](https://github.com/JJSGxKD/rubezh/pull/352) |
| [T-0082. Список игроков — пустой «Статус» не остаётся подписью без значения в карточке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0082-players-list-empty-status.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#314](https://github.com/JJSGxKD/rubezh/pull/314) |
| [T-0081. Друзья — на узком экране кнопки заявки и «Подарить» значками, имя читается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0081-friends-narrow-peer-actions.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#354](https://github.com/JJSGxKD/rubezh/pull/354) |
| [T-0080. Колесо — на кнопке бесплатной крутки загрузка идёт до остановки колеса](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0080-wheel-free-button-loading-until-stop.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#313](https://github.com/JJSGxKD/rubezh/pull/313) |
| [T-0079. Второй шанс — ролик главной кнопкой, звёзды второй, как в макете](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0079-death-ad-primary-button.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#319](https://github.com/JJSGxKD/rubezh/pull/319) |
| [T-0078. Событие continue_offered уходит после ответа проверок, а не при открытии шага](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0078-continue-offered-after-answers.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#296](https://github.com/JJSGxKD/rubezh/pull/296) |
| [T-0077. «Повторить» на плашке связи отвечает, даже если код проверки не загрузился](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0077-connection-retry-chunk-failure.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#298](https://github.com/JJSGxKD/rubezh/pull/298) |
| [T-0076. «Друзья»: крупное приглашение не мелькает, пока экран грузится](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0076-friends-no-invite-flash.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#318](https://github.com/JJSGxKD/rubezh/pull/318) |
| [T-0075. Награда дня сама обновляется на смене суток по Москве](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0075-daily-reload-on-midnight.md) | @Kennix88 · claude-7 / haiku-5.5 / medium | [#317](https://github.com/JJSGxKD/rubezh/pull/317) |
| [T-0074. Тест лимита приёмника событий не зависит от границы минуты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0074-events-limit-test-clock.md) | @Kennix88 · claude-9 / haiku-5.5 / low | [#311](https://github.com/JJSGxKD/rubezh/pull/311) |
| [T-0073. Проверки доступности не считаются кликами; клики без класса устройства — отдельной строкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0073-availability-checks-not-clicks.md) | @Kennix88 · claude-1 / sonnet-5.5 / high | [#328](https://github.com/JJSGxKD/rubezh/pull/328) |
| [T-0066. Карточка партнёра — TG id, статус, страна, валюта и способ выплаты, процент](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0066-partner-card-fields-and-status.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#299](https://github.com/JJSGxKD/rubezh/pull/299) |
| [T-0058. Переходник ссылок открывает Telegram диплинком — с запасным t.me](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0058-redirect-deeplink-page.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#369](https://github.com/JJSGxKD/rubezh/pull/369) |
| [T-0057. Цель ссылки и прямые ссылки — Mini App, бот или лендинг, с переходником и без](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0057-link-target-and-direct-links.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#288](https://github.com/JJSGxKD/rubezh/pull/288) |
| [T-0056. Вход в панель по QR и диплинку — запрос со страницей, без лишнего перехода](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0056-panel-login-qr-deeplink.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#285](https://github.com/JJSGxKD/rubezh/pull/285) |
| [T-0055. Выключатели внешних скриптов клиента в панели — Graspil, учёт аудитории, всё сразу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0055-external-scripts-switches.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#297](https://github.com/JJSGxKD/rubezh/pull/297) |
| [T-0051. Сводка панели — реклама, периоды 7 и 30 дней, покупки в ряду — сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0051-overview-ads-and-periods-api.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#284](https://github.com/JJSGxKD/rubezh/pull/284) |
| [T-0050. Подтверждения в панели по цене ошибки — окно действия и «Отменить»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0050-admin-confirm-and-undo.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#365](https://github.com/JJSGxKD/rubezh/pull/365) |
| [T-0049. Каркас панели — меню со значками и поиском, телефон, таблицы карточками](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0049-admin-shell-responsive.md) | @Kennix88 · claude-5 / sonnet-5.5 / high | [#286](https://github.com/JJSGxKD/rubezh/pull/286) |
| [T-0048. Экран друзей — список первым, полоса бонуса и «Подарить всем»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0048-friends-screen-layout.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#268](https://github.com/JJSGxKD/rubezh/pull/268) |
| [T-0047. «Подарить всем» — подарок каждому другу одним запросом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0047-gift-all-friends-api.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#255](https://github.com/JJSGxKD/rubezh/pull/255) |
| [T-0045. Экран смерти в два шага — сначала второй шанс, потом итоги](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0045-death-screen-two-steps.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#254](https://github.com/JJSGxKD/rubezh/pull/254) |
| [T-0044. «Перед забегом» одним листом — два касания до боя вместо четырёх](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0044-pre-run-sheet.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#253](https://github.com/JJSGxKD/rubezh/pull/253) |
| [T-0042. Компенсация после вайпа — выдача по кнопке и признак «Тестер» в ответах](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0042-compensation-claim-and-tester-flag.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#308](https://github.com/JJSGxKD/rubezh/pull/308) |
| [T-0041. Команда вайпа — подсчёт, снимок и стирание одной транзакцией](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0041-wipe-command.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#273](https://github.com/JJSGxKD/rubezh/pull/273) |
| [T-0040. Снимок перед вайпом — что вернуть тестеру и какой бонус дать](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0040-tester-compensation-snapshot.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#270](https://github.com/JJSGxKD/rubezh/pull/270) |
| [T-0039. План вайпа — у каждой таблицы решение «стираем» или «оставляем»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0039-wipe-plan.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#244](https://github.com/JJSGxKD/rubezh/pull/244) |
| [T-0037. Поддержка возвращает звёзды и повторяет выдачу покупки — сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0037-support-refund-and-refulfill-api.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#301](https://github.com/JJSGxKD/rubezh/pull/301) |
| [T-0036. Свежий бэкап базы перед каждым выкатом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0036-backup-before-deploy.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#247](https://github.com/JJSGxKD/rubezh/pull/247) |
| [T-0035. Тревога в чат команды о всплеске ошибок 5xx](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0035-server-error-alarm.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#260](https://github.com/JJSGxKD/rubezh/pull/260) |
| [T-0034. Внешняя проверка прода раз в 5 минут и тревога в чат команды](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0034-uptime-check.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#259](https://github.com/JJSGxKD/rubezh/pull/259) |
| [T-0033. Проверка готовности API — /health/ready смотрит базу и Redis](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0033-health-ready.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#238](https://github.com/JJSGxKD/rubezh/pull/238) |
| [T-0032. Роли владельца и администратора выдаются только с подтверждением в Telegram](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0032-confirm-privileged-roles-in-telegram.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#265](https://github.com/JJSGxKD/rubezh/pull/265) |
| [T-0031. API панели отвечает только на домене панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0031-admin-api-only-on-admin-domain.md) | @Kennix88 · claude-4 / sonnet-5.5 | [#239](https://github.com/JJSGxKD/rubezh/pull/239) |
| [T-0030. Отзыв без подписи запуска — строже лимит и потолок карточек в чат](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0030-unsigned-feedback-limits.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#241](https://github.com/JJSGxKD/rubezh/pull/241) |
| [T-0029. Досмотр рекламы через SDK засчитывается не раньше порога из панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0029-ad-min-view-time.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#252](https://github.com/JJSGxKD/rubezh/pull/252) |
| [T-0028. Награда за друга не теряется, если начисление упало](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0028-referral-reward-not-lost.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#251](https://github.com/JJSGxKD/rubezh/pull/251) |
| [T-0027. Обновления бота не теряются при перезапуске — сначала очередь, потом ответ](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0027-bot-updates-via-queue.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#261](https://github.com/JJSGxKD/rubezh/pull/261) |
| [T-0025. Вторая подписка VIP не оплачивается и не продлевается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0025-vip-no-double-subscription.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#258](https://github.com/JJSGxKD/rubezh/pull/258) |
| [T-0024. После возврата звёзд покупки аккаунту закрыты, команда получает карточку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0024-refund-closes-purchases.md) | @Kennix88 · claude-6 / sonnet-5.5 / extra | [#275](https://github.com/JJSGxKD/rubezh/pull/275) |
| [T-0023. Возврат звёзд забирает то, что осталось от покупки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0023-refund-revokes-remainder.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#269](https://github.com/JJSGxKD/rubezh/pull/269) |
| [T-0022. Лимиты частоты на маршрутах игрока, где их не было](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0022-rate-limits-on-open-routes.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#263](https://github.com/JJSGxKD/rubezh/pull/263) |
| [T-0021. Маршруты с правами — только в панели, дубли под токеном игры убраны](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0021-remove-duplicate-privileged-routes.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#240](https://github.com/JJSGxKD/rubezh/pull/240) |
| [T-0020. Бот говорит «идёт тест» и отвечает на обычное сообщение](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0020-bot-texts-and-reply.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#248](https://github.com/JJSGxKD/rubezh/pull/248) |
| [T-0019. Бот больше не пишет о каждой новой версии](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0019-no-bot-version-message.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#242](https://github.com/JJSGxKD/rubezh/pull/242) |
| [T-0018. Статусы задач в эпиках, страница доски и вклад по аккаунтам GitHub](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0018-board-page-and-epic-badges.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#217](https://github.com/JJSGxKD/rubezh/pull/217) |
| [T-0017. Подписи у всех вкладок нижней панели, если помещаются](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0017-tab-labels-when-fit.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#246](https://github.com/JJSGxKD/rubezh/pull/246) |
| [T-0016. Пересчёт значков не отменяется пустыми прогонами](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0016-task-board-concurrency.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#216](https://github.com/JJSGxKD/rubezh/pull/216) |
| [T-0015. Общая плашка «Нет связи с сервером»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0015-connection-banner.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#267](https://github.com/JJSGxKD/rubezh/pull/267) |
| [T-0014. Вид боя — красная гамма по угрозе, тени и новые цвета мира](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0014-battle-look-threat-colors.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#224](https://github.com/JJSGxKD/rubezh/pull/224) |
| [T-0012. Палитра, шрифты и скругления направления «Сумеречный рубеж»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0012-twilight-tokens-and-fonts.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#218](https://github.com/JJSGxKD/rubezh/pull/218) |
| [T-0011. Живые значки статуса задач и проверка захвата в CI](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0011-task-board-badges.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#213](https://github.com/JJSGxKD/rubezh/pull/213) |
| [T-0009. Выход везде и блокировка сразу закрывают выданные токены доступа](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0009-revoke-access-tokens.md) | @Kennix88 · claude-5 / sonnet-5.5 | [#249](https://github.com/JJSGxKD/rubezh/pull/249) |
| [T-0008. Свечение кнопок и значков — позади, а не поверх](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0008-glow-behind-not-over.md) | @Kennix88 · claude-3 / sonnet-5.5 / medium | [#295](https://github.com/JJSGxKD/rubezh/pull/295) |
| [T-0007. Точные и тикающие отсчёты «через сколько» на главной и в награде дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0007-countdown-precision.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#245](https://github.com/JJSGxKD/rubezh/pull/245) |
| [T-0006. Кнопка бесплатной крутки не оживает во время крутки за рекламу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0006-wheel-free-button-during-ad.md) | @Kennix88 · claude-3 / sonnet-5.5 | [#243](https://github.com/JJSGxKD/rubezh/pull/243) |
| [T-0005. Обереги и снаряды рисуются так, как бьёт симуляция](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0005-orbiters-and-projectiles-render.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#222](https://github.com/JJSGxKD/rubezh/pull/222) |
| [T-0004. Внешние возвраты через очередь и сигнал о брошенном задании](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0004-payments-refunds-via-queue.md) | @Kennix88 · claude-6 / sonnet-5.5 | [#250](https://github.com/JJSGxKD/rubezh/pull/250) |
| [T-0003. Оплаченное всегда выдаётся или возвращается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0003-payments-fulfillment-sweeper.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#228](https://github.com/JJSGxKD/rubezh/pull/228) |
| [T-0002. Команда pnpm task — доска, захват и проверка зон](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0002-task-cli.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#211](https://github.com/JJSGxKD/rubezh/pull/211) |
| [T-0001. Наборы магазина только из самоцветов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0001-shop-gems-only-bundles.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#205](https://github.com/JJSGxKD/rubezh/pull/205) |

## Вклад

Очки — сумма размеров сделанных задач: S — 1, M — 2. Это наглядность, а не формула выплат: доли участников — `docs/11-revenue-split.md`.

| GitHub | Задач | Очков | Последний мердж |
|---|---|---|---|
| [@Kennix88](https://github.com/Kennix88) | 80 | 112 | 17.10.2026 |

| GitHub | Исполнитель | Задач | Очков |
|---|---|---|---|
| @Kennix88 | claude-5 / sonnet-5.5 | 13 | 19 |
| @Kennix88 | claude-2 / sonnet-5.5 | 9 | 15 |
| @Kennix88 | claude-3 / sonnet-5.5 / medium | 13 | 14 |
| @Kennix88 | claude-5 / sonnet-5.5 / high | 7 | 12 |
| @Kennix88 | claude-6 / sonnet-5.5 | 6 | 11 |
| @Kennix88 | claude-3 / sonnet-5.5 | 9 | 10 |
| @Kennix88 | claude-6 / sonnet-5.5 / extra | 5 | 10 |
| @Kennix88 | claude-7 / haiku-5.5 / medium | 7 | 7 |
| @Kennix88 | claude-9 / haiku-5.5 / low | 6 | 6 |
| @Kennix88 | claude-1 / sonnet-5.5 / high | 2 | 4 |
| @Kennix88 | claude-1 / sonnet-5.5 / extra | 1 | 2 |
| @Kennix88 | claude-1 / haiku-5.5 / medium | 1 | 1 |
| @Kennix88 | claude-4 / sonnet-5.5 | 1 | 1 |
