// Импорт флагов стран для панели (Р201, docs/13-reuse-from-vpnsibcom.md §11).
//
// Источник — SVG-флаги из проекта VPNsib владельца (папка public/flags в
// рабочей копии vpnsibcom_web). Скрипт сжимает их svgo и кладёт строчными
// именами в apps/admin/public/flags/: панель отдаёт их статикой, лениво.
//
// Запуск: node scripts/admin/import-flags.mjs <папка источника>
//
// Берутся файлы вида NLD.svg (три заглавные латинские буквы), остальные
// пропускаются и попадают в отчёт. Выходная папка пересобирается: прежние
// *.svg в ней удаляются, так что она повторяет источник.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { optimize } from "svgo";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "admin", "public", "flags");
const USAGE = "Укажите папку с флагами: node scripts/admin/import-flags.mjs ../vpnsibcom_web/public/flags";

// Файлы отдаёт свой домен панели: активное содержимое и внешние ссылки недопустимы.
export function svgProblem(text) {
  if (/<script/i.test(text)) return "тег script";
  if (/<foreignObject/i.test(text)) return "тег foreignObject";
  if (/\son[a-z]+\s*=/i.test(text)) return "обработчик события";
  if (/href\s*=\s*["']https?:/i.test(text)) return "внешняя ссылка";
  return null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail(USAGE);
const srcDir = resolve(arg);
const srcStat = await stat(srcDir).catch(() => null);
if (!srcStat?.isDirectory()) fail(USAGE);

const names = (await readdir(srcDir)).sort();
const taken = names.filter((n) => /^[A-Z]{3}\.svg$/.test(n));
const skipped = names.filter((n) => !/^[A-Z]{3}\.svg$/.test(n));

// Сначала обрабатываем всё в памяти: упавший импорт не оставляет полупустую папку.
const results = [];
let before = 0;
for (const name of taken) {
  const text = await readFile(join(srcDir, name), "utf8");
  before += Buffer.byteLength(text);
  const out = optimize(text, { multipass: true, floatPrecision: 2, plugins: ["preset-default"] }).data;
  const problem = svgProblem(out);
  if (problem) fail(`Файл ${name} отвергнут: ${problem}`);
  if (!out.startsWith("<svg") || !out.includes("viewBox")) {
    fail(`Файл ${name} отвергнут: после сжатия нет корня svg или viewBox`);
  }
  results.push({ file: `${name.slice(0, 3).toLowerCase()}.svg`, data: out });
}

await mkdir(OUT_DIR, { recursive: true });
for (const old of await readdir(OUT_DIR)) {
  if (old.endsWith(".svg")) await rm(join(OUT_DIR, old));
}
let after = 0;
for (const r of results) {
  await writeFile(join(OUT_DIR, r.file), r.data);
  r.size = Buffer.byteLength(r.data);
  after += r.size;
}

const kb = (n) => (n / 1024).toFixed(1);
console.log(`Взято файлов: ${results.length}`);
console.log(`Пропущено: ${skipped.length}${skipped.length ? ` (${skipped.join(", ")})` : ""}`);
console.log(`Размер до: ${kb(before)} КБ, после: ${kb(after)} КБ`);
console.log("Пять самых тяжёлых после сжатия:");
for (const r of [...results].sort((a, b) => b.size - a.size).slice(0, 5)) {
  console.log(`  ${r.file} — ${kb(r.size)} КБ`);
}
