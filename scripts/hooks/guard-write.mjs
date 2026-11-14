// PreToolUse для Edit|Write: не даёт править .env и .claude/launch.json
// (docs/35-stage4-plan.md, Р224 A; CLAUDE.md, «Порты и переменные окружения»).
import { isMain, runHook } from "./io.mjs";

/** Имя файла окружения с секретами: `.env`, `.env.local`, `.env.production`; `.env.example` — образец, его правят. */
export function isEnvFileName(name) {
  return /^\.env(\..+)?$/i.test(name) && !/^\.env\.example$/i.test(name);
}

/** Последний компонент пути при любом разделителе. */
export function baseName(path) {
  return String(path).replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}

export const ENV_REASON =
  "Запрещено: .env правит только владелец. Новая переменная — в .env.example и в Zod-схему конфигурации (docs/20-env-and-ports.md §7), секреты — в окружение CI, а не в файл.";

const LAUNCH_REASON =
  "Запрещено: .claude/launch.json правит только владелец — это его настройки запуска серверов предпросмотра. Нужен другой запуск — вопрос в PR, а не правка файла.";

/** Причина запрета правки файла или null. */
export function checkWritePath(filePath) {
  if (typeof filePath !== "string" || filePath === "") return null;
  const normalized = filePath.replace(/\\/g, "/");
  if (isEnvFileName(baseName(normalized))) return ENV_REASON;
  if (/(?:^|\/)\.claude\/launch\.json$/i.test(normalized)) return LAUNCH_REASON;
  return null;
}

if (isMain(import.meta.url)) {
  await runHook("guard-write", (input) => {
    const toolInput = input.tool_input;
    if (toolInput === null || typeof toolInput !== "object") return null;
    return checkWritePath(toolInput.file_path);
  });
}
