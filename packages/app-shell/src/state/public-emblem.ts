import { z } from "zod/mini";

/**
 * Знак у имени в строке списка (рейтинг, сезон, друзья): тот же вид, что
 * `PublicEmblem` в `shared-types` (tasks/T-0240). Отдельным маленьким модулем:
 * схему строки рейтинга читает первая загрузка, а остальной клиент знаков
 * (`emblems-api.ts`) ей не нужен.
 */
export const publicEmblemSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** редкость предметов или отдельный тон `team` / `partner` */
  tier: z.string(),
  category: z.enum(["status", "season", "merit"]),
  /** порядковый номер сезона — только у сезонного знака */
  season: z.optional(z.number()),
});

export type PublicEmblemView = z.infer<typeof publicEmblemSchema>;
