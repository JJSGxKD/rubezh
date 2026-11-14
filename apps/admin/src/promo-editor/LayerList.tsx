import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Image as ImageIcon, Lock, LockOpen, Pencil, QrCode, RectangleHorizontal, Shield, Type } from "lucide-react";
import type { PartnerRight, PromoDoc, PromoLayer } from "@bh/promo-kit";
import { IconButton } from "./controls";
import type { Mode } from "./fabric-doc";

/**
 * Список слоёв (tasks/T-0274): сверху — верхний слой холста. Команда поднимает,
 * опускает, скрывает, закрепляет и переименовывает; партнёр видит только слои,
 * где ему что-то разрешено, и что именно.
 */
const ICONS = { text: Type, image: ImageIcon, rect: RectangleHorizontal, qr: QrCode, logo: Shield } as const;

const KIND_TITLES = { text: "Текст", image: "Картинка", rect: "Прямоугольник", qr: "QR-код", logo: "Логотип" } as const;

const RIGHT_TITLES: Record<PartnerRight, string> = { none: "", text: "можно менять текст", image: "можно заменить фото", color: "можно менять цвет" };

export interface LayerListProps {
  doc: PromoDoc;
  mode: Mode;
  selected: string | null;
  locked: ReadonlySet<string>;
  onSelect(id: string): void;
  onToggleHidden(layer: PromoLayer): void;
  onToggleLock(id: string): void;
  onMove(id: string, direction: "up" | "down"): void;
  /** вернуть текст ошибки, если имя не подошло */
  onRename(id: string, next: string): string | null;
}

export function LayerList(props: LayerListProps) {
  const { doc, mode } = props;
  const [renaming, setRenaming] = useState<{ id: string; draft: string; error: string | null } | null>(null);
  const layers = [...doc.layers].reverse();
  const shown = mode === "partner" ? layers.filter((layer) => (layer.partner ?? "none") !== "none") : layers;

  if (shown.length === 0) {
    return <p className="text-sm text-text-muted">{mode === "partner" ? "В этом шаблоне нечего менять." : "Слоёв пока нет — добавьте первый кнопками сверху."}</p>;
  }

  return (
    <ul className="flex flex-col gap-1" aria-label="Слои сверху вниз">
      {shown.map((layer) => {
        const Icon = ICONS[layer.type];
        const index = doc.layers.indexOf(layer);
        const isSelected = layer.id === props.selected;
        const hidden = layer.hidden === true;
        const isLocked = props.locked.has(layer.id);
        const editing = renaming?.id === layer.id ? renaming : null;
        return (
          <li key={layer.id} className={`rounded-sm border ${isSelected ? "border-accent bg-surface-raised" : "border-transparent hover:border-border"}`}>
            <div className="flex items-center gap-1 px-1.5 py-1">
              <Icon size={16} className="shrink-0 text-text-muted" aria-label={KIND_TITLES[layer.type]} />
              {editing === null ? (
                <button
                  type="button"
                  onClick={() => props.onSelect(layer.id)}
                  onDoubleClick={() => mode === "team" && setRenaming({ id: layer.id, draft: layer.id, error: null })}
                  aria-current={isSelected}
                  className={`min-w-0 flex-1 truncate py-1 text-left text-sm ${hidden ? "text-text-muted line-through" : "text-text"}`}
                  title={mode === "team" ? "Двойное нажатие — переименовать" : undefined}
                >
                  {layer.id}
                  {mode === "partner" ? <span className="block text-xs text-text-muted">{RIGHT_TITLES[layer.partner ?? "none"]}</span> : null}
                </button>
              ) : (
                <input
                  autoFocus
                  aria-label={`Новое имя слоя «${layer.id}»`}
                  value={editing.draft}
                  onChange={(event) => setRenaming({ ...editing, draft: event.target.value, error: null })}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRenaming(null);
                    if (event.key !== "Enter") return;
                    const error = props.onRename(layer.id, editing.draft);
                    setRenaming(error === null ? null : { ...editing, error });
                  }}
                  className="min-w-0 flex-1 rounded-sm border border-accent bg-surface-sunken px-1.5 py-1 text-sm"
                />
              )}
            </div>
            {mode === "team" ? (
              <div className="flex items-center justify-end gap-0.5 px-1.5 pb-1">
                <IconButton label={`Переименовать «${layer.id}»`} onClick={() => setRenaming({ id: layer.id, draft: layer.id, error: null })}>
                  <Pencil size={14} aria-hidden />
                </IconButton>
                <IconButton label={hidden ? `Показать «${layer.id}»` : `Скрыть «${layer.id}»`} pressed={hidden} onClick={() => props.onToggleHidden(layer)}>
                  {hidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                </IconButton>
                <IconButton label={isLocked ? `Открепить «${layer.id}»` : `Закрепить «${layer.id}»`} pressed={isLocked} onClick={() => props.onToggleLock(layer.id)}>
                  {isLocked ? <Lock size={14} aria-hidden /> : <LockOpen size={14} aria-hidden />}
                </IconButton>
                <IconButton label={`Поднять «${layer.id}»`} disabled={index === doc.layers.length - 1} onClick={() => props.onMove(layer.id, "up")}>
                  <ArrowUp size={14} aria-hidden />
                </IconButton>
                <IconButton label={`Опустить «${layer.id}»`} disabled={index === 0} onClick={() => props.onMove(layer.id, "down")}>
                  <ArrowDown size={14} aria-hidden />
                </IconButton>
              </div>
            ) : null}
            {editing?.error != null ? (
              <p role="alert" className="px-2 pb-1.5 text-xs text-danger">
                {editing.error}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
