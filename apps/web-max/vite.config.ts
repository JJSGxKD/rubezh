import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { clientRolldownOptions } from "../../scripts/vite/chunking.ts";
import { ignoreDotenvNodeEnvForBuild } from "../../scripts/vite/production-node-env.ts";
import { stableDevSession } from "../../scripts/vite/stable-dev-session.ts";
import { devServerConfig } from "../../scripts/vite/dev-server.ts";

// Корень монорепо — единственный .env на весь проект (см. docs/20-env-and-ports.md).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Платформа определяется на этапе сборки через --mode, не в рантайме —
// см. docs/01-tech-stack.md §1. Порт задаётся переменной WEB_MAX_PORT, чтобы
// три dev-сервера можно было держать поднятыми одновременно; strictPort
// намеренно включён — занятый порт должен падать явно, а не молча уезжать
// на соседний (docs/20-env-and-ports.md §2).
export default defineConfig(({ mode, command }) => {
  ignoreDotenvNodeEnvForBuild(command);
  const env = loadEnv(mode, repoRoot, "");
  const port = Number(env.WEB_MAX_PORT ?? 5174);

  // Порт, туннель и прокси — общие для трёх площадок
  // (scripts/vite/dev-server.ts).
  const { server, preview } = devServerConfig({ env, port, tunnelHostVar: "DEV_TUNNEL_MAX_HOST" });

  return {
    // stableDevSession — без перезагрузки страницы на обрыве связи с dev-сервером
    // (scripts/vite/stable-dev-session.ts).
    plugins: [react(), tailwindcss(), stableDevSession()],
    base: "./",
    envDir: repoRoot,
    server,
    preview,
    build: {
      outDir: "dist",
      // Одинаковая раскладка чанков на Windows и в CI (scripts/vite/chunking.ts).
      rolldownOptions: clientRolldownOptions,
    },
  };
});
