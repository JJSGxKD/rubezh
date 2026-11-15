// Общий ввод-вывод хуков Claude Code (docs/35-stage4-plan.md, Р224 A).
//
// Хук получает JSON на stdin и отвечает кодом выхода: 2 — запрет (до
// выполнения) или замечание агенту (после правки), причина — в stderr, её
// видит агент. Любой другой исход, в том числе поломка самого хука, не должен
// останавливать работу: сломанный хук хуже отсутствующего.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Читает stdin целиком; на закрытом или пустом вводе вернёт пустую строку. */
async function readStdin() {
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Разбор входа хука: объект или null, если пришёл мусор или не объект. */
export function parseInput(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Запускает хук: `check(input)` возвращает текст запрета/замечания или null.
 * Ошибка внутри — выход 0 и строка в stderr.
 */
export async function runHook(name, check) {
  try {
    const input = parseInput(await readStdin());
    if (!input) {
      process.stderr.write(`хук ${name}: вход не разобран, пропускаю\n`);
      return;
    }
    const message = await check(input);
    if (message) {
      process.stderr.write(`${message}\n`);
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`хук ${name} сломался и не блокирует работу: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 0;
  }
}

/** Скрипт запущен напрямую, а не импортирован тестом. */
export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
