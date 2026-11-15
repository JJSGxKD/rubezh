import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Определения агентов команды в `.claude/agents/` (Р224, D).
 *
 * Модель, инструменты и скилл роли лежат в файле, а не в промпте конвейера:
 * ревьюер и разведчик физически не могут править файлы, а дорогая модель не
 * достаётся агенту по наследству от основного чата.
 */
const AGENTS_DIR = fileURLToPath(new URL("../../.claude/agents/", import.meta.url));

const EXPECTED = ["rubezh-executor", "rubezh-fixer", "rubezh-reviewer", "rubezh-scout"];
const ALLOWED_MODELS = ["sonnet", "haiku", "opus"];
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

interface Agent {
  file: string;
  meta: Record<string, string>;
  tools: string[];
  body: string;
}

function parse(file: string): Agent {
  const text = readFileSync(join(AGENTS_DIR, file), "utf8").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: нет фронтматтера`);
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const pair = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (pair?.[1]) meta[pair[1]] = (pair[2] ?? "").trim();
  }
  const tools = (meta.tools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  return { file, meta, tools, body: match[2] ?? "" };
}

const files = readdirSync(AGENTS_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();
const agents = files.map(parse);
const byName = (name: string): Agent => {
  const agent = agents.find((item) => item.meta.name === name);
  if (!agent) throw new Error(`нет агента ${name}`);
  return agent;
};

describe("определения агентов команды", () => {
  it("есть ровно четыре агента роли", () => {
    expect(agents.map((agent) => agent.meta.name).sort()).toEqual(EXPECTED);
  });

  it.each(agents)("$file: имя совпадает с файлом, есть описание и модель из списка", (agent) => {
    expect(`${agent.meta.name}.md`).toBe(agent.file);
    expect((agent.meta.description ?? "").length).toBeGreaterThan(20);
    expect(ALLOWED_MODELS).toContain(agent.meta.model);
    expect(agent.body.trim().length).toBeGreaterThan(100);
  });

  it.each(agents)("$file: ссылается на общие правила, а не копирует их", (agent) => {
    expect(agent.body).toContain("CLAUDE.md");
    expect(agent.body).toContain("tasks/README.md");
  });

  it("ревьюер и разведчик не могут править файлы", () => {
    for (const name of ["rubezh-reviewer", "rubezh-scout"]) {
      const agent = byName(name);
      expect(agent.tools.length, `${name}: tools не задан`).toBeGreaterThan(0);
      for (const tool of WRITE_TOOLS) expect(agent.tools, name).not.toContain(tool);
    }
  });

  it("ревьюер читает, ищет и ходит в git, начинает с review-pr", () => {
    const reviewer = byName("rubezh-reviewer");
    for (const tool of ["Read", "Grep", "Glob", "Bash"]) expect(reviewer.tools).toContain(tool);
    expect(reviewer.body).toContain("review-pr");
    expect(reviewer.body).toContain("diff-check");
  });

  it("модели ролей: исполнитель, ревьюер и доработчик — Sonnet, разведчик — Haiku", () => {
    expect(byName("rubezh-executor").meta.model).toBe("sonnet");
    expect(byName("rubezh-reviewer").meta.model).toBe("sonnet");
    expect(byName("rubezh-fixer").meta.model).toBe("sonnet");
    expect(byName("rubezh-scout").meta.model).toBe("haiku");
  });

  it("исполнитель и доработчик получают все инструменты и начинают с take-task", () => {
    for (const name of ["rubezh-executor", "rubezh-fixer"]) {
      expect(byName(name).meta.tools, `${name}: tools не указывают, чтобы были все`).toBeUndefined();
      expect(byName(name).body).toContain("take-task");
    }
  });
});
