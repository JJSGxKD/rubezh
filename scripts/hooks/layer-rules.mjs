// Правила границ слоёв — один список на тест `scripts/test/layer-boundaries.test.ts`
// и хук `check-edit.mjs` (docs/35-stage4-plan.md, Р224 A): тест проверяет весь
// репозиторий, хук — один файл сразу после правки, а правила у них общие, чтобы
// не разойтись (CLAUDE.md, «Границы слоёв — жёсткие»; docs/15-engineering-standards.md §2.2).

/**
 * Что пакету запрещено импортировать.
 * @typedef {{ from: string, forbidden: RegExp, why: string }} Rule
 * @type {Rule[]}
 */
export const RULES = [
  {
    from: "packages/app-shell/src",
    forbidden: /["']@bh\/adapter-/,
    why: "оболочка не знает о площадках: адаптер приходит готовым объектом из apps/web-*",
  },
  {
    from: "packages/app-shell/src",
    forbidden: /["']phaser["']/i,
    why: "Phaser уходит отдельным чанком; прямой импорт затянул бы его в первую загрузку",
  },
  {
    from: "packages/app-shell/src",
    forbidden: /["']@bh\/core-game\//,
    why: "движок берётся только через публичный API index.ts, внутренности забега — не контракт",
  },
  {
    from: "packages/core-game/src",
    forbidden: /["']@bh\/app-shell/,
    why: "движок ничего не знает о том, кто и чем рисует меню",
  },
  {
    from: "packages/core-game/src",
    forbidden: /["']react/,
    why: "движок не знает о React: оболочка приходит к нему, а не наоборот",
  },
  {
    from: "packages/core-game/src",
    forbidden: /["']@bh\/adapter-/,
    why: "движок общается с площадкой только через PlatformAdapter из shared-types",
  },
  {
    from: "packages/shared-types/src",
    forbidden: /["']@bh\//,
    why: "shared-types — корень зависимостей и не импортирует ничего из монорепо",
  },
  {
    from: "packages/design-tokens/src",
    forbidden: /["']@bh\//,
    why: "токены дизайна — корень визуального стиля игры и панели и не зависят ни от чего в монорепо",
  },
  {
    from: "packages/fx/src",
    forbidden: /["']@bh\/|["']@nestjs\/|["']@prisma\/|generated\/prisma/,
    why: "ядро курсов самодостаточно: ни игры, ни Nest, ни Prisma — им станет отдельный сервис (docs/35-stage4-plan.md, Р32)",
  },
  {
    from: "packages/ledger/src",
    forbidden: /["']@bh\/|["']@nestjs\/|["']@prisma\/|generated\/prisma/,
    why: "ядро учёта переходит в другие проекты: ни игры, ни Nest, ни Prisma (docs/35-stage4-plan.md, Р98, Р219)",
  },
  {
    from: "packages/proxy-kit/src",
    forbidden: /["']@bh\/|["']@nestjs\/|["']@prisma\/|generated\/prisma/,
    why: "пакет проксирования переиспользуется в других проектах: ни игры, ни Nest, ни Prisma",
  },
  {
    from: "packages/promo-kit/src",
    forbidden: /["']@bh\/|["']@nestjs\/|["']@prisma\/|generated\/prisma|["']fabric["']/,
    why: "модель промо-материала переиспользуется панелью, кабинетом партнёра и другими проектами: ни игры, ни Nest, ни Prisma, ни Fabric (docs/35-stage4-plan.md, Р106, Р159)",
  },
  {
    from: "apps/admin/src",
    forbidden: /["']@bh\/(core-game|app-shell|adapter-)|["']phaser["']/i,
    why: "панель — отдельное приложение команды: ни движка, ни оболочки игры, ни площадок; с игрой её роднят только токены дизайна (docs/29-admin-panel.md §4)",
  },
  {
    from: "packages/core-game/src/content",
    forbidden: /["']\.\.\/game\//,
    why: "контент — это данные: он не знает о коде движка",
  },
  {
    from: "apps/sim-worker/src",
    forbidden: /["']@bh\/adapter-|["']phaser["']|["'](?:\.\.\/)+(?:backend|packages\/app-shell|apps\/admin)\/|["']@nestjs\/|["']@prisma\/|generated\/prisma/,
    why: "sim-worker — свой процесс со своей сборкой движка (docs/35-stage4-plan.md, Р15): ни бэкенда, ни площадок, ни оболочки, ни Phaser",
  },
  {
    from: "apps/sim-worker/src",
    forbidden: /["']@bh\/core-game["']|["']@bh\/core-game\/src\/(?:index|engine\/|game\/(?:MainScene|BenchScene|render\/|overlays\/|bench\/|diagnostics\/(?!replay["'])|joystick|radar))/,
    why: "движок берётся только симуляцией, балансом и контентом (`@bh/core-game/src/game/sim`, `game/balance`, `content`) и повтором забега (`game/diagnostics/replay`, без Phaser — это держит тест сборки в `apps/sim-worker/test/replay-job.test.ts`): index.ts и сцены тянут за собой Phaser в единственный файл сборки",
  },
];

/** Публичная дверь движка: только этот файл вправе тянуть Phaser в оболочке. */
export const ENGINE_ENTRY = "packages/core-game/src/index.ts";

export const ADAPTERS = ["telegram", "max", "vk"];

/** Бэкенд: домен не знает, на какой он площадке (docs/35-stage4-plan.md, Р22, §3.11). */
export const BACKEND_MODULES = "backend/api/src/modules";

/**
 * Инструменты команды, а не игра: карточки отчётов, сводка, выгрузка и
 * отзывы живут в чате администраторов в Telegram, и порт им не нужен.
 */
export const TEAM_TOOLS = new Set(["admin-notify", "export", "feedback"]);

/** Импорт адаптера площадки — `../../platforms/telegram/…` и старый `../telegram/…` — или библиотеки Bot API. */
export const PLATFORM_ADAPTER = /from ["'][./]*(?:platforms\/)?(?:telegram|max|vk)\/|["']grammy["']/;

/** Порты — контракт, а не реализация: ни адаптеров, ни домена. */
export const PORTS_FORBIDDEN = /from ["']\.\.\/(?:telegram|max|vk)\/|["'](?:\.\.\/)+modules\//;

/** Статический импорт Phaser в двери движка утащил бы полтора мегабайта в первую загрузку. */
export const ENGINE_STATIC_PHASER = /^import .*["']phaser["']/m;

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * Нарушения границ слоёв в одном файле: строки сообщений вида
 * «границы слоёв: путь:строка — причина». Путь — от корня репозитория, со слэшами.
 */
export function findLayerViolations(path, source) {
  const file = path.replace(/\\/g, "/");
  const found = [];
  const lines = source.split("\n");
  const report = (lineNumber, why) => found.push(`границы слоёв: ${file}:${lineNumber} — ${why}`);

  for (const rule of RULES) {
    if (!file.startsWith(`${rule.from}/`)) continue;
    const index = lines.findIndex((line) => rule.forbidden.test(line));
    if (index >= 0) report(index + 1, rule.why);
  }

  if (file === ENGINE_ENTRY) {
    const match = ENGINE_STATIC_PHASER.exec(source);
    if (match) report(lineOf(source, match.index), "index.ts движка не импортирует Phaser статически: за ним ходят через loadRunEngine()");
  }

  const adapter = /^packages\/adapter-([a-z]+)\/src\//.exec(file)?.[1];
  if (adapter) {
    for (const other of ADAPTERS.filter((name) => name !== adapter)) {
      const index = lines.findIndex((line) => line.includes(`@bh/adapter-${other}`));
      if (index >= 0) report(index + 1, `адаптеры не знают друг друга: adapter-${adapter} не импортирует adapter-${other}`);
    }
  }

  const backendModule = new RegExp(`^${BACKEND_MODULES}/([^/]+)/`).exec(file)?.[1];
  if (backendModule && !TEAM_TOOLS.has(backendModule)) {
    const index = lines.findIndex((line) => PLATFORM_ADAPTER.test(line));
    if (index >= 0) report(index + 1, `модуль ${backendModule} говорит с площадкой только через порты platforms/ports`);
  }
  if (file.startsWith("backend/api/src/platforms/ports/")) {
    const index = lines.findIndex((line) => PORTS_FORBIDDEN.test(line));
    if (index >= 0) report(index + 1, "порты не знают ни адаптеров, ни домена: это контракт, а не реализация");
  }
  return found;
}
