/**
 * Замер боковой прокрутки админки на телефоне (design/art/direction-v2.md §4.6).
 *
 * Открывает каждый раздел панели под входом разработчика и сравнивает ширину
 * страницы с шириной окна. Кадр предпросмотра телефона прокручивается внутри
 * своей рамки — это не дефект, его элементы в отчёт не попадают.
 *
 * Нужна запущенная панель с AUTH_DEV_LOGIN на бэкенде:
 *   ADMIN_URL=http://127.0.0.1:5176 WIDTH=390 node design/art/src/admin-overflow.mjs
 * Код выхода 1 — какой-то раздел шире окна.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ADMIN_URL = process.env.ADMIN_URL ?? "http://127.0.0.1:5176";
const WIDTH = Number(process.env.WIDTH ?? 390);

// Разделы — из реестра панели: новый раздел попадёт в замер без правки скрипта.
const routes = readFileSync(join(ROOT, "apps/admin/src/routes.ts"), "utf8");
const sections = [...routes.matchAll(/\{ id: "([a-z-]+)", title:/g)].map((match) => match[1]);

const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(path).href);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: WIDTH, height: 844 } })).newPage();
await page.goto(`${ADMIN_URL}/`);
await page.getByRole("button", { name: /разработ/i }).first().click();
await page.waitForTimeout(1500);

let failed = 0;
for (const id of sections) {
  await page.goto(`${ADMIN_URL}/#/${id}`);
  await page.waitForTimeout(1200);
  const result = await page.evaluate(() => {
    const inScroller = (el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        if (["auto", "scroll"].includes(getComputedStyle(node).overflowX)) return true;
      }
      return false;
    };
    const over = [...document.querySelectorAll("main *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !inScroller(el));
    const outer = over.filter((el) => !over.includes(el.parentElement));
    return { width: document.documentElement.scrollWidth, culprits: outer.slice(0, 3).map((el) => `${el.tagName.toLowerCase()} «${(el.textContent ?? "").trim().slice(0, 40)}»`) };
  });
  const bad = result.width > WIDTH;
  if (bad) failed++;
  console.log(`${bad ? "✗" : "✓"} ${id.padEnd(12)} ${String(result.width).padStart(4)}${bad ? `  ${result.culprits.join("; ")}` : ""}`);
}
await browser.close();
console.log(failed === 0 ? `все ${sections.length} разделов в ширину ${WIDTH}` : `шире окна: ${failed} из ${sections.length}`);
process.exitCode = failed === 0 ? 0 : 1;
