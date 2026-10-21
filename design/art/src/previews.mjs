// Листы для просмотра: сравнение концепций, раскадровка существ, герой.
//
//   node design/art/src/previews.mjs
//
// Листы рисуются на цвете земли арены: смотреть спрайт на прозрачном или
// белом фоне бессмысленно — в игре он всегда стоит на сумеречной земле.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENEMY_ART } from "./creatures.mjs";
import { HERO_DEFS, HERO_STATES } from "./hero.mjs";
import { creaturePalette, enemyBody, STAGES } from "./palette.mjs";
import { svgFrame, PPU, CELL_K } from "./build.mjs";
import { FX } from "./fx.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
const GROUND = "#33506a";
/** Пикселей экрана на игровую единицу у телефона 390×844 с DPR 3 в движении. */
const GAME_PX = 2.8;

function heroSvg(state, k) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100"><defs>${HERO_DEFS}</defs>${HERO_STATES[state][k]()}</svg>`;
}

function enemySvg(art, stage, t, style = "C") {
  const palette = style === "B" ? creaturePalette(0x3a1830, 0xff6a5a) : creaturePalette(enemyBody(art.pattern, art.rank, stage), STAGES[stage].eye);
  return svgFrame(art.draw(t, palette), { rank: art.rank, radius: art.radius, style });
}

/** Ячейка в игровом масштабе: размер в экранных пикселях, как на телефоне. */
const gameSize = (radius, k = CELL_K) => Math.round(radius * 2 * k * GAME_PX);

/** Простой лист: строки с подписью и ячейками; всё рисует браузер. */
async function renderBoard(page, board) {
  return page.evaluate(async ({ board, ground }) => {
    const canvas = document.createElement("canvas");
    canvas.width = board.width;
    canvas.height = board.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1d1c31";
    ctx.fillRect(0, 0, board.width, board.height);
    for (const item of board.items) {
      if (item.text !== undefined) {
        ctx.fillStyle = item.color ?? "#f3eee6";
        ctx.font = `${item.bold ? "700 " : ""}${item.size ?? 18}px system-ui, sans-serif`;
        ctx.fillText(item.text, item.x, item.y);
        continue;
      }
      if (item.ground) {
        ctx.fillStyle = ground;
        ctx.fillRect(item.x, item.y, item.w, item.h);
        continue;
      }
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.svg)}`;
      await img.decode();
      ctx.drawImage(img, item.x, item.y, item.size, item.size);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  }, { board, ground: GROUND });
}

function conceptsBoard() {
  const picks = ["swarm_rat", "dasher_wolf", "shooter_wisp", "tank_ghoul", "elite_grave_knight"].map((id) => ENEMY_ART.find((a) => a.id === id));
  const styles = [
    { id: "A", title: "A · «Лубок»: контур тёмной вишней", note: "читается лучше всех, но спорит с решением «у рядовых без обводки»" },
    { id: "B", title: "B · «Тени Нави»: тёмные силуэты, красная кайма", note: "атмосферно; красный остаётся только каймой и глазами — роль «враг — красный» слабеет" },
    { id: "C", title: "C · «Форма-предок»: два плоских тона, без контура — выбран", note: "силуэт наследует фигуру паттерна, цвет — по угрозе; контур только у героя" },
  ];
  const items = [];
  let y = 40;
  items.push({ text: "Концепции арта врагов — крупно и в игровом масштабе (телефон 390 px, DPR 3)", x: 24, y: 30, size: 22, bold: true });
  for (const style of styles) {
    y += 30;
    items.push({ text: style.title, x: 24, y, size: 20, bold: true, color: style.id === "C" ? "#ff8f3f" : "#f3eee6" });
    items.push({ text: style.note, x: 24, y: y + 24, size: 15, color: "#aeaac4" });
    y += 40;
    items.push({ ground: true, x: 16, y, w: 1350, h: 190 });
    let x = 28;
    items.push({ svg: heroSvg("walk", 1), x, y: y + 10, size: 170 });
    x += 180;
    for (const art of picks) {
      items.push({ svg: enemySvg(art, 0, 0.25, style.id), x, y: y + 10, size: 170 });
      x += 175;
    }
    // Игровой масштаб: те же существа размером с экранный пиксель телефона.
    let gx = x + 20;
    items.push({ svg: heroSvg("walk", 1), x: gx, y: y + 70, size: gameSize(10, 2.6) / 2 });
    gx += 40;
    for (const art of picks) {
      const size = gameSize(art.radius) / 2;
      items.push({ svg: enemySvg(art, 0, 0.25, style.id), x: gx, y: y + 120 - size / 2, size });
      gx += size + 8;
    }
    y += 200;
  }
  return { width: 1380, height: y + 20, items };
}

function rosterBoard() {
  const items = [];
  const rowH = 128;
  let y = 46;
  items.push({ text: "Бестиарий: 4 кадра шага · ступени 1–3 · в игровом масштабе", x: 24, y: 30, size: 22, bold: true });
  for (const art of ENEMY_ART) {
    items.push({ ground: true, x: 16, y, w: 1350, h: rowH - 6 });
    items.push({ text: art.id, x: 24, y: y + 20, size: 15, bold: true });
    items.push({ text: `${art.pattern}${art.rank ? ` · ${art.rank}` : ""} · r ${art.radius.toFixed(1)}`, x: 24, y: y + 40, size: 13, color: "#d7dcef" });
    let x = 200;
    const size = rowH - 12;
    for (let k = 0; k < 4; k++) {
      items.push({ svg: enemySvg(art, 0, k / 4), x, y: y + 3, size });
      x += size + 4;
    }
    x += 16;
    const stages = art.rank === undefined ? STAGES.length : 1;
    for (let s = 1; s < stages; s++) {
      items.push({ svg: enemySvg(art, s, 0), x, y: y + 3, size });
      x += size + 4;
    }
    x = 1050;
    const game = gameSize(art.radius) / 2;
    for (let s = 0; s < stages; s++) {
      items.push({ svg: enemySvg(art, s, 0.25), x, y: y + rowH / 2 - game / 2 - 3, size: game });
      x += game + 10;
    }
    y += rowH;
  }
  return { width: 1380, height: y + 16, items };
}

function heroBoard() {
  const items = [];
  items.push({ text: "Хранитель рубежа: покой ×2 · шаг ×4 · ранение · смерть ×4 · игровой масштаб справа", x: 24, y: 30, size: 22, bold: true });
  items.push({ ground: true, x: 16, y: 46, w: 1350, h: 170 });
  let x = 24;
  for (const [state, frames] of Object.entries(HERO_STATES)) {
    frames.forEach((_, k) => {
      items.push({ svg: heroSvg(state, k), x, y: 52, size: 104 });
      x += 100;
    });
  }
  items.push({ svg: heroSvg("walk", 1), x: 24, y: 160, size: gameSize(10, 2.6) / 2 });
  items.push({ text: "← в игре", x: 60, y: 196, size: 14, color: "#d7dcef" });
  return { width: 1380, height: 230, items };
}

/** Эффекты: кадры по порядку; белые — в цвете, как их окрасит тинт в рендере. */
function fxBoard() {
  const tints = { hit: ["#ffffff", "#ffe066", "#9bd0ff"], death: ["#ff4d5a", "#ff5a2e", "#ff7a90"], twinkle: ["#b6ff4a", "#d68cff"] };
  const items = [{ text: "Запечённые эффекты: кадры по порядку · белые окрашены, как их окрасит тинт", x: 24, y: 30, size: 22, bold: true }];
  let y = 46;
  for (const fx of FX) {
    const variants = tints[fx.id] ?? [null];
    for (const tint of variants) {
      items.push({ ground: true, x: 16, y, w: 1350, h: 120 });
      items.push({ text: `fx/${fx.id}${tint ? ` · тинт ${tint}` : ""}`, x: 24, y: y + 22, size: 15, bold: true });
      items.push({ text: `${fx.frames.length} кадров · ${fx.units} ед.`, x: 24, y: y + 42, size: 13, color: "#d7dcef" });
      fx.frames.forEach((svg, k) => {
        const colored = tint === null ? svg : svg.replaceAll('"#fff"', `"${tint}"`).replaceAll("#e8e4ee", tint).replaceAll("#b9b3c7", tint);
        items.push({ svg: colored, x: 260 + k * 118, y: y + 4, size: 112 });
      });
      y += 124;
    }
  }
  return { width: 1380, height: y + 10, items };
}

async function main() {
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, board] of [["concepts", conceptsBoard()], ["roster", rosterBoard()], ["hero", heroBoard()], ["fx", fxBoard()]]) {
    writeFileSync(join(OUT, `sheet-${name}.png`), Buffer.from(await renderBoard(page, board), "base64"));
  }
  await browser.close();
  console.log(`листы: ${OUT} · атлас ${PPU} пикс./ед.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
