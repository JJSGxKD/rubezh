import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { ignoreDotenvNodeEnvForBuild } from "../../scripts/vite/production-node-env.ts";
import { adminContentSecurityPolicy } from "./src/csp.ts";

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
  const policy = (policyMode: "dev" | "build") => ({
    headers: { "content-security-policy": adminContentSecurityPolicy(policyMode) },
  });

  return {
    plugins: [react(), tailwindcss()],
    base: "./",
    envDir: repoRoot,
    server: { ...common, ...policy("dev") },
    preview: { ...common, ...policy("build") },
    build: { outDir: "dist" },
  };
});
