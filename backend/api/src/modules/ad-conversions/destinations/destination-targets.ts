import { Prisma } from "../../../generated/prisma/client.js";

/**
 * Единственная точка, где запросы прохода узнают, кому и что отправлять
 * (tasks/T-0069, docs/35-stage4-plan.md Р86, Р96).
 *
 * CTE `targets(link_code, destination, events, since)`: у какой ссылки какие
 * назначения, какие события каждое получает и с какого момента — клики
 * раньше `since` назначению не отдаются. Ветка на назначение, ветки
 * соединяются `UNION ALL`: запросы прохода при этом не меняются.
 *
 * Список событий — подмножество того, что назначение принимает
 * (`PostbackDestination.accepts`): сверх принимаемого сервис всё равно
 * пропустит.
 *
 * Третья ветка (T-0070) — адреса постбэка: у ссылки без владельца-партнёра
 * свой адрес — назначение `s2s`, у ссылки партнёра — `partner`. Действует
 * адрес ссылки, а если его нет, общий адрес партнёра; события и момент
 * `postback_since` берутся у того объекта, чей адрес действует. Ссылка
 * AdsGram со своим адресом получает обе строки назначений.
 *
 * Прямой запуск `l-<код>` клика не оставляет, а `click_id` и `sub` на нём
 * взять неоткуда: проход по прямым запускам отбирает из набора только
 * назначения рекламных сетей (`direct-launch-sweep.ts`), `s2s` и `partner`
 * получают строки лишь по кликам.
 *
 * `TARGETS_SELECT` — сам запрос набора, `TARGETS_CTE` — он же под именем `targets`: тест оборачивает запрос в свой
 * отбор ссылок, чтобы его проходы не задевали ссылки соседних тестов в общей базе.
 */
export const TARGETS_SELECT: Prisma.Sql = Prisma.sql`
    SELECT l.code, 'adsgram'::text, ARRAY['registration', 'purchase_first', 'purchase_repeat']::text[], '-infinity'::timestamptz
    FROM link l
    WHERE l.network = 'adsgram'
    UNION ALL
    SELECT l.code,
           CASE WHEN l.partner_id IS NULL THEN 's2s' ELSE 'partner' END,
           (CASE WHEN l.postback_url IS NOT NULL THEN l.postback_events ELSE p.postback_events END)::text[],
           CASE WHEN l.postback_url IS NOT NULL THEN l.postback_since ELSE p.postback_since END
    FROM link l
    LEFT JOIN partner p ON p.partner_id = l.partner_id
    WHERE l.postback_url IS NOT NULL OR p.postback_url IS NOT NULL
  `;

/** Тот же набор как именованное CTE: запросы прохода подставляют его первым в `WITH`. */
export const TARGETS_CTE: Prisma.Sql = Prisma.sql`targets(link_code, destination, events, since) AS (${TARGETS_SELECT})`;
