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
 */
export const TARGETS_CTE: Prisma.Sql = Prisma.sql`targets(link_code, destination, events, since) AS (
    SELECT l.code, 'adsgram'::text, ARRAY['registration', 'purchase_first', 'purchase_repeat']::text[], '-infinity'::timestamptz
    FROM link l
    WHERE l.network = 'adsgram'
  )`;
