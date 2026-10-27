# Сторонние источники справок скиллов

Справочные файлы рядом со скиллами `ui-design`, `game-art`, `game-sound`,
`game-design` и `growth` — пересказ и адаптация чужих открытых материалов под
правила проекта (`docs/18-ai-skills.md` §4). Текст переписан своими словами
под наш стек, игру и Telegram, код не взят. Скрипты, бинарники, хуки и
загрузка правил по сети из этих источников **не используются**.

Материалы использованы на условиях их лицензий. Для Apache License 2.0:
работа производная, изменения — перевод, сокращение и адаптация под проект;
полный текст лицензии — <https://www.apache.org/licenses/LICENSE-2.0>. Для
MIT: уведомление об авторских правах ниже, текст лицензии —
<https://opensource.org/license/mit>.

| Источник | Лицензия | Правообладатель | Что взято | Куда |
|---|---|---|---|---|
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Apache 2.0 | Copyright 2025 Paul Bakaus | разбор по эвристикам, состояния и крайние случаи, полировка, онбординг, тексты, движение | `ui-design/critique.md`, `states.md`, `ux-writing.md`, `onboarding-and-ethics.md`, `motion.md` |
| [szilu/ux-designer-skill](https://github.com/szilu/ux-designer-skill) | MIT | Copyright (c) 2026 Szilárd Hajba | законы UX, эмоциональный и этичный дизайн, онбординг, уведомления, производительность, i18n | `ui-design/critique.md`, `states.md`, `ux-writing.md`, `onboarding-and-ethics.md`, `motion.md` |
| [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) | MIT | Copyright (c) 2025 Vercel Labs | правила «обязательно и никогда» для интерфейса | `ui-design/states.md` §5, `motion.md` |
| [anthropics/skills](https://github.com/anthropics/skills) — `frontend-design` | Apache 2.0 | Anthropic (в `LICENSE.txt` без отдельной строки) | раздел о текстах в интерфейсе | `ui-design/ux-writing.md` |
| [Donchitos/Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) | MIT | Copyright (c) 2026 Donchitos | проверка HUD, ступени доступности, отчёт плейтеста, честная монетизация | `ui-design/hud.md`, `game-art/game-feel.md`, `game-design/playtest.md`, `monetization-and-retention.md`, `growth/offers-and-monetization.md` |
| [omer-metin/skills-for-antigravity](https://github.com/omer-metin/skills-for-antigravity) | Apache 2.0 | Vibeship (vibeforge1111), по README | игровой интерфейс, приёмы отклика, этика монетизации | `ui-design/hud.md`, `game-art/game-feel.md` |
| [abagames/agentic-gamedev-skills](https://github.com/abagames/agentic-gamedev-skills) | MIT | Copyright (c) 2026 abagames | ощущение игры, читаемость экрана, политики проверки баланса, инварианты, поиск расхождения, звуковые наборы | `game-art/game-feel.md`, `game-design/combat-balance.md`, `invariants.md`, `loops-and-pacing.md`, `game-sound/*` |
| [gamesdesigners-source/agent-game-design-skills](https://github.com/gamesdesigners-source/agent-game-design-skills) | MIT | Copyright (c) 2026 Game Design Skills contributors | экономика, прогрессия, баланс боя, встречи, монетизация, симуляция плейтеста | `game-design/*` |
| [fagemx/gstack-game](https://github.com/fagemx/gstack-game) | MIT | Copyright (c) 2026 fagemx | проход по ощущению, проверка баланса, плейтест, давление монетизации | `game-art/game-feel.md`, `game-design/*` |
| [dannyjpwilliams/ui-sound-design-skill](https://github.com/dannyjpwilliams/ui-sound-design-skill) | MIT | Copyright (c) 2026 Danny Williams | словарь «описание → параметры», рецепты, правила Web Audio, ревью | `game-sound/*` |
| [opusgamelabs/game-creator](https://github.com/opusgamelabs/game-creator) | MIT по README и описаниям скиллов (файла LICENSE нет) | OpusGameLabs | только общие принципы микширования и звука | `game-sound/catalog.md`, `engineering.md` |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | MIT | Copyright (c) 2025 Corey Haines | тексты, редактура, психология, запуск, канал, рефералка, офферы, цены, экран покупки, онбординг, возврат, A/B-тесты | `growth/*` |

Не взяты: `nextlevelbuilder/ui-ux-pro-max-skill` (база стилей под SaaS),
`Leonxlnx/taste-skill` (запреты спорят с материалами реликвии),
`fcsouza/agent-skills` (GPL несовместима с лицензией репозитория),
`mae616/design-skills` (слабее szilu).

Обновление справки по новой версии источника — правка через PR с
пересмотром: молчаливых обновлений нет (`docs/18` §5).
