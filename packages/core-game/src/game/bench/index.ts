// Инструментарий FPS-испытаний. Сама сцена стенда сюда не реэкспортируется:
// она грузится динамически, чтобы не попадать в основной бандл (см. index.ts).
export * from "./metrics";
export * from "./verdict";
export * from "./autopilot";
export * from "./profiles";
export * from "./types";
export * from "./sender";
export * from "./clipboard";
export * from "./degradation-detector";
