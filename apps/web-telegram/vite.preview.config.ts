import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { ignoreDotenvNodeEnvForBuild } from "../../scripts/vite/production-node-env.ts";
import { adminOrigins } from "../../scripts/vite/preview-origins.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Страница предпросмотра для панели (docs/35-stage4-plan.md WP32) — своей
 * сборкой в `dist/preview/`, а не вторым входом игры: общий с игрой модуль
 * сборщик вынес бы в общие чанки, и раскладка первой загрузки игры поехала
 * бы от страницы, которую игрок не открывает. Отдаёт её тот же сервер, что
 * игру; политика источников — общая (`csp.txt` основной сборки). На
 * dev-сервере страницу отдаёт основной сервер клиента (vite.config.ts).
 */
export default defineConfig(({ mode, command }) => {
  ignoreDotenvNodeEnvForBuild(command);
  const env = loadEnv(mode, repoRoot, "");
  return {
    plugins: [react(), tailwindcss()],
    root: fileURLToPath(new URL("./preview", import.meta.url)),
    base: "./",
    envDir: repoRoot,
    define: { __ADMIN_ORIGINS__: JSON.stringify(adminOrigins(env, false)) },
    build: { outDir: fileURLToPath(new URL("./dist/preview", import.meta.url)), emptyOutDir: true },
  };
});
