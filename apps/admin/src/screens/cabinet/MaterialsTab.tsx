import { Copy, Download } from "lucide-react";
import { KIND_TITLES, MATERIAL_TEXTS, bannerFileName, bannerSize, fetchCabinetMaterials, type CabinetMaterial } from "../../api/partner-materials";
import { imageUrl } from "../../api/media";
import { api } from "../../services";
import { Badge, Button, ErrorNotice, Loading } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";

/** Скопировать текст как есть: партнёр вставляет его в пост, поэтому без доделок на клиенте. */
function copyText(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(MATERIAL_TEXTS.copied),
    () => toast.error(MATERIAL_TEXTS.copyFailed),
  );
}

/** Ссылка-кнопка «Скачать»: сам файл как он сохранён, а не его копия через холст. */
const DOWNLOAD_CLASS =
  "inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-raised px-3 py-1.5 text-sm font-medium text-text transition-colors hover:border-border-strong max-md:min-h-10";

function MaterialCard({ material }: { material: CabinetMaterial }) {
  const size = bannerSize(material);
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={material.kind === "rules" ? "info" : "neutral"}>{KIND_TITLES[material.kind]}</Badge>
        {material.shared ? null : <Badge tone="accent">лично для вас</Badge>}
      </div>
      <h3 className="text-base font-medium break-words">{material.title}</h3>
      {material.kind === "banner" && material.imageId !== null ? (
        <>
          <img src={imageUrl(material.imageId)} alt={material.title} loading="lazy" className="max-h-64 w-full rounded-sm border border-border bg-surface-sunken object-contain" />
          {material.text === null ? null : <p className="text-sm break-words whitespace-pre-wrap text-text-muted">{material.text}</p>}
          <div className="mt-auto flex flex-wrap items-center gap-3">
            <a href={imageUrl(material.imageId)} download={bannerFileName(material.title)} className={DOWNLOAD_CLASS} aria-label={`Скачать баннер «${material.title}»`}>
              <Download size={14} aria-hidden="true" />
              Скачать
            </a>
            {size === null ? null : <span className="text-xs text-text-muted">{size}, WebP</span>}
          </div>
        </>
      ) : (
        <>
          <p className="max-h-60 overflow-y-auto rounded-sm border border-border bg-surface-sunken px-3 py-2 text-sm break-words whitespace-pre-wrap">{material.text}</p>
          <div className="mt-auto">
            <Button onClick={() => copyText(material.text ?? "")} aria-label={`Скопировать текст «${material.title}»`}>
              <Copy size={14} aria-hidden="true" />
              Скопировать
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

/**
 * Вкладка «Материалы» (docs/35-stage4-plan.md Р136, tasks/T-0221): то, что выложила команда, — баннеры, тексты постов
 * и правила программы. Общие и адресованные этому партнёру, без архивных, по порядку команды; у текста — «Скопировать»,
 * у баннера — «Скачать». Ссылку партнёра в текст не подставляем: она на вкладке «Ссылки». В режиме «глазами партнёра»
 * видно то же, что видит он, — кнопки только читают.
 */
export function MaterialsTab({ partnerId }: { partnerId: string | null }) {
  const { state, reload } = useApi(() => fetchCabinetMaterials(api, partnerId), [partnerId]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { materials, viewOnly } = state.data;

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-text-muted">{MATERIAL_TEXTS.cabinetIntro}</p>
      {materials.length === 0 ? (
        <p className="text-sm text-text-muted">{viewOnly ? MATERIAL_TEXTS.cabinetEmptyView : MATERIAL_TEXTS.cabinetEmpty}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {materials.map((material) => (
            <MaterialCard key={material.materialId} material={material} />
          ))}
        </ul>
      )}
    </section>
  );
}
