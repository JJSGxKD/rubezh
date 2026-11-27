import { useRef, useState } from "react";
import { fetchPartners } from "../../api/partners";
import {
  KIND_TITLES,
  MATERIAL_KINDS,
  MATERIAL_LIMITS,
  MATERIAL_TEXTS,
  archiveMaterial,
  audienceTitle,
  bannerSize,
  createMaterial,
  emptyMaterialForm,
  fetchTeamMaterials,
  materialFormOf,
  materialProblems,
  prepareBanner,
  teamOrder,
  updateMaterial,
  uploadBannerImage,
  type MaterialForm,
  type MaterialKind,
  type TeamMaterial,
} from "../../api/partner-materials";
import { imageUrl } from "../../api/media";
import { formatDateTime } from "../../format";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { SOURCE_TYPES, sourceProblem } from "../../ui/image-crop";
import { Badge, Button, DataTable, ErrorNotice, Field, Help, Input, Loading, Notice, Panel, Select, TextArea } from "../../ui/kit";
import { toast, toastError, toastWithUndo } from "../../ui/toast";
import { useApi } from "../../ui/use-api";

/** Картинка баннера в строке и в окне: маленькая, целиком, без обрезки. */
function Thumb({ imageId, size }: { imageId: string; size: number }) {
  return <img src={imageUrl(imageId)} alt="" loading="lazy" width={size} height={size} className="shrink-0 rounded-sm border border-border bg-surface-sunken object-contain" style={{ width: size, height: size }} />;
}

/**
 * Вкладка «Материалы» раздела «Партнёры» (docs/35-stage4-plan.md Р136, tasks/T-0221): баннеры, тексты постов и
 * правила программы, которые партнёры забирают в своём кабинете. Общие — всем, адресные — одному партнёру. Смотрят
 * под `partners.view`, выкладывают, правят и убирают в архив под `partners.edit`. Удаления нет: архивный материал
 * партнёр не видит, но запись остаётся и возвращается из архива.
 */
export function PartnerMaterials({ canEdit }: { canEdit: boolean }) {
  const { state, reload } = useApi(() => fetchTeamMaterials(api), []);
  const partners = useApi(() => fetchPartners(api), []);
  // `undefined` — окно закрыто, `null` — новый материал, строка — правка.
  const [editing, setEditing] = useState<TeamMaterial | null | undefined>(undefined);

  const toggleArchive = async (material: TeamMaterial): Promise<void> => {
    const archived = material.archivedAt === null;
    const result = await archiveMaterial(api, material.materialId, archived);
    if (!result.ok) {
      toastError(result.error);
      return;
    }
    reload();
    if (!archived) {
      toast.success(`Вернули из архива: ${material.title}`);
      return;
    }
    toastWithUndo(`В архиве: ${material.title}`, async () => {
      const back = await archiveMaterial(api, material.materialId, false);
      if (!back.ok) throw new Error(back.error.message);
      reload();
    });
  };

  const body = () => {
    if (state.status === "loading") return <Loading />;
    if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
    return (
      <DataTable
        rows={teamOrder(state.data.materials)}
        rowKey={(material) => material.materialId}
        {...(canEdit ? { onRowClick: (material: TeamMaterial) => setEditing(material) } : {})}
        empty={canEdit ? MATERIAL_TEXTS.teamEmpty : MATERIAL_TEXTS.teamEmptyReadOnly}
        columns={[
          {
            title: "Материал",
            primary: true,
            render: (material) => (
              <span className="flex items-center gap-2">
                {material.imageId === null ? null : (
                  <span className="max-md:hidden">
                    <Thumb imageId={material.imageId} size={40} />
                  </span>
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium break-words">{material.title}</span>
                  {bannerSize(material) === null ? null : <span className="text-xs text-text-muted">{bannerSize(material)}</span>}
                </span>
              </span>
            ),
          },
          { title: "Вид", render: (material) => <Badge tone={material.kind === "rules" ? "info" : "neutral"}>{KIND_TITLES[material.kind]}</Badge> },
          { title: "Кому", render: (material) => <span className="break-words">{audienceTitle(material)}</span> },
          { title: "Порядок", align: "right", render: (material) => material.sort },
          { title: "Изменён", render: (material) => formatDateTime(material.updatedAt) },
          {
            title: "Состояние",
            help: MATERIAL_TEXTS.archiveHelp,
            render: (material) => (material.archivedAt === null ? <Badge tone="success">в кабинете</Badge> : <Badge>в архиве</Badge>),
          },
          {
            title: "",
            render: (material) =>
              canEdit ? (
                <span className="flex flex-wrap gap-2" onClick={(event) => event.stopPropagation()}>
                  <Button onClick={() => setEditing(material)}>Изменить</Button>
                  <Button onClick={() => void toggleArchive(material)}>{material.archivedAt === null ? "В архив" : "Вернуть"}</Button>
                </span>
              ) : null,
          },
        ]}
      />
    );
  };

  return (
    <>
      <Panel
        title="Материалы для партнёров"
        actions={
          canEdit ? (
            <Button tone="primary" onClick={() => setEditing(null)}>
              Новый материал
            </Button>
          ) : null
        }
      >
        <div className="mb-3">
          <Notice tone="info">{MATERIAL_TEXTS.teamIntro}</Notice>
        </div>
        {body()}
      </Panel>
      {editing === undefined ? null : (
        <MaterialDialog
          material={editing}
          partners={partners.state.status === "ok" ? partners.state.data.partners.map((partner) => ({ partnerId: partner.partnerId, name: partner.name, status: partner.status })) : []}
          onClose={() => setEditing(undefined)}
          onSaved={reload}
        />
      )}
    </>
  );
}

type Upload = { kind: "idle" } | { kind: "working"; text: string } | { kind: "failed"; problem: string };

/** Новый материал или правка: вид, название, текст или картинка, кому и в каком порядке. */
function MaterialDialog({
  material,
  partners,
  onClose,
  onSaved,
}: {
  material: TeamMaterial | null;
  partners: { partnerId: string; name: string; status: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<MaterialForm>(material === null ? emptyMaterialForm() : materialFormOf(material));
  const [size, setSize] = useState<string | null>(material === null ? null : bannerSize(material));
  const [upload, setUpload] = useState<Upload>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<MaterialForm>): void => setForm((current) => ({ ...current, ...patch }));

  const problems = materialProblems(form);
  const first = Object.values(problems)[0] ?? null;
  const dirty = material === null || JSON.stringify(form) !== JSON.stringify(materialFormOf(material));
  const busy = saving || upload.kind === "working";
  // Получателя, которого нет в списке (список ещё грузится или партнёра убрали из выборки), всё равно показываем.
  const audience = partners.filter((partner) => partner.status !== "rejected" || partner.partnerId === form.partnerId);
  if (form.partnerId !== "" && !audience.some((partner) => partner.partnerId === form.partnerId)) audience.push({ partnerId: form.partnerId, name: material?.partnerName ?? "Выбранный партнёр", status: "active" });

  const pick = async (file: File | undefined): Promise<void> => {
    // Тот же файл можно выбрать снова — после отказа.
    if (input.current !== null) input.current.value = "";
    if (file === undefined) return;
    const unfit = sourceProblem(file);
    if (unfit !== null) return setUpload({ kind: "failed", problem: unfit });
    setUpload({ kind: "working", text: "Сжимаю картинку…" });
    const prepared = await prepareBanner(file);
    if (!prepared.ok) return setUpload({ kind: "failed", problem: prepared.problem });
    setUpload({ kind: "working", text: "Загружаю…" });
    const uploaded = await uploadBannerImage(api, prepared.blob);
    if (!uploaded.ok) return setUpload({ kind: "failed", problem: uploaded.error.message });
    setUpload({ kind: "idle" });
    setSize(`${String(uploaded.data.width)}×${String(uploaded.data.height)}`);
    set({ imageId: uploaded.data.imageId });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    const result = material === null ? await createMaterial(api, form) : await updateMaterial(api, material.materialId, form);
    setSaving(false);
    if (!result.ok) {
      toastError(result.error);
      return;
    }
    toast.success(material === null ? `Выложено: ${result.data.title}` : `Сохранено: ${result.data.title}`);
    onSaved();
    onClose();
  };

  const isBanner = form.kind === "banner";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={material === null ? "Новый материал" : `Материал «${material.title}»`}
      description="Баннер, текст поста или правила программы: партнёр найдёт его во вкладке «Материалы» своего кабинета."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button tone="primary" disabled={busy || first !== null || !dirty} blockedBy={first} onClick={() => void save()}>
            {saving ? "Сохраняем…" : material === null ? "Выложить" : "Сохранить"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Вид" hint={material === null ? undefined : "после заведения вид не меняется"}>
          <Select
            value={form.kind}
            disabled={material !== null}
            onChange={(event) => {
              const next = MATERIAL_KINDS.find((kind) => kind === event.target.value);
              if (next !== undefined) set({ kind: next as MaterialKind, ...(next === "banner" ? {} : { imageId: null }) });
            }}
            className="w-full max-w-xs"
          >
            {MATERIAL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_TITLES[kind]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Название" hint="так материал называется в кабинете партнёра" error={form.title === "" ? undefined : problems.title}>
          <Input value={form.title} onChange={(event) => set({ title: event.target.value })} placeholder={isBanner ? "Баннер для поста 1080×1080" : "Текст для анонса"} maxLength={MATERIAL_LIMITS.titleMax + 10} className="w-full max-w-md" autoFocus />
        </Field>
        {isBanner ? (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              Картинка
              <Help text={MATERIAL_TEXTS.bannerHelp} />
            </span>
            <div className="flex items-start gap-3">
              {form.imageId === null ? <span className="size-24 shrink-0 rounded-md border border-dashed border-border bg-surface-sunken" aria-hidden="true" /> : <Thumb imageId={form.imageId} size={96} />}
              <div className="flex min-w-0 flex-col gap-1">
                <Button onClick={() => input.current?.click()} disabled={upload.kind === "working"}>
                  {form.imageId === null ? "Загрузить…" : "Заменить…"}
                </Button>
                {upload.kind === "working" ? (
                  <span role="status" className="text-xs text-text-muted">
                    {upload.text}
                  </span>
                ) : form.imageId === null ? (
                  <span className="text-xs text-text-muted">картинки пока нет</span>
                ) : (
                  <span className="text-xs text-text-muted">{size === null ? "загружена" : `${size}, WebP`}</span>
                )}
                {upload.kind === "failed" ? (
                  <span role="alert" className="text-xs text-danger">
                    {upload.problem}
                  </span>
                ) : null}
              </div>
            </div>
            <input ref={input} type="file" accept={SOURCE_TYPES.join(",")} className="hidden" onChange={(event) => void pick(event.target.files?.[0])} />
          </div>
        ) : null}
        <Field
          label={`${isBanner ? "Подпись" : "Текст"} — ${String(form.text.trim().length)} из ${String(MATERIAL_LIMITS.textMax)}`}
          hint={isBanner ? "необязательно: партнёр увидит её рядом с баннером" : "партнёр скопирует текст как есть"}
          error={form.text === "" ? undefined : problems.text}
        >
          <TextArea value={form.text} onChange={(event) => set({ text: event.target.value })} rows={isBanner ? 3 : 8} className="w-full max-w-md" />
        </Field>
        <Field label="Кому" help={MATERIAL_TEXTS.audienceHelp}>
          <Select value={form.partnerId} onChange={(event) => set({ partnerId: event.target.value })} className="w-full max-w-md">
            <option value="">Всем партнёрам</option>
            {audience.map((partner) => (
              <option key={partner.partnerId} value={partner.partnerId}>
                {partner.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Порядок" help={MATERIAL_TEXTS.sortHelp} error={problems.sort}>
          <Input value={form.sort} onChange={(event) => set({ sort: event.target.value })} inputMode="numeric" maxLength={4} className="w-24" />
        </Field>
      </div>
    </Dialog>
  );
}
