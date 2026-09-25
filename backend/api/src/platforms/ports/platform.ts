/**
 * Площадки, на которых живёт игра. Домен знает только этот список, а не то,
 * как устроена каждая площадка (docs/35-stage4-plan.md, Р22, §3.11): всё,
 * что от неё зависит, — за портами рядом с этим файлом, адаптеры — в
 * `platforms/<площадка>/`.
 */
export const PLATFORM_IDS = ["telegram", "max", "vk", "web"] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];
