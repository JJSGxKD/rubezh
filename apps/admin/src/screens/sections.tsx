import type { ReactNode } from "react";

/**
 * Экраны разделов по идентификатору из `SECTIONS` (routes.ts). `id` —
 * объект раздела из адреса: игрок, отчёт; `null` — список.
 */
export const SECTION_SCREENS: Record<string, (id: string | null) => ReactNode> = {};
