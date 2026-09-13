import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { clientRolldownOptions } from "../../scripts/vite/chunking.ts";
import { ignoreDotenvNodeEnvForBuild } from "../../scripts/vite/production-node-env.ts";
import { stableDevSession } from "../../scripts/vite/stable-dev-session.ts";

// Корень монорепо — единственный .env на весь проект (см. docs/20-env-and-ports.md).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Платформа определяется на этапе сборки через --mode, не в рантайме —
// см. docs/01-tech-stack.md §1. Порт задаётся переменной WEB_VK_PORT, чтобы
// три dev-сервера можно было держать поднятыми одновременно; strictPort
// намеренно включён — занятый порт должен падать явно, а не молча уезжать
// на соседний (docs/20-env-and-ports.md §2).
export default defineConfig(({ mode, command }) => {
  ignoreDotenvNodeEnvForBuild(command);
  const env = loadEnv(mode, repoRoot, "");
  const port = Number(env.WEB_VK_PORT ?? 5175);

  // Адрес туннеля frp, если он поднят: Telegram не открывает http://localhost
  // как Mini App, нужен публичный HTTPS (docs/20-env-and-ports.md §4).
  //
  // Сервер при этом продолжает слушать только петлю — наружу его выводит frpc.
  // Это сознательно: host: true отдал бы dev-сборку всей локальной сети.
  const tunnelHost = (env.DEV_TUNNEL_VK_HOST ?? "").trim();
  const tunnelServerOptions =
    tunnelHost === ""
      ? {}
      : {
          // Без этого Vite отклонит запрос с чужим заголовком Host
          allowedHosts: [tunnelHost],
          // HMR идёт на тот же домен по wss через 443 — иначе клиент стучится
          // на localhost телефона и молча остаётся без обновлений
          hmr: { protocol: "wss" as const, host: tunnelHost, clientPort: 443 },
        };

  return {
    // stableDevSession — без перезагрузки страницы на обрыве связи с dev-сервером
    // (scripts/vite/stable-dev-session.ts).
    plugins: [react(), tailwindcss(), stableDevSession()],
    base: "./",
    envDir: repoRoot,
    server: {
      port,
      strictPort: true,
      ...tunnelServerOptions,
    },
    preview: {
      port,
      strictPort: true,
      ...(tunnelHost === "" ? {} : { allowedHosts: [tunnelHost] }),
    },
    build: {
      outDir: "dist",
      // Одинаковая раскладка чанков на Windows и в CI (scripts/vite/chunking.ts).
      rolldownOptions: clientRolldownOptions,
    },
  };
});
