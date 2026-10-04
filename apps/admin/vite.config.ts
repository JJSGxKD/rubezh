import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { edgePolicyFile } from "../../scripts/vite/edge-policy.ts";
import { ignoreDotenvNodeEnvForBuild } from "../../scripts/vite/production-node-env.ts";
import { adminContentSecurityPolicy } from "./src/csp.ts";
import { originOf, previewUrl } from "../../scripts/vite/preview-origins.ts";

// Корень монорепо — единственный .env на весь проект (docs/20-env-and-ports.md).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Панель — десктопное приложение команды (docs/29-admin-panel.md §4). Порт —
// ADMIN_PORT из карты портов, strictPort: занятый порт падает явно.
//
// Слушаем только петлю и без туннеля: панель — это блокировки и начисления,
// ей нечего делать в локальной сети и на телефоне тестера. В API ходим
// только префиксом панели: в проде Caddy поддомена панели проксирует тот же
// префикс, поэтому запросы всегда на свой домен — без CORS, и cookie сессии
// с `SameSite=Strict` уходит сама.
export default defineConfig(({ mode, command }) => {
  ignoreDotenvNodeEnvForBuild(command);
  const env = loadEnv(mode, repoRoot, "");
  const port = Number(env.ADMIN_PORT ?? 5176);
  const apiTarget = `http://127.0.0.1:${Number(env.API_PORT ?? 4000)}`;

  const common = {
    port,
    strictPort: true,
    host: "127.0.0.1",
    proxy: { "/api/v1/admin": { target: apiTarget } },
  };
  // Страница предпросмотра клиента (WP32): на dev-сервере — петля с портом
  // клиента, в сборке — только явный адрес (scripts/vite/preview-origins.ts).
  const previewPage = previewUrl(env, command === "serve");
  const policy = (policyMode: "dev" | "build") => ({
    headers: { "content-security-policy": adminContentSecurityPolicy(policyMode, originOf(previewPage)) },
  });

  return {
    // Политика — ещё и файлом в сборку: в проде её ставит Caddy (scripts/vite/edge-policy.ts).
    plugins: [react(), tailwindcss(), edgePolicyFile(adminContentSecurityPolicy("build", originOf(previewPage)))],
    define: { __PREVIEW_URL__: JSON.stringify(previewPage) },
    base: "./",
    envDir: repoRoot,
    server: { ...common, ...policy("dev") },
    preview: { ...common, ...policy("build") },
    // Вес панели вторичен (решение участника 1, 01.10.2026: в панели берём
    // библиотеки форм и интерфейса ради скорости и удобства) — предупреждение
    // о крупном чанке для неё шум. Бюджет бандла — у игры (`pnpm budget`).
    build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
  };
});
