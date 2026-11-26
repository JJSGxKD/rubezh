import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Download, Image as ImageIcon, QrCode, Redo2, RectangleHorizontal, Shield, Type, Undo2 } from "lucide-react";
import { MAX_LAYERS, type PromoLayer } from "@bh/promo-kit";
import { Button, Notice, Panel } from "../ui/kit";
import { saveFile } from "../ui/save-file";
import { CanvasStage } from "./CanvasStage";
import { IconButton } from "./controls";
import { exportFileName, exportImage, type ExportType } from "./export";
import { objectToLayer, pendingLayerIds, viewDoc, type ObjectSpec } from "./fabric-doc";
import type { UrlResolver } from "./fabric-objects";
import { commandForKey } from "./keys";
import { LayerList } from "./LayerList";
import { addLayer, duplicateLayer, moveLayer, removeLayer, renameLayer, updateDoc, updateLayer, type LayerKind } from "./layer-ops";
import { PHOTO_ACCEPT, photoProblem } from "./photo";
import { editorProblems } from "./problems";
import { PropertiesPanel } from "./PropertiesPanel";
import type { PromoAsset, PromoEditorProps } from "./types";
import { useEditorState } from "./use-editor";

/**
 * Редактор промо-материала на Fabric.js (docs/35-stage4-plan.md Р159,
 * tasks/T-0274). Документ `promo-kit` — источник истины, холст — отображение;
 * экраны пресетов (T-0275), генератора (T-0276) и кабинета партнёра (T-0277)
 * встраивают этот компонент и получают документ обратно через `onChange`.
 *
 * Два режима. `team` — команда правит всё. `partner` — шаблон неприкосновенен,
 * партнёр меняет только то, что слой ему разрешил, и каждая правка проходит
 * `applyPartnerEdits`.
 */
export type { PromoAsset, PromoAssets, PromoEditorProps } from "./types";

const WIDE_QUERY = "(min-width: 1024px)";

/** Окна нет (тесты) — считаем экран широким. */
function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(WIDE_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

const TOOLS: readonly { kind: LayerKind; title: string; icon: typeof Type }[] = [
  { kind: "text", title: "Текст", icon: Type },
  { kind: "image", title: "Картинка", icon: ImageIcon },
  { kind: "rect", title: "Прямоугольник", icon: RectangleHorizontal },
  { kind: "qr", title: "QR-код", icon: QrCode },
  { kind: "logo", title: "Логотип", icon: Shield },
];

/** Поле ввода, где клавиши принадлежат полю, а не редактору (Delete стирает знак, стрелки двигают курсор). */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

type FileJob = { kind: "photo"; layerId: string } | { kind: "asset"; layerId: string | null };

export function PromoEditor(props: PromoEditorProps) {
  const wide = useWide();
  if (!wide) {
    return <Notice tone="info">Редактор — на экране от 1024 точек. Откройте панель на компьютере или растяните окно.</Notice>;
  }
  return <Editor {...props} />;
}

function Editor({ doc: initial, mode = "team", vars, assets, onChange }: PromoEditorProps) {
  const state = useEditorState(initial, mode, onChange);
  const { doc, locals } = state.snapshot;
  const [selected, setSelected] = useState<string | null>(null);
  const [locked, setLocked] = useState<ReadonlySet<string>>(new Set());
  const [library, setLibrary] = useState<readonly PromoAsset[]>([]);
  const [busy, setBusy] = useState<ExportType | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const job = useRef<FileJob | null>(null);
  const blobUrls = useRef(new Set<string>());

  const refreshLibrary = async (): Promise<void> => {
    if (assets === undefined) return;
    try {
      setLibrary(await assets.list());
    } catch (error) {
      state.setNotice(error instanceof Error ? `Картинки пресета не загрузились: ${error.message}` : "Картинки пресета не загрузились");
    }
  };
  useEffect(() => {
    void refreshLibrary();
    // Список перечитывается при смене источника, а не при каждой перерисовке.
  }, [assets]);

  useEffect(() => {
    const urls = blobUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const varValues = useMemo(() => vars ?? {}, [vars]);
  const view = useMemo(() => viewDoc(doc, varValues), [doc, varValues]);
  const pending = useMemo(() => pendingLayerIds(doc, varValues), [doc, varValues]);
  const ctx = useMemo(() => ({ mode, locked }), [mode, locked]);
  const urls = useMemo<UrlResolver>(() => {
    const byId = new Map(library.map((asset) => [asset.id, asset.url]));
    return { media: (id) => byId.get(id) ?? null, local: (layerId) => locals[layerId] ?? null };
  }, [library, locals]);

  const layer = selected === null ? null : (doc.layers.find((candidate) => candidate.id === selected) ?? null);
  // Выбранный слой, которого уже нет (удалили, отменили добавление), — не выбранный.
  useEffect(() => {
    if (selected !== null && layer === null) setSelected(null);
  }, [selected, layer]);

  const problems = useMemo(() => {
    const list = editorProblems(doc);
    for (const id of pending) list.push(`Слой «${id}»: у переменной нет значения — на картинке на её месте будет пусто`);
    return list;
  }, [doc, pending]);

  const team = mode === "team";

  const patchLayer = (id: string, patch: Record<string, unknown>): void => {
    const key = `${id}:${Object.keys(patch).sort().join(",")}`;
    state.editDoc((current) => updateLayer(current, id, patch), key);
  };

  const add = (kind: LayerKind): void => {
    const result = addLayer(doc, kind, kind === "image" && library[0] !== undefined ? { media: library[0].id } : undefined);
    if (!result.ok) {
      state.setNotice(result.message);
      return;
    }
    state.editDoc(() => result.doc);
    setSelected(result.id);
  };

  const duplicate = (id: string): void => {
    const result = duplicateLayer(doc, id);
    if (!result.ok) {
      state.setNotice(result.message);
      return;
    }
    state.editDoc(() => result.doc);
    setSelected(result.id);
  };

  const remove = (id: string): void => {
    if (locked.has(id)) {
      state.setNotice(`Слой «${id}» закреплён — сначала открепите его`);
      return;
    }
    state.editDoc((current) => removeLayer(current, id));
    setSelected(null);
  };

  const rename = (id: string, next: string): string | null => {
    const result = renameLayer(doc, id, next);
    if (!result.ok) return result.message;
    state.editDoc(() => result.doc);
    setSelected(result.id);
    setLocked((current) => (current.has(id) ? new Set([...current].map((item) => (item === id ? result.id : item))) : current));
    return null;
  };

  // Правка идёт от свежего документа, а не от того, что был при отрисовке: два события подряд не затирают друг друга.
  const replaceFromCanvas = (id: string, spec: ObjectSpec, untouched?: (prev: PromoLayer) => boolean): void => {
    state.editDoc((current) => {
      const prev = current.layers.find((candidate) => candidate.id === id);
      if (prev === undefined || untouched?.(prev) === true) return current;
      const next = objectToLayer(spec, prev);
      return JSON.stringify(next) === JSON.stringify(prev) ? current : { ...current, layers: current.layers.map((item) => (item.id === id ? next : item)) };
    });
  };

  const onCanvasChange = (id: string, spec: ObjectSpec): void => {
    if (team) replaceFromCanvas(id, spec);
  };

  const onEditText = (id: string, text: string, spec: ObjectSpec): void => {
    // Вошли в правку и вышли, ничего не набрав, — шага в истории не будет.
    if (team) replaceFromCanvas(id, spec, (prev) => prev.type === "text" && prev.text === text);
    else state.partnerChange({ layerId: id, field: "text", value: text });
  };

  const pickFile = (next: FileJob): void => {
    job.current = next;
    fileInput.current?.click();
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    const current = job.current;
    job.current = null;
    if (file === undefined || current === null) return;
    const problem = photoProblem(file);
    if (problem !== null) {
      state.setNotice(problem);
      return;
    }
    if (current.kind === "photo") {
      // Фото читает сам браузер: адрес живёт, пока открыт редактор, на сервер файл не уходит.
      const url = URL.createObjectURL(file);
      blobUrls.current.add(url);
      state.partnerChange({ layerId: current.layerId, field: "src", value: { local: true } }, url);
      return;
    }
    if (assets === undefined) return;
    try {
      const id = await assets.upload(file);
      await refreshLibrary();
      if (current.layerId === null) state.editDoc((now) => updateDoc(now, { background: { media: id } }));
      else patchLayer(current.layerId, { src: { media: id } });
    } catch (error) {
      state.setNotice(error instanceof Error ? `Картинка не загрузилась: ${error.message}` : "Картинка не загрузилась");
    }
  };

  const nudge = (dx: number, dy: number): void => {
    if (!team || layer === null) return;
    if (locked.has(layer.id)) {
      state.setNotice(`Слой «${layer.id}» закреплён — сначала открепите его`);
      return;
    }
    patchLayer(layer.id, { x: layer.x + dx, y: layer.y + dy });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isTyping(event.target)) return;
    const command = commandForKey(event);
    if (command === null) return;
    event.preventDefault();
    switch (command.type) {
      case "undo":
        state.undo();
        return;
      case "redo":
        state.redo();
        return;
      case "delete":
        if (team && layer !== null) remove(layer.id);
        return;
      case "duplicate":
        if (team && layer !== null) duplicate(layer.id);
        return;
      case "nudge":
        nudge(command.dx, command.dy);
        return;
    }
  };

  const download = async (type: ExportType): Promise<void> => {
    setBusy(type);
    try {
      const blob = await exportImage(doc, varValues, type, urls);
      saveFile(blob, exportFileName(doc.format, varValues.code, type));
    } catch (error) {
      state.setNotice(error instanceof Error ? `Выгрузка не удалась: ${error.message}` : "Выгрузка не удалась");
    } finally {
      setBusy(null);
    }
  };

  const toggleHidden = (target: PromoLayer): void => patchLayer(target.id, { hidden: target.hidden === true ? undefined : true });

  const toggleLock = (id: string): void =>
    setLocked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    // Фокус на корне нужен ради клавиш: холст Fabric сам фокус не берёт.
    <div ref={root} tabIndex={0} onKeyDown={onKeyDown} className="@container flex flex-col gap-3 outline-none" aria-label="Редактор промо">
      <input
        ref={fileInput}
        type="file"
        accept={PHOTO_ACCEPT}
        hidden
        onChange={(event) => {
          void onFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {team ? (
          <div role="group" aria-label="Добавить слой" className="flex flex-wrap items-center gap-1.5">
            {TOOLS.map((tool) => (
              <Button key={tool.kind} onClick={() => add(tool.kind)} disabled={doc.layers.length >= MAX_LAYERS} title={`Добавить: ${tool.title}`}>
                <tool.icon size={14} aria-hidden />
                {tool.title}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Отменить — Ctrl+Z" disabled={!state.canUndo} onClick={state.undo}>
            <Undo2 size={16} aria-hidden />
          </IconButton>
          <IconButton label="Повторить — Ctrl+Shift+Z" disabled={!state.canRedo} onClick={state.redo}>
            <Redo2 size={16} aria-hidden />
          </IconButton>
        </div>
      </div>

      {state.notice === null ? null : (
        <div role="alert" className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Notice tone="warning">{state.notice}</Notice>
          </div>
          <Button onClick={() => state.setNotice(null)}>Понятно</Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @4xl:grid-cols-[15rem_minmax(0,1fr)_17.5rem]">
        <div className="order-2 @4xl:order-1">
          <Panel title="Слои">
            <LayerList doc={doc} mode={mode} selected={selected} locked={locked} onSelect={setSelected} onToggleHidden={toggleHidden} onToggleLock={toggleLock} onMove={(id, direction) => state.editDoc((current) => moveLayer(current, id, direction))} onRename={rename} />
          </Panel>
        </div>

        <div className="order-1 flex min-w-0 flex-col gap-3 @2xl:col-span-2 @4xl:order-2 @4xl:col-span-1">
          <CanvasStage
            view={view}
            raw={doc}
            ctx={ctx}
            urls={urls}
            pending={pending}
            selected={selected}
            onSelect={setSelected}
            onChange={onCanvasChange}
            onEditText={onEditText}
            onProblem={state.setNotice}
          />
          <section aria-label="Выгрузка" className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
            {problems.length === 0 ? null : (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-semibold text-warning">Перед выгрузкой стоит поправить:</p>
                <ul className="list-disc pl-5 text-xs text-text-muted">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
                <p className="text-xs text-text-muted">Выгрузить можно и так — это подсказки, а не запрет.</p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button tone="primary" disabled={busy !== null} onClick={() => void download("png")}>
                <Download size={14} aria-hidden />
                {busy === "png" ? "Собираю…" : "Скачать PNG"}
              </Button>
              <Button disabled={busy !== null} onClick={() => void download("jpeg")}>
                <Download size={14} aria-hidden />
                {busy === "jpeg" ? "Собираю…" : "Скачать JPEG"}
              </Button>
              <span className="text-xs text-text-muted">В полном размере формата.</span>
            </div>
          </section>
        </div>

        <div className="order-3">
          <Panel title="Свойства">
            <PropertiesPanel
              doc={doc}
              layer={layer}
              mode={mode}
              assets={library}
              canUpload={assets !== undefined}
              onPatch={patchLayer}
              onDocPatch={(patch) => state.editDoc((current) => updateDoc(current, patch), `doc:${Object.keys(patch).join(",")}`)}
              onPartner={(layerId, field, value) => state.partnerChange({ layerId, field, value })}
              onPickPhoto={(layerId) => pickFile({ kind: "photo", layerId })}
              onUploadAsset={(layerId) => pickFile({ kind: "asset", layerId })}
              onDuplicate={duplicate}
              onDelete={remove}
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}
