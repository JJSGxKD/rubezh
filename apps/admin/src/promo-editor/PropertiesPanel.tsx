import type { ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, Copy, ImageUp, Trash2, Upload } from "lucide-react";
import { FONTS, MAX_PALETTE, MAX_TEXT_LENGTH, PARTNER_RIGHTS, VAR_NAMES, type PartnerRight, type PromoDoc, type PromoLayer, type TextLayer } from "@bh/promo-kit";
import { Button, Select, TextArea } from "../ui/kit";
import { ColorField, NumberField, Segmented } from "./controls";
import type { Mode } from "./fabric-doc";
import type { PromoAsset } from "./types";

/**
 * Свойства выбранного слоя (tasks/T-0274). Команда видит всё и правит
 * документ; партнёр — только то одно поле, которое слой ему разрешил.
 * Панель ничего не хранит: каждая правка — вызов наружу, документ меняется
 * там.
 */
export interface PropertiesProps {
  doc: PromoDoc;
  layer: PromoLayer | null;
  mode: Mode;
  assets: readonly PromoAsset[];
  canUpload: boolean;
  /** команда: поля слоя */
  onPatch(id: string, patch: Record<string, unknown>): void;
  /** команда: фон и палитра документа */
  onDocPatch(patch: Partial<Pick<PromoDoc, "background" | "palette">>): void;
  /** партнёр: одно из полей `text`, `color` */
  onPartner(layerId: string, field: "text" | "color", value: string): void;
  onPickPhoto(layerId: string): void;
  onUploadAsset(layerId: string | null): void;
  onDuplicate(id: string): void;
  onDelete(id: string): void;
}

const FONT_TITLES: Record<(typeof FONTS)[number], string> = { russo_one: "Russo One", ibm_plex_sans: "IBM Plex Sans" };

const RIGHT_OPTIONS: Record<PartnerRight, string> = { none: "Ничего", text: "Текст", image: "Картинку", color: "Цвет" };

/** Что партнёру можно разрешить на слое этого вида: у логотипа и у QR картинки и текста нет. */
function allowedRights(layer: PromoLayer): PartnerRight[] {
  switch (layer.type) {
    case "text":
      return ["none", "text", "color"];
    case "image":
      return ["none", "image"];
    case "rect":
    case "qr":
      return ["none", "color"];
    case "logo":
      return ["none"];
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold tracking-wide text-text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function PropertiesPanel(props: PropertiesProps) {
  const { layer, mode } = props;
  if (layer === null) return mode === "team" ? <DocumentProperties {...props} /> : <p className="text-sm text-text-muted">Выберите слой в списке или на холсте — здесь появится то, что в нём можно изменить.</p>;
  return mode === "team" ? <TeamProperties {...props} layer={layer} /> : <PartnerProperties {...props} layer={layer} />;
}

function PartnerProperties({ layer, doc, onPartner, onPickPhoto }: PropertiesProps & { layer: PromoLayer }) {
  const right = layer.partner ?? "none";
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{layer.id}</h3>
      {right === "text" && layer.type === "text" ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Текст</span>
          <TextArea rows={4} maxLength={MAX_TEXT_LENGTH} value={layer.text} onChange={(event) => onPartner(layer.id, "text", event.target.value)} />
          <span className="text-xs text-text-muted">
            Можно двойным нажатием прямо на холсте. Знаки вида {"{code}"} подставятся при выгрузке — не стирайте их. {layer.text.length}/{MAX_TEXT_LENGTH}
          </span>
        </label>
      ) : null}
      {right === "color" ? <ColorField label="Цвет" value={colorOf(layer)} palette={doc.palette} free={false} onChange={(color) => color !== undefined && onPartner(layer.id, "color", color)} /> : null}
      {right === "image" ? (
        <div className="flex flex-col gap-1.5">
          <Button onClick={() => onPickPhoto(layer.id)} className="justify-center">
            <ImageUp size={16} aria-hidden />
            Заменить своим фото
          </Button>
          <span className="text-xs text-text-muted">Фото остаётся в вашем браузере и на сервер не отправляется. PNG, JPEG или WebP.</span>
        </div>
      ) : null}
    </div>
  );
}

/** Цвет слоя: у текста — букв, у прямоугольника — заливки, у QR — модулей. */
function colorOf(layer: PromoLayer): string | undefined {
  if (layer.type === "text") return layer.color;
  if (layer.type === "rect") return layer.fill;
  if (layer.type === "qr") return layer.fg;
  return undefined;
}

function TeamProperties({ layer, doc, assets, canUpload, onPatch, onUploadAsset, onDuplicate, onDelete }: PropertiesProps & { layer: PromoLayer }) {
  const patch = (fields: Record<string, unknown>) => onPatch(layer.id, fields);
  const free = true;
  const sideOnly = layer.type === "qr";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{layer.id}</h3>
        <Button onClick={() => onDuplicate(layer.id)} aria-label={`Копия слоя «${layer.id}»`} title="Копия — Ctrl+D">
          <Copy size={14} aria-hidden />
        </Button>
        <Button tone="danger" onClick={() => onDelete(layer.id)} aria-label={`Удалить слой «${layer.id}»`} title="Удалить — Delete">
          <Trash2 size={14} aria-hidden />
        </Button>
      </div>

      <Section title="Положение">
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="X" value={layer.x} min={-5000} max={5000} onChange={(x) => patch({ x })} />
          <NumberField label="Y" value={layer.y} min={-5000} max={5000} onChange={(y) => patch({ y })} />
          <NumberField label={sideOnly ? "Сторона" : "Ширина"} value={layer.width} min={8} max={5000} onChange={(width) => patch(sideOnly ? { width, height: width } : { width })} />
          {sideOnly ? null : <NumberField label="Высота" value={layer.height} min={8} max={5000} onChange={(height) => patch({ height })} />}
          <NumberField label="Поворот, °" value={layer.rotation ?? 0} min={-180} max={180} onChange={(rotation) => patch({ rotation })} />
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Прозрачность: {Math.round((layer.opacity ?? 1) * 100)} %</span>
          <input type="range" min={0} max={100} value={Math.round((layer.opacity ?? 1) * 100)} onChange={(event) => patch({ opacity: Number(event.target.value) / 100 })} className="accent-accent" />
        </label>
      </Section>

      {layer.type === "text" ? <TextProperties layer={layer} palette={doc.palette} onPatch={patch} /> : null}

      {layer.type === "rect" ? (
        <Section title="Прямоугольник">
          <ColorField label="Заливка" value={layer.fill} palette={doc.palette} free={free} onChange={(fill) => fill !== undefined && patch({ fill })} />
          <NumberField label="Скругление" value={layer.radius ?? 0} min={0} max={540} onChange={(radius) => patch({ radius })} />
          <ColorField label="Обводка" value={layer.stroke} palette={doc.palette} free={free} allowEmpty onChange={(stroke) => patch(stroke === undefined ? { stroke: undefined, strokeWidth: undefined } : { stroke, strokeWidth: layer.strokeWidth ?? 4 })} />
          {layer.stroke === undefined ? null : <NumberField label="Толщина обводки" value={layer.strokeWidth ?? 0} min={0} max={200} onChange={(strokeWidth) => patch({ strokeWidth })} />}
        </Section>
      ) : null}

      {layer.type === "qr" ? (
        <Section title="QR-код">
          <ColorField label="Модули" value={layer.fg} palette={doc.palette} free={free} onChange={(fg) => fg !== undefined && patch({ fg })} />
          <ColorField label="Фон" value={layer.bg} palette={doc.palette} free={free} onChange={(bg) => bg !== undefined && patch({ bg })} />
          <p className="text-xs text-text-muted">Ссылку подставляет выгрузка. Тёмный код на светлом фоне, поле тишины — четыре модуля.</p>
        </Section>
      ) : null}

      {layer.type === "logo" ? (
        <Section title="Логотип">
          <Segmented
            label="Вариант"
            value={layer.variant}
            options={[
              { value: "full", title: "Словесный знак", content: "Слово" },
              { value: "rune", title: "Знак-оберег", content: "Оберег" },
            ]}
            onChange={(variant) => patch({ variant })}
          />
        </Section>
      ) : null}

      {layer.type === "image" ? (
        <Section title="Картинка">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Источник</span>
            <Select
              value={"media" in layer.src ? layer.src.media : ""}
              onChange={(event) => patch({ src: event.target.value === "" ? { local: true } : { media: event.target.value } })}
            >
              <option value="">Слот под фото партнёра</option>
              {"media" in layer.src && !assets.some((asset) => "media" in layer.src && asset.id === layer.src.media) ? <option value={layer.src.media}>{layer.src.media} (не найдена)</option> : null}
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name ?? asset.id}
                </option>
              ))}
            </Select>
          </label>
          <Button onClick={() => onUploadAsset(layer.id)} disabled={!canUpload} blockedBy={canUpload ? null : "Загрузка недоступна на этом экране"}>
            <Upload size={14} aria-hidden />
            Загрузить картинку
          </Button>
        </Section>
      ) : null}

      <Section title="Доступ партнёра">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Партнёр может менять</span>
          <Select value={layer.partner ?? "none"} onChange={(event) => patch({ partner: event.target.value === "none" ? undefined : event.target.value })}>
            {PARTNER_RIGHTS.filter((right) => allowedRights(layer).includes(right)).map((right) => (
              <option key={right} value={right}>
                {RIGHT_OPTIONS[right]}
              </option>
            ))}
          </Select>
        </label>
        <p className="text-xs text-text-muted">Положение, размер, шрифт и порядок партнёр не меняет никогда.</p>
      </Section>
    </div>
  );
}

function TextProperties({ layer, palette, onPatch }: { layer: TextLayer; palette: readonly string[]; onPatch: (fields: Record<string, unknown>) => void }) {
  return (
    <Section title="Текст">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">Содержимое</span>
        <TextArea rows={3} maxLength={MAX_TEXT_LENGTH} value={layer.text} onChange={(event) => onPatch({ text: event.target.value })} />
        <span className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
          Переменные:
          {VAR_NAMES.map((name) => (
            <button key={name} type="button" onClick={() => onPatch({ text: `${layer.text}{${name}}` })} className="rounded-sm border border-border px-1.5 py-0.5 font-mono hover:border-border-strong">
              {`{${name}}`}
            </button>
          ))}
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">Шрифт</span>
        <Select value={layer.font} onChange={(event) => onPatch({ font: event.target.value })}>
          {FONTS.map((font) => (
            <option key={font} value={font}>
              {FONT_TITLES[font]}
            </option>
          ))}
        </Select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Размер" value={layer.size} min={12} max={240} onChange={(size) => onPatch({ size })} />
        <NumberField label="Межстрочный" value={layer.lineHeight} min={0.8} max={2} onChange={(lineHeight) => onPatch({ lineHeight })} />
      </div>
      <div className="flex flex-wrap gap-3">
        <Segmented
          label="Начертание"
          value={layer.weight}
          options={[
            { value: 400, title: "Обычное", content: "Обычный" },
            { value: 700, title: "Жирное", content: <strong>Жирный</strong> },
          ]}
          onChange={(weight) => onPatch({ weight })}
        />
        <Segmented
          label="Выравнивание"
          value={layer.align}
          options={[
            { value: "left", title: "По левому краю", content: <AlignLeft size={16} aria-hidden /> },
            { value: "center", title: "По центру", content: <AlignCenter size={16} aria-hidden /> },
            { value: "right", title: "По правому краю", content: <AlignRight size={16} aria-hidden /> },
          ]}
          onChange={(align) => onPatch({ align })}
        />
      </div>
      <ColorField label="Цвет" value={layer.color} palette={palette} free onChange={(color) => color !== undefined && onPatch({ color })} />
    </Section>
  );
}

function DocumentProperties({ doc, assets, canUpload, onDocPatch, onUploadAsset }: PropertiesProps) {
  const background = doc.background;
  const palette = doc.palette;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">Документ</h3>
      <Section title="Фон">
        <Segmented
          label="Чем залить"
          value={typeof background === "string" ? "color" : "media"}
          options={[
            { value: "color", title: "Цвет", content: "Цвет" },
            { value: "media", title: "Картинка", content: "Картинка" },
          ]}
          onChange={(kind) => {
            const first = assets[0];
            if (kind === "color") onDocPatch({ background: palette[0] ?? "#120f1e" });
            else if (first !== undefined) onDocPatch({ background: { media: first.id } });
            else onUploadAsset(null);
          }}
        />
        {typeof background === "string" ? (
          <ColorField label="Цвет фона" value={background} palette={palette} free onChange={(color) => color !== undefined && onDocPatch({ background: color })} />
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Картинка фона</span>
            <Select value={background.media} onChange={(event) => onDocPatch({ background: { media: event.target.value } })}>
              {assets.some((asset) => asset.id === background.media) ? null : <option value={background.media}>{background.media} (не найдена)</option>}
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name ?? asset.id}
                </option>
              ))}
            </Select>
            <Button onClick={() => onUploadAsset(null)} disabled={!canUpload}>
              <Upload size={14} aria-hidden />
              Загрузить картинку
            </Button>
          </label>
        )}
      </Section>
      <Section title={`Палитра пресета (${String(palette.length)} из ${String(MAX_PALETTE)})`}>
        <p className="text-xs text-text-muted">Из неё выбирают цвет и команда, и партнёр.</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {palette.map((color, index) => (
            <span key={`${color}${String(index)}`} className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-sunken py-0.5 pr-1 pl-0.5">
              <input
                type="color"
                aria-label={`Цвет палитры ${String(index + 1)}`}
                value={color}
                onChange={(event) => onDocPatch({ palette: palette.map((item, at) => (at === index ? event.target.value.toLowerCase() : item)) })}
                className="h-6 w-7 cursor-pointer border-0 bg-transparent p-0"
              />
              <button type="button" aria-label={`Убрать цвет ${color} из палитры`} title="Убрать" onClick={() => onDocPatch({ palette: palette.filter((_, at) => at !== index) })} className="px-1 text-text-muted hover:text-danger">
                ×
              </button>
            </span>
          ))}
          <Button disabled={palette.length >= MAX_PALETTE} blockedBy={palette.length >= MAX_PALETTE ? `Не больше ${String(MAX_PALETTE)} цветов` : null} onClick={() => onDocPatch({ palette: [...palette, "#ffffff"] })}>
            + Цвет
          </Button>
        </div>
      </Section>
    </div>
  );
}
