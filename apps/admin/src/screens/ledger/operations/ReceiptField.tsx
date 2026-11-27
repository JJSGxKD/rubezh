import { useRef, useState, type DragEvent } from "react";
import { IMAGE_MAX_BYTES, imageUrl, uploadImage } from "../../../api/media";
import { api } from "../../../services";
import { encodeWithin } from "../../../ui/image-crop";
import { Button } from "../../../ui/kit";
import { RECEIPT_SHRINK_STEPS, receiptFileProblem, receiptShrinkAllowed, receiptSizeProblem, receiptTarget } from "./receipt-image";

/**
 * Снимок чека операции (tasks/T-0464, Р220; docs/29-admin-panel.md §6.5): файл перетаскивается в рамку или выбирается
 * кнопкой. Панель сама сжимает снимок в WebP до 200 КБ, сервер проверяет и кладёт по хэшу содержимого; видят его
 * только те, у кого есть учёт (`ledger.view`). Обрезки нет — чек не квадрат.
 */
type State = { kind: "idle" } | { kind: "working" } | { kind: "failed"; problem: string };

/** Сжать снимок до предела: качество шагами вниз, а если не хватило — меньший размер, пока короткая сторона не ниже 300 px. */
async function compress(bitmap: ImageBitmap): Promise<{ ok: true; blob: Blob } | { ok: false; problem: string }> {
  let last = "Не получилось сжать снимок — попробуйте другой файл";
  for (const shrink of RECEIPT_SHRINK_STEPS) {
    if (!receiptShrinkAllowed(bitmap, shrink)) break;
    const target = receiptTarget(bitmap, shrink);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, target.width, target.height);
    const encoded = await encodeWithin((quality) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality)), IMAGE_MAX_BYTES);
    if (encoded.ok) return { ok: true, blob: encoded.blob };
    last = encoded.problem;
  }
  return { ok: false, problem: last };
}

export function ReceiptField({ value, onChange }: { value: string | null; onChange: (imageId: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [over, setOver] = useState(false);

  const take = async (file: File | undefined): Promise<void> => {
    if (input.current !== null) input.current.value = "";
    if (file === undefined) return;
    const unfit = receiptFileProblem(file);
    if (unfit !== null) return setState({ kind: "failed", problem: unfit });
    setState({ kind: "working" });
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return setState({ kind: "failed", problem: "Не получилось открыть файл — он повреждён или это не PNG, JPEG и не WebP" });
    }
    const small = receiptSizeProblem(bitmap);
    if (small !== null) {
      bitmap.close();
      return setState({ kind: "failed", problem: small });
    }
    const packed = await compress(bitmap);
    bitmap.close();
    if (!packed.ok) return setState({ kind: "failed", problem: packed.problem });
    const uploaded = await uploadImage(api, "finance_receipt", packed.blob);
    if (!uploaded.ok) return setState({ kind: "failed", problem: uploaded.error.message });
    setState({ kind: "idle" });
    onChange(uploaded.data.imageId);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setOver(false);
    void take(event.dataTransfer.files[0]);
  };

  const working = state.kind === "working";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">Снимок чека</span>
      <div
        role="group"
        aria-label="Снимок чека: перетащите файл сюда"
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`flex flex-wrap items-center gap-3 rounded-sm border border-dashed px-3 py-2 ${over ? "border-accent bg-surface-raised" : "border-border"}`}
      >
        {value === null ? null : <img src={imageUrl(value)} alt="Снимок чека" className="h-16 w-16 rounded-sm border border-border object-cover" />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm text-text-muted">{working ? "Сжимаем и загружаем…" : value === null ? "Перетащите снимок сюда или выберите файл" : "Снимок приложен"}</span>
          <div className="flex flex-wrap gap-2">
            <Button disabled={working} onClick={() => input.current?.click()}>
              {value === null ? "Выбрать файл…" : "Заменить…"}
            </Button>
            {value === null ? null : (
              <Button disabled={working} onClick={() => onChange(null)}>
                Убрать
              </Button>
            )}
          </div>
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => void take(event.target.files?.[0])} />
      </div>
      {state.kind === "failed" ? (
        <span role="alert" className="text-xs text-danger">
          {state.problem}
        </span>
      ) : null}
    </div>
  );
}
