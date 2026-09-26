import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { clientRolldownOptions } from "../../scripts/vite/chunking.ts";
import { ignoreDotenvNodeEnvForBuild } from "../../scripts/vite/production-node-env.ts";
import { stableDevSession } from "../../scripts/vite/stable-dev-session.ts";
import { devServerConfig } from "../../scripts/vite/dev-server.ts";
import { contentSecurityPolicy } from "../../scripts/vite/content-security-policy.ts";
import { edgePolicyFile } from "../../scripts/vite/edge-policy.ts";

// Корень монорепо — единственный .env на весь проект (см. docs/20-env-and-ports.md).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Платформа определяется на этапе сборки через --mode, не в рантайме —
// см. docs/01-tech-stack.md §1. Порт задаётся переменной WEB_TELEGRAM_PORT, чтобы
// три dev-сервера можно было держать поднятыми одновременно; strictPort
// намеренно включён — занятый порт должен падать явно, а не молча уезжать
// на соседний (docs/20-env-and-ports.md §2).
export default defineConfig(({ mode, command }) => {
  ignoreDotenvNodeEnvForBuild(command);
  const env = loadEnv(mode, repoRoot, "");
  const port = Number(env.WEB_TELEGRAM_PORT ?? 5173);

  // Бэкенд за тем же доменом, что и клиент: телефон через туннель достаёт до
  // локального API без отдельного прокси и без CORS (docs/26-stage2-plan.md,
  // Р19). Проксируются только префиксы, которые сами защищены: вход — подписью
  // запуска и лимитом частоты, забеги, оплата, кошелёк, уровень и плейтест — токеном сессии, приёмники и
  // отзывы — выключателем, лимитами и Origin (docs/28-diagnostics.md §5.3), вебхук
  // бота — секретным токеном: через туннель машина разработчика может
  // принимать обновления и вебхуком. Остальное dev-API — роли, журнал —
  // наружу не выходит (docs/20-env-and-ports.md §4). Префикс, к которому ходит
  // клиент, но которого нет здесь, ловит scripts/test/dev-proxy.test.ts.
  const apiTarget = `http://127.0.0.1:${Number(env.API_PORT ?? 4000)}`;
  const apiProxy = Object.fromEntries(
    [
      "/api/v1/auth",
      "/api/v1/runs",
      "/api/v1/payments",
      "/api/v1/wallet",
      "/api/v1/progress",
      "/api/v1/playtest",
      "/api/v1/events",
      "/api/v1/diagnostics",
      "/api/v1/feedback",
      "/api/v1/bot",
    ].map((prefix) => [
      prefix,
      { target: apiTarget, changeOrigin: true },
    ]),
  );

  // Порт, туннель, HTTPS и доступ с телефона — общие для трёх площадок
  // (scripts/vite/dev-server.ts).
  // Аналитика Graspil — только со своим ключом: без него в политике нет ни
  // одного чужого скрипта (src/graspil.ts).
  const graspil = (env.VITE_GRASPIL_KEY ?? "").trim() !== "";
  const { server, preview } = devServerConfig({
    env,
    repoRoot,
    port,
    tunnelHostVar: "DEV_TUNNEL_TELEGRAM_HOST",
    proxy: apiProxy,
    graspil,
  });

  return {
    // React — для оболочки, Tailwind 4 — для токенов дизайн-системы
    // (docs/27-design-system-and-app-shell.md §1.4).
    // stableDevSession — без перезагрузки страницы на обрыве связи с dev-сервером
    // (scripts/vite/stable-dev-session.ts).
    // edgePolicyFile — та же политика файлом в сборку: в проде её ставит Caddy
    // (scripts/vite/edge-policy.ts).
    plugins: [
      react(),
      tailwindcss(),
      stableDevSession(),
      edgePolicyFile(contentSecurityPolicy({ mode: "build", apiOrigin: (env.VITE_API_URL ?? "").trim(), graspil })),
    ],
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
