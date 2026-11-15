import { useMemo, useState } from "react";
import type { PartnerEdits, PromoDoc } from "@bh/promo-kit";
import { Input, Notice } from "../ui/kit";
import { Segmented } from "./controls";
import { DEMO_DOC, createDemoAssets } from "./demo-doc";
import { LazyPromoEditor } from "./lazy";

/**
 * Витрина редактора промо (tasks/T-0274): открывается по адресу
 * `#/dev/promo-editor` только в сборке разработки. Пример — сторис с кодом;
 * оба режима, значения переменных и счётчик «что редактор отдал наружу».
 */
export function PromoEditorDemo() {
  const [mode, setMode] = useState<"team" | "partner">("team");
  const [filled, setFilled] = useState(true);
  const [code, setCode] = useState("ЗИМА25");
  const [emitted, setEmitted] = useState<{ count: number; layers: number; edits: PartnerEdits | null } | null>(null);
  // Набор один на витрину: смена режима не должна «терять» уже загруженные картинки.
  const assets = useMemo(() => createDemoAssets(), []);
  const vars = useMemo(() => (filled ? { code, link: "https://t.me/rubezh_bot?start=ref_zima25", reward: "300 монет" } : {}), [filled, code]);

  const onChange = (doc: PromoDoc, edits: PartnerEdits | null): void => setEmitted((current) => ({ count: (current?.count ?? 0) + 1, layers: doc.layers.length, edits }));

  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">Витрина редактора промо. Документ — «Сторис с кодом». Смена режима открывает пример заново.</Notice>
      <div className="flex flex-wrap items-end gap-4">
        <Segmented
          label="Режим"
          value={mode}
          options={[
            { value: "team", title: "Команда: правит всё", content: "Команда" },
            { value: "partner", title: "Партнёр: только разрешённое", content: "Партнёр" },
          ]}
          onChange={(next) => {
            setMode(next);
            setEmitted(null);
          }}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={filled} onChange={(event) => setFilled(event.target.checked)} />
          Значения переменных известны
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Промокод</span>
          <Input value={code} disabled={!filled} onChange={(event) => setCode(event.target.value)} className="w-40" />
        </label>
        <p className="text-xs text-text-muted" aria-live="polite">
          {emitted === null ? "Редактор пока ничего не отдавал наружу." : `Отдано наружу правок: ${String(emitted.count)}, слоёв: ${String(emitted.layers)}${emitted.edits === null ? "" : `, слоёв с правками партнёра: ${String(Object.keys(emitted.edits.layers ?? {}).length)}`}.`}
        </p>
      </div>
      <LazyPromoEditor key={mode} doc={DEMO_DOC} mode={mode} vars={vars} assets={assets} onChange={onChange} />
    </div>
  );
}
