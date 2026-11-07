# Доска задач

Обновлено 07.11.2026 14:33 МСК. Страницу пересчитывает workflow `task-board.yml` после захвата, PR и мерджа — руками не править. Как брать задачу — [tasks/README.md](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/README.md#как-взять-задачу).

Свободно 11 · в работе 2 · на ревью 0 · на доработке 0 · ждут тимлида 0 · ждут владельца 0 · влито сегодня 0 · пачка 4: осталось 63

## Ждут владельца — 0

Пусто.

## Ждут тимлида — 0

Пусто.

## Потоки сейчас

Какие потоки запускать в автопоток (`tasks/README.md`, «Автопоток»): доработка раньше новых задач, п.N — пачка выпуска. Строки `local` и `owner` — задачи только для потоков на машине с Docker и на машине владельца. То же даёт `pnpm task streams`.

### Запускать сейчас

| Поток | Свободно | Доработка | Ближайшие задачи |
|---|---|---|---|
| sonnet-5.5 / medium | 1 | 0 | [T-0356](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0356-admin-list-first-form-in-dialog.md) (п.4) |
| sonnet-5.5 / medium · local | 1 | 0 | [T-0214](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0214-fx-sound-render-and-metrics.md) (п.4) |
| sonnet-5.5 / high | 5 | 0 | [T-0126](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0126-tasks-kinds-bosses-elites-chests-evolutions.md) (п.4), [T-0127](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0127-enemy-codex.md) (п.4), [T-0148](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0148-online-counter-client.md) (п.4), [T-0297](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0297-rating-run-card.md) (п.7), [T-0313](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0313-battle-pass-ribbons-panel.md) (п.8) |
| sonnet-5.5 / extra | 4 | 0 | [T-0178](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0178-channel-unsubscribe-recheck.md) (п.4), [T-0217](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0217-partner-role-and-account.md) (п.4), [T-0303](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0303-content-drafts-server.md) (п.7), [T-0312](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0312-battle-pass-close.md) (п.8) |

### На очереди

| Поток | Ждут | Ближайшая пачка |
|---|---|---|
| sonnet-5.5 / low · local | 1 | 4 |
| sonnet-5.5 / medium | 22 | 4 |
| sonnet-5.5 / medium · owner | 1 | 5 |
| sonnet-5.5 / high | 50 | 4 |
| sonnet-5.5 / extra | 17 | 4 |

### Запуск по аккаунтам

Готовые промты с номером аккаунта; потоки, которые на нём уже идут, не предлагаются.

<details>
<summary>claude-10 — запустить 3: sonnet-5.5 / medium, sonnet-5.5 / medium · local, sonnet-5.5 / extra</summary>

```
Ты — исполнитель проекта «Рубеж», поток claude-10 / sonnet-5.5 / medium, запустил: владелец.
Сначала git fetch origin и git switch --detach origin/dev, Node — из .nvmrc,
pnpm install; так же — перед каждой новой задачей. Прочитай AGENTS.md и tasks/README.md, разделы «Автопоток» и «Доработка»,
и работай по скиллу take-task в режиме автопотока: бери задачи только
своей модели и уровня — pnpm task next --executor sonnet-5.5 --effort medium,
доработку первой (pnpm task resume), иначе pnpm task claim T-NNNN
--owner "claude-10 / sonnet-5.5 / medium". Делай строго по спецификации,
только в ветке task/T-NNNN, в описании PR — строки Поток и Запустил, в dev и main не пушь, PR не вливай — вливают
тимлиды. Неясно — черновик PR с разделом «Вопросы» и цитатой строки
спецификации, независимые шаги продолжай. PR открыт — сразу следующая
задача, ответа не жди: закончит PR тот поток, что первым возьмёт его на
доработку. Задач не осталось — отчёт и стоп.
```

```
Ты — исполнитель проекта «Рубеж», поток claude-10 / sonnet-5.5 / medium, запустил: владелец.
Сначала git fetch origin и git switch --detach origin/dev, Node — из .nvmrc,
pnpm install; так же — перед каждой новой задачей. Прочитай AGENTS.md и tasks/README.md, разделы «Автопоток» и «Доработка»,
и работай по скиллу take-task в режиме автопотока: бери задачи только
своей модели и уровня — pnpm task next --executor sonnet-5.5 --effort medium --runner local,
доработку первой (pnpm task resume), иначе pnpm task claim T-NNNN
--owner "claude-10 / sonnet-5.5 / medium". Делай строго по спецификации,
только в ветке task/T-NNNN, в описании PR — строки Поток и Запустил, в dev и main не пушь, PR не вливай — вливают
тимлиды. Неясно — черновик PR с разделом «Вопросы» и цитатой строки
спецификации, независимые шаги продолжай. PR открыт — сразу следующая
задача, ответа не жди: закончит PR тот поток, что первым возьмёт его на
доработку. Задач не осталось — отчёт и стоп.
```

```
Ты — исполнитель проекта «Рубеж», поток claude-10 / sonnet-5.5 / extra, запустил: владелец.
Сначала git fetch origin и git switch --detach origin/dev, Node — из .nvmrc,
pnpm install; так же — перед каждой новой задачей. Прочитай AGENTS.md и tasks/README.md, разделы «Автопоток» и «Доработка»,
и работай по скиллу take-task в режиме автопотока: бери задачи только
своей модели и уровня — pnpm task next --executor sonnet-5.5 --effort extra,
доработку первой (pnpm task resume), иначе pnpm task claim T-NNNN
--owner "claude-10 / sonnet-5.5 / extra". Делай строго по спецификации,
только в ветке task/T-NNNN, в описании PR — строки Поток и Запустил, в dev и main не пушь, PR не вливай — вливают
тимлиды. Неясно — черновик PR с разделом «Вопросы» и цитатой строки
спецификации, независимые шаги продолжай. PR открыт — сразу следующая
задача, ответа не жди: закончит PR тот поток, что первым возьмёт его на
доработку. Задач не осталось — отчёт и стоп.
```

</details>

## Доработка — 0

Пусто.

## Можно брать — 11

### В облаке — 10

| Задача | Приоритет | Размер | Исполнитель | Эпик |
|---|---|---|---|---|
| [T-0126. Задания и достижения: боссы, элиты, сундуки, кристаллы, эволюции](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0126-tasks-kinds-bosses-elites-chests-evolutions.md) | P1 | M | sonnet-5.5 · high | E16 |
| [T-0127. Кодекс врагов: гайдбук как коллекция, «7/11» и награда за полный](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0127-enemy-codex.md) | P1 | M | sonnet-5.5 · high | E16 |
| [T-0148. Счётчик онлайна — клиент и панель: шапка, кнопка «Играть», разбивка](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0148-online-counter-client.md) | P2 | M | sonnet-5.5 · high | E16 |
| [T-0356. Панель — список первым, форма «Новое …» и «Изменить» в окне: Задания, Главная, Журнал, Флаги](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0356-admin-list-first-form-in-dialog.md) | P2 | M | sonnet-5.5 · medium | E7 |
| [T-0178. Отписка от канала после награды — перепроверка 7 суток, списание, закрытие заданий](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0178-channel-unsubscribe-recheck.md) | P2 | M | sonnet-5.5 · extra | E14 |
| [T-0217. Роль «партнёр» — аккаунт привязан к карточке, вход в свой кабинет, без самопривязки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0217-partner-role-and-account.md) | P2 | M | sonnet-5.5 · extra | E14 |
| [T-0303. Контент на сервере — версии и черновики в базе, версия 0 из репозитория, правка черновика, проверка через sim-worker и разница с базой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0303-content-drafts-server.md) | P2 | M | sonnet-5.5 · extra | E7 |
| [T-0297. Карточка забега — «паутина» пяти осей против ожидаемого, разбор очков полосами и сборка; открывается из рейтинга и с экрана итогов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0297-rating-run-card.md) | P2 | M | sonnet-5.5 · high | E12 |
| [T-0312. Батл-пасс — закрытие месяца: незабранное выдаётся само под локом, уведомление в игре и в боте; бусты-подарки тратятся при включении буста](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0312-battle-pass-close.md) | P2 | M | sonnet-5.5 · extra | E16 |
| [T-0313. Батл-пасс — ленты месяца в панели: 30 ступеней двух лент, награды по схеме без случайного, копия прошлого месяца, предпросмотр](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0313-battle-pass-ribbons-panel.md) | P3 | M | sonnet-5.5 · high | E7 |

### Машина с Docker — 1

| Задача | Приоритет | Размер | Исполнитель | Эпик |
|---|---|---|---|---|
| [T-0214. Рендер звуков в WAV и замеры — `pnpm fx:sound [звук…]`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0214-fx-sound-render-and-metrics.md) | P2 | M | sonnet-5.5 · medium | E0 |

### Машина владельца — 0

Пусто.

## Можно заделом — 0

Пусто.

## В работе — 2

| Задача | Поток | Запустил | Висит | Кругов | Чего ждёт |
|---|---|---|---|---|---|
| [T-0119. Модификаторы забега «Спешка» и «Инверсия»: данные и движок](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0119-run-modifiers-hurry-inverse.md) | claude-10 / sonnet-5.5 / high | — | ⚠️ 3 дн | — | исполнителя |
| [T-0203. Сводка «чего достигли» в панели — итоги за всё время и рекорды DAU/WAU/MAU](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0203-admin-all-time-summary.md) | claude-lead-1 / sonnet-5.5 / extra | — | ⚠️ 4 дн | — | исполнителя |

## На ревью — 0

Пусто.

## Задел — 0

Пусто.

## Ждут — 91

| Задача | Чего ждёт |
|---|---|
| [T-0122. Модификаторы забега: проверка и награда ×1,25 на сервере, без рейтинга](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0122-run-modifiers-server.md) | ждёт T-0119; зоны пересекаются с T-0203 (в работе) |
| [T-0123. Модификаторы забега: выбор в листе «Перед забегом»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0123-run-modifiers-prerun-sheet.md) | ждёт T-0119; ждёт T-0122 |
| [T-0129. Испытание дня: движок — фиксированный seed и набор на старте забега](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0129-daily-challenge-engine.md) | ждёт T-0119; зоны пересекаются с T-0119 (в работе) |
| [T-0130. Испытание дня: сервер — расписание, выдача попыток, проверка, награда, таблица дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0130-daily-challenge-server.md) | ждёт T-0129; ждёт T-0122 |
| [T-0131. Испытание дня — вход с главной, лист испытания, таблица дня, расписание в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0131-daily-challenge-shell-and-panel.md) | ждёт T-0130 |
| [T-0199. Переброс карточек за рекламу — один раз за забег, когда заряды кончились](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0199-reroll-for-ad.md) | ждёт T-0119; ждёт T-0122; ждёт T-0123; ждёт T-0127; ждёт T-0129; ждёт T-0130; ждёт T-0131; ждёт T-0175; зоны пересекаются с T-0119 (в работе) |
| [T-0241. Дневной кап роликов на все места — реклама не становится работой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0241-ads-daily-cap.md) | ждёт T-0199 |
| [T-0242. Награда дня ×2 за ролик — новое место рекламы daily_double, сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0242-daily-double-for-ad.md) | ждёт T-0241 |
| [T-0243. Самоцветы за ролик раз в день — новое место рекламы free_gems в магазине, сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0243-free-gems-for-ad.md) | ждёт T-0242 |
| [T-0244. Клиент наградной рекламы — «Удвоить за ролик» в награде дня, самоцветы за ролик в магазине, сообщение о капе](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0244-reward-ads-shell.md) | ждёт T-0243 |
| [T-0175. Лента живых событий — убитый босс и редкий сундук: счётчик редких сундуков и события](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0175-live-feed-boss-and-rare-chest.md) | зоны пересекаются с T-0119 (в работе) |
| [T-0235. Знаки у имени — сервер: каталог, статусные и сезонные знаки, выбор знака](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0235-emblems-server.md) | ждёт T-0126 |
| [T-0236. Знаки у имени — клиент: все знаки в профиле, выбор знака, знак в рейтинге и у друзей](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0236-emblems-shell.md) | ждёт T-0235; ждёт T-0240 |
| [T-0237. Облики-архетипы — сервер: каталог, кто чем владеет, выбор облика и аватара, облик в списках](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0237-appearance-server.md) | ждёт T-0235; ждёт T-0240; ждёт T-0126 |
| [T-0238. Облики — экран «Облик» из арсенала и профиля, портрет в арсенале, голова облика в аватаре](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0238-appearance-shell.md) | ждёт T-0237; ждёт T-0236 |
| [T-0239. Облик в забеге — герой кадрами выбранного облика из его атласа в режиме арта](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0239-appearance-in-run.md) | ждёт T-0238; зоны пересекаются с T-0119 (в работе) |
| [T-0240. Знак у имени в строках рейтинга, сезона и друзей — порт PublicIdentity](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0240-public-identity-in-lists.md) | ждёт T-0235; ждёт T-0161 |
| [T-0247. Карточка игрока — сервер: публичный id, ответ карточки, заявка в друзья по публичному id](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0247-player-card-server.md) | ждёт T-0240; ждёт T-0237 |
| [T-0248. Карточка игрока — клиент: лист по тапу в рейтинге, сезоне и у друзей, «Как меня видят» в профиле](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0248-player-card-shell.md) | ждёт T-0247; ждёт T-0238 |
| [T-0262. Серия дней — сервер: +5 % к награде дня за каждый день подряд до +50 %, пропуск — минус две ступени](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0262-daily-streak-server.md) | ждёт T-0242 |
| [T-0263. Серия дней — клиент: огонёк у аватара в шапке и строка серии в награде дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0263-daily-streak-shell.md) | ждёт T-0262; ждёт T-0244 |
| [T-0322. Достижения v2 — «Без единой царапины», «Пацифист», стихийники, «Коллекционер», «Мастер Метеора», «Душа компании»; знаки у трудных](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0322-achievements-v2-trials-elements-collector.md) | ждёт T-0126; ждёт T-0235 |
| [T-0215. Отчёт проверки звука и эффектов — `pnpm fx:check`, таблица в описание PR](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0215-fx-check-report.md) | ждёт T-0214 |
| [T-0158. Донаты проекту — клиент: лист доната, ссылки Tribute, знак, благодарность, слайд](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0158-donations-client.md) | ждёт T-0161 |
| [T-0161. Знак «Меценат» в ответах входа, рейтинга и сезонов — сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0161-supporter-badge-api.md) | зоны пересекаются с T-0119 (в работе) |
| [T-0245. «Набор хранителя» — сервер: 48 часов после первой победы над Рубежом, окрас и самоцветы](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0245-keeper-set-server.md) | ждёт T-0237 |
| [T-0246. «Набор хранителя» — клиент: предложение после первой победы и карточка в магазине с отсчётом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0246-keeper-set-shell.md) | ждёт T-0245; ждёт T-0238 |
| [T-0249. VIP в подарок другу — сервер: заказ за звёзды, срок подарка, уведомление, возврат](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0249-vip-gift-server.md) | ждёт T-0247 |
| [T-0250. VIP в подарок — клиент: «Подарить VIP» в карточке друга, уведомление получателю](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0250-vip-gift-shell.md) | ждёт T-0249; ждёт T-0248 |
| [T-0251. VIP глазами других — золотая галочка у аватара в списках и карточке, «Что увидят другие» на экране VIP](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0251-vip-seen-by-others.md) | ждёт T-0250 |
| [T-0327. Второй сундук в кладе за ролик — сервер: место показа `clad_chest`, раз за забег, книга показов и сверка итога](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0327-clad-ad-chest-server.md) | ждёт T-0199; ждёт T-0241 |
| [T-0328. Второй сундук в кладе за ролик — движок и окно: кнопка «Ещё сундук за ролик» в окне сундука клада, команда в записи забега, сундук из своего потока](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0328-clad-ad-chest-engine-shell.md) | ждёт T-0327; зоны пересекаются с T-0119 (в работе) |
| [T-0329. Облик в подарок другу — сервер: позиция Ярмарки за самоцветы дарящего, только другу и только то, чего у него нет; уведомление получателю](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0329-appearance-gift-server.md) | ждёт T-0264; ждёт T-0247 |
| [T-0330. Облик в подарок другу — клиент: «Подарить облик» в карточке друга, витрина Ярмарки глазами друга, подтверждение с ценой, уведомление получателю](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0330-appearance-gift-shell.md) | ждёт T-0329; ждёт T-0265; ждёт T-0248; ждёт T-0250 |
| [T-0252. Картинки бота — основа: шрифт Russo One, общая сцена с обликом, кэш file_id, публичный адрес картинки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0252-bot-cards-foundation.md) | ждёт T-0237 |
| [T-0253. Приглашение и итог забега картинкой — «Поделиться» несёт облик и рекорд](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0253-invite-and-run-share-cards.md) | ждёт T-0252 |
| [T-0255. Напоминания бота картинкой — «тебя обогнали», сезон закрывается, награда дня ждёт, колесо снова крутится](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0255-reminders-with-images.md) | ждёт T-0252 |
| [T-0256. Итог сезона в боте картинкой — место и награды тем, кто играл](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0256-season-result-message.md) | ждёт T-0255 |
| [T-0353. Герой в четыре стороны в забеге — спереди при ходе вниз, спиной при ходе вверх](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0353-hero-view-by-direction.md) | ждёт T-0239; зоны пересекаются с T-0119 (в работе) |
| [T-0072. Метка партнёрки Telegram у игрока — слот источника занят, процент и срок программы в настройках](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0072-telegram-affiliate-mark.md) | ждёт T-0199 |
| [T-0183. Подсказка о правиле подписки на карточке партнёрского задания](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0183-unsubscribe-rule-hint-on-task-card.md) | ждёт T-0178 |
| [T-0218. Кабинет партнёра в панели — свои ссылки и промокоды, доступ из карточки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0218-partner-cabinet-links-promo.md) | ждёт T-0217 |
| [T-0219. Кабинет партнёра — воронка по своим ссылкам и кодам, без ID и малых групп](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0219-partner-cabinet-funnel.md) | ждёт T-0218 |
| [T-0222. Заказчик партнёрского задания — модель оплаты CPA или RS, ставка и срок удержания](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0222-task-customer-and-pay-model.md) | ждёт T-0126; ждёт T-0178 |
| [T-0223. Отметки удержания подписки на 1-й, 3-й и 7-й день — из перепроверки отписки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0223-subscription-retention-marks.md) | ждёт T-0178; ждёт T-0222 |
| [T-0225. Отчёт заказчику партнёрских заданий — по дням, без ID, экран и CSV](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0225-customer-report.md) | ждёт T-0222; ждёт T-0223 |
| [T-0271. Картинка партнёрского задания — аватар канала, бота или Mini App берётся с источника сам](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0271-partner-task-source-avatar.md) | ждёт T-0222 |
| [T-0261. Кодекс тайников — найденные за всё время на сервере, раздел гайдбука с преданиями, достижение и знак «Следопыт»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0261-secrets-codex.md) | ждёт T-0235 |
| [T-0264. Ярмарка — сервер: облики и окрасы за самоцветы на неделю по кругу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0264-fair-server.md) | ждёт T-0245 |
| [T-0265. Ярмарка — клиент: раздел в магазине с портретами, ценой и «уйдёт через N дней»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0265-fair-shell.md) | ждёт T-0264; ждёт T-0246 |
| [T-0254. Карточка игрока картинкой — «Поделиться» из карточки и вход по ссылке прямо в карточку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0254-player-card-share.md) | ждёт T-0253; ждёт T-0251 |
| [T-0257. Сводка дня и тревоги в чате администраторов картинкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0257-admin-chat-images.md) | ждёт T-0252 |
| [T-0360. Панель — строка «пульса» в шапке: онлайн сейчас, ход рассылки, новые блокировки клиента за час](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0360-admin-pulse-line.md) | ждёт T-0148 |
| [T-0221. Материалы для партнёров — баннеры, тексты постов и правила в кабинете](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0221-partner-materials.md) | ждёт T-0219 |
| [T-0273. Промо — сервер: пресеты команды, картинки для макетов, выдача пресетов партнёрам и журнал выгрузок](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0273-promo-studio-server.md) | ждёт T-0221 |
| [T-0274. Редактор промо на Fabric.js — холст, слои, текст, картинки, QR, отмена и выгрузка PNG/JPEG](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0274-promo-editor-fabric.md) | ждёт T-0218 |
| [T-0275. Раздел «Промо» в панели — пресеты команды: список, новый пресет, правка в редакторе, публикация партнёрам](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0275-promo-presets-screen.md) | ждёт T-0273; ждёт T-0274 |
| [T-0276. Промо — вкладка «Материал»: пресет, промокод и ссылка с заведением на месте, правка и выгрузка](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0276-promo-material-generator.md) | ждёт T-0275 |
| [T-0277. Кабинет партнёра — вкладка «Промо»: пресеты команды со своим кодом и ссылкой, свои тексты и фото, выгрузка](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0277-cabinet-promo.md) | ждёт T-0276 |
| [T-0266. Дружина — сервер, ядро: создать, вступить по ссылке или заявкой, выйти, исключить, до 20 участников](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0266-clans-core-server.md) | ждёт T-0247 |
| [T-0267. Дружина — неделя: босс дружины из забегов участников, рейтинг дружин, награда и подарки внутри](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0267-clans-week-and-boss.md) | ждёт T-0266 |
| [T-0268. Дружина — клиент: вкладка в «Друзьях», список открытых, своя дружина с боссом недели, заявки и ссылка](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0268-clans-shell.md) | ждёт T-0267; ждёт T-0254 |
| [T-0269. Застава — сервер: кузня, капище и сторожевая башня за монеты, прибавки в силе игрока, доход башни вне игры](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0269-outpost-server.md) | ждёт T-0247 |
| [T-0270. Застава — клиент: экран с тремя постройками, улучшение за монеты и забор дохода башни](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0270-outpost-shell.md) | ждёт T-0269; ждёт T-0268 |
| [T-0367. Граф связей игрока — сервер: игрок и два шага, связи дружбы, приглашения, партнёрки и подарков](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0367-player-graph-server.md) | ждёт T-0249; ждёт T-0329 |
| [T-0368. Граф связей игрока — вкладка «Связи» в карточке: граф на ПК, список на телефоне](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0368-player-graph-tab.md) | ждёт T-0367 |
| [T-0369. Граф связей — связи антифрода по отдельному праву; признаки — у владельца](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0369-player-graph-fraud-edges.md) | ждёт T-0367 |
| [T-0281. Новый контент, данные — враг Ледяной дух и оружие Кистень с эволюцией «Круговерть» на готовых паттерне и поведении](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0281-ice-spirit-and-flail.md) | зоны пересекаются с T-0119 (в работе) |
| [T-0282. Болотник — враг, оставляющий ядовитые лужи: поле `trail` у врага, лужи в мире, облик на земле](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0282-bog-lurker-puddles.md) | ждёт T-0281; зоны пересекаются с T-0119 (в работе) |
| [T-0283. Кикимора — новый паттерн `blink`: исчезает и появляется рядом с игроком после метки на земле](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0283-kikimora-blink.md) | ждёт T-0282; зоны пересекаются с T-0119 (в работе) |
| [T-0284. Леший — элита с новым паттерном `roots`: корни из земли под игроком после метки, опутывание](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0284-leshy-roots.md) | ждёт T-0283; зоны пересекаются с T-0119 (в работе) |
| [T-0285. Змей Горыныч — босс трёх голов: поле `phases` у босса (свой паттерн и стихия на каждую фазу), головы гаснут по фазам](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0285-gorynych-boss-phases.md) | ждёт T-0284; зоны пересекаются с T-0119 (в работе) |
| [T-0286. Навыки защиты — Вампиризм (лечение за убийство) и Стойкость (щит раз в 30 с): новые параметры игрока](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0286-vampirism-steadfast.md) | ждёт T-0281; зоны пересекаются с T-0119 (в работе) |
| [T-0287. Навыки атаки — Удача (критические удары и крупнее сундуки) и Рикошет (снаряды отскакивают к следующему врагу)](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0287-luck-ricochet.md) | ждёт T-0286; зоны пересекаются с T-0119 (в работе) |
| [T-0288. Серп — поведение `boomerang`: летит к врагу и возвращается, режет на обоих путях; эволюция «Жатва»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0288-sickle-boomerang.md) | ждёт T-0287; зоны пересекаются с T-0119 (в работе) |
| [T-0289. Гусли — поведение `cone`: волна звука конусом по ходу, отталкивает врагов; эволюция «Песнь Баяна» — волна вокруг](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0289-gusli-cone-knockback.md) | ждёт T-0288; зоны пересекаются с T-0119 (в работе) |
| [T-0290. Рябиновые бусы — поведение `chain`: снаряд перескакивает между врагами и травит; эволюция «Ожерелье»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0290-rowan-beads-chain.md) | ждёт T-0289; зоны пересекаются с T-0119 (в работе) |
| [T-0323. «Мастера» оружия Р157 — Кистень, Серп, Гусли, Рябиновые бусы; стихии нового оружия в заданиях; тест, что у каждого базового оружия есть «Мастер»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0323-weapon-masters-new-weapons.md) | ждёт T-0322; ждёт T-0281; ждёт T-0288; ждёт T-0289; ждёт T-0290 |
| [T-0304. Панель «Баланс» — таблицы контента по разделам, правка ячейки с прежним числом, ошибка формы строкой под записью, список правок черновика](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0304-balance-editor-tables.md) | ждёт T-0303 |
| [T-0305. Панель «Баланс» — «Проверить»: проверки контента и симуляция черновика против версии в игре полосами с коридорами, рельсы шагов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0305-balance-editor-check.md) | ждёт T-0304 |
| [T-0306. Публикация контента — версия сначала команде, потом всем, только после зелёной проверки; откат кнопкой; версия для клиента по его схеме](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0306-content-publish.md) | ждёт T-0305 |
| [T-0307. Клиент играет опубликованной версией контента — берёт её при входе, хранит по хэшу, забег держит свою версию до конца; сервер знает хэши из базы](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0307-client-content-version.md) | ждёт T-0306 |
| [T-0309. Цены товаров в панели с подтверждением второго участника — заявка на правку, подтверждает другой человек с правом, правка ложится поверх каталога в коде](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0309-two-person-prices.md) | ждёт T-0304 |
| [T-0308. История баланса в git — публикация «Всем» открывает PR от бота в dev со снимком версии и списком правок](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0308-content-snapshot-bot-pr.md) | ждёт T-0306; зоны пересекаются с T-0119 (в работе) |
| [T-0310. Награды числами в панели — монеты и опыт за забег, награды за уровень и награда дня ключами каталога с подтверждением второго участника](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0310-reward-settings-two-person.md) | ждёт T-0309 |
| [T-0316. Запись для проверки у каждого забега — лог ввода, выборы и контрольные суммы сквозь продолжение из снимка; отправка на сервер очередью](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0316-run-proof-client.md) | зоны пересекаются с T-0119 (в работе) |
| [T-0318. sim-worker — очередь повтора забега: та же симуляция по записи, снимку контента и снаряжению, исход и тик расхождения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0318-sim-worker-replay.md) | ждёт T-0316 |
| [T-0319. Перепроверка забегов — кому повтор обязателен, выборка остальных, постановка в sim-worker, исход в вердикт забега и в разбор](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0319-run-replay-verdict.md) | ждёт T-0318 |
| [T-0320. Что даёт проверка повтором — эпическая добыча и награда Стража после совпадения, сезон награждает проверенных, метка «проверяется» и «проверен»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0320-replay-gated-rewards.md) | ждёт T-0319; ждёт T-0297 |
| [T-0314. Батл-пасс — экран: две ленты по 30 ступеням, текущая ступень и очки до следующей, забор, что даёт VIP; вкладка в «Заданиях» и виджет на главной](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0314-battle-pass-shell.md) | ждёт T-0312 |
| [T-0315. Батл-пасс — облики в наградах: окрасы на 10-й и 20-й бесплатной ленты, окрасы и облик сезона в VIP-ленте](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0315-battle-pass-appearances.md) | ждёт T-0313; ждёт T-0245 |

## Готово — 264

| Задача | Сделал | PR |
|---|---|---|
| [T-0372. Справка по ссылкам в панели — виды ссылок, путь клика, поля, ключи и счётчики](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0372-links-guide-in-panel.md) | claude-50 / sonnet-5.5 / high | — |
| [T-0371. Брошенный захват — ветка без работы дольше суток не держит зоны, задачу можно перехватить](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0371-abandoned-claim-takeover.md) | claude-49 / sonnet-5.5 / medium | — |
| [T-0370. «Предел» в снимке контента и отпечатке; после изгнания последнего предмета — «Предел», а не лечение](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0370-limits-in-content-snapshot.md) | claude-10 / sonnet-5.5 / medium | — |
| [T-0366. Вход в панель — опрос ответа бота только в видимой вкладке, срок — по слову сервера, а не по часам устройства](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0366-admin-login-poll-visible-only.md) | claude-10 / sonnet-5.5 / low | — |
| [T-0365. Журнал исходящих — пачка держится в буфере, пока база недоступна; причина сбоя в логе обрезана до 200 знаков](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0365-outbound-journal-outage-and-reason.md) | claude-10 / sonnet-5.5 / low | — |
| [T-0364. Донаты отдельно от покупок — ежедневный отчёт, цели сетей, разрез флагов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0364-donations-out-of-purchase-reports.md) | claude-10 / sonnet-5.5 / medium | — |
| [T-0363. Кампания и источник у прямых ссылок и ссылок с метками — список игроков, воронка, ежедневный отчёт](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0363-campaign-for-link-and-tagged-starts.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0362. Карточка игрока — привязка к партнёру по ссылке с кодом ссылки и переходом в её карточку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0362-player-card-partner-link-code.md) | claude-10 / sonnet-5.5 / low | — |
| [T-0361. Сводка панели — досмотры рекламы в ряду дней только с правом `ads.view`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0361-overview-ads-series-by-permission.md) | claude-10 / sonnet-5.5 / low | — |
| [T-0359. Панель — счётчик «Ждёт вас» на пункте «Сводка» в меню; лёгкий запрос `/admin/attention`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0359-admin-attention-menu-badge.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0358. Панель — «мало данных» вместо графика из одного столбика; у пустых состояний — следующий шаг](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0358-admin-sparse-charts-and-empty-next-step.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0357. Панель — ряд полей не прыгает от подсказки и ошибки; у недоступной главной кнопки — причина одной строкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0357-admin-field-rows-and-blocked-reason.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0355. Панель — поиск игрока из поиска разделов «/»: «@ник» или число — строка «Игрок …» первой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0355-admin-palette-player-search.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0354. Панель «Игроки» — список новых сразу, фильтры свёрнуты в строку с чипами активных](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0354-admin-players-list-first.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0352. Тайники рубежа — проводка к забегу: события в шину, выбор благословения с паузой, снимок контента и забега, эталоны](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0352-secrets-run-wiring.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0351. Задел — брать задачу до мерджа зависимостей, ветка поверх их веток, метка «задел», доводка первой в очереди](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0351-ahead-work.md) | claude-1 / sonnet-5.5 / high | — |
| [T-0350. Фильтр имён — потолок регулярок, прогон один раз на шаблон, медленное правило видно в логе, NFKC до правил закреплён тестом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0350-name-rules-load-and-nfkc.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0349. Самостоятельный мердж — поле merge в задаче, команды pnpm task merge и pnpm task holds, правила для потоков](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0349-self-merge-command.md) | claude-1 / sonnet-5.5 / high | — |
| [T-0348. Курсы фиата — ForexRateAPI ещё одним голосом рубля и евро, включается ключом из панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0348-fx-forexrateapi-source.md) | claude-1 / sonnet-5.5 / medium | — |
| [T-0347. Компенсация тестерам — своё имя пересчёта звёзд второго шанса в самоцветы](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0347-compensation-continue-gems-rename.md) | claude-15 / haiku-5.5 / low | — |
| [T-0346. Второй шанс за самоцветы — отказ при занятом ключе списания без строки и свой шаг стирания в вайпе](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0346-gem-continue-key-conflict-and-wipe.md) | claude-14 / sonnet-5.5 / extra | — |
| [T-0345. Системное ограничение не ослабляет решение человека и в гонке — проверка под блокировкой аккаунта](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0345-system-restriction-under-lock.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0344. Кнопка «Связаться с разработчиком» в меню и настройках — ссылка своя на каждую площадку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0344-contact-developer-button.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0343. PR задачи не правит epics.md и чужие задачи — перенос в архив уборкой тимлида](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0343-archive-by-cleanup.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0342. Кольцо стражей — плотнее, медленнее, жирнее: числа, элита и босс внутри, гайдбук](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0342-cordon-numbers-and-guide.md) | claude-44 / sonnet-5.5 / medium | — |
| [T-0341. Фильтр имён — кандидаты в правила из частых слов в никах](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0341-name-rule-candidates.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0340. Фильтр имён — статистика срабатываний правил](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0340-name-rules-hits.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0339. Фильтр имён — экран в панели, проверка на примерах и перечистка ников](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0339-name-rules-panel.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0338. Фильтр имён — правила в базе, чистка ников по ним и ручки панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0338-name-rules-server.md) | claude-1 / sonnet-5.5 / high | — |
| [T-0337. Юзернейм бота — над вкладками «Заданий», после награды сворачивается в строку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0337-bot-mention-above-tabs.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0336. Стоящий враг не шагает — кадр шага по движению, как у героя](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0336-enemy-walk-frame-by-motion.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0335. Кольцо стражей — строй сразу со вспышкой, элита и босс внутри (движок)](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0335-cordon-formation-and-elite.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0334. Проверка рекламы командой — экран в игре и debug на вызов в адаптере](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0334-ads-test-screen.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0333. Проверка рекламы командой — каталог SDK-сетей и журнал проверок на сервере](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0333-ads-test-tools-server.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0332. Тексты сервера и бота для игрока на «ты» — ошибки, ответы оплаты, сообщения бота; тест по исходникам](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0332-server-texts-informal-address.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0331. Тексты оболочки на «ты» — без «вы» и без рода игрока, тест не даёт вернуть «вы»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0331-shell-texts-informal-address.md) | claude-16 / haiku-5.5 / medium | — |
| [T-0326. «Выбор игроков» в магазине — метка у набора, который за 30 дней купило больше всего разных игроков; считается сервером, ниже порога не показывается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0326-shop-players-choice-badge.md) | claude-1 / sonnet-5.5 / medium | — |
| [T-0325. Второй шанс за самоцветы — экран смерти: кнопка с ценой и балансом, нехватка видна до нажатия, ролик раз в сутки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0325-gem-continue-shell.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0324. Второй шанс за самоцветы — сервер: цена от начатых минут по курсу звёзд, списание и выдача одной транзакцией, книга продолжений; реклама — одно продолжение в сутки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0324-gem-continue-server.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0321. Итог забега — самая долгая серия без попаданий и без убийств, убийства по стихиям; приём и проверка правдоподобия на сервере](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0321-run-result-streaks-and-element-kills.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0317. Сервер принимает запись для проверки — PUT к своему забегу, проверка формы и размера, хранение 7 дней, дольше — у проверенных](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0317-run-proof-server.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0311. Батл-пасс — сервер: месяц по Москве, очки пасса за задания, 30 ступеней в двух лентах, забор награды, VIP-лента и пройденное до покупки VIP](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0311-battle-pass-server.md) | claude-10 / sonnet-5.5 / extra | — |
| [T-0302. sim-worker — отдельный процесс со своей сборкой движка: очередь проверки и симуляции черновика контента, отчёт против текущей версии](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0302-sim-worker.md) | claude-14 / sonnet-5.5 / extra | — |
| [T-0301. Снимок контента ContentSnapshot — весь контент одним объектом со схемой, проверки контента чистой функцией, движок и бот принимают снимок](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0301-content-snapshot.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0298. Раскладка для ПК, основа — с 1024 px боковое меню вместо нижнего, шапка с кошельком, две колонки экрана, листы становятся панелями сбоку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0298-desktop-shell-rail.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0296. Экран рейтинга v2 — очки вместо времени, пьедестал топ-3, стиль у имени, «Ты» и «до следующего места», дивизион и «Твой стиль»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0296-rating-screen-v2.md) | claude-lead-1 / sonnet-5.5 / high | — |
| [T-0295. Дивизионы сезона по доле доски и стиль игрока — сильнейшая ось лучшего забега, «Твой стиль» с подсказкой, что поднимет слабую ось](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0295-rating-divisions-and-style.md) | claude-lead-1 / sonnet-5.5 / high | — |
| [T-0294. Доски рейтинга по очкам — общая, сезонная, друзья и скрытая; лучший забег периода, порог награды сезона в очках, переход с нового сезона](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0294-rating-boards-by-points.md) | claude-lead-1 / sonnet-5.5 / extra | — |
| [T-0293. Очки эффективности на сервере — пять осей против ожидаемого, стиль забега, веса ключами панели, пересчёт прошлых забегов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0293-rating-run-score-server.md) | claude-lead-1 / sonnet-5.5 / extra | — |
| [T-0292. Итог забега для очков — журнал охоты (сколько жила каждая элита и босс) и оценка сборки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0292-run-result-hunt-and-build.md) | claude-lead-1 / sonnet-5.5 / medium | — |
| [T-0291. Рейтинг эффективности — таблица ожидаемого E(S, t): новый выход balance:sim по полосам силы и минутам забега](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0291-rating-expected-table.md) | claude-lead-1 / sonnet-5.5 / high | — |
| [T-0280. Пролог — оболочка: первый запуск без меню, подсказки по событию, «Советуем», окно «Рубеж удержан!» и открытие разделов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0280-prologue-shell.md) | claude-lead-1 / sonnet-5.5 / extra | — |
| [T-0279. Пролог — сервер: запись забега-пролога, награда один раз, признак «пролог пройден» и открытие награды дня и заданий](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0279-prologue-server.md) | claude-lead-1 / sonnet-5.5 / extra | — |
| [T-0278. Пролог первого забега — движок: таймлайн трёх минут, оберег 25 %, большой первый сундук, «Советуем» и победа над Стражем](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0278-prologue-engine.md) | claude-lead-1 / sonnet-5.5 / extra | — |
| [T-0272. Пакет promo-kit — документ промо-материала, форматы, подстановка кода и ссылки, правила правки партнёром](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0272-promo-kit-model.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0260. Тайники рубежа — облик на канве, радар, круг стояния и окно благословения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0260-secrets-look-and-blessing.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0259. Тайники рубежа — древо-оберег и разлом Нави](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0259-secrets-tree-and-rift.md) | claude-42 / sonnet-5.5 / high | — |
| [T-0258. Тайники рубежа — движок: размещение по кольцам, капище, клад, камень-указатель, огонёк](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0258-secrets-engine-core.md) | claude-14 / sonnet-5.5 / extra | — |
| [T-0234. Музыка в игре — лобби, пульс забега, слой босса и регулятор громкости](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0234-music-playback.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0233. Музыка — три круга кодом по брифу — лобби, пульс забега и слой босса](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0233-music-tracks.md) | не указан | — |
| [T-0232. Итоги забега — окно-реликвия, как сундук и уровень](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0232-run-results-relic.md) | claude-lead-1 / sonnet-5.5 / medium | — |
| [T-0231. Больше трёх вкладок — строкой с прокруткой и подчёркиванием, а не сеткой 2×2](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0231-tabs-row-over-three.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0230. Черновой арт — тестерам флагом панели, с выключателем в «Графике»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0230-draft-art-testers-flag.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0229. Поле `size` у врага — радиус крупнее или мельче паттерна](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0229-enemy-size-field.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0228. Отчёт «Нажатия» в панели — что нажимают на каждом экране](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0228-ui-clicks-report.md) | claude-1 / sonnet-5.5 / medium | — |
| [T-0227. Имена всех кнопок, вкладок и переключателей оболочки — и `track` обязателен](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0227-ui-track-ids-all-screens.md) | claude-16 / haiku-5.5 / medium | — |
| [T-0226. Событие нажатий `ui_clicked` — разметка встроена в кнопки, вкладки и переключатели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0226-ui-clicked-event.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0224. Показы партнёрских заданий — событие `task_shown` при открытии экрана заданий](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0224-partner-task-impressions.md) | claude-10 / haiku-5.5 / medium | — |
| [T-0216. Уровни ролей — администратор выдаёт роли ниже своей](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0216-role-levels.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0213. Раскадровка эффекта и замеры — `pnpm fx:frames <сцена>`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0213-fx-frames-and-metrics.md) | claude-10 / sonnet-5.5 / medium | — |
| [T-0212. Сцена эффекта по адресу — `?fx=<сцена>` на dev-сервере, шаг по тикам для снимков](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0212-fx-scene-by-url.md) | claude-10 / sonnet-5.5 / medium | — |
| [T-0211. Колокольчик обновляется сразу после экрана друзей, предмета и журнала](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0211-bell-refresh-after-actions.md) | claude-16 / haiku-5.5 / medium | — |
| [T-0210. Уведомления гаснут своим действием — друзья, подарки, предмет, журнал](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0210-notifications-read-by-action.md) | claude-1 / sonnet-5.5 / medium | — |
| [T-0209. Готовые промты потоков с номером аккаунта — на доске и в `pnpm task streams`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0209-flow-prompts-per-account.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0208. «Вклад» на доске — задачи, доработки, ревью, спецификации и PR тимлидов по периодам](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0208-board-contribution-periods.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0207. Строки «Поток» и «Запустил» в описании PR задачи — проверяет pr-check](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0207-pr-runner-and-launcher-lines.md) | claude-16 / haiku-5.5 / medium | — |
| [T-0206. Доска — в «В работе» и «На ревью» видно, кто, сколько висит и чего ждёт](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0206-board-work-review-columns.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0205. Доска — кто кого ждёт, вид `owner` и счётчики сверху](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0205-board-who-waits-owner-runner.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0204. Архив задач — готовые и отменённые в `tasks/archive/`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0204-tasks-archive-folder.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0202. Флак выгрузки — ENOENT во временном каталоге, потоки не закрываются при ошибке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0202-export-test-enoent-flake.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0201. Фильтр ников — латинские имена не ловятся корнем после транслитерации](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0201-display-name-latin-names.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0200. Панель за CDN Bunny — Caddy, тесты и документы; зона и DNS ставит тимлид](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0200-admin-behind-cdn.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0198. Уборка кода вражеских снарядов — снаряд врага уходит из пула, отрисовки и сигналов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0198-remove-enemy-projectile-code.md) | claude-lead-1 / sonnet-5.5 / medium | — |
| [T-0197. Второй босс без снарядов — «Таран» вместо ушедшего Вещуна](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0197-second-boss-no-projectiles.md) | claude-10 / sonnet-5.5 / medium | — |
| [T-0196. Подстройка под силу — калибровка, слабое устройство в оболочке, аналитика и приём на сервере](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0196-player-power-pressure-wiring.md) | claude-lead-1 / sonnet-5.5 / high | — |
| [T-0195. Сила игрока и подстройка директора — движок и контент](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0195-player-power-pressure-engine.md) | claude-46 / sonnet-5.5 / high | — |
| [T-0194. «Предел» — бесконечные малые прибавки, когда прокачивать нечего](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0194-limit-break-offers.md) | claude-45 / sonnet-5.5 / high | — |
| [T-0193. Прокачка до 15-й минуты — кривая опыта, уровни навыков, поздние сундуки, слоты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0193-longer-run-progression.md) | claude-41 / sonnet-5.5 / high | — |
| [T-0192. Давление после 8-й минуты — единая сложность тяжелее «Сложной»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0192-pressure-after-minute-8.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0191. Одна сложность на сервере — рейтинг с чистого листа](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0191-single-difficulty-server.md) | claude-10 / sonnet-5.5 / extra | — |
| [T-0190. Одна сложность у игрока — без выбора, первый забег обучающий](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0190-single-difficulty-shell.md) | claude-10 / sonnet-5.5 / high | — |
| [T-0189. Порядок слайдов главной перетаскиванием в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0189-admin-home-slides-order.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0188. «Что нового» скрыт у игроков до пересмотра журнала](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0188-hide-changelog-for-players.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0187. Строки свойств предмета — значение не переносится, прибавка видна и при малом шаге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0187-item-stat-rows-narrow.md) | claude-16 / haiku-5.5 / medium | — |
| [T-0186. Итоги забега — все кнопки видны без прокрутки, прокрутка одна](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0186-death-screen-pinned-actions.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0185. Модалки и листы — поверх шапки и нижней панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0185-modal-layer-above-chrome.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0184. Политика источников пускает сборки Яндекса и стили RichAds — вторая волна цепочек рекламы](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0184-csp-ad-chains-yandex-richads-styles.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0182. Аналитика кольца — событие исхода (прорвался, выстоял, погиб)](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0182-cordon-ring-analytics.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0181. Прямая ссылка на Mini App для рекламы AdsGram — метки сети в стартовом параметре и конверсия по запуску](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0181-direct-ad-link-network-label.md) | claude-51 / sonnet-5.5 / extra | — |
| [T-0180. Панель «Ссылки» — автоисточники: пометка «авто», название, скрытие и сводка незнакомых меток](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0180-links-panel-auto-sources.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0179. Авторазбор стартовых параметров ключ-значение — автоисточники и сводка незнакомых ключей](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0179-start-param-pairs-auto-sources.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0177. Штраф за отписку — заготовки: списание награды, срочное закрытие, уведомление](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0177-unsubscribe-penalty-building-blocks.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0176. Лента живых событий — клиент: строка на главной под «Играть»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0176-live-feed-client.md) | claude-10 / sonnet-5.5 / high | — |
| [T-0174. Лента живых событий — сервер: запись настоящих событий за сутки, кэш, маршрут](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0174-live-feed-backend.md) | claude-10 / sonnet-5.5 / high | — |
| [T-0173. Положение радара в настройках игрока — справа сверху, слева сверху, выключен](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0173-radar-position-setting.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0172. Уход огонька и кастера — в бою нет врагов со снарядами](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0172-remove-shooting-enemies.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0171. Страж кольца и кольца в таймлайне — контент, гайдбук, калибровка](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0171-cordon-guard-content.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0170. Кольцо стражей — движок: событие таймлайна, паттерн строя, непроходимое тело](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0170-cordon-ring-engine.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0169. Порядок заданий у игрока — по состоянию, внутри по порядку из панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0169-player-tasks-panel-order.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0168. Порядок рекламных сетей в круге — перетаскиванием вместо числа](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0168-admin-ad-networks-order.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0167. Порядок заданий перетаскиванием — SortableList в панели и запрос порядка](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0167-admin-sortable-list-tasks-order.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0166. Узкие экраны: время в плитке награды, имя в заявке в друзья, срез в витрине](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0166-narrow-screen-leftovers.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0165. Гард панели экспортирует AdminModule, счётчик онлайна — один сервис](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0165-panel-guard-export-single-online-service.md) | claude-1 / sonnet-5.5 / high | — |
| [T-0164. Тесты «61-й запрос — 429» не падают на смене минуты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0164-readiness-test-fixed-clock.md) | claude-15 / haiku-5.5 / low | — |
| [T-0163. Забег, прерванный обновлением игры, засчитывается, а не пропадает](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0163-settle-run-interrupted-by-update.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0162. Юзернейм бота в имени и bio — модуль на сервере: проверка, награда, серия, ночной проход](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0162-bot-mention-module.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0160. Задания «юзернейм бота в имени и в bio» — блок на экране заданий и события](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0160-bot-mention-client.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0159. Юзернейм бота в имени и bio — порт площадки BotMentions и getChat у Telegram](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0159-bot-mention-server.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0157. Донаты проекту — сервер: оплата любой суммой, выдача знака, ключи панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0157-donations-backend.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0156. Панель — сводка заблокированных адресов клиента](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0156-csp-reports-panel.md) | claude-16 / haiku-5.5 / medium | — |
| [T-0155. Отчёты политики источников — директива в политике и приём со сводкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0155-csp-reports-intake.md) | claude-1 / sonnet-5.5 / high | — |
| [T-0154. Политика источников пускает цепочки SDK рекламы и Google Fonts](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0154-csp-ad-sdk-chains.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0153. Ники без ссылок и упоминаний, словарь мата точнее](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0153-display-name-links-and-roots.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0152. Бот калибровки с задержкой реакции и ограниченным вниманием](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0152-imperfect-balance-bot.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0151. Ник в панели — исходник, ручная смена с закреплением, длинные ники в списке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0151-admin-player-rename.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0150. Ник чистится при входе — исходник для панели, закрепление, чистка старых](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0150-display-name-on-login.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0149. Чистка ников — символы, длина, мат, замена пустого](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0149-display-name-cleaning.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0147. Счётчик онлайна — бэкенд: активность, пинг, подсчёт, ключи настроек](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0147-online-counter-backend.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0146. «pnpm task check» сверяет метку и заголовок из раздела «PR» с шапкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0146-task-check-pr-section.md) | claude-7 / haiku-5.5 / medium | — |
| [T-0145. Снимки экранов одной командой — `pnpm screens`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0145-screens-one-command.md) | claude-1 / sonnet-5.5 / medium | — |
| [T-0144. Вход разработчика игроком без ролей — `dev-player-<id>`](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0144-dev-login-as-player.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0143. Проверка PR — номер в сводке, путь задачи, сводка не в коде, трейлеры коммитов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0143-pr-check-summary-task-trailers.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0142. Бюджет экранов — порог на самый большой экран, сумма — предупреждением](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0142-budget-largest-screen-chunk.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0141. Хост Referer без порта — проверки доступности отсекаются и с портом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0141-referer-host-without-port.md) | claude-1 / haiku-5.5 / medium | — |
| [T-0140. Две подписки VIP одновременно — продление остаётся у одной](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0140-vip-double-subscription-tie.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0139. Полный прогон интеграционных тестов проходит и на Windows](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0139-integration-tests-on-windows.md) | claude-1 / sonnet-5.5 / medium | — |
| [T-0138. Меню панели на телефоне открывается прокрученным к открытому разделу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0138-admin-menu-scroll-on-open.md) | claude-9 / haiku-5.5 / low | — |
| [T-0137. Индекс досмотров по времени завершения — для ряда сводки панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0137-ad-session-completed-index.md) | claude-1 / sonnet-5.5 / medium | — |
| [T-0136. Подсказки к параметрам снаряжения — что значит каждый](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0136-stat-hints.md) | claude-7 / haiku-5.5 / medium | — |
| [T-0135. Карточка предмета — «было → станет» перед улучшением](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0135-item-upgrade-preview.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0134. Счёт за второй шанс проверяет ограничение «Покупки»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0134-continue-invoice-purchases-restriction.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0133. Панель — подпись «отдельной доски» в журнале и сверка списка оружия с контентом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0133-admin-audit-board-label-and-weapon-sync.md) | claude-15 / haiku-5.5 / low | — |
| [T-0132. Дата начала сезонов не в прошлом — проверка при сохранении и потолок догона](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0132-season-start-date-guard.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0128. Напоминания через бота: обогнали в сезоне, сезон закрывается, награда дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0128-bot-reminders.md) | claude-lead-1 / sonnet-5.5 / extra | — |
| [T-0125. Итог забега: счётчики боссов, элит, сундуков и кристаллов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0125-run-result-rank-chest-crystal-counters.md) | claude-1 / sonnet-5.5 / high | — |
| [T-0124. Рубеж — цель забега, оболочка: баннеры, «до рубежа N с», отметка в рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0124-rubezh-banners-and-death-screen.md) | claude-lead-1 / sonnet-5.5 / high | — |
| [T-0121. Рубеж — цель забега, сервер: проверка победы, награда ×2, отметка в рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0121-rubezh-win-reward-server.md) | claude-lead-1 / sonnet-5.5 / high | — |
| [T-0120. Рубеж — цель забега, движок: страж на отметке, победа в итоге забега](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0120-rubezh-guard-engine.md) | claude-lead-1 / sonnet-5.5 / high | — |
| [T-0118. Седьмое оружие «Метеор» и его эволюция «Огненный ливень»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0118-seventh-weapon-meteor-and-evolution.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0117. Враги в духе Vampire Survivors: два рядовых и элита](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0117-vampire-survivors-enemies.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0116. Подбор «Заморозка»: враги на поле замирают на 10 секунд](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0116-freeze-pickup.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0115. Метка «Отдельная доска» в сводке, воронке и разборе забегов в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0115-board-label-in-reports.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0114. Сезон и награды за места по доске зрителя, призы только внутриигровые](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0114-season-rewards-by-viewer-board.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0113. Доски рейтинга по зрителю: полная и общая, место и профиль по доске смотрящего](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0113-boards-by-viewer.md) | claude-14 / sonnet-5.5 / extra | — |
| [T-0112. Скрытое ограничение «Отдельная доска»: вид, право, панель](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0112-separate-board-restriction.md) | claude-1 / sonnet-5.5 / high | — |
| [T-0111. Недельный сезон — экран рейтинга: вкладки «Неделя», «Всё время», «Друзья», награды и таймер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0111-weekly-season-screen.md) | claude-10 / sonnet-5.5 / high | — |
| [T-0110. Недельный сезон рейтинга — сервер: таблица недели, закрытие, награды, друзья](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0110-weekly-season-server.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0109. Экран смерти — блок «Что дальше» с двумя-тремя ближайшими целями](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0109-death-whats-next.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0108. Лестница открытий — оружие и навыки по уровням 2–14, а не все к шестому](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0108-unlock-ladder.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0107. Витрина достижений: категории, редкость, любимые и престиж в профиле и рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0107-achievements-showcase-shell.md) | claude-10 / sonnet-5.5 / high | — |
| [T-0106. Достижения с престижем: сервер, 49 определений, редкость «есть у N%»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0106-achievements-prestige-server.md) | claude-44 / sonnet-5.5 / extra | — |
| [T-0105. Очки заданий: полоса дня и недели и награды за ступени очков](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0105-task-points-and-rewards.md) | claude-14 / sonnet-5.5 / extra | — |
| [T-0104. Задания: пул с ротацией по дням и недели и шесть новых видов цели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0104-tasks-pool-rotation-new-kinds.md) | claude-1 / sonnet-5.5 / high | — |
| [T-0103. Рецепты эволюций в игре: подсказка на карточке, гайдбук, значок готовности](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0103-weapon-evolution-recipes-in-game.md) | claude-12 / sonnet-5.5 / medium | — |
| [T-0102. Эволюции оружия: рецепты в контенте и выдача сундуком](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0102-weapon-evolutions-data-and-engine.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0101. Переброс, пропуск и изгнание карточек на выборе улучшения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0101-card-reroll-skip-banish.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0100. Сундук забега: окно открытия с «барабаном» и списком полученного](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0100-run-chest-window.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0099. Сундук забега: падает с элиты и босса, открывает 1, 3 или 5 улучшений](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0099-run-chest-engine.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0098. «Задания» открываются на вкладке, где ждёт награда](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0098-tasks-open-claimable-tab.md) | claude-7 / haiku-5.5 / medium | — |
| [T-0097. Радар забега — наверх, аптечки на нём зелёные](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0097-radar-top-green-medkit.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0096. Убрать тень под врагами](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0096-enemy-no-shadow.md) | claude-7 / haiku-5.5 / medium | — |
| [T-0095. «Очаг» не звучит на каждый такт ауры](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0095-hearth-no-tick-sound.md) | claude-9 / haiku-5.5 / low | — |
| [T-0094. Лист «Перед забегом»: отмеченная плитка справа не даёт боковой прокрутки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0094-prerun-no-sideways-scroll.md) | claude-7 / haiku-5.5 / medium | — |
| [T-0093. Подписка Xray для прокси — хранение, обновление, контейнер Xray, раздел панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0093-xray-subscription-backend.md) | claude-lead-1 / sonnet-5.5 / extra | — |
| [T-0092. Пакет proxy-kit — разбор подписки Xray, конфиг спутника, пул узлов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0092-proxy-kit-package.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0091. Ссылки Telegram собираются в одном месте — подготовка к смене домена](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0091-telegram-link-single-point.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0090. QR входа на https, домен ссылок Telegram — настройкой в панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0090-telegram-link-host-and-qr-https.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0089. Пропуск рекламы VIP — отдельной меткой «Пропуск VIP», не досмотр](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0089-vip-ad-pass-mark.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0088. Внешняя проверка прода без ложных тревог и без записи развёртывания на каждый прогон](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0088-uptime-no-false-alarms-no-deployments.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0087. Карточка разбора забега ведёт в панель, а комментарии о маршруте и боте говорят правду](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0087-stale-route-and-bot-texts.md) | claude-9 / haiku-5.5 / low | — |
| [T-0086. Два теста охраны проверяют то, что обещают: публичность готовности и тревогу 5xx в полной сборке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0086-guard-tests-readiness-and-alarm.md) | claude-1 / haiku-5.5 / medium | — |
| [T-0085. Первый выкат на чистый сервер проходит без --no-backup](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0085-first-deploy-clean-server.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0084. Тесный `SegmentedControl`: подписи сжимаются на узком экране, без обёрток снаружи](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0084-segmented-small.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0083. `Modal`: закреплённый подвал при прокручиваемом теле](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0083-modal-pinned-footer.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0082. Список игроков — пустой «Статус» не остаётся подписью без значения в карточке](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0082-players-list-empty-status.md) | claude-9 / haiku-5.5 / low | — |
| [T-0081. Друзья — на узком экране кнопки заявки и «Подарить» значками, имя читается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0081-friends-narrow-peer-actions.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0080. Колесо — на кнопке бесплатной крутки загрузка идёт до остановки колеса](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0080-wheel-free-button-loading-until-stop.md) | claude-9 / haiku-5.5 / low | — |
| [T-0079. Второй шанс — ролик главной кнопкой, звёзды второй, как в макете](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0079-death-ad-primary-button.md) | claude-7 / haiku-5.5 / medium | — |
| [T-0078. Событие continue_offered уходит после ответа проверок, а не при открытии шага](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0078-continue-offered-after-answers.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0077. «Повторить» на плашке связи отвечает, даже если код проверки не загрузился](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0077-connection-retry-chunk-failure.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0076. «Друзья»: крупное приглашение не мелькает, пока экран грузится](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0076-friends-no-invite-flash.md) | claude-7 / haiku-5.5 / medium | — |
| [T-0075. Награда дня сама обновляется на смене суток по Москве](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0075-daily-reload-on-midnight.md) | claude-7 / haiku-5.5 / medium | — |
| [T-0074. Тест лимита приёмника событий не зависит от границы минуты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0074-events-limit-test-clock.md) | claude-9 / haiku-5.5 / low | — |
| [T-0073. Проверки доступности не считаются кликами; клики без класса устройства — отдельной строкой](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0073-availability-checks-not-clicks.md) | claude-1 / sonnet-5.5 / high | — |
| [T-0071. Постбэки — покупки и возврат на следующий день, выбор событий у назначения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0071-postback-events-and-selection.md) | claude-53 / sonnet-5.5 / high | — |
| [T-0070. Постбэки в s2s-сети и партнёру — шаблон адреса, click_id и sub1…sub5](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0070-postback-s2s-and-partner.md) | claude-52 / sonnet-5.5 / extra | — |
| [T-0069. Постбэки — слой «событие → назначение», AdsGram первым назначением](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0069-postback-destinations-layer.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0068. Воронка партнёра — по его ссылкам, кодам и площадкам](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0068-partner-funnel.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0067. Ссылки партнёра — ссылка кампании с владельцем-партнёром, привязка игрока по первому входу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0067-partner-links-and-binding.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0066. Карточка партнёра — TG id, статус, страна, валюта и способ выплаты, процент](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0066-partner-card-fields-and-status.md) | claude-6 / sonnet-5.5 / extra | — |
| [T-0065. Прокси для исходящих запросов — список в панели, перебор после неудачи напрямую](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0065-outbound-proxies.md) | claude-14 / sonnet-5.5 / extra | — |
| [T-0064. Курсы руками — «Обновить сейчас» у источника и запасной ручной курс любой валюты](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0064-fx-refresh-now-and-fallback-rates.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0063. CoinMarketCap — новый источник курсов; необязательные ключи tonapi и erapi](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0063-coinmarketcap-and-optional-keys.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0062. Лимиты источников курсов в панели — сколько осталось, правка лимита и счётчика, предупреждения](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0062-fx-source-limits-panel.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0061. Раздел «Запросы» в панели — исходящие вызовы и сводка входящих](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0061-requests-panel-section.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0060. Журнал запросов — исходящие по вызову, входящие сводкой по маршрутам, 7 дней](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0060-request-journal-storage.md) | claude-1 / sonnet-5.5 / extra | — |
| [T-0059. Один клиент исходящих запросов — все вызовы внешних API через него](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0059-outbound-http-client.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0058. Переходник ссылок открывает Telegram диплинком — с запасным t.me](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0058-redirect-deeplink-page.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0057. Цель ссылки и прямые ссылки — Mini App, бот или лендинг, с переходником и без](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0057-link-target-and-direct-links.md) | claude-6 / sonnet-5.5 / extra | — |
| [T-0056. Вход в панель по QR и диплинку — запрос со страницей, без лишнего перехода](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0056-panel-login-qr-deeplink.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0055. Выключатели внешних скриптов клиента в панели — Graspil, учёт аудитории, всё сразу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0055-external-scripts-switches.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0054. Карточка игрока вкладками — шапка с действиями, «Сводка» на один взгляд](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0054-player-card-tabs.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0053. Воронка в панели — полосами, сравнение с прошлым периодом, подсветка источников](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0053-funnel-chart-screen.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0052. Сводка панели — плитка и панель рекламы, вехи полосами, периоды — экран](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0052-overview-ads-and-periods-screen.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0051. Сводка панели — реклама, периоды 7 и 30 дней, покупки в ряду — сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0051-overview-ads-and-periods-api.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0050. Подтверждения в панели по цене ошибки — окно действия и «Отменить»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0050-admin-confirm-and-undo.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0049. Каркас панели — меню со значками и поиском, телефон, таблицы карточками](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0049-admin-shell-responsive.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0048. Экран друзей — список первым, полоса бонуса и «Подарить всем»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0048-friends-screen-layout.md) | claude-5 / sonnet-5.5 | — |
| [T-0047. «Подарить всем» — подарок каждому другу одним запросом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0047-gift-all-friends-api.md) | claude-5 / sonnet-5.5 | — |
| [T-0046. Магазин в облике «Сумеречный рубеж» — по макету](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0046-shop-twilight-look.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0045. Экран смерти в два шага — сначала второй шанс, потом итоги](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0045-death-screen-two-steps.md) | claude-5 / sonnet-5.5 | — |
| [T-0044. «Перед забегом» одним листом — два касания до боя вместо четырёх](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0044-pre-run-sheet.md) | claude-5 / sonnet-5.5 | — |
| [T-0043. Окно «Спасибо за тест» и знак «Тестер» в профиле, у друзей и в рейтинге](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0043-thanks-for-testing-window.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0042. Компенсация после вайпа — выдача по кнопке и признак «Тестер» в ответах](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0042-compensation-claim-and-tester-flag.md) | claude-6 / sonnet-5.5 / extra | — |
| [T-0041. Команда вайпа — подсчёт, снимок и стирание одной транзакцией](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0041-wipe-command.md) | claude-6 / sonnet-5.5 | — |
| [T-0040. Снимок перед вайпом — что вернуть тестеру и какой бонус дать](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0040-tester-compensation-snapshot.md) | claude-6 / sonnet-5.5 | — |
| [T-0039. План вайпа — у каждой таблицы решение «стираем» или «оставляем»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0039-wipe-plan.md) | claude-5 / sonnet-5.5 | — |
| [T-0038. Кнопки «Выдать» и «Вернуть звёзды» у покупки в карточке игрока](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0038-support-purchase-actions-panel.md) | claude-13 / sonnet-5.5 / high | — |
| [T-0037. Поддержка возвращает звёзды и повторяет выдачу покупки — сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0037-support-refund-and-refulfill-api.md) | claude-6 / sonnet-5.5 / extra | — |
| [T-0036. Свежий бэкап базы перед каждым выкатом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0036-backup-before-deploy.md) | claude-5 / sonnet-5.5 | — |
| [T-0035. Тревога в чат команды о всплеске ошибок 5xx](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0035-server-error-alarm.md) | claude-5 / sonnet-5.5 | — |
| [T-0034. Внешняя проверка прода раз в 5 минут и тревога в чат команды](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0034-uptime-check.md) | claude-3 / sonnet-5.5 | — |
| [T-0033. Проверка готовности API — /health/ready смотрит базу и Redis](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0033-health-ready.md) | claude-3 / sonnet-5.5 | — |
| [T-0032. Роли владельца и администратора выдаются только с подтверждением в Telegram](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0032-confirm-privileged-roles-in-telegram.md) | claude-5 / sonnet-5.5 | — |
| [T-0031. API панели отвечает только на домене панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0031-admin-api-only-on-admin-domain.md) | claude-4 / sonnet-5.5 | — |
| [T-0030. Отзыв без подписи запуска — строже лимит и потолок карточек в чат](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0030-unsigned-feedback-limits.md) | claude-3 / sonnet-5.5 | — |
| [T-0029. Досмотр рекламы через SDK засчитывается не раньше порога из панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0029-ad-min-view-time.md) | claude-5 / sonnet-5.5 | — |
| [T-0028. Награда за друга не теряется, если начисление упало](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0028-referral-reward-not-lost.md) | claude-5 / sonnet-5.5 | — |
| [T-0027. Обновления бота не теряются при перезапуске — сначала очередь, потом ответ](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0027-bot-updates-via-queue.md) | claude-6 / sonnet-5.5 | — |
| [T-0025. Вторая подписка VIP не оплачивается и не продлевается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0025-vip-no-double-subscription.md) | claude-6 / sonnet-5.5 | — |
| [T-0024. После возврата звёзд покупки аккаунту закрыты, команда получает карточку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0024-refund-closes-purchases.md) | claude-6 / sonnet-5.5 / extra | — |
| [T-0023. Возврат звёзд забирает то, что осталось от покупки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0023-refund-revokes-remainder.md) | claude-6 / sonnet-5.5 | — |
| [T-0022. Лимиты частоты на маршрутах игрока, где их не было](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0022-rate-limits-on-open-routes.md) | claude-5 / sonnet-5.5 | — |
| [T-0021. Маршруты с правами — только в панели, дубли под токеном игры убраны](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0021-remove-duplicate-privileged-routes.md) | claude-3 / sonnet-5.5 | — |
| [T-0020. Бот говорит «идёт тест» и отвечает на обычное сообщение](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0020-bot-texts-and-reply.md) | claude-3 / sonnet-5.5 | — |
| [T-0019. Бот больше не пишет о каждой новой версии](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0019-no-bot-version-message.md) | claude-3 / sonnet-5.5 | — |
| [T-0018. Статусы задач в эпиках, страница доски и вклад по аккаунтам GitHub](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0018-board-page-and-epic-badges.md) | claude-2 / sonnet-5.5 | — |
| [T-0017. Подписи у всех вкладок нижней панели, если помещаются](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0017-tab-labels-when-fit.md) | claude-3 / sonnet-5.5 | — |
| [T-0016. Пересчёт значков не отменяется пустыми прогонами](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0016-task-board-concurrency.md) | claude-2 / sonnet-5.5 | — |
| [T-0015. Общая плашка «Нет связи с сервером»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0015-connection-banner.md) | claude-5 / sonnet-5.5 | — |
| [T-0014. Вид боя — красная гамма по угрозе, тени и новые цвета мира](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0014-battle-look-threat-colors.md) | claude-2 / sonnet-5.5 | — |
| [T-0013. Срезанный угол с рамкой по срезу у главного на экране](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0013-cut-corners.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0012. Палитра, шрифты и скругления направления «Сумеречный рубеж»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0012-twilight-tokens-and-fonts.md) | claude-2 / sonnet-5.5 | — |
| [T-0011. Живые значки статуса задач и проверка захвата в CI](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0011-task-board-badges.md) | claude-2 / sonnet-5.5 | — |
| [T-0010. Разрешение боту писать — после первого забега и в настройках](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0010-bot-write-access.md) | claude-5 / sonnet-5.5 / high | — |
| [T-0009. Выход везде и блокировка сразу закрывают выданные токены доступа](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0009-revoke-access-tokens.md) | claude-5 / sonnet-5.5 | — |
| [T-0008. Свечение кнопок и значков — позади, а не поверх](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0008-glow-behind-not-over.md) | claude-3 / sonnet-5.5 / medium | — |
| [T-0007. Точные и тикающие отсчёты «через сколько» на главной и в награде дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0007-countdown-precision.md) | claude-3 / sonnet-5.5 | — |
| [T-0006. Кнопка бесплатной крутки не оживает во время крутки за рекламу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0006-wheel-free-button-during-ad.md) | claude-3 / sonnet-5.5 | — |
| [T-0005. Обереги и снаряды рисуются так, как бьёт симуляция](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0005-orbiters-and-projectiles-render.md) | claude-2 / sonnet-5.5 | — |
| [T-0004. Внешние возвраты через очередь и сигнал о брошенном задании](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0004-payments-refunds-via-queue.md) | claude-6 / sonnet-5.5 | — |
| [T-0003. Оплаченное всегда выдаётся или возвращается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0003-payments-fulfillment-sweeper.md) | claude-2 / sonnet-5.5 | — |
| [T-0002. Команда pnpm task — доска, захват и проверка зон](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0002-task-cli.md) | claude-2 / sonnet-5.5 | — |
| [T-0001. Наборы магазина только из самоцветов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/archive/T-0001-shop-gems-only-bundles.md) | claude-2 / sonnet-5.5 | — |

## Вклад

Наглядность, а не формула выплат: доли участников проекта назначает владелец (`docs/11-revenue-split.md` §3). Время — МСК.

Нет данных GitHub: список влитых PR не получен — показаны только спецификации.

### Сегодня

Пусто.

<details>
<summary>Вчера</summary>

| Кто | Задачи | Очки | Доработки | Ревью и ответы | Спецификации | PR тимлидов |
|---|---|---|---|---|---|---|
| claude-lead-1 · — | 0 | 0 | 0 | 0 | 2 | 0 |

</details>

### Неделя

| Кто | Задачи | Очки | Доработки | Ревью и ответы | Спецификации | PR тимлидов |
|---|---|---|---|---|---|---|
| claude-lead-1 · — | 0 | 0 | 0 | 0 | 3 | 0 |

<details>
<summary>Месяц</summary>

| Кто | Задачи | Очки | Доработки | Ревью и ответы | Спецификации | PR тимлидов |
|---|---|---|---|---|---|---|
| claude-lead-1 · — | 0 | 0 | 0 | 0 | 19 | 0 |

</details>

<details>
<summary>Всё время</summary>

| Кто | Задачи | Очки | Доработки | Ревью и ответы | Спецификации | PR тимлидов |
|---|---|---|---|---|---|---|
| claude-lead-1 · — | 0 | 0 | 0 | 0 | 253 | 0 |
| claude-lead2-1 · — | 0 | 0 | 0 | 0 | 3 | 0 |
| claude-lead2-10 · — | 0 | 0 | 0 | 0 | 2 | 0 |
| claude-lead2-11 · — | 0 | 0 | 0 | 0 | 2 | 0 |
| claude-lead2-12 · — | 0 | 0 | 0 | 0 | 2 | 0 |
| claude-lead2-13 · — | 0 | 0 | 0 | 0 | 3 | 0 |
| claude-lead2-14 · — | 0 | 0 | 0 | 0 | 3 | 0 |
| claude-lead2-15 · — | 0 | 0 | 0 | 0 | 2 | 0 |
| claude-lead2-16 · — | 0 | 0 | 0 | 0 | 4 | 0 |
| claude-lead2-17 · — | 0 | 0 | 0 | 0 | 4 | 0 |
| claude-lead2-18 · — | 0 | 0 | 0 | 0 | 6 | 0 |
| claude-lead2-19 · — | 0 | 0 | 0 | 0 | 7 | 0 |
| claude-lead2-2 · — | 0 | 0 | 0 | 0 | 3 | 0 |
| claude-lead2-20 · — | 0 | 0 | 0 | 0 | 2 | 0 |
| claude-lead2-21 · — | 0 | 0 | 0 | 0 | 2 | 0 |
| claude-lead2-22 · — | 0 | 0 | 0 | 0 | 2 | 0 |
| claude-lead2-3 · — | 0 | 0 | 0 | 0 | 1 | 0 |
| claude-lead2-4 · — | 0 | 0 | 0 | 0 | 1 | 0 |
| claude-lead2-5 · — | 0 | 0 | 0 | 0 | 5 | 0 |
| claude-lead2-6 · — | 0 | 0 | 0 | 0 | 4 | 0 |
| claude-lead2-7 · — | 0 | 0 | 0 | 0 | 2 | 0 |
| claude-lead2-8 · — | 0 | 0 | 0 | 0 | 4 | 0 |
| claude-lead2-9 · — | 0 | 0 | 0 | 0 | 1 | 0 |

</details>
