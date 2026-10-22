/**
 * Портреты героя для экранов меню (design/art/direction-v2.md §4.4): тот же
 * рисунок, что в атласе, но вектором. Арсенал показывает героя крупно, и
 * растровый кадр на 130 px поплыл бы на экране с плотностью 3.
 *
 * Рамка обрезана по кадру покоя из `atlas-core.json`: портрет встаёт в
 * контейнер ступнями вниз, без пустых полей ячейки. Поэтому сначала
 * `build.mjs`, потом этот скрипт:
 *   node design/art/src/portraits.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HERO_SKINS, HERO_STATES, heroDefs, withHeroPalette } from "./hero.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../out");

const atlas = JSON.parse(readFileSync(join(OUT, "atlas-core.json"), "utf8"));
const frame = atlas.frames["hero/idle0"];
const k = 100 / frame.sourceSize.w;
const round = (n) => Math.round(n * 10) / 10;
const box = [-50 + frame.spriteSourceSize.x * k, -50 + frame.spriteSourceSize.y * k, frame.spriteSourceSize.w * k, frame.spriteSourceSize.h * k].map(round);

for (const skin of HERO_SKINS) {
  const svg = withHeroPalette(skin.palette, () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(" ")}"><defs>${heroDefs()}</defs>${HERO_STATES.idle[0]()}</svg>\n`);
  const file = join(OUT, `portrait-hero-${skin.id}.svg`);
  writeFileSync(file, svg);
  console.log(`${file} · ${String(Buffer.byteLength(svg))} Б · рамка ${box.join(" ")}`);
}
