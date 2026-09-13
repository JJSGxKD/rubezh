import type { UserConfig } from "vite";

type RolldownOptions = NonNullable<NonNullable<UserConfig["build"]>["rolldownOptions"]>;

/**
 * Раскладка чанков клиентской сборки — одна на три площадки.
 *
 * Rolldown по умолчанию сливает общий чанк с уже существующим «входным»
 * (`mergeCommonChunks`), и входными для него считаются в том числе чанки
 * динамического импорта. Какой чанк он выберет, зависит от порядка модулей, и
 * на Windows и Linux выбор разный: в CI общие runtime-хелперы CommonJS, которыми
 * обёрнут React, уехали в чанк движка. Первая загрузка стала статически
 * импортировать чанк с Phaser — 453 КБ вместо 123, а локальная сборка на
 * Windows этого не показывала (docs/27-design-system-and-app-shell.md §3.4).
 *
 * Без слияния общие модули остаются отдельными маленькими чанками, и первая
 * загрузка не тянет за ними чанк движка. Остальные различия раскладки между
 * машинами остаются, поэтому бюджет всё равно проверяется в CI.
 */
export const clientRolldownOptions: RolldownOptions = {
  experimental: {
    chunkOptimization: { mergeCommonChunks: false },
  },
};
