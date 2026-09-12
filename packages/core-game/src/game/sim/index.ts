// Публичная поверхность симуляции. Ничего из Phaser здесь не импортируется:
// весь этот слой обязан запускаться headless (docs/17-testing-strategy.md §3.0).
export * from "./rng";
export * from "./grid";
export * from "./directions";
export * from "./map-types";
export * from "./world";
export * from "./step";
export * from "./spawner";
export * from "./director";
export * from "./timeline";
export * from "./timeline-content";
export * from "./events";
export * from "./vector";
export * from "./pools";
export * from "./combat";
export * from "./gems";
export * from "./create-world";
