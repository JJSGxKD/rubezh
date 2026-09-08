import Phaser from "phaser";
import type { PlatformAdapter } from "@bh/shared-types";
import { MainScene } from "./game/MainScene";

export * from "./content/enemies";
export * from "./content/waves";
export * from "./content/upgrades";

/**
 * Точка входа игры для любого apps/web-*. Платформа передаётся через
 * уже готовый адаптер — core-game сам ничего не знает о платформе.
 * См. docs/01-tech-stack.md §1.
 */
export function createGame(adapter: PlatformAdapter, parent: string): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 800,
    height: 600,
    scene: [MainScene],
  });

  adapter.init().then((user) => {
    console.log("Игрок авторизован:", user);
  });

  return game;
}
