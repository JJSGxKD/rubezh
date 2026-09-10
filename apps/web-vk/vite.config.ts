import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

// Корень монорепо — единственный .env на весь проект (см. docs/20-env-and-ports.md).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Платформа определяется на этапе сборки через --mode, не в рантайме —
// см. docs/01-tech-stack.md §1. Порт задаётся переменной WEB_VK_PORT, чтобы
// три dev-сервера можно было держать поднятыми одновременно; strictPort
// намеренно включён — занятый порт должен падать явно, а не молча уезжать
// на соседний (docs/20-env-and-ports.md §2).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");

  return {
    base: "./",
    envDir: repoRoot,
    server: {
      port: Number(env.WEB_VK_PORT ?? 5175),
      strictPort: true,
    },
    preview: {
      port: Number(env.WEB_VK_PORT ?? 5175),
      strictPort: true,
    },
    build: {
      outDir: "dist",
    },
  };
});
