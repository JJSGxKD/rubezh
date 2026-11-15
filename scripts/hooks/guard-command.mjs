// PreToolUse для Bash и PowerShell: не даёт выполнить команды, которые команда
// запретила текстом в CLAUDE.md (docs/35-stage4-plan.md, Р224 A).
//
// Команда разбирается на сегменты и слова с учётом кавычек и here-doc, а не
// ищется регулярным выражением по всей строке: иначе запрет срабатывал бы на
// слова «npm install» в сообщении коммита или теле PR. Разбор упрощённый — он
// ловит типичную ошибку агента, а не защищает от злого умысла.
import { baseName, ENV_REASON, isEnvFileName } from "./guard-write.mjs";
import { isMain, runHook } from "./io.mjs";

/** Метка перенаправления в списке слов: следующее слово — его цель. */
const REDIRECT = "\u0000>";
const MAX_DEPTH = 3;

const REASON_NPM =
  "Запрещено: в репозитории только pnpm. Зависимости ставит `pnpm install` (в рабочей копии — `pnpm install --frozen-lockfile`): npm не понимает протокол workspace:* и сломает раскладку.";
const REASON_PUSH =
  "Запрещено: git push с --force, -f и --force-with-lease (и refspec с «+»). Расхождение с удалённой веткой решается `git merge origin/dev`, а не перезаписью истории; свою ветку обновляет обычный `git push`.";
const REASON_REMOVE =
  "Запрещено: Remove-Item -Recurse идёт по junction'ам pnpm и стирает файлы за пределами папки. Рабочую копию удаляют `git worktree remove --force <путь>`, остаток — `cmd /c rmdir /s /q <путь>`.";
const REASON_TEST_ENV =
  "Запрещено: тесты идут на Redis 13 и базе rubezh_test, а не на Redis 14 и bullet_heaven — это живая dev-среда. Подключи тестовое окружение: `source scripts/lead/test-env.sh t<номер задачи>` (test-env.sh).";

/** Разрешённые пакеты для npx: всё остальное скачивает и запускает чужой код. */
const NPX_ALLOWED = new Set(["prisma", "vitest", "tsc", "eslint", "playwright", "@playwright/test"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["env", "sudo", "command", "time", "nohup", "call", "exec", "nice"]);

/** Тела here-doc и here-string PowerShell — текст, а не команды. */
export function stripHeredocs(command) {
  return command
    .replace(/<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g, (match) => `${match.slice(0, match.indexOf("\n"))}\n`)
    .replace(/@(['"])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g, '""');
}

/** Команда → сегменты (по `;`, `&&`, `|`, переводам строк) → слова без кавычек. */
export function splitSegments(command) {
  const text = stripHeredocs(command);
  const segments = [];
  let tokens = [];
  let current = "";
  let started = false;
  let quote = null;

  const endToken = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quote) {
      if (char === quote) quote = null;
      else if ((char === "\\" || char === "`") && quote === '"' && next === '"') {
        current += '"';
        i += 1;
      } else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "#" && !started) {
      while (i < text.length && text[i] !== "\n") i += 1;
      endSegment();
    } else if (char === "\n") endSegment();
    else if (char === " " || char === "\t" || char === "\r") endToken();
    else if (char === ";" || char === "|" || char === "(" || char === ")" || char === "{" || char === "}") endSegment();
    else if (char === "&") {
      if (next === ">") {
        // `&>файл` — перенаправление, а не конец команды
        i += 1;
        if (text[i + 1] === ">") i += 1;
        endToken();
        tokens.push(REDIRECT);
      } else {
        if (next === "&") i += 1;
        endSegment();
      }
    } else if (char === ">") {
      // `2>`, `>>`: номер дескриптора перед знаком — часть оператора, а не слово
      if (started && /^\d+$/.test(current)) {
        current = "";
        started = false;
      } else endToken();
      if (next === ">") i += 1;
      if (text[i + 1] === "&") {
        // `2>&1` — дублирование дескриптора, цели-файла нет
        i += 1;
        while (/[\d-]/.test(text[i + 1] ?? "")) i += 1;
      } else tokens.push(REDIRECT);
    } else if (char === "`" && (next === "\n" || next === "\r")) {
      endToken();
    } else {
      current += char;
      started = true;
    }
  }
  endSegment();
  return segments;
}

/** Имя исполняемого файла: без каталога и расширения, в нижнем регистре. */
function exeName(token) {
  return baseName(token)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1)$/, "");
}

/** Слова команды без перенаправлений и их целей. */
function withoutRedirects(tokens) {
  const result = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === REDIRECT) i += 1;
    else result.push(tokens[i]);
  }
  return result;
}

/** Слова команды после присваиваний окружения и обёрток вроде `env`, `sudo`. */
function commandWords(tokens) {
  let i = 0;
  while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || WRAPPERS.has(exeName(tokens[i])))) i += 1;
  return tokens.slice(i);
}

const isFlag = (token) => /^-/.test(token);
const isRecurseFlag = (token) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(token);

const WRITE_ANY = new Set(["set-content", "add-content", "out-file", "clear-content", "tee-object", "new-item", "sc", "ac", "ni", "tee"]);
const REMOVE_ANY = new Set(["rm", "del", "erase", "remove-item", "ri", "rd", "mv", "move", "move-item", "mi"]);
const WRITE_LAST = new Set(["cp", "copy", "copy-item", "cpi", "ln"]);
const SHELLS = new Set(["powershell", "pwsh", "bash", "sh", "zsh", "cmd"]);
const POWERSHELL_REMOVE = new Set(["rm", "del", "erase", "rd"]);

function checkGit(rest) {
  let i = 0;
  while (i < rest.length && isFlag(rest[i])) {
    i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(rest[i]) ? 2 : 1;
  }
  if (rest[i] !== "push") return null;
  for (const arg of rest.slice(i + 1)) {
    if (arg === "--force" || arg === "--force-if-includes" || arg.startsWith("--force-with-lease")) return REASON_PUSH;
    if (/^-[A-Za-z]*f[A-Za-z]*$/.test(arg)) return REASON_PUSH;
    if (/^\+\S/.test(arg) || /:\+\S/.test(arg)) return REASON_PUSH;
  }
  return null;
}

function checkNpx(rest) {
  const name = rest.find((arg) => !isFlag(arg));
  if (name === undefined) return null;
  const bare = name.replace(/^(@?[^@]+)@.*$/, "$1");
  return NPX_ALLOWED.has(bare)
    ? null
    : `Непроверенный npx «${bare}»: он скачивает и запускает чужой код. Разрешены prisma, vitest, tsc, eslint, playwright; всё остальное — сначала спросить владельца (вопрос в PR), а не запускать.`;
}

function checkEnvTouch(name, rest) {
  const targets = rest.filter((arg) => !isFlag(arg));
  if (WRITE_ANY.has(name) || REMOVE_ANY.has(name)) {
    return targets.some((arg) => isEnvFileName(baseName(arg))) ? ENV_REASON : null;
  }
  if (WRITE_LAST.has(name)) {
    const destination = targets[targets.length - 1];
    return destination !== undefined && isEnvFileName(baseName(destination)) ? ENV_REASON : null;
  }
  if (name === "sed") {
    const inPlace = rest.some((arg) => arg === "--in-place" || arg.startsWith("--in-place=") || /^-[A-Za-z]*i[A-Za-z.]*$/.test(arg));
    return inPlace && targets.some((arg) => isEnvFileName(baseName(arg))) ? ENV_REASON : null;
  }
  return null;
}

function checkSegment(tokens, tool, depth) {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i] === REDIRECT && isEnvFileName(baseName(tokens[i + 1]))) return ENV_REASON;
  }

  const words = commandWords(withoutRedirects(tokens));
  if (words.length === 0) return null;
  const name = exeName(words[0]);
  const rest = words.slice(1);

  if (name === "npm") {
    const sub = rest.find((arg) => !isFlag(arg));
    if (sub === "install" || sub === "i" || sub === "ci" || sub === "add") return REASON_NPM;
    return null;
  }
  if (name === "git") return checkGit(rest);
  if (name === "npx") return checkNpx(rest);

  if (name === "remove-item" || name === "ri" || (tool === "PowerShell" && POWERSHELL_REMOVE.has(name))) {
    if (rest.some(isRecurseFlag)) return REASON_REMOVE;
  }

  const envReason = checkEnvTouch(name, rest);
  if (envReason) return envReason;

  if (SHELLS.has(name) && depth < MAX_DEPTH) {
    const flag = rest.findIndex((arg) => /^(?:-c|-lc|-ic|-command|-c(?:ommand)?|\/c)$/i.test(arg));
    if (flag >= 0) return checkCommand(rest.slice(flag + 1).join(" "), tool, depth + 1);
  }
  return null;
}

/** Слово — присваивание или адрес, в котором назван Redis 14 или dev-база. */
function pointsAtDevData(token) {
  const urlLike = ASSIGNMENT.test(token) || /^(?:rediss?|postgres(?:ql)?):\/\//.test(token);
  if (!urlLike) return false;
  return /rediss?:\/\/[^\s/]+\/14(?!\d)/.test(token) || /\/bullet_heaven(?![\w])/.test(token);
}

function isTestRun(tokens) {
  const words = commandWords(withoutRedirects(tokens));
  if (words.length === 0) return false;
  const name = exeName(words[0]);
  const rest = words.slice(1);
  if (name === "vitest") return true;
  if (name === "pnpm" || name === "npm" || name === "yarn" || name === "npx") {
    return rest.some((arg) => arg === "vitest" || /^test(?::[\w:-]+)?$/.test(arg));
  }
  return false;
}

/** Причина запрета команды или null, если её можно выполнять. */
export function checkCommand(command, tool = "Bash", depth = 0) {
  if (typeof command !== "string" || command.trim() === "") return null;
  const segments = splitSegments(command);
  for (const tokens of segments) {
    const reason = checkSegment(tokens, tool, depth);
    if (reason) return reason;
  }
  if (segments.some(isTestRun) && segments.some((tokens) => tokens.some(pointsAtDevData))) return REASON_TEST_ENV;
  return null;
}

if (isMain(import.meta.url)) {
  await runHook("guard-command", (input) => {
    const toolInput = input.tool_input;
    if (toolInput === null || typeof toolInput !== "object") return null;
    const tool = typeof input.tool_name === "string" ? input.tool_name : "Bash";
    return checkCommand(toolInput.command, tool);
  });
}
