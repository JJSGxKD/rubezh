import { mountAppShell } from "@bh/app-shell";
import { CONTENT_HASH } from "@bh/core-game";
import { VkAdapter } from "@bh/adapter-vk";

/**
 * Точка входа vk-сборки. Адаптер — заглушка до портирования после
 * публичного лонча в Telegram (docs/02-roadmap.md, «Приоритет платформ»);
 * оболочка при этом собирается и работает: она о площадке ничего не знает и
 * получает от заглушки честные умолчания.
 */
const container = document.getElementById("app");

if (container === null) {
  throw new Error("Нет контейнера #app в разметке");
}

void mountAppShell({
  container,
  adapter: new VkAdapter(),
  build: {
    version: import.meta.env.VITE_APP_VERSION ?? "dev",
    contentHash: CONTENT_HASH,
    platform: "vk",
  },
  capabilities: { platformAvailable: true, botUrl: "" },
});
