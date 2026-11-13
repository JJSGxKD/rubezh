import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { checkCommand } from "../hooks/guard-command.mjs";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { checkWritePath } from "../hooks/guard-write.mjs";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { checkSource, SIM_FORBIDDEN_MATH } from "../hooks/check-edit.mjs";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { findLayerViolations } from "../hooks/layer-rules.mjs";

/**
 * Хуки-ограждения Claude Code (docs/35-stage4-plan.md, Р224 A; T-0473).
 *
 * Скрипты хуков проверяются так, как их зовёт Claude Code: JSON на stdin,
 * код выхода 2 — запрет (или находка после правки) с причиной в stderr, код 0 —
 * можно. Чистые функции проверяются отдельно: на них держится разбор команд.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOKS = join(ROOT, "scripts/hooks");

interface Run {
  status: number | null;
  stderr: string;
  stdout: string;
}

function runHook(script: string, input: string, env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [join(HOOKS, script)], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function bash(command: string, tool = "Bash"): Run {
  return runHook("guard-command.mjs", JSON.stringify({ tool_name: tool, tool_input: { command } }));
}

describe("guard-command: запрещённые команды дают код 2 и причину", () => {
  const denied: [string, string, RegExp][] = [
    ["npm install lodash", "Bash", /pnpm install/],
    ["npm i", "Bash", /pnpm/],
    ["npm ci", "PowerShell", /pnpm/],
    ["cd packages/app-shell && npm install", "Bash", /pnpm/],
    ["git push --force origin task/T-0001", "Bash", /--force/],
    ["git push -f", "Bash", /--force/],
    ["git push origin task/T-0001 --force-with-lease", "PowerShell", /--force/],
    ["git -C ../x push -f origin main", "Bash", /--force/],
    ["git push origin +task/T-0001", "Bash", /--force/],
    ["Remove-Item -Recurse -Force .claude/worktrees/wf_1", "PowerShell", /worktree remove --force/],
    ["Remove-Item .claude\\worktrees\\wf_1 -Recurse", "PowerShell", /rmdir/],
    ["ri -r -fo x", "PowerShell", /worktree remove/],
    ["rm -Recurse -Force x", "PowerShell", /worktree remove/],
    ['powershell -Command "Remove-Item -Recurse -Force x"', "Bash", /worktree remove/],
    ["echo KEY=1 > .env", "Bash", /\.env/],
    ["echo KEY=1 >> backend/api/.env", "Bash", /владелец/],
    ['echo KEY=1 > ".env"', "Bash", /\.env/],
    ["cat x | tee .env.local", "Bash", /\.env/],
    ['Set-Content -Path ".env" -Value "A=1"', "PowerShell", /\.env/],
    ["Add-Content .env 'A=1'", "PowerShell", /\.env/],
    ["'A=1' | Out-File -FilePath .env.production", "PowerShell", /\.env/],
    ["sed -i 's/A=1/A=2/' .env", "Bash", /\.env/],
    ["cp .env.example .env", "Bash", /\.env/],
    ["REDIS_URL=redis://localhost:6379/14 pnpm test", "Bash", /Redis 13/],
    ["DATABASE_URL=postgresql://u:p@localhost:5432/bullet_heaven pnpm --filter backend-api test", "Bash", /rubezh_test/],
    ["export TEST_DATABASE_URL=postgresql://u@h/bullet_heaven; pnpm exec vitest run", "Bash", /test-env\.sh/],
    ["npx some-random-package", "Bash", /npx/],
    ["npx -y cowsay hi", "Bash", /спросить/],
  ];

  for (const [command, tool, reason] of denied) {
    it(`${tool}: ${command}`, () => {
      const result = bash(command, tool);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(reason);
    });
  }
});

describe("guard-command: разрешённое проходит с кодом 0", () => {
  const allowed = [
    "pnpm install",
    "pnpm install --frozen-lockfile",
    "git push",
    "git push -u origin task/T-0473",
    "git push --set-upstream origin task/T-0473",
    "git worktree remove --force .claude/worktrees/wf_1",
    "cmd /c rmdir /s /q .claude\\worktrees\\wf_1",
    "Remove-Item tmp.txt",
    "Remove-Item -Path out.log -Force",
    "npx prisma migrate diff",
    "npx -y prisma@6 generate",
    "npx vitest run",
    "npx tsc --noEmit",
    "npx eslint .",
    "npx playwright test",
    "echo KEY=1 > .env.example",
    "cat .env",
    "grep -n KEY .env",
    "cp .env /tmp/x",
    "echo hi > /dev/null 2>&1",
    "REDIS_URL=redis://localhost:6379/13 pnpm test",
    "git push origin main:dev",
    "pnpm build",
    "npm run build",
    "REDIS_URL=redis://localhost:6379/14 pnpm dev",
  ];

  for (const command of allowed) {
    it(command, () => {
      expect(bash(command).status).toBe(0);
    });
  }

  it("текст запрета внутри сообщения коммита и here-doc не считается командой", () => {
    expect(bash('git commit -m "docs: Запрет npm install и git push --force"').status).toBe(0);
    expect(bash("git commit -m \"$(cat <<'EOF'\nfix: убрать npm install\n\ngit push --force не нужен\nEOF\n)\"").status).toBe(0);
    expect(bash("gh pr create --body 'тесты на redis://x/14, bullet_heaven' --title t").status).toBe(0);
  });

  it("чистая функция: null — можно, строка — причина", () => {
    expect(checkCommand("pnpm test")).toBeNull();
    expect(checkCommand("npm install")).toMatch(/pnpm install/);
    expect(checkCommand("")).toBeNull();
  });
});

describe("guard-write: правка .env и launch.json", () => {
  function write(filePath: string, tool = "Edit"): Run {
    return runHook("guard-write.mjs", JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath } }));
  }

  it(".env и .env.* запрещены, .env.example — нет", () => {
    for (const path of ["F:\\projects\\rubezh\\.env", "/repo/.env", "/repo/backend/api/.env.local", "C:\\x\\.env.production"]) {
      const result = write(path, "Write");
      expect(result.status, path).toBe(2);
      expect(result.stderr).toMatch(/\.env/);
    }
    expect(write("/repo/.env.example").status).toBe(0);
    expect(write("F:\\projects\\rubezh\\.env.example", "Write").status).toBe(0);
  });

  it("запрещён .claude/launch.json, но не соседние файлы", () => {
    expect(write("/repo/.claude/launch.json").status).toBe(2);
    expect(write("F:\\repo\\.claude\\launch.json", "Write").status).toBe(2);
    expect(write("/repo/.claude/settings.json").status).toBe(0);
    expect(write("/repo/docs/launch.json").status).toBe(0);
    expect(write("/repo/src/environment.ts").status).toBe(0);
  });

  it("чистая функция", () => {
    expect(checkWritePath("/repo/.env")).toMatch(/владелец/);
    expect(checkWritePath("/repo/a.ts")).toBeNull();
    expect(checkWritePath(undefined)).toBeNull();
  });
});

describe("сломанный вход не блокирует работу", () => {
  for (const script of ["guard-command.mjs", "guard-write.mjs", "check-edit.mjs"]) {
    it(`${script}: мусор вместо JSON, пустой ввод, чужая форма`, () => {
      for (const input of ["{не json", "", "null", "[]", '{"tool_input": 5}', '{"tool_name":"Bash"}']) {
        const result = runHook(script, input, { CLAUDE_HOOKS_SKIP_ESLINT: "1" });
        expect(result.status, `${script} ← ${JSON.stringify(input)}`).toBe(0);
      }
    });
  }
});

describe("check-edit: чистота симуляции", () => {
  const simFile = "packages/core-game/src/game/sim/foo.ts";

  it("находит Math.random в game/sim с номером строки и подсказкой", () => {
    const found: string[] = checkSource(simFile, "const a = 1;\nconst b = Math.random();\n");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/sim-purity: Math\.random в packages\/core-game\/src\/game\/sim\/foo\.ts:2/);
    expect(found[0]).toMatch(/инжектируемый/);
  });

  it("не трогает Math.random в game/render и в комментариях симуляции", () => {
    expect(checkSource("packages/core-game/src/game/render/fx.ts", "const a = Math.random();\n")).toEqual([]);
    expect(checkSource(simFile, "// не Math.random\n/* Date.now\n   Math.sin */\nconst a = 1;\n")).toEqual([]);
  });

  it("находит приближённую математику, часы и Phaser", () => {
    const text = [
      "import Phaser from \"phaser\";",
      "const a = Math.sin(1);",
      "const b = Date.now();",
      "const c = performance.now();",
      "const d = Math.hypot(1, 2);",
    ].join("\n");
    const found: string[] = checkSource("packages/core-game/src/game/weapons/x.ts", text);
    expect(found.join("\n")).toMatch(/Math\.sin .*:2/);
    expect(found.join("\n")).toMatch(/Date\.now .*:3/);
    expect(found.join("\n")).toMatch(/performance\.now .*:4/);
    expect(found.join("\n")).toMatch(/Math\.hypot .*:5/);
    expect(found.join("\n")).toMatch(/Phaser .*:1/);
  });

  it("покрывает те же каталоги, что sim-purity.test.ts", () => {
    for (const dir of ["sim", "patterns", "weapons", "progression", "run", "balance", "diagnostics"]) {
      const found: string[] = checkSource(`packages/core-game/src/game/${dir}/x.ts`, "Math.random();\n");
      expect(found.length, dir).toBe(1);
    }
    expect(checkSource("packages/core-game/src/game/bench/autopilot.ts", "Math.random();\n")).toHaveLength(1);
    expect(checkSource("packages/core-game/src/game/bench/other.ts", "Math.random();\n")).toEqual([]);
  });

  it("список запрещённой математики совпадает с sim-purity.test.ts — правила не расходятся", () => {
    const purity = readFileSync(join(ROOT, "packages/core-game/test/sim-purity.test.ts"), "utf8");
    expect(purity).toContain(SIM_FORBIDDEN_MATH.source);
  });
});

describe("check-edit: границы слоёв", () => {
  it("общий список правил — тот же, что читает layer-boundaries.test.ts", () => {
    const test = readFileSync(join(ROOT, "scripts/test/layer-boundaries.test.ts"), "utf8");
    expect(test).toMatch(/from "\.\.\/hooks\/layer-rules\.mjs"/);
  });

  it("оболочка не импортирует адаптеры, Phaser и внутренности движка", () => {
    const shell = "packages/app-shell/src/screens/Home.tsx";
    expect(findLayerViolations(shell, 'import x from "@bh/adapter-telegram";\n')).toHaveLength(1);
    expect(findLayerViolations(shell, 'import Phaser from "phaser";\n')).toHaveLength(1);
    expect(findLayerViolations(shell, 'import x from "@bh/core-game/src/game/sim/world";\n')).toHaveLength(1);
    expect(findLayerViolations(shell, 'import x from "@bh/core-game";\nimport y from "react";\n')).toEqual([]);
  });

  it("сообщение называет файл, строку и причину", () => {
    const [message] = findLayerViolations("packages/core-game/src/game/sim/x.ts", 'const a = 1;\nimport r from "react";\n');
    expect(message).toMatch(/границы слоёв: packages\/core-game\/src\/game\/sim\/x\.ts:2/);
    expect(message).toMatch(/React/);
  });

  it("контент не знает о коде движка, shared-types — о монорепо", () => {
    expect(findLayerViolations("packages/core-game/src/content/enemies.ts", 'import { a } from "../game/sim/x";\n')).toHaveLength(1);
    expect(findLayerViolations("packages/shared-types/src/index.ts", 'import { a } from "@bh/fx";\n')).toHaveLength(1);
    expect(findLayerViolations("packages/shared-types/src/index.ts", 'import { z } from "zod";\n')).toEqual([]);
  });

  it("адаптеры не знают друг друга; домен бэкенда не знает адаптеров площадок", () => {
    expect(findLayerViolations("packages/adapter-max/src/a.ts", 'import x from "@bh/adapter-vk";\n')).toHaveLength(1);
    expect(findLayerViolations("backend/api/src/modules/runs/runs.service.ts", 'import { B } from "../../platforms/telegram/bot";\n')).toHaveLength(1);
    expect(findLayerViolations("backend/api/src/modules/runs/runs.service.ts", 'import { B } from "../../platforms/ports/bot";\n')).toEqual([]);
    expect(findLayerViolations("backend/api/src/modules/admin-notify/a.ts", 'import { B } from "../../platforms/telegram/bot";\n')).toEqual([]);
  });

  it("файл вне проверяемых слоёв — без находок", () => {
    expect(findLayerViolations("scripts/x.ts", 'import x from "@bh/adapter-telegram";\n')).toEqual([]);
  });
});

describe("check-edit: запуск как хука", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-hooks-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function edit(relative: string, source: string, tool = "Edit"): Run {
    const file = join(dir, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    return runHook(
      "check-edit.mjs",
      JSON.stringify({ tool_name: tool, tool_input: { file_path: file } }),
      { CLAUDE_PROJECT_DIR: dir, CLAUDE_HOOKS_SKIP_ESLINT: "1" },
    );
  }

  it("Math.random в game/sim — находка в stderr, код 2 (правка уже сделана, агент её видит)", () => {
    const result = edit("packages/core-game/src/game/sim/foo.ts", "export const a = 1;\nexport const b = Math.random();\n");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/sim-purity: Math\.random в packages\/core-game\/src\/game\/sim\/foo\.ts:2/);
  });

  it("тот же код в game/render — тишина", () => {
    const result = edit("packages/core-game/src/game/render/foo.ts", "export const b = Math.random();\n");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("не TS-файл и несуществующий файл — тишина", () => {
    expect(edit("packages/core-game/src/game/sim/readme.md", "Math.random()\n").status).toBe(0);
    const missing = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(dir, "nope.ts") } });
    expect(runHook("check-edit.mjs", missing, { CLAUDE_PROJECT_DIR: dir, CLAUDE_HOOKS_SKIP_ESLINT: "1" }).status).toBe(0);
  });

  it("нарушение границ слоёв — находка", () => {
    const result = edit("packages/app-shell/src/x.tsx", 'import a from "@bh/adapter-telegram";\n', "Write");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/границы слоёв: packages\/app-shell\/src\/x\.tsx:1/);
  });
});

describe(".claude/settings.json: хуки подключены", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8")) as {
    hooks: Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]>;
  };

  function commandsFor(event: string, tool: string): string[] {
    return (settings.hooks[event] ?? [])
      .filter((entry) => new RegExp(`^(?:${entry.matcher})$`).test(tool))
      .flatMap((entry) => entry.hooks.map((hook) => hook.command));
  }

  it("PreToolUse: Bash и PowerShell — guard-command, Edit и Write — guard-write", () => {
    for (const tool of ["Bash", "PowerShell"]) expect(commandsFor("PreToolUse", tool).join("\n")).toMatch(/guard-command\.mjs/);
    for (const tool of ["Edit", "Write"]) expect(commandsFor("PreToolUse", tool).join("\n")).toMatch(/guard-write\.mjs/);
  });

  it("PostToolUse: Edit и Write — check-edit", () => {
    for (const tool of ["Edit", "Write"]) expect(commandsFor("PostToolUse", tool).join("\n")).toMatch(/check-edit\.mjs/);
  });

  it("команды — node и существующие скрипты", () => {
    const all = Object.values(settings.hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks));
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const hook of all) {
      expect(hook.type).toBe("command");
      const script = /scripts\/hooks\/[\w-]+\.mjs/.exec(hook.command)?.[0];
      expect(script, hook.command).toBeDefined();
      expect(() => readFileSync(join(ROOT, script ?? ""), "utf8"), hook.command).not.toThrow();
    }
  });
});
