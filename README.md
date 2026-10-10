# Доска задач

Обновлено 10.10.2026 08:50 UTC. Страницу пересчитывает workflow `task-board.yml` после захвата, PR и мерджа — руками не править. Как брать задачу — [tasks/README.md](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/README.md#как-взять-задачу).

## Можно брать — 0

Пусто.

## В работе — 18

| Задача | Взял |
|---|---|
| [T-0004. Внешние возвраты через очередь и сигнал о брошенном задании](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0004-payments-refunds-via-queue.md) | claude-6 / sonnet-5.5 |
| [T-0039. План вайпа — у каждой таблицы решение «стираем» или «оставляем»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0039-wipe-plan.md) | claude-5 / sonnet-5.5 |
| [T-0033. Проверка готовности API — /health/ready смотрит базу и Redis](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0033-health-ready.md) | claude-3 / sonnet-5.5 |
| [T-0036. Свежий бэкап базы перед каждым выкатом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0036-backup-before-deploy.md) | claude-5 / sonnet-5.5 |
| [T-0009. Выход везде и блокировка сразу закрывают выданные токены доступа](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0009-revoke-access-tokens.md) | claude-5 / sonnet-5.5 |
| [T-0021. Маршруты с правами — только в панели, дубли под токеном игры убраны](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0021-remove-duplicate-privileged-routes.md) | claude-3 / sonnet-5.5 |
| [T-0028. Награда за друга не теряется, если начисление упало](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0028-referral-reward-not-lost.md) | claude-5 / sonnet-5.5 |
| [T-0029. Досмотр рекламы через SDK засчитывается не раньше порога из панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0029-ad-min-view-time.md) | claude-5 / sonnet-5.5 |
| [T-0030. Отзыв без подписи запуска — строже лимит и потолок карточек в чат](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0030-unsigned-feedback-limits.md) | claude-3 / sonnet-5.5 |
| [T-0031. API панели отвечает только на домене панели](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0031-admin-api-only-on-admin-domain.md) | claude-4 / sonnet-5.5 |
| [T-0019. Бот больше не пишет о каждой новой версии](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0019-no-bot-version-message.md) | claude-3 / sonnet-5.5 |
| [T-0020. Бот говорит «идёт тест» и отвечает на обычное сообщение](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0020-bot-texts-and-reply.md) | claude-3 / sonnet-5.5 |
| [T-0006. Кнопка бесплатной крутки не оживает во время крутки за рекламу](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0006-wheel-free-button-during-ad.md) | claude-3 / sonnet-5.5 |
| [T-0007. Точные и тикающие отсчёты «через сколько» на главной и в награде дня](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0007-countdown-precision.md) | claude-3 / sonnet-5.5 |
| [T-0044. «Перед забегом» одним листом — два касания до боя вместо четырёх](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0044-pre-run-sheet.md) | claude-5 / sonnet-5.5 |
| [T-0045. Экран смерти в два шага — сначала второй шанс, потом итоги](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0045-death-screen-two-steps.md) | claude-5 / sonnet-5.5 |
| [T-0017. Подписи у всех вкладок нижней панели, если помещаются](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0017-tab-labels-when-fit.md) | claude-3 / sonnet-5.5 |
| [T-0047. «Подарить всем» — подарок каждому другу одним запросом](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0047-gift-all-friends-api.md) | claude-5 / sonnet-5.5 |

## На ревью — 0

Пусто.

## Ждут — 19

| Задача | Чего ждёт |
|---|---|
| [T-0023. Возврат звёзд забирает то, что осталось от покупки](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0023-refund-revokes-remainder.md) | ждёт T-0004; ждёт T-0025; зоны пересекаются с T-0004 (в работе) |
| [T-0024. После возврата звёзд покупки аккаунту закрыты, команда получает карточку](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0024-refund-closes-purchases.md) | ждёт T-0023; зоны пересекаются с T-0004 (в работе) |
| [T-0025. Вторая подписка VIP не оплачивается и не продлевается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0025-vip-no-double-subscription.md) | зоны пересекаются с T-0004 (в работе) |
| [T-0037. Поддержка возвращает звёзды и повторяет выдачу покупки — сервер](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0037-support-refund-and-refulfill-api.md) | ждёт T-0024; зоны пересекаются с T-0004 (в работе) |
| [T-0038. Кнопки «Выдать» и «Вернуть звёзды» у покупки в карточке игрока](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0038-support-purchase-actions-panel.md) | ждёт T-0037 |
| [T-0027. Обновления бота не теряются при перезапуске — сначала очередь, потом ответ](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0027-bot-updates-via-queue.md) | ждёт T-0020; зоны пересекаются с T-0020 (в работе) |
| [T-0040. Снимок перед вайпом — что вернуть тестеру и какой бонус дать](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0040-tester-compensation-snapshot.md) | ждёт T-0039; зоны пересекаются с T-0039 (в работе) |
| [T-0041. Команда вайпа — подсчёт, снимок и стирание одной транзакцией](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0041-wipe-command.md) | ждёт T-0040; ждёт T-0036 |
| [T-0042. Компенсация после вайпа — выдача по кнопке и признак «Тестер» в ответах](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0042-compensation-claim-and-tester-flag.md) | ждёт T-0040; зоны пересекаются с T-0009 (в работе); зоны пересекаются с T-0047 (в работе) |
| [T-0034. Внешняя проверка прода раз в 5 минут и тревога в чат команды](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0034-uptime-check.md) | ждёт T-0033 |
| [T-0035. Тревога в чат команды о всплеске ошибок 5xx](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0035-server-error-alarm.md) | ждёт T-0033; зоны пересекаются с T-0033 (в работе) |
| [T-0022. Лимиты частоты на маршрутах игрока, где их не было](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0022-rate-limits-on-open-routes.md) | ждёт T-0021; зоны пересекаются с T-0021 (в работе) |
| [T-0032. Роли владельца и администратора выдаются только с подтверждением в Telegram](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0032-confirm-privileged-roles-in-telegram.md) | ждёт T-0020; зоны пересекаются с T-0020 (в работе) |
| [T-0010. Разрешение боту писать — после первого забега и в настройках](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0010-bot-write-access.md) | зоны пересекаются с T-0019 (в работе); зоны пересекаются с T-0044 (в работе) |
| [T-0008. Свечение кнопок и значков — позади, а не поверх](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0008-glow-behind-not-over.md) | ждёт T-0007; зоны пересекаются с T-0007 (в работе) |
| [T-0015. Общая плашка «Нет связи с сервером»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0015-connection-banner.md) | зоны пересекаются с T-0017 (в работе) |
| [T-0013. Срезанный угол с рамкой по срезу у главного на экране](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0013-cut-corners.md) | ждёт T-0008; ждёт T-0010; зоны пересекаются с T-0007 (в работе); зоны пересекаются с T-0044 (в работе); зоны пересекаются с T-0045 (в работе) |
| [T-0046. Магазин в облике «Сумеречный рубеж» — по макету](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0046-shop-twilight-look.md) | ждёт T-0013 |
| [T-0048. Экран друзей — список первым, полоса бонуса и «Подарить всем»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0048-friends-screen-layout.md) | ждёт T-0047 |

## Готово — 9

| Задача | Сделал | PR |
|---|---|---|
| [T-0018. Статусы задач в эпиках, страница доски и вклад по аккаунтам GitHub](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0018-board-page-and-epic-badges.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#217](https://github.com/JJSGxKD/rubezh/pull/217) |
| [T-0016. Пересчёт значков не отменяется пустыми прогонами](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0016-task-board-concurrency.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#216](https://github.com/JJSGxKD/rubezh/pull/216) |
| [T-0014. Вид боя — красная гамма по угрозе, тени и новые цвета мира](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0014-battle-look-threat-colors.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#224](https://github.com/JJSGxKD/rubezh/pull/224) |
| [T-0012. Палитра, шрифты и скругления направления «Сумеречный рубеж»](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0012-twilight-tokens-and-fonts.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#218](https://github.com/JJSGxKD/rubezh/pull/218) |
| [T-0011. Живые значки статуса задач и проверка захвата в CI](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0011-task-board-badges.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#213](https://github.com/JJSGxKD/rubezh/pull/213) |
| [T-0005. Обереги и снаряды рисуются так, как бьёт симуляция](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0005-orbiters-and-projectiles-render.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#222](https://github.com/JJSGxKD/rubezh/pull/222) |
| [T-0003. Оплаченное всегда выдаётся или возвращается](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0003-payments-fulfillment-sweeper.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#228](https://github.com/JJSGxKD/rubezh/pull/228) |
| [T-0002. Команда pnpm task — доска, захват и проверка зон](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0002-task-cli.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#211](https://github.com/JJSGxKD/rubezh/pull/211) |
| [T-0001. Наборы магазина только из самоцветов](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/T-0001-shop-gems-only-bundles.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#205](https://github.com/JJSGxKD/rubezh/pull/205) |

## Вклад

Очки — сумма размеров сделанных задач: S — 1, M — 2. Это наглядность, а не формула выплат: доли участников — `docs/11-revenue-split.md`.

| GitHub | Задач | Очков | Последний мердж |
|---|---|---|---|
| [@Kennix88](https://github.com/Kennix88) | 9 | 15 | 07.10.2026 |

| GitHub | Исполнитель | Задач | Очков |
|---|---|---|---|
| @Kennix88 | claude-2 / sonnet-5.5 | 9 | 15 |
