import { promoDocSchema, type PromoDoc } from "@bh/promo-kit";
import type { PromoAsset, PromoAssets } from "./types";

/**
 * Пример для витрины редактора (tasks/T-0274): сторис с кодом — заголовок,
 * картинка, плашка, QR и логотип. Права партнёра расставлены так, чтобы в
 * режиме партнёра было что показать: текст заголовка, замена картинки и цвет
 * плашки; остальное неприкосновенно.
 */
export const DEMO_DOC: PromoDoc = promoDocSchema.parse({
  version: 1,
  format: "story",
  background: "#120f1e",
  palette: ["#ffffff", "#ff8f3f", "#46d9c6", "#28273f", "#120f1e"],
  layers: [
    { id: "hero", type: "image", x: 0, y: 300, width: 1080, height: 820, src: { media: "demo_hero" }, partner: "image" },
    { id: "plate", type: "rect", x: 60, y: 1180, width: 960, height: 420, fill: "#28273f", radius: 36, stroke: "#ff8f3f", strokeWidth: 6, partner: "color" },
    { id: "logo", type: "logo", x: 270, y: 90, width: 540, height: 170, variant: "full" },
    { id: "title", type: "text", x: 90, y: 1220, width: 900, height: 130, text: "Твой код: {code}", font: "russo_one", size: 96, weight: 400, color: "#ffffff", align: "center", lineHeight: 1.1, partner: "text" },
    { id: "subtitle", type: "text", x: 90, y: 1360, width: 560, height: 180, text: "Подарок за первый забег. Отсканируй QR или открой ссылку.", font: "ibm_plex_sans", size: 44, weight: 400, color: "#aeaac4", align: "left", lineHeight: 1.3 },
    { id: "qr", type: "qr", x: 700, y: 1330, width: 260, height: 260, fg: "#120f1e", bg: "#ffffff" },
  ],
});

/** Картинка-заглушка для витрины: рисуется на лету, чтобы в репозитории не лежал бинарный файл. */
async function drawHero(): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1200;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Нет 2D-холста");
  const sky = context.createLinearGradient(0, 0, 0, 1200);
  sky.addColorStop(0, "#3b2f5c");
  sky.addColorStop(0.6, "#c0562d");
  sky.addColorStop(1, "#ffb22e");
  context.fillStyle = sky;
  context.fillRect(0, 0, 1600, 1200);
  context.fillStyle = "#120f1e";
  context.beginPath();
  context.moveTo(0, 1200);
  for (let x = 0; x <= 1600; x += 100) context.lineTo(x, 760 + ((x * 7) % 5) * 55);
  context.lineTo(1600, 1200);
  context.fill();
  context.fillStyle = "#ffe7a3";
  context.beginPath();
  context.arc(1150, 420, 130, 0, Math.PI * 2);
  context.fill();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob === null) throw new Error("Картинка не собралась");
  return URL.createObjectURL(blob);
}

/** Набор картинок для витрины: одна готовая и всё, что «загрузят» руками, — локально, в памяти страницы. */
export function createDemoAssets(): PromoAssets {
  const items: PromoAsset[] = [];
  const ready = drawHero().then((url) => {
    items.push({ id: "demo_hero", url, name: "Рассвет над рубежом (заглушка)" });
  });
  let counter = 0;
  return {
    async list() {
      await ready;
      return [...items];
    },
    // Настоящая загрузка — на сервер с профилем `promo_asset` (T-0275); витрине достаточно адреса из браузера.
    upload(file) {
      counter += 1;
      const id = `upload_${String(counter)}`;
      items.push({ id, url: URL.createObjectURL(file), name: file.name });
      return Promise.resolve(id);
    },
  };
}
