/**
 * Доступность готовых экранов по разметке (docs/27-design-system-and-app-shell.md
 * §4.4, design/art/meta-v2.md §9). Контраст меряет отдельный скрипт по
 * пикселям — `contrast-audit.mjs`; здесь три проверки, которым хватает DOM:
 *
 * - `touch` — зона касания: меньше 24 px по любой стороне — провал (WCAG
 *   2.5.8), ниже 44 px по высоте — замечание. Прозрачный `::after` утилиты
 *   `hit-tall` засчитывается. Отдельная ссылка в тексте с пустым местом вокруг
 *   проходит по исключению WCAG — её скрипт всё равно покажет, решает человек.
 * - `names` — имя для диктора у кнопок, ссылок, вкладок, переключателей,
 *   полей и картинок: из дерева доступности самого Chromium (CDP), то есть
 *   ровно то, что прочтёт TalkBack или VoiceOver.
 * - `scale` — крупный шрифт системы: Android масштабирует текст WebView
 *   Telegram, и всё в rem растёт. Корню ставится 130 % и 150 %, и ищется
 *   то, что вылезло за край окна вне своей прокрутки. Украшения (`svg`,
 *   `aria-hidden`) не в счёт.
 *
 * Нужен dev-сервер оболочки и бэкенд; STATE — состояние браузера игрока,
 * прошедшего первый забег (как у `contrast-audit.mjs`).
 *
 *   STATE=state.json node design/art/src/a11y-audit.mjs
 *   CHECKS=scale WIDTH=320 HEIGHT=640 STATE=state.json node design/art/src/a11y-audit.mjs
 * Код выхода 1 — есть провал.
 */
import { pathToFileURL } from "node:url";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:5173";
const WIDTH = Number(process.env.WIDTH ?? 390);
const HEIGHT = Number(process.env.HEIGHT ?? 844);
const SCREENS = (process.env.SCREENS ?? "lobby,arsenal,shop,tasks,rating,friends,profile,history,notifications,changelog,settings,guide,about,wheel,daily,level,diagnostics").split(",");
const CHECKS = new Set((process.env.CHECKS ?? "touch,names,scale").split(","));
const SCALES = (process.env.SCALES ?? "130%,150%").split(",");
const TABS = new Set(["lobby", "arsenal", "shop", "tasks", "rating", "friends"]);
const NAMED_ROLES = new Set(["button", "link", "tab", "switch", "checkbox", "radio", "textbox", "slider", "combobox", "menuitem", "spinbutton", "img", "image"]);

const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(path).href);
const browser = await chromium.launch();

let failed = 0;
const fail = (line) => {
  failed += 1;
  console.log(`    ✗ ${line}`);
};

/** Новая вкладка с приложением; `scale` — размер шрифта корня, как у системы. */
async function open(scale) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    reducedMotion: "reduce",
    ...(process.env.STATE === undefined ? {} : { storageState: process.env.STATE }),
  });
  if (scale !== undefined) {
    await context.addInitScript((size) => {
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.fontSize = size;
      });
    }, scale);
  }
  const page = await context.newPage();
  await page.goto(`${APP_URL}/`);
  await page.waitForTimeout(3500);
  const navigation = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name).find((name) => name.includes("/state/navigation")));
  if (navigation === undefined) throw new Error("Модуль навигации не найден — это dev-сервер оболочки?");
  const go = async (id) => {
    await page.evaluate(
      async ([url, screen, tab]) => {
        const { useNavigation } = await import(url);
        const nav = useNavigation.getState();
        if (tab) nav.resetTo(screen);
        else nav.push(screen);
      },
      [navigation, id, TABS.has(id)],
    );
    await page.waitForTimeout(1600);
  };
  return { context, page, go };
}

async function touch(page) {
  const found = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("button, a[href], [role=button], [role=tab], [role=switch], input, select, summary, [role=slider]")) {
      if (el.closest("[aria-hidden=true],[inert]")) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || box.bottom < 0 || box.top > innerHeight) continue;
      const after = getComputedStyle(el, "::after");
      const grow = after.content !== "none" && after.position === "absolute" ? Math.max(0, -Number.parseFloat(after.top) || 0) : 0;
      const height = box.height + 2 * grow;
      const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
      if (box.width < 24 || height < 24) out.push({ hard: true, line: `${Math.round(box.width)}×${Math.round(height)} «${label}»` });
      else if (height < 44) out.push({ hard: false, line: `${Math.round(box.width)}×${Math.round(height)} «${label}»` });
    }
    return out;
  });
  for (const item of found) {
    if (item.hard) fail(`касание меньше 24 px: ${item.line}`);
    else console.log(`    · касание ниже 44 px: ${item.line}`);
  }
}

async function names(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  for (const node of nodes) {
    if (node.ignored === true || !NAMED_ROLES.has(node.role?.value)) continue;
    if ((node.name?.value ?? "").trim() !== "") continue;
    let html = "";
    if (node.backendDOMNodeId !== undefined) {
      const { outerHTML } = await cdp.send("DOM.getOuterHTML", { backendNodeId: node.backendDOMNodeId });
      html = outerHTML.slice(0, 120);
    }
    fail(`без имени для диктора: ${node.role.value} ${html}`);
  }
  await cdp.detach();
}

async function overflow(page) {
  const found = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("svg,[aria-hidden=true],canvas")) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      let clipped = false;
      for (let up = el.parentElement; up !== null; up = up.parentElement) {
        if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(up).overflowX)) {
          clipped = true;
          break;
        }
      }
      if (!clipped && (box.right > innerWidth + 1 || box.left < -1)) out.push(`${el.tagName.toLowerCase()} «${(el.textContent ?? "").trim().slice(0, 30)}» ${Math.round(box.left)}..${Math.round(box.right)}`);
    }
    return out.slice(0, 5);
  });
  for (const line of found) fail(`вылезло за край: ${line}`);
}

if (CHECKS.has("touch") || CHECKS.has("names")) {
  const { context, page, go } = await open();
  for (const id of SCREENS) {
    await go(id);
    console.log(`${id}`);
    if (CHECKS.has("touch")) await touch(page);
    if (CHECKS.has("names")) await names(context, page);
  }
  await context.close();
}

if (CHECKS.has("scale")) {
  for (const scale of SCALES) {
    const { context, page, go } = await open(scale);
    for (const id of SCREENS) {
      await go(id);
      console.log(`${id} при шрифте ${scale}`);
      await overflow(page);
    }
    await context.close();
  }
}

await browser.close();
console.log(failed === 0 ? `провалов нет на ${WIDTH}×${HEIGHT}` : `провалов: ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
