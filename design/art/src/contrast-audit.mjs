/**
 * Замер контраста текста на готовых экранах (design/art/meta-v2.md §9,
 * docs/27-design-system-and-app-shell.md §4.4).
 *
 * axe на наших экранах почти ничего не решает: под текстом живой фон,
 * градиенты карточек и полупрозрачные плашки, и он отвечает «не определено».
 * Здесь иначе: текст на экране прячется, кадр снимается, и цвет каждой
 * подписи — с прозрачностью её и предков — сравнивается с пикселями, которые
 * под ней на самом деле. Текст под панелью вкладок или окном не меряется: его
 * не видно. Прозрачные слои касаний поверх HUD текст не закрывают.
 *
 * Порог — WCAG 2.2: 4,5:1 для обычного текста, 3:1 для крупного (от 24 px или
 * от 18,66 px полужирного). Выключенное (`disabled`, `aria-disabled`) и
 * скрытое от диктора не меряется: порог его не касается.
 *
 * Нужен dev-сервер оболочки (`pnpm dev`) и бэкенд. STATE — файл состояния
 * браузера игрока, прошедшего первый забег (Playwright `storageState`): без
 * него новичок упрётся в первый забег, и замерятся только ворота.
 *
 *   STATE=state.json WIDTH=390 node design/art/src/contrast-audit.mjs
 *   SCREENS=shop,daily WIDTH=320 HEIGHT=640 node design/art/src/contrast-audit.mjs
 *   PREVIEWS=1 STATE=state.json node design/art/src/contrast-audit.mjs
 * PREVIEWS=1 — ещё и окна забега из витрины компонентов (уровень, пауза,
 * смерть, рекорд, второй шанс, сундуки): в настоящем забеге до них долго
 * идти. Витрина открыта игроку с правом `tools.dev`.
 * Код выхода 1 — где-то текст ниже порога.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:5173";
const WIDTH = Number(process.env.WIDTH ?? 390);
const HEIGHT = Number(process.env.HEIGHT ?? 844);
const SCREENS = (process.env.SCREENS ?? "lobby,arsenal,shop,tasks,rating,friends,profile,history,notifications,changelog,settings,guide,about,wheel,daily,level,diagnostics").split(",");
// Вкладки нижней панели открываются сбросом стека, остальное — поверх.
const TABS = new Set(["lobby", "arsenal", "shop", "tasks", "rating", "friends"]);

const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(path).href);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  reducedMotion: "reduce",
  ...(process.env.STATE === undefined ? {} : { storageState: process.env.STATE }),
});
const page = await context.newPage();
await page.goto(`${APP_URL}/`);
await page.waitForTimeout(3500);
// Модуль навигации — тот же, что у приложения: в dev он отдаётся по своему пути.
const navigation = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name).find((name) => name.includes("/state/navigation")));
if (navigation === undefined) throw new Error("Модуль навигации не найден — это dev-сервер оболочки?");

/**
 * Подписи в окне: цвет с прозрачностью предков, размер, рамка текста. На время
 * сбора всё ловит касания: `elementFromPoint` пропускает `pointer-events: none`,
 * а так устроены HUD забега и подписи поверх кнопок.
 */
async function collect() {
  const touchable = await page.addStyleTag({ content: "*{pointer-events:auto!important}" });
  const items = await page.evaluate(() => {
    const parse = (value) => {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (match === null) return null;
      const [r, g, b, a = "1"] = match[1].split(/[\s,/]+/).filter(Boolean);
      return [Number(r), Number(g), Number(b), Number(a)];
    };
    // Подпись закрыта, если над ней в стопке есть слой, который что-то рисует:
    // фон, картинка, канва. Прозрачные слои касаний поверх HUD не в счёт.
    const paints = (node) => {
      if (["IMG", "CANVAS", "VIDEO"].includes(node.tagName)) return true;
      const style = getComputedStyle(node);
      const bg = parse(style.backgroundColor);
      return style.backgroundImage !== "none" || (bg !== null && bg[3] > 0.5);
    };
    const covered = (el, x, y) => {
      for (const node of document.elementsFromPoint(x, y)) {
        if (node === el || el.contains(node) || node.contains(el)) return false;
        if (paints(node)) return true;
      }
      return true;
    };
    const items = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const el = node.parentElement;
      if (el === null || seen.has(el) || node.textContent.trim() === "") continue;
      seen.add(el);
      if (el.closest("[disabled],[aria-disabled=true],[aria-hidden=true],script,style,title") !== null) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const color = parse(style.color);
      if (color === null || color[3] === 0) continue;
      let opacity = 1;
      for (let up = el; up !== null; up = up.parentElement) opacity *= Number(getComputedStyle(up).opacity);
      if (opacity < 0.05) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) continue;
      const cx = Math.min(innerWidth - 1, Math.max(0, (box.left + box.right) / 2));
      const cy = Math.min(innerHeight - 1, Math.max(0, (box.top + box.bottom) / 2));
      if (covered(el, cx, cy)) continue;
      items.push({
        text: node.textContent.trim().slice(0, 40),
        color: [color[0], color[1], color[2], color[3] * opacity],
        size: Number.parseFloat(style.fontSize),
        weight: Number(style.fontWeight),
        box: [Math.max(0, box.left), Math.max(0, box.top), Math.min(innerWidth, box.right), Math.min(innerHeight, box.bottom)],
        classes: String(el.getAttribute("class") ?? "").slice(0, 90),
      });
    }
    return items;
  });
  await touchable.evaluate((node) => node.remove());
  return items;
}

/** Кадр без текста — и контраст каждой подписи к пикселям под ней. */
async function measure(items) {
  const hide = await page.addStyleTag({ content: "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}" });
  await page.waitForTimeout(120);
  const png = (await page.screenshot()).toString("base64");
  await hide.evaluate((node) => node.remove());
  return await page.evaluate(
    async ([png, items]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const g = canvas.getContext("2d");
      g.drawImage(image, 0, 0);
      const lin = (v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const lum = ([r, gg, b]) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
      return items.map((item) => {
        const [x0, y0, x1, y1] = item.box.map(Math.round);
        const w = Math.max(1, x1 - x0);
        const h = Math.max(1, y1 - y0);
        const data = g.getImageData(x0, y0, w, h).data;
        const ratios = [];
        const step = Math.max(1, Math.floor((w * h) / 400));
        for (let i = 0; i < w * h; i += step) {
          const bg = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
          const alpha = item.color[3];
          const fg = [0, 1, 2].map((k) => item.color[k] * alpha + bg[k] * (1 - alpha));
          const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
          ratios.push((hi + 0.05) / (lo + 0.05));
        }
        ratios.sort((a, b) => a - b);
        const large = item.size >= 24 || (item.size >= 18.66 && item.weight >= 700);
        // Медиана — подложка в целом; десятый процентиль — светлое место под буквами.
        return { ...item, median: ratios[Math.floor(ratios.length / 2)], low: ratios[Math.floor(ratios.length * 0.1)], need: large ? 3 : 4.5 };
      });
    },
    [png, items],
  );
}

let failed = 0;
let measured = 0;
const verdict = (id, results) => {
  measured += 1;
  const bad = results.filter((item) => item.median < item.need);
  failed += bad.length;
  console.log(`${bad.length === 0 ? "✓" : "✗"} ${id.padEnd(14)} подписей ${String(results.length).padStart(3)}${bad.length === 0 ? "" : `, ниже порога ${bad.length}`}`);
  for (const item of bad) {
    console.log(`    ${item.median.toFixed(2)} при пороге ${item.need} · ${item.size}px/${item.weight} · «${item.text}» · ${item.classes}`);
  }
};
const go = (id, tab) =>
  page.evaluate(
    async ([url, screen, isTab]) => {
      const { useNavigation } = await import(url);
      const nav = useNavigation.getState();
      if (isTab) nav.resetTo(screen);
      else nav.push(screen);
    },
    [navigation, id, tab],
  );

for (const id of SCREENS) {
  await go(id, TABS.has(id));
  await page.waitForTimeout(1800);
  verdict(id, await measure(await collect()));
}

if (process.env.PREVIEWS === "1") {
  // Заголовки строк витрины — из её словаря: новое окно в витрине попадёт в
  // замер без правки скрипта.
  const gallery = JSON.parse(readFileSync(new URL("../../../packages/app-shell/src/i18n/ru-gallery.json", import.meta.url), "utf8"));
  const shell = JSON.parse(readFileSync(new URL("../../../packages/app-shell/src/i18n/ru.json", import.meta.url), "utf8"));
  const titles = Object.entries(gallery)
    .filter(([key]) => key.startsWith("gallery.preview."))
    .flatMap(([key, text]) => (key === "gallery.preview.chest" ? [1, 3, 5].map((size) => text.replace("{size}", String(size))) : [text]));
  titles.push(shell["run.continue.title"]);
  await go("gallery", false);
  await page.waitForTimeout(2000);
  for (const title of titles) {
    const row = page.getByRole("button", { name: title, exact: true }).first();
    if ((await row.count()) === 0) continue;
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.waitForTimeout(2200);
    verdict(title.slice(0, 14), await measure(await collect()));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const close = page.getByRole("button", { name: /^закрыть$/i }).last();
    if ((await page.getByRole("button", { name: title, exact: true }).count()) === 0 && (await close.count()) > 0) {
      await close.click();
      await page.waitForTimeout(600);
    }
  }
}
await browser.close();
console.log(failed === 0 ? `все подписи на ${measured} экранах и окнах не ниже порога на ${WIDTH}×${HEIGHT}` : `ниже порога: ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
