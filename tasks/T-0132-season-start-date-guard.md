---
id: T-0132
title: Дата начала сезонов не в прошлом — проверка при сохранении и потолок догона
epic: E16
priority: P1
status: done
owner: claude-3 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/admin/admin-settings.service.ts
  - backend/api/src/modules/seasons/season-rules.ts
  - backend/api/src/modules/seasons/seasons-schedule.ts
  - backend/api/test/settings.test.ts
  - backend/api/test/seasons.test.ts
  - backend/api/test/seasons.integration.test.ts
shared:
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 2
---

# T-0132. Дата начала сезонов не в прошлом — проверка при сохранении и потолок догона

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0132.json)](README.md#значки-статуса)

## Зачем

Ключ `seasons.start-date` (T-0110) принимает любой понедельник начиная с 1000
года. Если задать дату в прошлом, задание закрытия пройдёт по всем неделям между
ней и сегодняшним днём. При настоящих забегах в этих окнах оно выдаст награды
задним числом. Находка ревью #327 (`tasks/inbox.md`, 14.10). Закрыть до
включения сезонов.

## Решения

Решение `claude-lead-1` от 14.10.2026, защита в два слоя:

1. **При сохранении из панели** дата раньше понедельника текущей недели (UTC)
   отклоняется. Текст: «Старт сезонов не может быть в прошлом — укажите
   понедельник этой или следующей недели». `0` (выключено) разрешён всегда.
2. **Потолок догона в задании закрытия** — `MAX_CATCH_UP_WEEKS = 2`. Задание
   закрывает только сезоны, которые кончились не раньше двух недель назад.
   Более старые незакрытые сезоны пропускаются: в лог уходит строка
   `season_backfill_capped` с числом пропущенных. Слой защищает и от даты,
   заданной в обход панели (окружение, база), и от долгого простоя сервера.
   Пропустить награду безопаснее, чем раздать её пачкой задним числом.

Интеграционный тест истории сезонов (`seasons.integration.test.ts`, «не больше
восьми закрытых сезонов») закрывал десять недель одним вызовом `closeDue` —
с потолком догона так закрываются только две. Тест закрывает неделю за
неделей, как работает задание, поэтому файл в зонах. Строка
`season_backfill_capped` пишется на каждом проходе, пока старые сезоны
остаются незакрытыми, — так и задумано: это сигнал, что дату задали в обход
панели или сервер долго стоял (ответ claude-lead2-1 на вопрос PR #358,
17.10.2026).

## Как сейчас

- `backend/api/src/modules/settings/setting-catalog.ts:311–326` — `seasonsStartDate`:
  схема проверяет только формат (`parseStartDate`), про текущую дату не знает.
  `SettingDefinition` (строка 35) — без проверки при сохранении.
- `backend/api/src/modules/admin/admin-settings.service.ts:44–48` — `save`:
  `setting.schema.safeParse(raw)`, ошибка — `ValidationError` с заголовком
  настройки.
- `backend/api/src/modules/seasons/season-rules.ts:61–65` — `dueSeasons(start, now)`:
  все недели от `start` до `now` без ограничения.
- `backend/api/src/modules/seasons/seasons-schedule.ts:30` — расписание отдаёт
  `dueSeasons(start, now)` заданию закрытия.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`SettingDefinition`** — необязательное поле с комментарием «проверка,
   которой нужно текущее время, — только при сохранении из панели»:
   `readonly saveCheck?: (value: T, now: Date) => string | null`.
3. **`seasonsStartDate.saveCheck`**: `0` — `null`; иначе `parseStartDate(value)`
   раньше понедельника недели `now` — текст из «Решений».
4. **`AdminSettingsService.save`** — после разбора схемы
   `setting.saveCheck?.(parsed.data, now)`; не `null` — `ValidationError` с
   заголовком настройки, как у ошибки схемы. Время — тем же источником, каким
   сервис уже пользуется. Если его нет — параметр часов с умолчанием `() => new Date()`,
   по образцу соседних сервисов.
5. **`season-rules.ts`** — `export const MAX_CATCH_UP_WEEKS = 2`;
   `dueSeasons(start, now)` отдаёт только сезоны с концом не раньше
   `now − MAX_CATCH_UP_WEEKS × неделя` и вторым значением — число отброшенных:
   `{ due: Season[]; skipped: number }`. Вызовы обновить.
6. **`seasons-schedule.ts`** — при `skipped > 0` строка лога уровня warn:
   `{ module: "seasons", event: "season_backfill_capped", skipped }`.
7. **`docs/30-configuration-map.md`** — в строке `seasons.start-date` дописать:
   «не в прошлом; догон — не больше двух недель».

## Чего не трогаем

- Правила наград, порогов и мест, закрытие под локом, таблицы сезона (T-0110).
- Остальные ключи каталога: `saveCheck` у них не появляется.
- Экран рейтинга (T-0111).

## Тесты

- `seasons.test.ts`:
  - `dueSeasons(start, now)`: `start` три недели назад → в `due` только два
    последних закончившихся сезона, `skipped: 1`;
  - `start` на текущей неделе → `due` пуст, `skipped: 0`;
  - граница: сезон кончился ровно две недели назад — попадает в `due`.
- `settings.test.ts` (через `AdminSettingsService.save`, по образцу кейса `ads.interstitial.every-runs`):
  - сохранить `seasons.start-date` с понедельником прошлой недели → `ValidationError`
    с текстом из «Решений»;
  - понедельник текущей недели и следующей → сохраняется;
  - `0` → сохраняется;
  - формат «не понедельник» — прежняя ошибка схемы.

## Аналитика

Нет. Строка лога `season_backfill_capped` — для команды, не событие.

## Настройки и окружение

Нет новых ключей и переменных.

## Документы

`docs/30-configuration-map.md` — шаг 7.

## Критерии приёмки

- [ ] Дату раньше понедельника текущей недели панель не сохраняет, текст —
  дословно из «Решений»; `0` сохраняется всегда.
- [ ] Задание закрытия не закрывает сезоны старше двух недель и пишет
  `season_backfill_capped`.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `fix(api): Старт сезонов не в прошлом и потолок догона`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЕЗОНЫ НЕ ЗАКРОЮТСЯ ЗАДНИМ ЧИСЛОМ**

  Дату начала недельных сезонов больше нельзя поставить в прошлое, а задание закрытия догоняет не больше двух недель. Иначе дата в прошлом раздала бы награды за все прошедшие недели разом.
  ```
