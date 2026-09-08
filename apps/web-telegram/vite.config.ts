import { defineConfig } from "vite";

// Платформа определяется на этапе сборки через --mode, не в рантайме —
// см. docs/01-tech-stack.md §1. Локаль: telegram поддерживает мультиязычность.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
  },
});
