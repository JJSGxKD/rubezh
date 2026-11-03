# @bh/promo-kit

Модель промо-материала (генератор промо, `docs/35-stage4-plan.md` Р159):
форматы, документ из слоёв, подстановка промокода, ссылки и QR, правила
правки партнёром и предупреждения редактора. Пакет самостоятельный: ничего
из монорепо, Nest, Prisma и Fabric — его берут панель, кабинет партнёра,
сервер и другие проекты. Перевод документа в холст и выгрузка в картинку —
дело редактора.

## Что внутри

- `FORMATS`, `FORMAT_IDS`, `formatSize` — пять форматов первой волны: сторис
  1080×1920, пост 1:1 и 4:5, баннер 1280×720, превью ссылки 1200×630.
- `promoDocSchema` (Zod, `version: 1`) — документ: формат, фон (цвет или
  картинка из `media`), палитра до 8 цветов, до 40 слоёв. Слои: `text`, `image`,
  `rect`, `qr`, `logo`; размеры и положение — в точках формата.
- `resolveDoc(doc, vars)` — подставляет `{code}`, `{link}`, `{reward}` в тексты
  и отдаёт новый документ. Нет значения — пустое место; `qr` без `link`
  скрыт, а с ним получает `data` — что кодировать. `usedVars(doc)` — какие
  переменные нужны документу (слой `qr` требует `link`).
- `applyPartnerEdits(template, edits)` — правки партнёра. Право задаёт
  `partner` слоя: `text` — менять текст, `image` — заменить картинку своим фото
  (`{ local: true }`, на сервер оно не уходит), `color` — выбрать цвет из
  `palette`. Положение, размер, шрифт, порядок и скрытие слоёв не меняются
  никогда. Запрещённое — `PartnerEditError` с `layerId`.
- `docProblems(doc)` — предупреждения по-русски: слой целиком за холстом, повтор
  `id`, QR меньше 160 точек, текст мельче 24 на сторис. Это подсказки
  редактора, схема их не отвергает.

## Пример

```ts
import { applyPartnerEdits, docProblems, promoDocSchema, resolveDoc, usedVars } from "@bh/promo-kit";

const template = promoDocSchema.parse(JSON.parse(stored));
const edited = applyPartnerEdits(template, { layers: { greeting: { text: "Заходи, друг! {code}" } } });
const needs = usedVars(edited); // ["code", "link"] — что спросить у пользователя
const ready = resolveDoc(edited, { code: "ЗИМА25", link: "https://t.me/bot?start=ref_x", reward: "300 монет" });
const warnings = docProblems(ready);
```

## Проверки

```bash
pnpm --filter @bh/promo-kit typecheck
pnpm exec vitest run packages/promo-kit
```
