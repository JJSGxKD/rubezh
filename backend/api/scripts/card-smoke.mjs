// Проверка карточек бота в собранном образе API (job `docker` в ci.yml).
//
// Тест на машине разработчика этого не видит: у Windows свои шрифты, а в
// slim-образе их может не оказаться или resvg их не найдёт — тогда текст на
// карточке пропадает целиком, как было с приветствием по /start. Карточка с
// текстом обязана весить заметно больше пустой: пустое поле сжимается в сотни
// байт, а буквы — нет.
import { renderPng, svgDocument, text } from "./dist/common/card/svg.js";

const blank = renderPng(svgDocument(600, 160, []));
const withText = renderPng(svgDocument(600, 160, [text(20, 100, "Привет, рубеж! Hold the line", { size: 44, fill: "#f3f6fc", weight: 700 })]));

if (withText.length <= blank.length + 1000) {
  console.error(`Текст на карточке не отрисован: ${withText.length} байт против ${blank.length} у пустой`);
  process.exit(1);
}
console.log(`Текст на карточке отрисован: ${withText.length} байт против ${blank.length} у пустой`);
