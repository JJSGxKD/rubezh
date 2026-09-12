// Публичная поверхность симуляции. Ничего из Phaser здесь не импортируется:
// весь этот слой обязан запускаться headless (docs/17-testing-strategy.md §3.0).
export * from "./rng";
export * from "./grid";
export * from "./world";
export * from "./step";
export * from "./spawner";
export * from "./events";
export * from "./vector";
export * from "./pools";
